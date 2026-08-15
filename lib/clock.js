// REX Clock — terminal POS rejestracji czasu pracy (WorkRhythm · Time & Attendance).
// SEC-04: karta działa wyłącznie po hashu tokenu karty (bez obejścia loginem),
//         terminal musi być zarejestrowany przez ASM (clock:terminals) i aktywny.
// TNA-01: zdarzenia clock:{YYYY-MM-DD} są append-only i jedynym automatycznym
//         źródłem wykonania; endpoint ?action=projection buduje z nich timesheet.
import crypto from 'crypto';
import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole, sessionSecret } from './auth.js';
import { audit, aktor } from './audit.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const norm = (s) => String(s || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

// dzień operacyjny dla znacznika czasu (godziny 00–06 należą do dnia poprzedniego)
export const opDay = (ts = Date.now()) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  if (+p.hour < 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

const hhmm = (ts) => new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts));

const KEY = (d) => `clock:${d}`;
const TERMS_KEY = 'clock:terminals';
const stanKonta = (events, accountId) => {
  const moje = events.filter((e) => e.accountId === accountId);
  const last = moje[moje.length - 1];
  if (!last || last.type === 'clock_out') return 'off';
  if (last.type === 'break_start') return 'break';
  return 'working';
};
const DOZWOLONE = { off: ['clock_in'], working: ['break_start', 'clock_out'], break: ['break_end'] };
const NAZWY = { clock_in: 'Clock in', clock_out: 'Clock out', break_start: 'Start break', break_end: 'End break' };

// krótka sesja terminalowa (3 min) — podpis sekretem sesji, nie hasłem ASM
const tokenFor = async (accountId) => { const exp = Date.now() + 3 * 60 * 1000; return `${accountId}.${exp}.${sha(`${accountId}|${exp}|${await sessionSecret()}`)}`; };
const tokenCheck = async (t) => {
  const [aid, exp, sig] = String(t || '').split('.');
  if (!aid || !exp || !sig || +exp < Date.now()) return null;
  return sha(`${aid}|${exp}|${await sessionSecret()}`) === sig ? aid : null;
};

// ── Rejestr terminali (SEC-04): tylko urządzenia dodane przez ASM mogą odbijać ──
const readTerms = async () => (await kv.get(TERMS_KEY)) || [];
async function checkTerminal(terminalId) {
  const id = String(terminalId || '').trim();
  if (!id) return { ok: false, error: 'Brak identyfikatora terminala.' };
  const terms = await readTerms();
  if (!terms.length) return { ok: false, error: 'Żaden terminal nie jest zarejestrowany. ASM musi dodać terminal w panelu: Ustawienia → Terminale REX Clock.' };
  const t = terms.find((x) => x.id === id);
  if (!t) return { ok: false, error: `Terminal ${id} nie jest zarejestrowany. ASM może go dodać w Ustawieniach panelu.` };
  if (t.active === false) return { ok: false, error: `Terminal ${id} został wycofany.` };
  return { ok: true, terminal: t };
}
async function touchTerminal(id) {
  try {
    const terms = await readTerms();
    const t = terms.find((x) => x.id === id);
    if (t) { t.lastSeen = Date.now(); await kv.set(TERMS_KEY, terms); }
  } catch {}
}

