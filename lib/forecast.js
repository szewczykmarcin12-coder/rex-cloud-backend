// P4: prognoza dnia — dwa modele baseline (mediana dnia tygodnia × trend; hybryda poziom 7 dni × udział dnia tygodnia) z automatycznym wyborem po backteście,
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

// ── Dwa modele baseline (deterministyczne) i automatyczny wybór po backteście ──
// 1) MEDIANA: mediana sprzedaży tego samego dnia tygodnia z ostatnich `oknoTyg` tygodni PRZED datą × tłumiony trend 4-tyg. (0,85–1,15).
//    Odporna na pojedyncze promocje, ale reaguje z opóźnieniem na zmianę poziomu (np. sierpień → wrzesień −17 %).
// 2) HYBRYDA: poziom = suma ostatnich 7 zamkniętych dni (z winsoryzacją pojedynczych anomalii) × udział dnia tygodnia
//    (średnia z do 4 pełnych tygodni). Szybko podąża za sezonem; kształt tygodnia bierze ze stabilnych udziałów.
// Backtest liczy oba na ostatnich 28 zamkniętych dniach wyłącznie z danych sprzed dnia; wygrywa niższy MAPE.
const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dowOf = (dateStr) => new Date(dateStr + 'T00:00:00Z').getUTCDay();
const val = (sales, k) => (sales[k] != null && Number.isFinite(Number(sales[k])) ? Number(sales[k]) : null);

export function baselineMediana(sales, dateStr, oknoTyg = 8, asOf = null) {
  if (!dataOk(dateStr)) return null;
  const granica = asOf || addDays(dateStr, -1);                       // tylko dane do `asOf` włącznie
  const vals = [];
  for (let w = 1; w <= oknoTyg; w++) { const k = addDays(dateStr, -7 * w); if (k > granica) continue; const v = val(sales, k); if (v != null) vals.push(v); }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const med = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
  let s1 = 0, n1 = 0, s2 = 0, n2 = 0;
  for (let i = 1; i <= 28; i++) { const k = addDays(dateStr, -i); if (k > granica) continue; const v = val(sales, k); if (v != null) { s1 += v; n1++; } }
  for (let i = 29; i <= 56; i++) { const k = addDays(dateStr, -i); if (k > granica) continue; const v = val(sales, k); if (v != null) { s2 += v; n2++; } }
  let trend = 1;
  if (n1 >= 14 && n2 >= 14 && s2 > 0) trend = Math.max(0.85, Math.min(1.15, (s1 / n1) / (s2 / n2)));
  return Math.round(med * trend);
}

// ostatni dzień z danymi nie późniejszy niż `granica` (prognoza „na żywo” bierze najświeższy zamknięty dzień)
export function ostatniDzienZDanymi(sales, granica) {
  let best = null;
  for (const k of Object.keys(sales)) { if (k <= granica && val(sales, k) != null && (!best || k > best)) best = k; }
  return best;
}

export function baselineHybryda(sales, dateStr, asOf = null) {
  if (!dataOk(dateStr)) return null;
  const koniec = ostatniDzienZDanymi(sales, asOf || addDays(dateStr, -1));
  if (!koniec) return null;
  // udziały dnia tygodnia z pełnych tygodni kończących się na `koniec`, koniec-7, … (max 4)
  const udzialy = {};  // dow -> [udział…]
  const tygodnie = [];
  for (let w = 0; w < 4; w++) {
    const dni = Array.from({ length: 7 }, (_, i) => addDays(koniec, -i - 7 * w));
    if (dni.some((k) => val(sales, k) == null)) continue;
    const suma = dni.reduce((a, k) => a + val(sales, k), 0); if (suma <= 0) continue;
    dni.forEach((k) => { (udzialy[dowOf(k)] = udzialy[dowOf(k)] || []).push(val(sales, k) / suma); });
    tygodnie.push(dni);
  }
  if (!tygodnie.length) return null;
  const udzialDow = (dw) => { const u = udzialy[dw] || []; return u.length ? u.reduce((a, x) => a + x, 0) / u.length : null; };
  // poziom: ostatnie 7 dni; pojedyncza anomalia (odchylenie > 35 % od oczekiwanego udziału × suma tygodnia) jest przycinana
  const ost = tygodnie[0]; const sumaOst = ost.reduce((a, k) => a + val(sales, k), 0);
  let poziom = 0;
  ost.forEach((k) => { const v = val(sales, k); const uk = Math.min(0.5, udzialDow(dowOf(k)) || 1 / 7); const ocz = uk * (sumaOst - v) / (1 - uk); const lim = 0.35; poziom += Math.max(ocz * (1 - lim), Math.min(ocz * (1 + lim), v)); });   // oczekiwana wartość dnia liczona bez niego samego
  const u = udzialDow(dowOf(dateStr)); if (u == null) return null;
  return Math.round(poziom * u);
}

