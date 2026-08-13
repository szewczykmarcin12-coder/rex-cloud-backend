// REX Clock — terminal POS rejestracji czasu pracy (WorkRhythm · Time & Attendance).
// Konta i grafik współdzielone z resztą REX Cloud; zdarzenia pod clock:{YYYY-MM-DD}
// (doba operacyjna 06:00–06:00, Europe/Warsaw). Sesje terminalowe bezstanowe (podpisany token, 3 min).
import crypto from 'crypto';
import { kv, cors, kvConfigured } from './_helpers.js';

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

const KEY = (d) => `clock:${d}`;
const stanKonta = (events, accountId) => {
  const moje = events.filter((e) => e.accountId === accountId);
  const last = moje[moje.length - 1];
  if (!last || last.type === 'clock_out') return 'off';
  if (last.type === 'break_start') return 'break';
  return 'working';
};
const DOZWOLONE = { off: ['clock_in'], working: ['break_start', 'clock_out'], break: ['break_end'] };
const NAZWY = { clock_in: 'Clock in', clock_out: 'Clock out', break_start: 'Start break', break_end: 'End break' };

const sekret = async () => (await kv.get('asm:pass')) || 'rex-clock-fallback';
const tokenFor = async (accountId) => { const exp = Date.now() + 3 * 60 * 1000; return `${accountId}.${exp}.${sha(`${accountId}|${exp}|${await sekret()}`)}`; };
const tokenCheck = async (t) => {
  const [aid, exp, sig] = String(t || '').split('.');
  if (!aid || !exp || !sig || +exp < Date.now()) return null;
  return sha(`${aid}|${exp}|${await sekret()}`) === sig ? aid : null;
};

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza niedostępna' });
  try {
    const action = (req.query && req.query.action) || '';

    if (req.method === 'GET') {
      const d = (req.query && req.query.date) || opDay();
      const events = (await kv.get(KEY(d))) || [];
      return res.json({ success: true, date: d, events });
    }

    if (req.method === 'POST' && action === 'auth') {
      const { method, employeeNumber, pin, cardToken, terminalId } = req.body || {};
      if (!terminalId || !String(terminalId).trim()) return res.status(400).json({ success: false, error: 'Brak identyfikatora terminala.' });
      const konta = (await kv.get('accounts:list')) || [];
      let konto = null;
      if (method === 'card') {
        const tok = norm(cardToken);
        if (tok.length < 4) return res.status(400).json({ success: false, error: 'Nieczytelna karta — spróbuj ponownie.' });
        konto = konta.find((a) => (a.cardToken && norm(a.cardToken) === tok) || norm(a.login) === tok);
      } else {
        const cel = String(employeeNumber || '').trim().toUpperCase();
        konto = konta.find((a) => String(a.login || '').toUpperCase() === cel);
        if (konto && konto.hasloHash !== sha(String(pin || ''))) konto = null;
      }
      if (!konto) return res.status(401).json({ success: false, error: 'Nie rozpoznano pracownika lub kod jest nieprawidłowy.' });
      if (konto.mustChange) return res.status(401).json({ success: false, error: 'Konto ma hasło startowe — ustaw własny PIN w aplikacji pracownika, potem wróć do terminala.' });

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

    if (req.method === 'POST' && action === 'event') {
      const { token, action: typ, breakType, method, terminalId, clientEventId } = req.body || {};
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
        at: at.getTime(), atISO: at.toISOString(), opDay: d,
      });
      await kv.set(KEY(d), events);
      return res.json({ success: true, state: stanKonta(events, aid), occurredAt: at.toISOString() });
    }

    return res.status(405).json({ success: false, error: 'Nieobsługiwana metoda' });
  } catch (e) {
    return res.status(500).json({ success: false, error: (e && e.message) || 'Błąd serwera' });
  }
}
