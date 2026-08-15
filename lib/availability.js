// WFM-02: dostępność i preferencje pracowników.
// avail:list = { [accountId]: {
//   wzor: { '0'..'6': { tryb: 'pelna'|'brak'|'okno', od: 'HH:MM', do: 'HH:MM', pref: ''|'rano'|'wieczor' } },
//   pending: { wzor, requestedAt } | null,        // propozycja pracownika czeka na akceptację
//   updatedAt, decidedBy
// } }
// Wzorzec zatwierdzony egzekwuje WFM-05 w schedule: 'brak' = blokada, poza oknem = ostrzeżenie.
import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit, aktor } from './audit.js';

const KEY = 'avail:list';

// ── Dyspozycje dzienne (REX WorkRhythm Modules): avail:reqs = [{
//   id, accountId, name, login, date, type, startTime, endTime,
//   recurrence: 'once'|'weekly', repeatUntil, note,
//   status: 'pending'|'approved'|'rejected', managerName, managerNote,
//   decidedAt, createdAt }]
// Konflikt liczony przy odczycie: opublikowana zmiana pracownika w tym dniu.
const REQS_KEY = 'avail:reqs';
const TYPY_DYSPO = ['available', 'unavailable', 'from_time', 'until_time', 'specific_shift'];
const czasOk = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
const dOk = (x) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x || ''))) return false; try { return new Date(x + 'T00:00:00Z').toISOString().slice(0, 10) === x; } catch { return false; } };
const readReqs = async () => (await kv.get(REQS_KEY)) || [];

// ── Okno składania dyspozycji: wyłącznie KOLEJNY miesiąc, do 20. dnia bieżącego.
// Po 20. okno zamknięte — ręcznie otworzyć/zamknąć może tylko ASM (avail:window per miesiąc docelowy).
const WINDOW_KEY = 'avail:window';
const dzisWarszawa = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
const nastepnyMiesiac = (todayIso) => { const [y, m] = todayIso.split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); };
const ostatniDzienMies = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };
export async function stanOknaDyspo() {
  const today = dzisWarszawa();
  const targetMonth = nastepnyMiesiac(today);
  const manual = ((await kv.get(WINDOW_KEY)) || {})[targetMonth] || null;
  const autoOtwarte = Number(today.slice(8, 10)) <= 20;
  return {
    targetMonth,
    deadline: `${today.slice(0, 7)}-20`,
    autoOtwarte,
    reczne: manual,
    otwarte: manual ? !!manual.open : autoOtwarte,
  };
}

// czy zatwierdzona dyspozycja obowiązuje danego dnia (z powtarzalnością tygodniową)
export function dyspozycjaObowiazuje(rq, date) {
  if (rq.date === date) return true;
  if (rq.recurrence !== 'weekly') return false;
  if (date < rq.date) return false;
  if (rq.repeatUntil && date > rq.repeatUntil) return false;
  return new Date(rq.date + 'T00:00:00Z').getUTCDay() === new Date(date + 'T00:00:00Z').getUTCDay();
}

// pomocnicze dla schedule (WFM-05): zatwierdzona dyspozycja konta na dzień
export async function dyspozycjaNaDzien(accountId, date) {
  if (!accountId || !date) return null;
  const reqs = await readReqs();
  return reqs.find((r) => r.accountId === accountId && r.status === 'approved' && dyspozycjaObowiazuje(r, date)) || null;
}

// konflikt: pracownik ma zmianę w OPUBLIKOWANYM grafiku tego dnia
async function zKonfliktami(reqs) {
  const yms = [...new Set(reqs.map((r) => r.date.slice(0, 7)))];
  const puby = {};
  for (const ym of yms) puby[ym] = await kv.get(`sched:pub:${ym}`);
  return reqs.map((r) => {
    const pub = puby[r.date.slice(0, 7)];
    const conflict = !!(pub && (pub.shifts || []).some((x) => x.accountId === r.accountId && x.date === r.date));
    return { ...r, conflict };
  });
}
const TRYBY = ['pelna', 'brak', 'okno'];
const read = async () => (await kv.get(KEY)) || {};
const write = (o) => kv.set(KEY, o);

const czysc = (wzor) => {
  const out = {};
  for (let d = 0; d <= 6; d++) {
    const w = (wzor || {})[d] || (wzor || {})[String(d)] || {};
    const tryb = TRYBY.includes(w.tryb) ? w.tryb : 'pelna';
    out[d] = { tryb, od: tryb === 'okno' ? (w.od || '06:00') : null, do: tryb === 'okno' ? (w.do || '23:00') : null, pref: ['rano', 'wieczor'].includes(w.pref) ? w.pref : '' };
  }
  return out;
};

