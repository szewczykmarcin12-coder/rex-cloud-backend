import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit, aktor } from './audit.js';
import { norm, SLOWNIK_STANOWISK } from './work-model.js';

// ═══════════════════════════════════════════════════════════════════════════════════
//  MACIERZ KWALIFIKACJI — oddzielona od historii pracy
// ═══════════════════════════════════════════════════════════════════════════════════
//  quals:matrix = { [accountId]: { [STANOWISKO]: { poziom: 0..3, zatwierdzone: bool, zrodlo: 'manager'|'historia',
//                                                   uwagi?, at, by } } }
//  Poziomy: 0 brak, 1 w szkoleniu (tylko pod nadzorem poziomu ≥ 2 na tej samej stacji), 2 samodzielny, 3 trener.
//  Częstotliwość pracy na stanowisku NIE potwierdza uprawnienia: wpisy „z historii” są propozycjami
//  (zatwierdzone=false) i nie liczą się jako kwalifikacja, dopóki manager ich nie zatwierdzi.
//  Stara lista konta `stanowiska: []` jest honorowana jako poziom 2 zatwierdzony (zgodność wsteczna).
// ═══════════════════════════════════════════════════════════════════════════════════

export const QUAL_KEY = 'quals:matrix';
export const POZIOMY = { 0: 'brak', 1: 'w szkoleniu', 2: 'samodzielny', 3: 'trener' };

export async function czytajMacierz() { return (await kv.get(QUAL_KEY)) || {}; }

// kwalifikacja osoby na stanowisku: { poziom, zatwierdzone, zrodlo } albo { poziom: null, zrodlo: 'brak' }
export function kwalifikacja(matrix, account, station) {
  const st = norm(station);
  const wpis = ((matrix || {})[account.id] || {})[st];
  if (wpis && wpis.zatwierdzone) return { poziom: Number(wpis.poziom) || 0, zatwierdzone: true, zrodlo: wpis.zrodlo || 'manager' };
  if (Array.isArray(account.stanowiska) && account.stanowiska.length) return account.stanowiska.map(norm).includes(st) ? { poziom: 2, zatwierdzone: true, zrodlo: 'konto' } : { poziom: 0, zatwierdzone: true, zrodlo: 'konto' };
  if (wpis) return { poziom: Number(wpis.poziom) || 0, zatwierdzone: false, zrodlo: wpis.zrodlo || 'historia' };
  return { poziom: null, zatwierdzone: false, zrodlo: 'brak' };
}

// czy konto ma JAKIEKOLWIEK zatwierdzone dane kwalifikacji
export const maDaneKwalifikacji = (matrix, account) => (Array.isArray(account.stanowiska) && account.stanowiska.length > 0) || Object.values(((matrix || {})[account.id]) || {}).some((w) => w.zatwierdzone);

// stan danych: ile osób ma zatwierdzoną macierz, które wymagane stanowiska nie mają puli samodzielnych
export function stanDanychKwalifikacji(matrix, accounts, stanowiska = []) {
  const aktywne = (accounts || []).filter((a) => a.aktywny !== false);
  const zDanymi = aktywne.filter((a) => maDaneKwalifikacji(matrix, a));
  const pula = {};
  [...new Set((stanowiska || []).map(norm))].forEach((st) => {
    const samodzielni = aktywne.filter((a) => { const q = kwalifikacja(matrix, a, st); return q.zatwierdzone && q.poziom >= 2; });
    const wSzkoleniu = aktywne.filter((a) => { const q = kwalifikacja(matrix, a, st); return q.zatwierdzone && q.poziom === 1; });
    const propozycje = aktywne.filter((a) => { const q = kwalifikacja(matrix, a, st); return !q.zatwierdzone && q.poziom >= 1; });
    pula[st] = { samodzielni: samodzielni.length, wSzkoleniu: wSzkoleniu.length, propozycje: propozycje.length };
  });
  return { osob: aktywne.length, zDanymi: zDanymi.length, bezDanych: aktywne.filter((a) => !maDaneKwalifikacji(matrix, a)).map((a) => a.name), tryb: zDanymi.length ? (zDanymi.length === aktywne.length ? 'macierz' : 'macierz-czesciowa') : 'brak', pula, stanowiskaBezPuli: Object.entries(pula).filter(([, p]) => p.samodzielni === 0).map(([st]) => st) };
}

