// ═══════════════════════════════════════════════════════════════════════════════
//  Plan miesiąca — JEDNO źródło sprzedaży i transakcji miesiąca dla całego systemu.
//  „Jest 20 września, planuję październik”: propozycja totalu z historii POS (poziom ostatnich tygodni ×
//  skład kalendarza miesiąca × tłumiony trend), ręczna korekta z uzasadnieniem, zatwierdzenie z wersją.
//  Zatwierdzony plan zasila: Rozkład miesiąca i COL (P5), Automatyczne układanie (AOP), Zapotrzebowanie i obsadę.
//  Limit godzin AOP: hoursAop (godziny total z AOP — twardy limit miesiąca) i crewHours (opcjonalnie: część CREW).
//  Klucz: monthplan:YYYY-MM = { month, version, status: DRAFT|APPROVED, sales, transactions, hoursAop, crewHours, source, reason,
//                               proposal (migawka), by, at, approvedAt, approvedBy, history: [...] }
//  Wspólne parametry planowania (SPLH, MPT, podłoga, koszt pośredni): klucz params:planning.
// ═══════════════════════════════════════════════════════════════════════════════
import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit, aktor } from './audit.js';
import { ostatniDzienZDanymi } from './forecast.js';

const keyFor = (m) => `monthplan:${m}`;
const PARAMS_KEY = 'params:planning';
export const PARAMS_DOMYSLNE = { splh: 420, mpt: 4, podloga: 3, indirectPct: 0.12, colTargetPct: 20, yoyWeight: 0.3 };
const validMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const pad2 = (n) => String(n).padStart(2, '0');
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dowOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const r0 = (v) => Math.round(v);
const r2 = (v) => Math.round(v * 100) / 100;
const monthDates = (m) => { const [y, mm] = m.split('-').map(Number); const n = new Date(Date.UTC(y, mm, 0)).getUTCDate(); return Array.from({ length: n }, (_, i) => `${m}-${pad2(i + 1)}`); };

export async function czytajParametry() { return { ...PARAMS_DOMYSLNE, ...((await kv.get(PARAMS_KEY)) || {}) }; }

