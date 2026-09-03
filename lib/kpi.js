import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit } from './audit.js';
import { ocenZgodnosc } from './compliance.js';

// ═══════════ Snapshoty KPI dnia (Vercel Cron) ═══════════
// /api/kpi-nightly  — zadanie nocne (Vercel Cron: Authorization: Bearer CRON_SECRET) lub ręcznie przez ASM.
// /api/kpi?days=90  — odczyt snapshotów do Analityki (bez przeliczania całej historii w kliencie).
// Klucze: kpi:daily:YYYY-MM-DD, indeks kpi:index (posortowana lista dat, max 400).

const INDEX = 'kpi:index';
const mn = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const dur = (a, b) => { let d = mn(b) - mn(a); if (d <= 0) d += 1440; return d; };
const kosztGodzin = (k, h) => !k ? 0 : (k.umowa === 'UOP' ? ((Number(k.stawka) || 0) / 160) * h : (Number(k.stawka) || 0) * h);
const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

export async function snapshotDnia(date) {
  const ym = date.slice(0, 7);
  const [mies, konta, ts, sd] = await Promise.all([kv.get(`sched:${ym}`), kv.get('accounts:list'), kv.get('ts:data'), kv.get('sales:data')]);
  const accounts = konta || [];
  const poId = new Map(accounts.map((a) => [a.id, a]));
  const poNaz = new Map(accounts.flatMap((a) => [a.grafikName, a.name, ...(a.aliasy || [])].filter(Boolean).map((n) => [norm(n), a])));
  const kontoZ = (s) => poId.get(s.accountId) || poNaz.get(norm(s.name)) || null;
  const zm = ((mies && mies.shifts) || []).filter((s) => s.date === date && s.rola !== 'instruktor');
  let planMin = 0, kosztPlan = 0, actMin = 0, kosztAct = 0, zOdbiciem = 0;
  const actuals = (ts && ts.actuals) || {};
  zm.forEach((s) => {
    const d = dur(s.start, s.end); planMin += d; kosztPlan += kosztGodzin(kontoZ(s), d / 60);
    const a = actuals[s.sid ? `sid:${s.sid}` : `${s.name}|${s.date}|${s.station}|${s.start}|${s.end}`];
    if (a && a.start && a.end) { const da = dur(a.start, a.end); actMin += da; kosztAct += kosztGodzin(kontoZ(s), da / 60); zOdbiciem++; }
  });
  const sprzedaz = Number(((sd && sd.sales) || {})[date]) || 0;
  const transakcje = Number(((sd && sd.checks) || {})[date]) || 0;
  const zg = ocenZgodnosc((mies && mies.shifts) || [], accounts, { from: date, to: date });
  const snap = {
    date, zmian: zm.length, osob: new Set(zm.map((s) => (kontoZ(s) || {}).id || norm(s.name))).size,
    planH: Math.round(planMin / 6) / 10, actualH: Math.round(actMin / 6) / 10, zOdbiciem,
    kosztPlan: Math.round(kosztPlan), kosztActual: Math.round(kosztAct),
    sprzedaz, transakcje,
    colPlan: sprzedaz ? Math.round(kosztPlan / sprzedaz * 1000) / 10 : null,
    colActual: sprzedaz && actMin ? Math.round(kosztAct / sprzedaz * 1000) / 10 : null,
    splh: planMin ? Math.round(sprzedaz / (planMin / 60)) : null,
    naruszenia: zg.summary,
    completed: !!(((ts && ts.completed) || {})[date]),
    generatedAt: new Date().toISOString(),
  };
  await kv.set(`kpi:daily:${date}`, snap);
  const idx = new Set((await kv.get(INDEX)) || []); idx.add(date);
  const lista = [...idx].sort().slice(-400);
  await kv.set(INDEX, lista);
  return snap;
}

const wczoraj = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });
  try {
    const nightly = String(req.url || '').includes('kpi-nightly') || (req.query && req.query.job === 'nightly');
    if (nightly) {
      // autoryzacja: Vercel Cron (CRON_SECRET) albo sesja ASM (uruchomienie ręczne)
      const auth = String((req.headers || {}).authorization || '');
      const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
      let s = null;
      if (!cronOk) { s = await requireRole(req, res, ['asm']); if (!s) return; }
      const dni = [];
      const ile = Math.min(31, Math.max(1, Number((req.query || {}).days) || 1));
      const koniec = (req.query || {}).date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : wczoraj();
      const d0 = new Date(koniec + 'T00:00:00Z');
      for (let i = ile - 1; i >= 0; i--) { const d = new Date(d0); d.setUTCDate(d.getUTCDate() - i); dni.push(d.toISOString().slice(0, 10)); }
      const wyniki = [];
      for (const d of dni) wyniki.push(await snapshotDnia(d));
      await audit({ actor: s ? s.name : 'cron', role: s ? s.role : 'system', action: 'kpi.snapshot', target: `${dni[0]}..${dni[dni.length - 1]}`, after: { dni: dni.length, tryb: cronOk ? 'cron' : 'manual' } });
      return res.json({ success: true, dni: dni.length, snapshoty: wyniki });
    }

    if (req.method === 'GET') {
      if (!(await requireRole(req, res, ['asm', 'kierownik']))) return;
      const days = Math.min(400, Math.max(1, Number((req.query || {}).days) || 90));
      const idx = ((await kv.get(INDEX)) || []).slice(-days);
      const snaps = [];
      for (const d of idx) { const s = await kv.get(`kpi:daily:${d}`); if (s) snaps.push(s); }
      return res.json({ success: true, snapshots: snaps, cronSkonfigurowany: Boolean(process.env.CRON_SECRET) });
    }
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