// ── Projekcja odbić na timesheet (TNA-01): pary IN/OUT + przerwy + anomalie ──
function projectEvents(events, konta) {
  const byAcc = {};
  events.forEach((e) => { (byAcc[e.accountId] = byAcc[e.accountId] || []).push(e); });
  return Object.entries(byAcc).map(([aid, evs]) => {
    evs.sort((a, b) => a.at - b.at);
    let inAt = null, outAt = null, curBreak = null;
    const breaks = [], anomalies = [];
    evs.forEach((e) => {
      if (e.type === 'clock_in') { if (inAt) anomalies.push('podwójne wejście'); else inAt = e.at; }
      else if (e.type === 'break_start') { if (curBreak) anomalies.push('przerwa bez zakończenia'); else curBreak = { start: e.at, paid: !!e.paid }; }
      else if (e.type === 'break_end') { if (curBreak) { breaks.push({ start: hhmm(curBreak.start), end: hhmm(e.at), paid: curBreak.paid }); curBreak = null; } else anomalies.push('koniec przerwy bez początku'); }
      else if (e.type === 'clock_out') { if (!inAt) anomalies.push('wyjście bez wejścia'); outAt = e.at; }
    });
    if (curBreak) anomalies.push('przerwa w toku / niezamknięta');
    if (inAt && !outAt) anomalies.push('brak wyjścia (praca w toku lub niedobicie)');
    const konto = (konta || []).find((k) => k.id === aid) || {};
    const unpaidMin = breaks.filter((b) => !b.paid).reduce((x, b) => {
      const [h1, m1] = b.start.split(':').map(Number), [h2, m2] = b.end.split(':').map(Number);
      let d = (h2 * 60 + m2) - (h1 * 60 + m1); if (d < 0) d += 1440; return x + d;
    }, 0);
    let workedMin = null;
    if (inAt && outAt && outAt > inAt) workedMin = Math.round((outAt - inAt) / 60000) - unpaidMin;
    return {
      accountId: aid, login: konto.login || (evs[0] && evs[0].login) || null, name: konto.name || (evs[0] && evs[0].name) || null,
      in: inAt ? hhmm(inAt) : null, out: outAt ? hhmm(outAt) : null,
      breaks, workedMin, complete: !!(inAt && outAt), anomalies, source: 'clock', events: evs.length,
    };
  });
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza niedostępna' });
  try {
    const action = (req.query && req.query.action) || '';

    // ── odczyty (panel admina) ──
    if (req.method === 'GET' && action === 'terminals') {
      if (!(await requireRole(req, res, ['asm', 'kierownik']))) return;
      return res.json({ success: true, terminals: await readTerms() });
    }
    if (req.method === 'GET' && action === 'projection') {
      if (!(await requireRole(req, res, ['asm', 'kierownik']))) return;
      const d = (req.query && req.query.date) || opDay();
      const events = (await kv.get(KEY(d))) || [];
      const konta = (await kv.get('accounts:list')) || [];
      return res.json({ success: true, date: d, projection: projectEvents(events, konta) });
    }
    if (req.method === 'GET') {
      if (!(await requireRole(req, res, ['asm', 'kierownik']))) return;
      const d = (req.query && req.query.date) || opDay();
      const events = (await kv.get(KEY(d))) || [];
      return res.json({ success: true, date: d, events });
    }

    // ── zarządzanie terminalami (tylko ASM) ──
    if (req.method === 'POST' && action === 'terminal-add') {
      const sesjaT = await requireRole(req, res, ['asm']); if (!sesjaT) return;
      const { id, name } = req.body || {};
      const tid = String(id || '').trim();
      if (!tid) return res.status(400).json({ success: false, error: 'Podaj identyfikator terminala (np. K003-POS-01)' });
      const terms = await readTerms();
      if (terms.some((t) => t.id === tid)) return res.status(409).json({ success: false, error: `Terminal ${tid} już istnieje` });
      terms.push({ id: tid, name: String(name || '').trim() || tid, active: true, addedAt: Date.now(), lastSeen: null });
      await kv.set(TERMS_KEY, terms);
      audit({ ...aktor(sesjaT), action: 'terminal.add', target: tid });
      return res.json({ success: true, terminals: terms });
    }
    if (req.method === 'POST' && action === 'terminal-toggle') {
      const sesjaT = await requireRole(req, res, ['asm']); if (!sesjaT) return;
      const terms = await readTerms();
      const t = terms.find((x) => x.id === String((req.body || {}).id || '').trim());
      if (!t) return res.status(404).json({ success: false, error: 'Nie ma takiego terminala' });
      t.active = t.active === false;                    // przełącz: wycofany ↔ aktywny
      await kv.set(TERMS_KEY, terms);
      audit({ ...aktor(sesjaT), action: t.active ? 'terminal.activate' : 'terminal.deactivate', target: t.id });
      return res.json({ success: true, terminals: terms });
    }
    if (req.method === 'POST' && action === 'terminal-del') {
      const sesjaT = await requireRole(req, res, ['asm']); if (!sesjaT) return;
      const terms = (await readTerms()).filter((x) => x.id !== String((req.body || {}).id || '').trim());
      await kv.set(TERMS_KEY, terms);
      audit({ ...aktor(sesjaT), action: 'terminal.delete', target: String((req.body || {}).id || '').trim() });
      return res.json({ success: true, terminals: terms });
    }

    // ── identyfikacja przy terminalu ──
    if (req.method === 'POST' && action === 'auth') {
      const { method, employeeNumber, pin, cardToken, terminalId } = req.body || {};
      const term = await checkTerminal(terminalId);
      if (!term.ok) return res.status(403).json({ success: false, error: term.error });

      const konta = (await kv.get('accounts:list')) || [];
      let konto = null;
      if (method === 'card') {
        // SEC-04: wyłącznie hash tokenu karty — login NIE jest substytutem karty
        const tok = norm(cardToken);
        if (tok.length < 4) return res.status(400).json({ success: false, error: 'Nieczytelna karta — spróbuj ponownie.' });
        const tokHash = sha(tok);
        konto = konta.find((a) => a.cardTokenHash === tokHash);
        if (!konto) {
          // migracja starych kont z plaintextowym cardToken (jednorazowo, po dopasowaniu)
          const legacy = konta.find((a) => a.cardToken && norm(a.cardToken) === tok);
          if (legacy) { legacy.cardTokenHash = tokHash; delete legacy.cardToken; await kv.set('accounts:list', konta); konto = legacy; }
        }
        if (!konto) return res.status(401).json({ success: false, error: 'Karta nieprzypisana do żadnego pracownika. ASM może przypisać kartę w panelu.' });
      } else {
        const cel = String(employeeNumber || '').trim().toUpperCase();
        konto = konta.find((a) => String(a.login || '').toUpperCase() === cel);
        if (konto) {
          const { verifySecret, hashSecret } = await import('./auth.js');
          const w = verifySecret(String(pin || ''), konto.hasloHash);
          if (!w.ok) konto = null;
          else if (w.upgrade) { konto.hasloHash = hashSecret(String(pin)); await kv.set('accounts:list', konta); }
        }
      }
      if (!konto) return res.status(401).json({ success: false, error: 'Nie rozpoznano pracownika lub kod jest nieprawidłowy.' });
      if (konto.mustChange) return res.status(401).json({ success: false, error: 'Konto ma hasło startowe — ustaw własny PIN w aplikacji pracownika, potem wróć do terminala.' });

      await touchTerminal(String(terminalId).trim());
      const dzis = opDay();
      const events = (await kv.get(KEY(dzis))) || [];
      const state = stanKonta(events, konto.id);

      // opublikowana zmiana z grafiku na dzisiejszą dobę operacyjną (bez wpisów instruktorskich)
      let planned = null;
      try {
        const mies = (await kv.get(`sched:${dzis.slice(0, 7)}`)) || { shifts: [] };
        const zm = (mies.shifts || []).find((x) => x.date === dzis && (x.accountId === konto.id || String(x.name || '').toUpperCase().trim() === String(konto.grafikName || '').toUpperCase()) && x.rola !== 'instruktor');
        if (zm) planned = { start: zm.start, end: zm.end, station: zm.station || null };
      } catch {}

      return res.json({
        success: true,
        token: await tokenFor(konto.id),
        state,
        employee: { id: konto.id, employeeNumber: konto.login, fullName: konto.name, role: konto.funkcja || 'CREW', plannedStart: planned && planned.start, plannedEnd: planned && planned.end, station: planned && planned.station },
      });
    }

    // ── zdarzenie odbicia (append-only, idempotentne) ──
    if (req.method === 'POST' && action === 'event') {
      const { token, action: typ, breakType, method, terminalId, clientEventId } = req.body || {};
      const term = await checkTerminal(terminalId);
      if (!term.ok) return res.status(403).json({ success: false, error: term.error });
      const aid = await tokenCheck(token);
      if (!aid) return res.status(401).json({ success: false, error: 'Sesja terminala wygasła — zidentyfikuj się ponownie.' });
      if (!DOZWOLONE.off.concat(DOZWOLONE.working, DOZWOLONE.break).includes(typ)) return res.status(400).json({ success: false, error: 'Nieznany typ zdarzenia.' });

      const d = opDay();
      const events = (await kv.get(KEY(d))) || [];
      if (clientEventId && events.some((e) => e.cid === clientEventId)) {
        return res.json({ success: true, state: stanKonta(events, aid), occurredAt: new Date().toISOString(), duplicate: true });
      }
      const st = stanKonta(events, aid);
      if (!DOZWOLONE[st].includes(typ)) {
        const opis = { off: 'poza zmianą', working: 'w pracy', break: 'na przerwie' }[st];
        return res.status(409).json({ success: false, error: `Nie można wykonać „${NAZWY[typ]}" — jesteś obecnie ${opis}. Odśwież i spróbuj ponownie.` });
      }
      const konta = (await kv.get('accounts:list')) || [];
      const konto = konta.find((a) => a.id === aid) || {};
      const at = new Date();
      events.push({
        cid: clientEventId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        accountId: aid, login: konto.login || null, name: konto.name || null,
        type: typ, paid: typ === 'break_start' ? breakType === 'paid' : undefined,
        method: method === 'card' ? 'card' : 'code', terminal: String(terminalId || '').trim() || null,
        at: at.getTime(), atISO: at.toISOString(), serverReceivedAt: at.toISOString(), opDay: d,
      });
      await kv.set(KEY(d), events);
      await touchTerminal(String(terminalId).trim());
      return res.json({ success: true, state: stanKonta(events, aid), occurredAt: at.toISOString() });
    }

    return res.status(405).json({ success: false, error: 'Nieobsługiwana metoda' });
  } catch (e) {
    return res.status(500).json({ success: false, error: (e && e.message) || 'Błąd serwera' });
  }
}