// ── Kalendarz zdarzeń: promocje, zamknięcia, eventy, święta — znane z wyprzedzeniem, z wpływem w % na sprzedaż dnia ──
// events:list = [{ id, name, typ: promo|closure|event|holiday|other, from, to, upliftPct, note, by, at }]
export const EVENTS_KEY = 'events:list';
const EVENT_TYPY = ['promo', 'closure', 'event', 'holiday', 'other'];
const okDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z'));
export function normalizujZdarzenie(b, przed = {}) {
  const typ = EVENT_TYPY.includes(b.typ) ? b.typ : (przed.typ || 'other');
  const from = okDate(b.from) ? b.from : przed.from, to = okDate(b.to) ? b.to : (przed.to || from);
  if (!from || !to || to < from) return { error: 'Zakres dat zdarzenia: od ≤ do, format YYYY-MM-DD.' };
  if (Date.parse(to) - Date.parse(from) > 120 * 86400000) return { error: 'Zdarzenie nie może trwać dłużej niż 120 dni.' };
  const name = String(b.name == null ? przed.name || '' : b.name).trim().slice(0, 80);
  if (name.length < 2) return { error: 'Nazwa zdarzenia (min. 2 znaki).' };
  let uplift = typ === 'closure' ? -100 : Number(b.upliftPct == null ? przed.upliftPct : b.upliftPct);
  if (!Number.isFinite(uplift) || uplift < -100 || uplift > 300) return { error: 'Wpływ w procentach: od −100 (zamknięte) do +300.' };
  return { value: { id: przed.id || `ev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, typ, from, to, upliftPct: Math.round(uplift * 10) / 10, note: String(b.note == null ? przed.note || '' : b.note).trim().slice(0, 300) } };
}
// mnożnik dnia z wszystkich zdarzeń obejmujących datę (sumujemy procenty, zamknięcie = 0)
export function mnoznikZdarzen(events, date) {
  const akt = (events || []).filter((e) => e.from <= date && date <= e.to);
  if (!akt.length) return { factor: 1, events: [] };
  if (akt.some((e) => e.typ === 'closure' || e.upliftPct <= -100)) return { factor: 0, events: akt.map((e) => e.name) };
  const suma = akt.reduce((a, e) => a + (Number(e.upliftPct) || 0), 0);
  return { factor: Math.max(0, 1 + suma / 100), events: akt.map((e) => e.name) };
}
export async function czytajZdarzenia() { return (await kv.get(EVENTS_KEY)) || []; }

// ── Indeks sezonowy 12 miesięcy: punkt startu dla QSR w galerii handlowej (PL), edycja ręczna, uczenie z zamkniętych miesięcy ──
// params:season = { manual: { '1'..'12': factor|null } }  — wartości ręczne nadpisują; wyuczone liczymy z historii na bieżąco
export const SEASON_KEY = 'params:season';
export const SEZON_DOMYSLNY = { 1: 0.90, 2: 0.90, 3: 0.97, 4: 0.99, 5: 1.02, 6: 1.02, 7: 1.06, 8: 1.10, 9: 0.96, 10: 1.00, 11: 1.00, 12: 1.08 };
// wyuczony indeks: średnia dzienna miesiąca / średnia dzienna wszystkich kompletnych miesięcy w historii (normalizowana do średniej 1)
export function wyuczonyIndeks(sales) {
  const mies = {};
  Object.entries(sales || {}).forEach(([d, v]) => { const m = d.slice(0, 7); (mies[m] = mies[m] || { suma: 0, dni: 0 }); mies[m].suma += Number(v) || 0; mies[m].dni++; });
  const pelne = Object.entries(mies).filter(([m, x]) => x.dni === monthDates(m).length && x.suma > 0).map(([m, x]) => ({ m, avg: x.suma / x.dni }));
  if (pelne.length < 2) return { idx: {}, n: {}, miesiecy: pelne.length };
  const sr = pelne.reduce((a, x) => a + x.avg, 0) / pelne.length;
  const idx = {}, n = {};
  pelne.forEach((x) => { const k = String(Number(x.m.slice(5, 7))); (idx[k] = idx[k] || []).push(x.avg / sr); });
  Object.keys(idx).forEach((k) => { n[k] = idx[k].length; idx[k] = idx[k].reduce((a, v) => a + v, 0) / idx[k].length; });
  return { idx, n, miesiecy: pelne.length };
}
// indeks efektywny per miesiąc: ręczny > wyuczony (ważony liczbą obserwacji: n/(n+2)) zmieszany z domyślnym
export function indeksSezonowy(sales, manual = {}) {
  const w = wyuczonyIndeks(sales);
  const out = {};
  for (let m = 1; m <= 12; m++) {
    const k = String(m); const man = manual && manual[k] != null && Number.isFinite(Number(manual[k])) ? Number(manual[k]) : null;
    const prior = SEZON_DOMYSLNY[m]; const n = w.n[k] || 0; const learned = w.idx[k];
    const auto = n ? (learned * (n / (n + 2)) + prior * (2 / (n + 2))) : prior;
    out[k] = { factor: Math.round((man != null ? man : auto) * 1000) / 1000, zrodlo: man != null ? 'manual' : (n ? 'learned' : 'default'), learned: n ? Math.round(learned * 1000) / 1000 : null, n, prior };
  }
  return { idx: out, miesiecyHistorii: w.miesiecy };
}
export async function czytajSezon() { return (await kv.get(SEASON_KEY)) || { manual: {} }; }
export function normalizujParametry(b = {}, przed = PARAMS_DOMYSLNE) {
  const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : d);
  return { splh: clamp(b.splh, 50, 5000, przed.splh), mpt: clamp(b.mpt, 0.5, 30, przed.mpt), podloga: clamp(b.podloga, 0, 10, przed.podloga), indirectPct: clamp(b.indirectPct, 0, 1, przed.indirectPct), colTargetPct: clamp(b.colTargetPct, 1, 80, przed.colTargetPct), yoyWeight: clamp(b.yoyWeight, 0, 1, przed.yoyWeight != null ? przed.yoyWeight : 0.3) };
}

// ── Propozycja totalu miesiąca z historii dziennej (netto) i paragonów ──
// 1) pełne tygodnie (pn–nd) kończące się na ostatnim dniu z danymi ≤ asOf; poziom = średnia z ostatnich 4 (winsoryzowana),
// 2) trend tygodniowy g = (średnia ostatnich 4 / średnia poprzednich 4)^(1/4) − 1, ograniczony do ±4 %/tydz., tłumiony 0,75^k,
// 3) udziały dni tygodnia z 8 tygodni; dzień docelowy = poziomTyg × udział_dow × trend(k tygodni do przodu),
// 4) transakcje: ta sama procedura na paragonach (albo sprzedaż / AGC z historii, gdy brak paragonów),
// 5) przedział: ± zmienność tygodniowa (CV sum tygodni z 8 tygodni) × 1,0, min ±4 %.
export function propozycjaMiesiaca({ month, sales = {}, checks = {}, asOf = null, events = [], seasonManual = {}, yoyWeight = 0.3 }) {
  const dzis = asOf || new Date().toISOString().slice(0, 10);
  const ostatni = ostatniDzienZDanymi(sales, dzis);
  const out = { month, asOf: dzis, ostatniDzien: ostatni, ok: false, powody: [] };
  if (!ostatni) { out.powody.push('Brak historii sprzedaży — zaimportuj raport Sales Day by Day.'); return out; }
  // ostatnia pełna niedziela ≤ ostatni
  let nd = ostatni; while (dowOf(nd) !== 0) nd = addDays(nd, -1);
  const tygodnie = [];
  for (let w = 0; w < 8; w++) {
    const dni = Array.from({ length: 7 }, (_, i) => addDays(nd, -i - 7 * w));
    if (dni.some((d) => sales[d] == null)) break;
    tygodnie.push({ start: dni[6], end: dni[0], dni, sales: dni.reduce((a, d) => a + Number(sales[d]), 0), checks: dni.reduce((a, d) => a + (Number(checks[d]) || 0), 0) });
  }
  if (tygodnie.length < 2) { out.powody.push(`Za mało pełnych tygodni (pn–nd) w historii: ${tygodnie.length}. Potrzeba co najmniej 2, zalecane 8.`); return out; }
  const n4 = Math.min(4, tygodnie.length);
  const srednia = (arr) => arr.reduce((a, x) => a + x, 0) / arr.length;
  const ost4 = tygodnie.slice(0, n4).map((t) => t.sales);
  // winsoryzacja: tydzień odstający > 25 % od mediany ostatnich 4 przycinany do granicy
  const med = ost4.slice().sort((a, b) => a - b)[Math.floor((ost4.length - 1) / 2)];
  const ost4w = ost4.map((v) => Math.max(med * 0.75, Math.min(med * 1.25, v)));
  const poziomTyg = srednia(ost4w);
  let trendTyg = 0;
  if (tygodnie.length >= 6) { const prev = tygodnie.slice(n4, Math.min(8, tygodnie.length)).map((t) => t.sales); const ratio = srednia(ost4w) / srednia(prev); trendTyg = Math.max(-0.04, Math.min(0.04, Math.pow(ratio, 1 / n4) - 1)); }
  else if (tygodnie.length >= 3) { const ratio = ost4w[0] / srednia(ost4w.slice(1)); trendTyg = Math.max(-0.04, Math.min(0.04, (ratio - 1) / 2)); }
  // udziały dni tygodnia (0 = Nd … 6 = Sb) z wszystkich pełnych tygodni
  const udz = Array.from({ length: 7 }, () => []);
  tygodnie.forEach((t) => t.dni.forEach((d) => { if (t.sales > 0) udz[dowOf(d)].push(Number(sales[d]) / t.sales); }));
  const udzialDow = udz.map((a) => (a.length ? srednia(a) : 1 / 7));
  const sumaUdz = udzialDow.reduce((a, x) => a + x, 0); const udzN = udzialDow.map((x) => x / sumaUdz);
  // AGC (średni rachunek) z ostatnich 4 tygodni
  const checks4 = tygodnie.slice(0, n4).reduce((a, t) => a + t.checks, 0), sales4 = tygodnie.slice(0, n4).reduce((a, t) => a + t.sales, 0);
  const agc = checks4 > 0 ? sales4 / checks4 : null;
  const udzC = Array.from({ length: 7 }, () => []);
  tygodnie.forEach((t) => t.dni.forEach((d) => { if (t.checks > 0) udzC[dowOf(d)].push((Number(checks[d]) || 0) / t.checks); }));
  const udzCDow = udzC.map((a) => (a.length ? srednia(a) : 1 / 7)); const sC = udzCDow.reduce((a, x) => a + x, 0);
  const poziomTygC = checks4 > 0 ? srednia(tygodnie.slice(0, n4).map((t) => t.checks)) : null;
  // dni miesiąca docelowego
  const dates = monthDates(month);
  const tlum = (k) => { let f = 1; for (let i = 1; i <= k; i++) f *= 1 + trendTyg * Math.pow(0.75, i - 1); return f; };
  const dni = dates.map((d) => { const k = Math.max(0, Math.ceil((Date.parse(d) - Date.parse(nd)) / (7 * 86400000))); const sprz = poziomTyg * udzN[dowOf(d)] * tlum(k); const tr = poziomTygC != null ? poziomTygC * (udzCDow[dowOf(d)] / sC) * tlum(k) : (agc ? sprz / agc : 0); return { date: d, dow: dowOf(d), sales: r2(sprz), transactions: r0(tr), weeksAhead: k }; });
  const salesM = dni.reduce((a, x) => a + x.sales, 0), trM = dni.reduce((a, x) => a + x.transactions, 0);
  // zmienność: CV sum tygodniowych po usunięciu trendu
  const detr = tygodnie.map((t, i) => t.sales * Math.pow(1 + trendTyg, i)); const mu = srednia(detr); const cv = Math.sqrt(srednia(detr.map((x) => (x - mu) ** 2))) / mu;
  // sezonowość roczna: ten sam miesiąc rok wcześniej vs miesiąc bazowy rok wcześniej (oba kompletne) → mnożnik sezonowy
  const bazowyM = nd.slice(0, 7);                       // miesiąc, z którego pochodzi poziom (ostatnia pełna niedziela)
  const mRok = (m, dy) => `${Number(m.slice(0, 4)) + dy}-${m.slice(5, 7)}`;
  const sumaMies = (m) => { const ds = monthDates(m); return ds.every((d) => sales[d] != null) ? ds.reduce((a, d) => a + Number(sales[d]), 0) : null; };
  const yoyCel = sumaMies(mRok(month, -1)), yoyBaza = bazowyM !== month ? sumaMies(mRok(bazowyM, -1)) : null;
  // sezonowość: indeks sezonowy (start QSR-galeria → ręczny → wyuczony z własnych zamkniętych miesięcy) jako głos główny,
  // rok wcześniej (jeśli kiedyś będzie) tylko jako słaby głos o wadze yoyWeight (promocje sprzed roku nie mogą rządzić planem)
  const yoy = { dostepne: false, factor: 1, celRokTemu: yoyCel, bazaRokTemu: yoyBaza, miesiacBazowy: bazowyM, waga: yoyWeight };
  if (yoyCel && yoyBaza && bazowyM !== month) { const dC = monthDates(mRok(month, -1)).length, dB = monthDates(mRok(bazowyM, -1)).length; yoy.dostepne = true; yoy.factor = r2(Math.max(0.6, Math.min(1.6, (yoyCel / dC) / (yoyBaza / dB)))); }
  const ids = indeksSezonowy(sales, seasonManual);
  const mCel = String(Number(month.slice(5, 7))), mBaza = String(Number(bazowyM.slice(5, 7)));
  const idxRatio = bazowyM === month ? 1 : ids.idx[mCel].factor / ids.idx[mBaza].factor;
  const w = yoy.dostepne ? Math.max(0, Math.min(1, yoyWeight)) : 0;
  const sezon = Math.max(0.6, Math.min(1.6, Math.pow(idxRatio, 1 - w) * Math.pow(yoy.dostepne ? yoy.factor : 1, w)));
  const sezonInfo = { factor: r2(sezon), idxCel: ids.idx[mCel], idxBaza: ids.idx[mBaza], idxRatio: r2(idxRatio), miesiacBazowy: bazowyM, miesiecyHistorii: ids.miesiecyHistorii };
  if (sezon !== 1) dni.forEach((x) => { x.sales = r2(x.sales * sezon); x.transactions = r0(x.transactions * sezon); });
  // zdarzenia znane z wyprzedzeniem: promocje, zamknięcia, eventy — mnożnik dnia
  const zdarzenia = []; let wplywZdarzen = 0;
  dni.forEach((x) => { const z = mnoznikZdarzen(events, x.date); if (z.factor !== 1) { const przed = x.sales; x.sales = r2(x.sales * z.factor); x.transactions = r0(x.transactions * z.factor); x.events = z.events; wplywZdarzen += x.sales - przed; z.events.forEach((n) => { if (!zdarzenia.includes(n)) zdarzenia.push(n); }); } });
  const salesM2 = dni.reduce((a, x) => a + x.sales, 0), trM2 = dni.reduce((a, x) => a + x.transactions, 0);
  // pasmo: zmienność tygodniowa + 1 pkt za każdy tydzień horyzontu + 5 pkt, gdy sezonowość roczna nieznana
  const pas = Math.min(0.35, Math.max(0.04, cv) + 0.01 * dni[0].weeksAhead + (yoy.dostepne ? 0 : 0.05));
  const sklad = Array.from({ length: 7 }, (_, w) => dates.filter((d) => dowOf(d) === w).length);
  const tygodniDoPrzodu = dni[0].weeksAhead;
  const powody = [];
  if (tygodnie.length < 8) powody.push(`Historia obejmuje ${tygodnie.length} pełnych tygodni (zalecane 8) — trend i udziały dni są mniej pewne.`);
  if (tygodniDoPrzodu > 6) powody.push(`Miesiąc zaczyna się ${tygodniDoPrzodu} tygodni po ostatnich danych — trend wygaszony, propozycja opiera się głównie na poziomie ostatnich 4 tygodni.`);
  if (!agc) powody.push('Brak paragonów w historii — transakcje nieoszacowane.');
  if (bazowyM !== month) powody.push(`Sezon: indeks ${mCel}/12 (${sezonInfo.idxCel.zrodlo === 'manual' ? 'ręczny' : sezonInfo.idxCel.zrodlo === 'learned' ? `wyuczony z ${sezonInfo.idxCel.n} mies.` : 'start QSR-galeria'}) ${sezonInfo.idxCel.factor} vs miesiąc bazowy ${sezonInfo.idxBaza.factor} → ×${sezonInfo.idxRatio}${yoy.dostepne ? `; rok wcześniej ×${yoy.factor} z wagą ${Math.round(w * 100)} %` : ' (danych rok wcześniej brak — indeks nauczy się z Twoich zamkniętych miesięcy)'}.`);
  if (zdarzenia.length) powody.push(`Zdarzenia w miesiącu: ${zdarzenia.join(', ')} → ${wplywZdarzen >= 0 ? '+' : ''}${r0(wplywZdarzen).toLocaleString('pl-PL')} zł.`);
  const dniOd = Math.round((Date.parse(dzis) - Date.parse(ostatni)) / 86400000);
  if (dniOd > 9) powody.push(`Ostatnie dane POS sprzed ${dniOd} dni — zrób import wtorkowy przed zatwierdzeniem.`);
  return {
    ...out, ok: true, powody,
    sales: r0(salesM2), transactions: r0(trM2), agc: agc ? r2(agc) : null, yoy, sezon: sezonInfo, zdarzenia, wplywZdarzen: r0(wplywZdarzen),
    low: r0(salesM2 * (1 - pas)), high: r0(salesM2 * (1 + pas)), pasmoPct: r2(pas * 100),
    poziomTyg: r0(poziomTyg), trendTygPct: r2(trendTyg * 100), tygodniHistorii: tygodnie.length, tygodniDoPrzodu, dniWMiesiacu: dates.length,
    sklad: { Nd: sklad[0], Pn: sklad[1], Wt: sklad[2], Sr: sklad[3], Cz: sklad[4], Pt: sklad[5], Sb: sklad[6] },
    udzialDow: udzN.map((x) => r2(x * 100)),
    tygodnie: tygodnie.map((t) => ({ start: t.start, end: t.end, sales: r0(t.sales), checks: t.checks })).reverse(),
    dni,
  };
}

export async function czytajPlan(month) { return (await kv.get(keyFor(month))) || null; }
// zatwierdzony plan miesiąca albo null — używane przez P5 i autoplan, gdy wywołanie nie podaje własnych liczb
export async function zatwierdzonyPlan(month) { const p = await czytajPlan(month); return p && p.status === 'APPROVED' ? p : null; }

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });
  try {
    if (req.method === 'GET') {
      const s = await requireRole(req, res, ['asm', 'kierownik']); if (!s) return;
      if (req.query.params === '1') return res.json({ success: true, params: await czytajParametry(), domyslne: PARAMS_DOMYSLNE });
      const month = req.query.month;
      if (!validMonth(month)) return res.status(400).json({ success: false, error: 'Miesiąc w formacie YYYY-MM.' });
      const sd = (await kv.get('sales:data')) || {};
      const plan = await czytajPlan(month);
      const events = await czytajZdarzenia(); const sezonCfg = await czytajSezon(); const paramy = await czytajParametry();
      const proposal = propozycjaMiesiaca({ month, sales: sd.sales || {}, checks: sd.checks || {}, events, seasonManual: sezonCfg.manual || {}, yoyWeight: paramy.yoyWeight != null ? paramy.yoyWeight : 0.3 });
      // kalibracja: miesiące z planem — propozycja vs plan vs wykonanie (POS)
      const kalibracja = [];
      for (let i = -6; i <= 0; i++) { const d = new Date(); const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1)); const k = `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}`; const p = await czytajPlan(k); const ds = monthDates(k); const zDanymi = ds.filter((dd) => (sd.sales || {})[dd] != null); const actual = zDanymi.reduce((a, dd) => a + Number(sd.sales[dd]), 0); if (!p && !zDanymi.length) continue; kalibracja.push({ month: k, proposal: p && p.proposal ? p.proposal.sales : null, plan: p ? p.sales : null, status: p ? p.status : null, hoursAop: p ? p.hoursAop : null, actual: zDanymi.length ? r0(actual) : null, dniZDanymi: zDanymi.length, dni: ds.length, kompletny: zDanymi.length === ds.length, odchPlanPct: p && zDanymi.length === ds.length ? r2((actual / p.sales - 1) * 100) : null, odchPropPct: p && p.proposal && p.proposal.sales && zDanymi.length === ds.length ? r2((actual / p.proposal.sales - 1) * 100) : null }); }
      // lista miesięcy z planami (do nawigacji)
      const lista = [];
      for (let i = -2; i <= 3; i++) { const d = new Date(); const m = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`; const [y, mm] = m.split('-').map(Number); const x = new Date(Date.UTC(y, mm - 1 + i, 1)); const k = `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}`; const p = k === month ? plan : await czytajPlan(k); lista.push({ month: k, status: p ? p.status : null, sales: p ? p.sales : null, version: p ? p.version : 0 }); }
      const sched = (await kv.get(`sched:${month}`)) || { shifts: [] };
      const zm = (sched.shifts || []).filter((x) => x && x.rola !== 'instruktor');
      const grafik = { godziny: Math.round(zm.reduce((a, x) => a + (Number(x.hours) || 0), 0) * 4) / 4, zmian: zm.length, dni: new Set(zm.map((x) => x.date)).size };
      return res.json({ success: true, month, plan, proposal, params: paramy, miesiace: lista, grafik, events, sezon: indeksSezonowy(sd.sales || {}, sezonCfg.manual || {}), kalibracja });
    }
    if (req.method === 'POST') {
      const s = await requireRole(req, res, ['asm']); if (!s) return;
      const akcja = req.query.action; const b = req.body || {};
      if (akcja === 'event-save') {
        const lista = await czytajZdarzenia(); const przed = b.id ? lista.find((e) => e.id === b.id) : null;
        if (b.id && !przed) return res.status(404).json({ success: false, error: 'Nie ma takiego zdarzenia.' });
        const n = normalizujZdarzenie(b, przed || {}); if (n.error) return res.status(400).json({ success: false, error: n.error });
        const ev = { ...n.value, by: s.name, at: new Date().toISOString() };
        const next = przed ? lista.map((e) => (e.id === ev.id ? ev : e)) : [...lista, ev];
        await kv.set(EVENTS_KEY, next.sort((a, c) => a.from.localeCompare(c.from)).slice(-500));
        await audit({ ...aktor(s), action: przed ? 'events.update' : 'events.create', target: ev.id, before: przed || null, after: ev });
        return res.json({ success: true, event: ev, events: next });
      }
      if (akcja === 'event-delete') {
        const lista = await czytajZdarzenia(); const przed = lista.find((e) => e.id === b.id);
        if (!przed) return res.status(404).json({ success: false, error: 'Nie ma takiego zdarzenia.' });
        const next = lista.filter((e) => e.id !== b.id); await kv.set(EVENTS_KEY, next);
        await audit({ ...aktor(s), action: 'events.delete', target: b.id, before: przed });
        return res.json({ success: true, events: next });
      }
      if (akcja === 'season-save') {
        const cfg = await czytajSezon(); const manual = { ...(cfg.manual || {}) };
        Object.entries(b.manual || {}).forEach(([k, v]) => { const m = Number(k); if (!Number.isInteger(m) || m < 1 || m > 12) return; if (v == null || v === '') delete manual[String(m)]; else { const f = Number(v); if (Number.isFinite(f) && f >= 0.5 && f <= 2) manual[String(m)] = Math.round(f * 1000) / 1000; } });
        await kv.set(SEASON_KEY, { manual });
        await audit({ ...aktor(s), action: 'season.save', target: SEASON_KEY, before: cfg.manual || {}, after: manual });
        const sd = (await kv.get('sales:data')) || {};
        return res.json({ success: true, sezon: indeksSezonowy(sd.sales || {}, manual) });
      }
      if (akcja === 'params') {
        const przed = await czytajParametry(); const next = normalizujParametry(b, przed);
        await kv.set(PARAMS_KEY, next);
        await audit({ ...aktor(s), action: 'planning.params', target: 'params:planning', before: przed, after: next });
        return res.json({ success: true, params: next });
      }
      const month = b.month;
      if (!validMonth(month)) return res.status(400).json({ success: false, error: 'Miesiąc w formacie YYYY-MM.' });
      const current = await czytajPlan(month);
      const ver = Number((current && current.version) || 0);
      if (b.expectedVersion != null && Number(b.expectedVersion) !== ver) return res.status(409).json({ success: false, konflikt: true, version: ver, error: 'Plan został zmieniony w międzyczasie — odśwież.' });
      const now = new Date().toISOString();
      if (akcja === 'save') {
        const sales = Number(b.sales), transactions = Number(b.transactions);
        if (!Number.isFinite(sales) || sales <= 0 || sales > 1e8) return res.status(400).json({ success: false, error: 'Sprzedaż miesiąca musi być liczbą 0–100 000 000 zł.' });
        if (!Number.isFinite(transactions) || transactions < 0 || transactions > 1e7) return res.status(400).json({ success: false, error: 'Transakcje muszą być liczbą ≥ 0.' });
        const hoursAop = b.hoursAop == null || b.hoursAop === '' ? null : Number(b.hoursAop);
        const crewHours = b.crewHours == null || b.crewHours === '' ? null : Number(b.crewHours);
        if (hoursAop != null && (!Number.isFinite(hoursAop) || hoursAop < 0 || hoursAop > 100000)) return res.status(400).json({ success: false, error: 'Godziny AOP muszą być liczbą 0–100 000.' });
        if (crewHours != null && (!Number.isFinite(crewHours) || crewHours < 0 || (hoursAop != null && crewHours > hoursAop))) return res.status(400).json({ success: false, error: 'Godziny CREW nie mogą przekraczać godzin AOP.' });
        const source = b.source === 'proposal' ? 'proposal' : 'manual';
        const reason = String(b.reason || '').trim();
        if (source === 'manual' && b.proposal && Number.isFinite(Number(b.proposal.sales)) && Math.abs(sales / Number(b.proposal.sales) - 1) > 0.03 && reason.length < 3) return res.status(400).json({ success: false, error: 'Odchylenie od propozycji > 3 % wymaga uzasadnienia (min. 3 znaki).' });
        const wpis = { version: ver + 1, sales: Math.round(sales), transactions: Math.round(transactions), hoursAop: hoursAop != null ? Math.round(hoursAop * 4) / 4 : null, crewHours: crewHours != null ? Math.round(crewHours * 4) / 4 : null, source, reason: reason || null, by: s.name, at: now };
        const plan = { month, ...wpis, status: 'DRAFT', proposal: b.proposal && typeof b.proposal === 'object' ? { sales: Number(b.proposal.sales) || null, transactions: Number(b.proposal.transactions) || null, low: Number(b.proposal.low) || null, high: Number(b.proposal.high) || null, asOf: b.proposal.asOf || null, ostatniDzien: b.proposal.ostatniDzien || null } : (current && current.proposal) || null, createdAt: (current && current.createdAt) || now, approvedAt: null, approvedBy: null, history: [...((current && current.history) || []), { ...wpis, status: 'DRAFT' }].slice(-30) };
        await kv.set(keyFor(month), plan);
        await audit({ ...aktor(s), action: 'monthplan.save', target: `${month}/v${plan.version}`, before: current ? { sales: current.sales, transactions: current.transactions, status: current.status } : null, after: { sales: plan.sales, transactions: plan.transactions, hoursAop: plan.hoursAop, crewHours: plan.crewHours, source, reason: plan.reason } });
        return res.json({ success: true, plan });
      }
      if (akcja === 'approve') {
        if (!current) return res.status(404).json({ success: false, error: 'Najpierw zapisz plan.' });
        if (current.status === 'APPROVED') return res.json({ success: true, plan: current });
        const plan = { ...current, version: ver + 1, status: 'APPROVED', approvedAt: now, approvedBy: s.name, history: [...(current.history || []), { version: ver + 1, status: 'APPROVED', by: s.name, at: now, sales: current.sales, transactions: current.transactions }].slice(-30) };
        await kv.set(keyFor(month), plan);
        await audit({ ...aktor(s), action: 'monthplan.approve', target: `${month}/v${plan.version}`, after: { sales: plan.sales, transactions: plan.transactions } });
        return res.json({ success: true, plan });
      }
      if (akcja === 'reopen') {
        if (!current) return res.status(404).json({ success: false, error: 'Brak planu.' });
        const reason = String(b.reason || '').trim(); if (reason.length < 3) return res.status(400).json({ success: false, error: 'Otwarcie zatwierdzonego planu wymaga uzasadnienia.' });
        const plan = { ...current, version: ver + 1, status: 'DRAFT', approvedAt: null, approvedBy: null, reopen: { by: s.name, at: now, reason }, history: [...(current.history || []), { version: ver + 1, status: 'DRAFT', by: s.name, at: now, reason, sales: current.sales, transactions: current.transactions }].slice(-30) };
        await kv.set(keyFor(month), plan);
        await audit({ ...aktor(s), action: 'monthplan.reopen', target: `${month}/v${plan.version}`, after: { reason } });
        return res.json({ success: true, plan });
      }
      return res.status(400).json({ success: false, error: 'Nieznana akcja (save | approve | reopen | params).' });
    }
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
}
