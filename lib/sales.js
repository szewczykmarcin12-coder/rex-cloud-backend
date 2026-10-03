import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit, aktor } from './audit.js';

// Dane sprzedażowe + parametry optymalizatora. Klucz sales:data:
//   { sales: { 'YYYY-MM-DD': gross }, checks: { 'YYYY-MM-DD': n }, params: {...} }
const KEY = 'sales:data';
const EMPTY = { sales: {}, checks: {}, salesGross: {}, params: null, meta: null, hourly: {}, intraday: null };
// Podstawa sprzedaży: `sales` = NETTO (Sales Net VAT) — jak „Planowana sprzedaż netto” w prognozie miesiąca i COL.
// `salesGross` = brutto po rabatach (informacyjnie). meta.basis mówi, co zaimportowano ostatnio.

// ── Profil śróddzienny z raportu Daily Operations: { source, from, to, location, slots: { 'HH:MM': { sales, checks } } } ──
const SLOT_RE = /^([01]\d|2[0-3]):(00|15|30|45)$/;
const walidujIntraday = (x) => {
  if (!x || typeof x !== 'object' || !x.slots || typeof x.slots !== 'object') return null;
  const slots = {};
  Object.entries(x.slots).forEach(([k, v]) => { if (!SLOT_RE.test(k)) return; const sales = Number((v || {}).sales), checks = Number((v || {}).checks); if (!Number.isFinite(sales) || sales < 0) return; slots[k] = { sales: Math.round(sales * 100) / 100, checks: Number.isFinite(checks) && checks >= 0 ? Math.round(checks) : 0 }; });
  if (Object.keys(slots).length < 8) return null;
  const okDate = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
  return { source: String(x.source || 'daily-operations').slice(0, 40), from: okDate(x.from), to: okDate(x.to), location: x.location ? String(x.location).slice(0, 80) : null, slots, importedAt: new Date().toISOString() };
};
// 96 slotów po 15 min od 06:00 (udziały sprzedaży i paragonów) + profil godzinowy — dla P5, autoplanu i obsady
export function profilSrodDzienny(intraday) {
  if (!intraday || !intraday.slots) return null;
  const pad = (n) => String(n).padStart(2, '0');
  let sumS = 0, sumC = 0; Object.values(intraday.slots).forEach((v) => { sumS += v.sales || 0; sumC += v.checks || 0; });
  if (!sumS) return null;
  const weights96 = [], checks96 = [], hourly = {};
  for (let i = 0; i < 96; i++) { const min = (6 * 60 + i * 15) % 1440; const k = `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; const v = intraday.slots[k] || { sales: 0, checks: 0 }; weights96.push(v.sales / sumS); checks96.push(sumC ? v.checks / sumC : v.sales / sumS); const h = k.slice(0, 2); hourly[h] = (hourly[h] || 0) + v.sales / sumS; }
  for (let h = 0; h < 24; h++) hourly[pad(h)] = hourly[pad(h)] || 0;
  const hourlyDow = {}; for (let d = 0; d < 7; d++) hourlyDow[String(d)] = hourly;
  return { weights96, checks96, hourly, hourlyDow, source: intraday.source, from: intraday.from, to: intraday.to, days: intraday.from && intraday.to ? Math.round((Date.parse(intraday.to) - Date.parse(intraday.from)) / 86400000) + 1 : null };
}

// Sprzedaż godzinowa: hourly = { 'YYYY-MM-DD': { 'HH': { sales, trx } } }.
// Profil dnia tygodnia = średni udział godziny w sprzedaży dnia z ostatnich 8 tygodni (max 56 dni z danymi).
export function profilGodzinowy(hourly) {
  const dni = Object.keys(hourly || {}).sort().slice(-56);
  const akum = {};   // dow -> hour -> [sumShare, n]
  dni.forEach((d) => {
    const godz = hourly[d] || {};
    const suma = Object.values(godz).reduce((a, x) => a + (Number((x || {}).sales) || 0), 0);
    if (!suma) return;
    const [y, m, dd] = d.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
    akum[dow] = akum[dow] || {};
    Object.entries(godz).forEach(([h, x]) => { const k = String(Number(h)).padStart(2, '0'); const share = (Number((x || {}).sales) || 0) / suma; const c = akum[dow][k] || [0, 0]; c[0] += share; c[1] += 1; akum[dow][k] = c; });
  });
  const out = {};
  Object.entries(akum).forEach(([dow, godz]) => { out[dow] = {}; Object.entries(godz).forEach(([h, [sum, n]]) => { out[dow][h] = n ? sum / n : 0; }); });
  return { profil: out, dniZDanymi: dni.length };
}

const walidujHourly = (hourly) => {
  if (!hourly || typeof hourly !== 'object' || Array.isArray(hourly)) return {};
  const out = {};
  Object.entries(hourly).forEach(([d, godz]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !godz || typeof godz !== 'object') return;
    const dzien = {};
    Object.entries(godz).forEach(([h, x]) => {
      const hh = Number(h); if (!Number.isInteger(hh) || hh < 0 || hh > 23) return;
      const sales = Number((x || {}).sales), trx = Number((x || {}).trx);
      if (!Number.isFinite(sales) || sales < 0 || sales > 1e7) return;
      dzien[String(hh).padStart(2, '0')] = { sales: Math.round(sales * 100) / 100, trx: Number.isFinite(trx) && trx >= 0 ? Math.round(trx) : 0 };
    });
    if (Object.keys(dzien).length) out[d] = dzien;
  });
  return out;
};

// P4: raport braków — dni bez sprzedaży w ostatnich 30 zakończonych dobach
function raportBrakow(sales) {
  const braki = [];
  const d = new Date(); d.setDate(d.getDate() - 1);
  for (let i = 0; i < 30; i++) {
    const k = d.toISOString().slice(0, 10);
    if (sales[k] == null) braki.push(k);
    d.setDate(d.getDate() - 1);
  }
  return braki.reverse();
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });

  try {
    if (req.method === 'GET') {
      if (!(await requireRole(req, res, ['asm', 'kierownik']))) return;
      const d = (await kv.get(KEY)) || EMPTY;
      const prof = profilGodzinowy(d.hourly || {});
      const sd = profilSrodDzienny(d.intraday);
      // profil godzinowy per dzień tygodnia: z importu godzinowego; gdy go nie ma — zmierzony profil śróddzienny (ten sam dla każdego dnia)
      const maGodz = Object.keys(prof.profil || {}).length > 0;
      return res.json({ success: true, sales: d.sales || {}, checks: d.checks || {}, salesGross: d.salesGross || {}, params: d.params || null, meta: d.meta || null, braki: raportBrakow(d.sales || {}), hourly: d.hourly || {},
        hourlyProfile: maGodz ? prof.profil : (sd ? sd.hourlyDow : {}), hourlyDays: prof.dniZDanymi, hourlyProfileSource: maGodz ? 'hourly' : (sd ? 'intraday' : null),
        intraday: d.intraday ? { source: d.intraday.source, from: d.intraday.from, to: d.intraday.to, location: d.intraday.location, importedAt: d.intraday.importedAt, slots: d.intraday.slots } : null, intradayProfile: sd ? { weights96: sd.weights96, checks96: sd.checks96, hourly: sd.hourly, from: sd.from, to: sd.to, days: sd.days } : null });
    }

    if (req.method === 'PUT') {
      const s = await requireRole(req, res, ['asm']);
      if (!s) return;
      const { sales, checks, params, source, salesGross, basis } = req.body || {};
      const hourlyNowe = walidujHourly((req.body || {}).hourly);
      const intradayNowy = walidujIntraday((req.body || {}).intraday);
      if ((req.body || {}).intraday && !intradayNowy) return res.status(400).json({ success: false, error: 'Profil śróddzienny: oczekiwano slots { "HH:MM": { sales, checks } } (co 15 min, co najmniej 8 slotów)' });
      const cur = (await kv.get(KEY)) || EMPTY;
      const noweDni = sales && typeof sales === 'object' && !Array.isArray(sales) ? Object.keys(sales).length : 0;
      const next = {
        sales: sales && typeof sales === 'object' && !Array.isArray(sales) ? { ...(cur.sales || {}), ...sales } : (cur.sales || {}),
        checks: checks && typeof checks === 'object' && !Array.isArray(checks) ? { ...(cur.checks || {}), ...checks } : (cur.checks || {}),
        params: params && typeof params === 'object' && !Array.isArray(params) ? params : (cur.params || null),
        salesGross: salesGross && typeof salesGross === 'object' && !Array.isArray(salesGross) ? { ...(cur.salesGross || {}), ...salesGross } : (cur.salesGross || {}),
        hourly: Object.keys(hourlyNowe).length ? { ...(cur.hourly || {}), ...hourlyNowe } : (cur.hourly || {}),
        intraday: intradayNowy || cur.intraday || null,
        // P4: wersja i świeżość danych sprzedażowych — Excel pozostaje trybem awaryjnym do czasu POS
        meta: noweDni ? { wersja: ((cur.meta && cur.meta.wersja) || 0) + 1, importedAt: new Date().toISOString(), source: source || 'excel', importedBy: s.name, dniWImporcie: noweDni, basis: basis === 'gross' ? 'gross' : (basis === 'net' ? 'net' : ((cur.meta && cur.meta.basis) || null)) } : (cur.meta || null),
      };
      // sprzedaż godzinowa uzupełnia sumy dzienne (jeśli dzień nie ma wartości dziennej)
      Object.entries(hourlyNowe).forEach(([d, godz]) => { if (next.sales[d] == null) next.sales[d] = Math.round(Object.values(godz).reduce((a, x) => a + x.sales, 0) * 100) / 100; if (next.checks[d] == null) { const t = Object.values(godz).reduce((a, x) => a + (x.trx || 0), 0); if (t) next.checks[d] = t; } });
      await kv.set(KEY, next);
      if (Object.keys(hourlyNowe).length) await audit({ ...aktor(s), action: 'sales.import-hourly', target: `${Object.keys(hourlyNowe).length} dni`, after: { dni: Object.keys(hourlyNowe).length, source: source || 'csv' } });
      if (noweDni) await audit({ ...aktor(s), action: 'sales.import', target: `wersja ${next.meta.wersja}`, after: { dni: noweDni, source: next.meta.source, basis: next.meta.basis } });
      if (intradayNowy) await audit({ ...aktor(s), action: 'sales.import-intraday', target: `${intradayNowy.from || '?'} – ${intradayNowy.to || '?'}`, after: { sloty: Object.keys(intradayNowy.slots).length, source: intradayNowy.source } });
      return res.json({ success: true, dni: Object.keys(next.sales).length, meta: next.meta, braki: raportBrakow(next.sales), intraday: !!next.intraday });
    }

    if (req.method === 'DELETE') {
      if (!(await requireRole(req, res, ['asm']))) return;
      await kv.set(KEY, EMPTY);
      return res.json({ success: true });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
