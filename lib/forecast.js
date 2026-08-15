// P4: prognoza dnia — baseline sezonowy (mediana dnia tygodnia × tłumiony trend),
// ręczne korekty z UZASADNIENIEM (audytowalne) i pomiar błędu MAPE/WAPE (backtest).
// Model jest deterministyczny: te same dane → ta sama prognoza (kryterium odbioru P4).
// forecast:overrides = { 'YYYY-MM-DD': { value, reason, by, at } }
import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit, aktor } from './audit.js';

const OKEY = 'forecast:overrides';
const dstr = (d) => d.toISOString().slice(0, 10);
// P4-11: walidacja prawdziwym parserem kalendarzowym — '2026-99-99' NIE przechodzi
const dataOk = (x) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x || ''))) return false; try { const d = new Date(x + 'T00:00:00Z'); return d.toISOString().slice(0, 10) === x; } catch { return false; } };
const MAX_PROGNOZA = 5000000;

// baseline dla dnia: mediana sprzedaży tego samego dnia tygodnia z ostatnich `oknoTyg`
// tygodni PRZED datą × tłumiony trend 4-tygodniowy (0,85–1,15)
export function baselineFor(sales, dateStr, oknoTyg = 8) {
  if (!dataOk(dateStr)) return null;
  const target = new Date(dateStr);
  const vals = [];
  for (let w = 1; w <= oknoTyg; w++) {
    const d = new Date(target); d.setDate(d.getDate() - 7 * w);
    const v = sales[dstr(d)];
    if (v != null) vals.push(Number(v));
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const med = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
  let s1 = 0, n1 = 0, s2 = 0, n2 = 0;
  for (let i = 1; i <= 28; i++) { const d = new Date(target); d.setDate(d.getDate() - i); const v = sales[dstr(d)]; if (v != null) { s1 += Number(v); n1++; } }
  for (let i = 29; i <= 56; i++) { const d = new Date(target); d.setDate(d.getDate() - i); const v = sales[dstr(d)]; if (v != null) { s2 += Number(v); n2++; } }
  let trend = 1;
  if (n1 >= 14 && n2 >= 14 && s2 > 0) trend = Math.max(0.85, Math.min(1.15, (s1 / n1) / (s2 / n2)));
  return Math.round(med * trend);
}

// backtest na zakończonych dniach: prognoza liczona WYŁĄCZNIE z danych sprzed dnia
export function backtest(sales, dni = 28) {
  const wyniki = [];
  const d = new Date(); d.setDate(d.getDate() - 1);
  for (let i = 0; i < dni; i++) {
    const k = dstr(d);
    const a = sales[k];
    if (a != null && Number(a) > 0) {
      const f = baselineFor(sales, k);
      if (f != null) wyniki.push({ date: k, f, a: Number(a) });
    }
    d.setDate(d.getDate() - 1);
  }
  if (!wyniki.length) return { dni: 0, mape: null, wape: null };
  const mape = wyniki.reduce((x, w) => x + Math.abs(w.f - w.a) / w.a, 0) / wyniki.length * 100;
  const wape = wyniki.reduce((x, w) => x + Math.abs(w.f - w.a), 0) / wyniki.reduce((x, w) => x + w.a, 0) * 100;
  return { dni: wyniki.length, mape: Math.round(mape * 10) / 10, wape: Math.round(wape * 10) / 10 };
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });

  try {
    const sesja = await requireRole(req, res, ['asm', 'kierownik']);
    if (!sesja) return;
    const salesData = (await kv.get('sales:data')) || {};
    const sales = salesData.sales || {};
    const overrides = (await kv.get(OKEY)) || {};

    if (req.method === 'GET') {
      const from = dataOk(req.query.from) ? req.query.from : dstr(new Date());
      const n = Math.min(Number(req.query.days) || 14, 60);
      const days = [];
      const d = new Date(from);
      for (let i = 0; i < n; i++) {
        const k = dstr(d);
        const baseline = baselineFor(sales, k);
        const ov = overrides[k] || null;
        days.push({ date: k, dow: d.getDay(), baseline, override: ov, forecast: ov ? ov.value : baseline, actual: sales[k] != null ? Number(sales[k]) : null });
        d.setDate(d.getDate() + 1);
      }
      return res.json({ success: true, days, backtest: backtest(sales), oknoTyg: 8 });
    }

    // korekta ręczna — wymaga uzasadnienia; value=null usuwa korektę (tylko ASM)
    if (req.method === 'POST' && (req.query.action === 'override')) {
      if (sesja.role !== 'asm') return res.status(403).json({ success: false, error: 'Korekta prognozy wymaga uprawnień ASM.' });
      const { date, value, reason } = req.body || {};
      if (!dataOk(date)) return res.status(400).json({ success: false, error: 'Nieprawidłowa data korekty (kalendarzowa YYYY-MM-DD).' });
      if (value == null || value === '') {
        const przed = overrides[date];
        delete overrides[date];
        await kv.set(OKEY, overrides);
        await audit({ ...aktor(sesja), action: 'forecast.override-clear', target: date, before: przed || null });
        return res.json({ success: true, date, override: null });
      }
      const v = Number(value);
      if (!Number.isFinite(v) || v < 0 || v > MAX_PROGNOZA) return res.status(400).json({ success: false, error: `Wartość prognozy musi być skończoną liczbą 0-${MAX_PROGNOZA.toLocaleString('pl-PL')} zł.` });
      const powod = String(reason || '').trim();
      if (powod.length < 3 || powod.length > 200) return res.status(400).json({ success: false, error: 'Korekta wymaga uzasadnienia (3-200 znaków).' });
      const przed = overrides[date] || null;
      overrides[date] = { value: Math.round(v), reason: powod, by: sesja.name, at: new Date().toISOString() };
      await kv.set(OKEY, overrides);
      await audit({ ...aktor(sesja), action: 'forecast.override', target: date, before: przed, after: overrides[date] });
      return res.json({ success: true, date, override: overrides[date] });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