// propozycja wpisów z historii zmian (do zatwierdzenia jednym kliknięciem) — NIE nadpisuje zatwierdzonych
export function propozycjeZHistorii(matrix, accounts, historia, opts = {}) {
  const { minZmian = 3 } = opts;
  const out = JSON.parse(JSON.stringify(matrix || {}));
  const licz = {};
  (historia || []).forEach((s) => { if (!s.accountId || !s.station || s.rola === 'instruktor') return; const st = norm(s.station); ((licz[s.accountId] = licz[s.accountId] || {})[st] = (licz[s.accountId][st] || 0) + 1); });
  let dodane = 0;
  (accounts || []).forEach((a) => {
    Object.entries(licz[a.id] || {}).forEach(([st, n]) => {
      if (n < minZmian) return;
      const w = (out[a.id] = out[a.id] || {})[st];
      if (w && (w.zatwierdzone || w.zrodlo === 'manager')) return;
      out[a.id][st] = { poziom: 2, zatwierdzone: false, zrodlo: 'historia', zmian: n, at: new Date().toISOString() };
      dodane++;
    });
  });
  return { matrix: out, dodane };
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });
  try {
    const akcja = (req.query || {}).action || '';
    if (req.method === 'GET') {
      if (!(await requireRole(req, res, ['asm', 'kierownik']))) return;
      const [matrix, accounts] = await Promise.all([czytajMacierz(), kv.get('accounts:list')]);
      const stacje = String((req.query || {}).stations || '').split(',').map((x) => x.trim()).filter(Boolean);
      return res.json({ success: true, matrix, poziomy: POZIOMY, slownik: SLOWNIK_STANOWISK.map((s) => s.kod), stan: stanDanychKwalifikacji(matrix, accounts || [], stacje.length ? stacje : SLOWNIK_STANOWISK.map((s) => s.kod)) });
    }
    const s = await requireRole(req, res, ['asm']);
    if (!s) return;
    const matrix = await czytajMacierz();
    // PUT { accountId, station, poziom, uwagi } albo { wpisy: [{accountId, station, poziom}] } — zatwierdzone przez managera
    if (req.method === 'PUT') {
      const b = req.body || {};
      const wpisy = Array.isArray(b.wpisy) ? b.wpisy : [b];
      let n = 0;
      wpisy.forEach((w) => {
        if (!w || !w.accountId || !w.station) return;
        const st = norm(w.station); const poziom = Math.max(0, Math.min(3, Number(w.poziom) || 0));
        const m = matrix[w.accountId] = matrix[w.accountId] || {};
        if (poziom === 0 && !w.zachowajZero) { delete m[st]; m[st] = { poziom: 0, zatwierdzone: true, zrodlo: 'manager', at: new Date().toISOString(), by: s.name }; }
        else m[st] = { poziom, zatwierdzone: true, zrodlo: 'manager', uwagi: w.uwagi ? String(w.uwagi).slice(0, 120) : undefined, at: new Date().toISOString(), by: s.name };
        n++;
      });
      await kv.set(QUAL_KEY, matrix);
      await audit({ ...aktor(s), action: 'qualifications.set', after: { wpisow: n } });
      return res.json({ success: true, matrix, zapisane: n });
    }
    // POST ?action=propose — propozycje z historii (6 mies.), ?action=approve-proposals {accountId?} — zatwierdź propozycje
    if (req.method === 'POST' && akcja === 'propose') {
      const accounts = (await kv.get('accounts:list')) || [];
      const idx = (await kv.get('sched:index')) || [];
      const historia = []; for (const ym of idx.slice(-6)) { const m = await kv.get(`sched:${ym}`); if (m) historia.push(...(m.shifts || [])); }
      const { matrix: nowa, dodane } = propozycjeZHistorii(matrix, accounts, historia);
      await kv.set(QUAL_KEY, nowa);
      await audit({ ...aktor(s), action: 'qualifications.propose', after: { dodane } });
      return res.json({ success: true, matrix: nowa, dodane });
    }
    if (req.method === 'POST' && akcja === 'approve-proposals') {
      const b = req.body || {}; let n = 0;
      Object.entries(matrix).forEach(([aid, m]) => { if (b.accountId && b.accountId !== aid) return; Object.values(m).forEach((w) => { if (!w.zatwierdzone) { w.zatwierdzone = true; w.by = s.name; w.at = new Date().toISOString(); n++; } }); });
      await kv.set(QUAL_KEY, matrix);
      await audit({ ...aktor(s), action: 'qualifications.approve', after: { zatwierdzone: n } });
      return res.json({ success: true, matrix, zatwierdzone: n });
    }
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