// pomocnicze dla schedule (WFM-05): zatwierdzona dostępność konta na dany dzień
export async function dostepnoscDnia(accountId, date) {
  if (!accountId || !date) return null;
  const all = await read();
  const rec = all[accountId];
  if (!rec || !rec.wzor) return null;
  return rec.wzor[new Date(date).getDay()] || null;
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });

  try {
    const sesja = await requireRole(req, res, ['asm', 'kierownik', 'pracownik']);
    if (!sesja) return;

    // ── stan okna składania dyspozycji ──
    if (req.method === 'GET' && req.query && req.query.window) {
      const okno = await stanOknaDyspo();
      return res.json({ success: true, okno });
    }

    // ── ręczne otwarcie/zamknięcie okna (tylko ASM) ──
    if (req.method === 'POST' && req.query && req.query.action === 'window') {
      if (sesja.role !== 'asm') return res.status(403).json({ success: false, error: 'Okno dyspozycji może otworzyć lub zamknąć wyłącznie ASM.' });
      const okno = await stanOknaDyspo();
      const open = !!(req.body || {}).open;
      const all = (await kv.get(WINDOW_KEY)) || {};
      all[okno.targetMonth] = { open, by: sesja.name, at: new Date().toISOString() };
      await kv.set(WINDOW_KEY, all);
      await audit({ ...aktor(sesja), action: open ? 'availability.window-open' : 'availability.window-close', target: okno.targetMonth });
      return res.json({ success: true, okno: await stanOknaDyspo() });
    }

    // ── dyspozycje dzienne: lista (panel: wszystkie w zakresie; pracownik: własne) ──
    if (req.method === 'GET' && req.query && req.query.reqs) {
      let reqs = await readReqs();
      if (sesja.role === 'pracownik') reqs = reqs.filter((r) => r.accountId === sesja.accountId);
      const { from, to } = req.query;
      if (dOk(from) && dOk(to)) reqs = reqs.filter((r) => (r.date >= from && r.date <= to) || (r.recurrence === 'weekly' && r.date <= to && (!r.repeatUntil || r.repeatUntil >= from)));
      reqs = await zKonfliktami(reqs);
      return res.json({ success: true, requests: reqs.sort((a, b) => b.createdAt - a.createdAt) });
    }

    // ── nowe zgłoszenie dyspozycji (pracownik; panel może wpisać za pracownika) ──
    if (req.method === 'POST' && req.query && req.query.action === 'request') {
      const b = req.body || {};
      if (!dOk(b.date)) return res.status(400).json({ success: false, error: 'Nieprawidłowa data dyspozycji.' });
      if (!TYPY_DYSPO.includes(b.type)) return res.status(400).json({ success: false, error: 'Nieznany typ dyspozycji.' });
      const startTime = ['from_time', 'specific_shift'].includes(b.type) ? b.startTime : null;
      const endTime = ['until_time', 'specific_shift'].includes(b.type) ? b.endTime : null;
      if ((startTime && !czasOk(startTime)) || (endTime && !czasOk(endTime))) return res.status(400).json({ success: false, error: 'Nieprawidłowa godzina (HH:MM).' });
      if (b.type === 'specific_shift' && !(startTime && endTime)) return res.status(400).json({ success: false, error: 'Podaj początek i koniec zmiany.' });
      const recurrence = b.recurrence === 'weekly' ? 'weekly' : 'once';
      let repeatUntil = recurrence === 'weekly' ? (dOk(b.repeatUntil) && b.repeatUntil >= b.date ? b.repeatUntil : null) : null;
      if (recurrence === 'weekly' && !repeatUntil) return res.status(400).json({ success: false, error: 'Przy powtarzalności podaj datę „powtarzaj do".' });

      const accountId = sesja.role === 'pracownik' ? sesja.accountId : (b.accountId || null);
      if (!accountId) return res.status(400).json({ success: false, error: 'Wskaż pracownika.' });
      // Reguła okna: pracownik składa wyłącznie na KOLEJNY miesiąc i tylko w otwartym oknie.
      // Panel (ASM/kierownik) może wpisywać dyspozycje bez ograniczeń.
      let repeatLimit = null;
      if (sesja.role === 'pracownik') {
        const okno = await stanOknaDyspo();
        const [ry, rm] = okno.targetMonth.split('-').map(Number);
        const nazwaMies = new Intl.DateTimeFormat('pl-PL', { month: 'long', year: 'numeric' }).format(new Date(Date.UTC(ry, rm - 1, 1)));
        if (b.date.slice(0, 7) !== okno.targetMonth) {
          return res.status(400).json({ success: false, error: `Dyspozycje przyjmujemy wyłącznie na ${nazwaMies}.` });
        }
        if (!okno.otwarte) {
          return res.status(403).json({ success: false, error: `Okno dyspozycji na ${nazwaMies} jest zamknięte (termin: 20. dzień miesiąca). Otworzyć może je wyłącznie ASM.` });
        }
        repeatLimit = ostatniDzienMies(okno.targetMonth);
        if (repeatUntil && repeatUntil > repeatLimit) repeatUntil = repeatLimit;   // powtarzalność nie wychodzi poza miesiąc docelowy
      }
      const konta = (await kv.get('accounts:list')) || [];
      const konto = konta.find((k) => k.id === accountId);
      if (!konto) return res.status(404).json({ success: false, error: 'Nie znaleziono konta.' });
      const reqs = await readReqs();
      const rq = {
        id: 'dy' + Date.now() + Math.random().toString(36).slice(2, 6),
        accountId, name: konto.name, login: konto.login,
        date: b.date, type: b.type, startTime, endTime, recurrence, repeatUntil,
        note: String(b.note || '').slice(0, 500),
        status: 'pending', managerName: null, managerNote: '', decidedAt: null, createdAt: Date.now(),
      };
      // jedna aktywna dyspozycja na dzień — nowe zgłoszenie zastępuje poprzednie dla tej daty
      const bez = reqs.filter((r) => !(r.accountId === accountId && r.date === b.date));
      bez.unshift(rq);
      await kv.set(REQS_KEY, bez);
      await audit({ ...aktor(sesja), action: 'availability.request-day', target: `${konto.login} ${b.date}`, after: { type: b.type, recurrence } });
      const [zK] = await zKonfliktami([rq]);
      return res.json({ success: true, request: zK });
    }

    // ── decyzja managera ──
    if (req.method === 'POST' && req.query && req.query.action === 'decide') {
      if (sesja.role === 'pracownik') return res.status(403).json({ success: false, error: 'Decyzja wymaga uprawnień kierownika.' });
      const { id, status, managerNote } = req.body || {};
      if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ success: false, error: 'Decyzja: approved albo rejected.' });
      const reqs = await readReqs();
      const rq = reqs.find((r) => r.id === id);
      if (!rq) return res.status(404).json({ success: false, error: 'Nie znaleziono zgłoszenia.' });
      rq.status = status;
      rq.managerName = sesja.name;
      rq.managerNote = String(managerNote || '').slice(0, 300);
      rq.decidedAt = new Date().toISOString();
      await kv.set(REQS_KEY, reqs);
      await audit({ ...aktor(sesja), action: `availability.${status === 'approved' ? 'approve' : 'reject'}-day`, target: `${rq.login} ${rq.date}`, after: { type: rq.type, managerNote: rq.managerNote || null } });
      const [zK] = await zKonfliktami([rq]);
      return res.json({ success: true, request: zK });
    }

    if (req.method === 'GET') {
      const all = await read();
      if (sesja.role === 'pracownik') return res.json({ success: true, availability: all[sesja.accountId] || null });
      const konta = (await kv.get('accounts:list')) || [];
      const lista = Object.entries(all).map(([aid, rec]) => ({ accountId: aid, name: (konta.find((k) => k.id === aid) || {}).name || aid, ...rec }));
      return res.json({ success: true, list: lista, pending: lista.filter((x) => x.pending).length });
    }

    // ── zapis wzorca ──
    if (req.method === 'PUT') {
      const b = req.body || {};
      const wzor = czysc(b.wzor);
      const all = await read();
      if (sesja.role === 'pracownik') {
        // workflow akceptacji: propozycja czeka na decyzję kierownika
        const rec = all[sesja.accountId] || { wzor: null };
        rec.pending = { wzor, requestedAt: Date.now() };
        all[sesja.accountId] = rec;
        await write(all);
        await audit({ ...aktor(sesja), action: 'availability.request', target: sesja.login });
        return res.json({ success: true, availability: rec, message: 'Propozycja dostępności czeka na akceptację kierownika.' });
      }
      // panel: ustawienie wprost (zatwierdzone)
      const accountId = b.accountId;
      if (!accountId) return res.status(400).json({ success: false, error: 'Wskaż pracownika.' });
      all[accountId] = { wzor, pending: null, updatedAt: Date.now(), decidedBy: sesja.name };
      await write(all);
      await audit({ ...aktor(sesja), action: 'availability.set', target: accountId });
      return res.json({ success: true, availability: all[accountId] });
    }

    // ── decyzja o propozycji pracownika ──
    if (req.method === 'POST') {
      if (sesja.role === 'pracownik') return res.status(403).json({ success: false, error: 'Decyzja wymaga uprawnień kierownika.' });
      const { accountId, action } = req.body || {};
      const all = await read();
      const rec = all[accountId];
      if (!rec || !rec.pending) return res.status(404).json({ success: false, error: 'Brak oczekującej propozycji.' });
      if (action === 'approve') {
        rec.wzor = rec.pending.wzor;
        rec.updatedAt = Date.now(); rec.decidedBy = sesja.name; rec.pending = null;
        await audit({ ...aktor(sesja), action: 'availability.approve', target: accountId });
      } else if (action === 'reject') {
        rec.pending = null; rec.decidedBy = sesja.name;
        await audit({ ...aktor(sesja), action: 'availability.reject', target: accountId });
      } else return res.status(400).json({ success: false, error: 'Nieznana akcja.' });
      await write(all);
      return res.json({ success: true, availability: rec });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