// backtest obu modeli na zakończonych dniach (prognoza liczona WYŁĄCZNIE z danych sprzed dnia) + wybór
export function backtestModeli(sales, dni = 28, dzis = null) {
  const wyn = { mediana: [], hybryda: [] };
  let d = addDays(dzis || new Date().toISOString().slice(0, 10), -1);
  for (let i = 0; i < dni; i++) {
    const a = val(sales, d);
    if (a != null && a > 0) {
      const fm = baselineMediana(sales, d); const fh = baselineHybryda(sales, d);
      if (fm != null) wyn.mediana.push({ date: d, f: fm, a }); if (fh != null) wyn.hybryda.push({ date: d, f: fh, a });
    }
    d = addDays(d, -1);
  }
  const miary = (w) => { if (!w.length) return { dni: 0, mape: null, wape: null }; const mape = w.reduce((x, r) => x + Math.abs(r.f - r.a) / r.a, 0) / w.length * 100; const wape = w.reduce((x, r) => x + Math.abs(r.f - r.a), 0) / w.reduce((x, r) => x + r.a, 0) * 100; return { dni: w.length, mape: Math.round(mape * 10) / 10, wape: Math.round(wape * 10) / 10 }; };
  const m = miary(wyn.mediana), h = miary(wyn.hybryda);
  // wybór: hybryda, jeśli ma ≥ 14 dni backtestu i nie jest gorsza; inaczej mediana (bezpieczny domyślny)
  const wybrany = h.dni >= 14 && m.mape != null && h.mape != null ? (h.mape <= m.mape ? 'hybryda' : 'mediana') : (h.dni >= 14 && m.mape == null ? 'hybryda' : 'mediana');
  return { wybrany, mediana: m, hybryda: h, okno: dni };
}
// zgodność wstecz: backtest wybranego modelu
export function backtest(sales, dni = 28) { const b = backtestModeli(sales, dni); return { ...b[b.wybrany], model: b.wybrany }; }
export function baselineFor(sales, dateStr, oknoTyg = 8, model = null) {
  const m = model || backtestModeli(sales).wybrany;
  const h = m === 'hybryda' ? baselineHybryda(sales, dateStr) : null;
  return h != null ? h : baselineMediana(sales, dateStr, oknoTyg);
}

// świeżość danych POS: rytm tygodniowy (import we wtorek z ostatnich 8 tygodni)
export function swiezoscDanych(salesData, dzis = null) {
  const today = dzis || new Date().toISOString().slice(0, 10);
  const sales = (salesData && salesData.sales) || {};
  const ostatni = ostatniDzienZDanymi(sales, today);
  const dniOd = ostatni ? Math.round((Date.parse(today) - Date.parse(ostatni)) / 86400000) : null;
  const dw = dowOf(today); const doWtorku = (2 - dw + 7) % 7 || 7;
  const nastepnyWtorek = addDays(today, doWtorku);
  // we wtorek import obejmuje dni do poniedziałku włącznie → najstarszy akceptowalny „ostatni dzień” to 8 dni wstecz (+1 dzień luzu)
  const przeterminowane = ostatni == null || dniOd > 9;
  const okno8 = ostatni ? [addDays(ostatni, -55), ostatni] : null;
  const importedAt = salesData && salesData.meta && salesData.meta.importedAt ? salesData.meta.importedAt : null;
  return { ostatniDzien: ostatni, dniOdOstatniego: dniOd, importedAt, basis: salesData && salesData.meta ? salesData.meta.basis || null : null, nastepnyImport: nastepnyWtorek, rytm: 'wtorek, ostatnie 8 tygodni', przeterminowane, okno8, dniWBazie: Object.keys(sales).length };
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
      const modele = backtestModeli(sales);
      const { czytajZdarzenia, mnoznikZdarzen } = await import('./month-plan.js');
      const zdarzenia = await czytajZdarzenia();
      const days = [];
      const d = new Date(from);
      for (let i = 0; i < n; i++) {
        const k = dstr(d);
        const baselineMed = baselineMediana(sales, k), baselineHyb = baselineHybryda(sales, k);
        const bazowy = modele.wybrany === 'hybryda' && baselineHyb != null ? baselineHyb : baselineMed;
        const z = mnoznikZdarzen(zdarzenia, k);
        const baseline = bazowy != null ? Math.round(bazowy * z.factor) : null;      // zdarzenia znane z wyprzedzeniem (promocja, zamknięcie) nakładane na model
        const ov = overrides[k] || null;
        days.push({ date: k, dow: d.getDay(), baseline, baselineModel: bazowy, baselineMediana: baselineMed, baselineHybryda: baselineHyb, events: z.events, eventFactor: z.factor, override: ov, forecast: ov ? ov.value : baseline, actual: sales[k] != null ? Number(sales[k]) : null });
        d.setDate(d.getDate() + 1);
      }
      return res.json({ success: true, days, backtest: { ...modele[modele.wybrany], model: modele.wybrany }, modele, dane: swiezoscDanych(salesData), oknoTyg: 8 });
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
