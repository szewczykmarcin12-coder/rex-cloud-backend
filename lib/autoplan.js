import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit, aktor } from './audit.js';
import { ocenZgodnosc } from './compliance.js';
import { dyspozycjaObowiazuje } from './availability.js';

// ═══════════════════════════════════════════════════════════════════════════════════
//  AOP AUTOPLAN — układanie grafiku planowanego z planu miesięcznego, dyspozycji i historii
// ═══════════════════════════════════════════════════════════════════════════════════
//  Wejście (AOP): okres od–do, górna granica godzin CREW, godziny total (MGR dokłada kierownik),
//  estymowana sprzedaż i transakcje, szablon zmian wymaganych w dobie (np. codziennie KANAPKI od 06:00).
//
//  Model statystyczny (czyste funkcje, testowalne):
//   1. Afiniczność stanowisk  P(stanowisko | osoba) — zliczenia z historii z wygaszaniem
//      wykładniczym po wieku miesiąca (półokres 2 mies.) i wygładzeniem Dirichleta w stronę
//      rozkładu grupowego (crew/mgr). Nowy pracownik dziedziczy prior grupy.
//   2. Nawyk pory startu  P(godzina startu | osoba) — histogram 24 h z wygładzeniem jądrowym ±1 h.
//   3. Nawyk dnia tygodnia  P(dow | osoba) — udział dni pracy per dow.
//   4. Rozkład popytu na dni — udział dnia tygodnia w sprzedaży z historii (fallback: profil QSR),
//      przeskalowany do estymowanej sprzedaży AOP; budżet godzin CREW dnia ∝ sprzedaż dnia
//      z podłogą wynikającą z szablonu wymaganych zmian.
//   5. Krzywa popytu w dobie — profil godzinowy (z importu godzinowego, gdy jest; inaczej
//      standardowy) × sprzedaż dnia / SPLH docelowe → wymagana obsada co 30 min.
//
//  Algorytm:
//   A. Generowanie zmian: (i) wymagane z szablonu (twarde), (ii) dopełnienie popytu blokami
//      8 h / 6 h / 4 h (chciwe pokrycie największego deficytu) aż do budżetu dnia.
//   B. Przypisanie osób: dni chronologicznie; dla każdej zmiany kandydaci filtrowani
//      ograniczeniami twardymi (absencja, dyspozycja „niedostępny"/okno godzin, 11 h odpoczynku,
//      12 h w dobie, brak nakładania, max 6 dni z rzędu), punktacja:
//        score = 3.0·afiniczność + 1.2·nawyk startu + 0.6·nawyk dow + 1.5·fairness(niedobór do
//                nominału / brak przekroczenia) + 0.8·dostępność jawna − 0.5·dni z rzędu
//      z drobnym szumem deterministycznym (seed) dla rozstrzygania remisów.
//   C. Reperacja lokalna: 2 przebiegi zamian par (osoba A↔B na tej samej zmianie) poprawiające
//      sumę score bez łamania ograniczeń; wyrównanie godzin do nominału UOP.
//   D. Walidacja końcowa silnikiem zgodności (compliance) + raport pokrycia wymagań.
//  Wynik: propozycja (draft) z uzasadnieniem każdego przypisania; zastosowanie = add-bulk.
// ═══════════════════════════════════════════════════════════════════════════════════

const PROP_KEY = 'autoplan:proposals';
const MGRF = new Set(['RGM', 'ASM', 'SM', 'JSM']);
const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ')
  .replace(/Ą/g, 'A').replace(/Ć/g, 'C').replace(/Ę/g, 'E').replace(/Ł/g, 'L').replace(/Ń/g, 'N').replace(/Ó/g, 'O').replace(/Ś/g, 'S').replace(/Ź/g, 'Z').replace(/Ż/g, 'Z');
const mn = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const hhmm = (min) => `${String(Math.floor(((min % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((min % 60) + 60) % 60).padStart(2, '0')}`;
const dayNum = (iso) => Math.floor(Date.UTC(...iso.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))) / 86400000);
const isoOf = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const dowOf = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();
const durMin = (a, b) => { let d = mn(b) - mn(a); if (d <= 0) d += 1440; return d; };
const round2 = (x) => Math.round(x * 100) / 100;

// deterministyczny szum (mulberry32)
const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

// profil QSR: udział dnia tygodnia [nd, pn, wt, śr, cz, pt, so]
const DOW_QSR = [0.155, 0.125, 0.128, 0.132, 0.138, 0.158, 0.164];
// profil godzinowy 06..01 (udział godziny w sprzedaży dnia)
const PROF_H = { 6: .006, 7: .012, 8: .02, 9: .03, 10: .045, 11: .065, 12: .085, 13: .09, 14: .08, 15: .07, 16: .07, 17: .078, 18: .085, 19: .08, 20: .065, 21: .045, 22: .028, 23: .016, 0: .008, 1: .004 };

// ── 1–3. Model osoby z historii ──────────────────────────────────────────────────
export function modelOsob(historia, accounts, opts = {}) {
  const { dzis = new Date().toISOString().slice(0, 10), halfLifeMonths = 2, alpha = 1.5 } = opts;
  const poId = new Map(accounts.map((a) => [a.id, a]));
  const poNaz = new Map(accounts.flatMap((a) => [a.grafikName, a.name, ...(a.aliasy || [])].filter(Boolean).map((n) => [norm(n), a])));
  const kontoZ = (s) => poId.get(s.accountId) || poNaz.get(norm(s.name)) || null;
  const mies0 = Number(dzis.slice(0, 4)) * 12 + Number(dzis.slice(5, 7));
  const grupa = (a) => (MGRF.has(a.funkcja) ? 'mgr' : 'crew');
  const stCount = {}, stGroup = { crew: {}, mgr: {} }, startH = {}, dowC = {}, godzinM = {}, ostatnio = {};
  (historia || []).forEach((s) => {
    if (!s.date || !s.start || s.rola === 'instruktor') return;
    const k = kontoZ(s); if (!k) return;
    const wiek = mies0 - (Number(s.date.slice(0, 4)) * 12 + Number(s.date.slice(5, 7)));
    const w = Math.pow(0.5, Math.max(0, wiek) / halfLifeMonths);
    const st = norm(s.station || 'OBSADA');
    (stCount[k.id] = stCount[k.id] || {})[st] = (stCount[k.id][st] || 0) + w;
    const g = grupa(k); stGroup[g][st] = (stGroup[g][st] || 0) + w;
    const h = Math.floor(mn(s.start) / 60);
    startH[k.id] = startH[k.id] || new Array(24).fill(0);
    startH[k.id][h] += w; startH[k.id][(h + 23) % 24] += w * 0.35; startH[k.id][(h + 1) % 24] += w * 0.35;
    (dowC[k.id] = dowC[k.id] || new Array(7).fill(0))[dowOf(s.date)] += w;
    const ym = s.date.slice(0, 7);
    (godzinM[k.id] = godzinM[k.id] || {})[ym] = (godzinM[k.id][ym] || 0) + (Number(s.hours) || durMin(s.start, s.end) / 60);
    ostatnio[k.id] = ostatnio[k.id] && ostatnio[k.id] > s.date ? ostatnio[k.id] : s.date;
  });
  const normuj = (obj) => { const suma = Object.values(obj).reduce((a, b) => a + b, 0) || 1; return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v / suma])); };
  const priorG = { crew: normuj(stGroup.crew), mgr: normuj(stGroup.mgr) };
  const model = {};
  accounts.forEach((a) => {
    const g = grupa(a);
    const cnt = stCount[a.id] || {};
    const n = Object.values(cnt).reduce((x, y) => x + y, 0);
    const stacje = new Set([...Object.keys(cnt), ...Object.keys(priorG[g])]);
    const afin = {};
    stacje.forEach((st) => { afin[st] = ((cnt[st] || 0) + alpha * (priorG[g][st] || 0)) / (n + alpha); });   // Dirichlet
    const sh = startH[a.id] || new Array(24).fill(0); const shS = sh.reduce((x, y) => x + y, 0) || 1;
    const dc = dowC[a.id] || new Array(7).fill(0); const dcS = dc.reduce((x, y) => x + y, 0) || 1;
    const mies = Object.values(godzinM[a.id] || {});
    model[a.id] = {
      grupa: g, n: round2(n), afinicznosc: afin,
      startPref: sh.map((x) => x / shS), dowPref: dc.map((x) => (dcS ? x / dcS : 1 / 7)),
      srGodzinMies: mies.length ? round2(mies.reduce((x, y) => x + y, 0) / mies.length) : null,
      ostatniaZmiana: ostatnio[a.id] || null,
      topStanowiska: Object.entries(afin).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([st, p]) => ({ st, p: round2(p) })),
    };
  });
  return { model, priorGrupy: priorG };
}

// ── 4. Rozkład sprzedaży AOP na dni ─────────────────────────────────────────────
export function rozkladDni(dni, aop, salesHist = {}) {
  const wagiDow = new Array(7).fill(0), licz = new Array(7).fill(0);
  Object.entries(salesHist || {}).forEach(([d, v]) => { const dw = dowOf(d); if (Number(v) > 0) { wagiDow[dw] += Number(v); licz[dw]++; } });
  const srDow = wagiDow.map((s, i) => (licz[i] ? s / licz[i] : null));
  const maHist = srDow.filter((x) => x != null).length >= 5;
  const profil = maHist ? srDow.map((x, i) => x != null ? x : DOW_QSR[i] * (srDow.filter(Boolean).reduce((a, b) => a + b, 0) / DOW_QSR.reduce((a, b, j) => a + (srDow[j] != null ? b : 0), 0))) : DOW_QSR;
  const wagi = dni.map((d) => profil[dowOf(d)]);
  const suma = wagi.reduce((a, b) => a + b, 0) || 1;
  const sales = Number(aop.sales) || 0, trx = Number(aop.transactions) || 0;
  return dni.map((d, i) => ({ date: d, dow: dowOf(d), udzial: wagi[i] / suma, sales: round2(sales * wagi[i] / suma), trx: Math.round(trx * wagi[i] / suma) }));
}

// ── 5. Krzywa popytu w dobie (48 slotów po 30 min od 06:00) ─────────────────────
export function krzywaDnia(salesDnia, splh, profilGodz = null, podloga = 1) {
  const prof = {}; let s = 0;
  for (let h = 0; h < 24; h++) { const key = String(h).padStart(2, '0'); const v = profilGodz && profilGodz[key] != null ? profilGodz[key] : (PROF_H[h] || 0); prof[h] = v; s += v; }
  const wym = new Array(48).fill(0);
  for (let i = 0; i < 48; i++) { const h = (6 + Math.floor(i / 2)) % 24; const udz = s ? prof[h] / s : 0; const godzSprz = salesDnia * udz; wym[i] = godzSprz > 0 ? Math.max(podloga, Math.round(godzSprz / splh)) : 0; }
  return wym;
}

// ── A. Generowanie zmian dnia ──────────────────────────────────────────────────
const slotOf = (t) => { let m = mn(t) - 360; if (m < 0) m += 1440; return Math.round(m / 30); };
function zmianyDnia(date, wymagane, wym48, budzetH, opts) {
  const { blokiH = [8, 6, 4], minStartH = 6, maxEndH = 26 } = opts;
  const out = [];
  const cover = new Array(48).fill(0);
  wymagane.forEach((w) => {
    const s = slotOf(w.start), e = s + Math.round(durMin(w.start, w.end) / 30);
    for (let i = s; i < Math.min(e, 48); i++) cover[i]++;
    out.push({ date, station: norm(w.station), start: w.start, end: w.end, wymagana: true, zrodlo: 'szablon' });
  });
  let uzyte = out.reduce((a, z) => a + durMin(z.start, z.end) / 60, 0);
  let guard = 0;
  while (uzyte + 4 <= budzetH && guard++ < 60) {
    const deficit = wym48.map((d, i) => Math.max(0, d - cover[i]));
    if (!deficit.some((x) => x > 0)) break;
    let best = null;
    for (const bh of blokiH) {
      const len = bh * 2;
      if (uzyte + bh > budzetH + 0.01) continue;
      for (let s = (minStartH - 6) * 2; s + len <= Math.min(48, (maxEndH - 6) * 2); s++) {
        let gain = 0; for (let i = s; i < s + len; i++) gain += deficit[i] > 0 ? 1 : 0;
        const sc = gain / len + gain * 0.01;
        if (gain > 0 && (!best || sc > best.sc + 1e-9)) best = { s, len, sc, bh };
      }
    }
    if (!best) break;
    for (let i = best.s; i < best.s + best.len; i++) cover[i]++;
    const startMin = 360 + best.s * 30, endMin = startMin + best.len * 30;
    out.push({ date, station: null, start: hhmm(startMin), end: hhmm(endMin), wymagana: false, zrodlo: 'popyt' });
    uzyte += best.bh;
  }
  const deficytH = wym48.reduce((a, d, i) => a + Math.max(0, d - cover[i]), 0) / 2;
  return { zmiany: out, cover, deficytH: round2(deficytH), uzyteH: round2(uzyte) };
}

// ── B/C. Przypisanie osób ─────────────────────────────────────────────────────
export function przypisz(zmianyWszystkie, accounts, ctx) {
  const { model, absences = [], avail = [], istniejace = [], seed = 42, nominal = {}, wagi = {} } = ctx;
  const W = { afin: 3.0, start: 1.2, dow: 0.6, fair: 1.5, dost: 0.8, ciag: 0.5, ...wagi };
  const rand = rng(seed);
  const crew = accounts.filter((a) => !MGRF.has(a.funkcja) && a.aktywny !== false);
  // stan osoby: przypisane bloki (absolutne minuty), godziny w okresie, dni pracy
  const stan = {};
  crew.forEach((a) => { stan[a.id] = { bloki: [], godz: 0, dni: new Set() }; });
  istniejace.forEach((s) => { if (stan[s.accountId]) { const sa = dayNum(s.date) * 1440 + mn(s.start); stan[s.accountId].bloki.push([sa, sa + durMin(s.start, s.end)]); stan[s.accountId].godz += durMin(s.start, s.end) / 60; stan[s.accountId].dni.add(s.date); } });
  const absZ = (aid, d) => absences.some((x) => x.accountId === aid && x.status === 'approved' && x.from <= d && d <= x.to);
  const dyspoZ = (aid, d) => avail.find((r) => r.accountId === aid && r.status === 'approved' && dyspozycjaObowiazuje(r, d)) || null;
  const dniZRzedu = (st, d) => { let n = 0, k = dayNum(d) - 1; while (st.dni.has(isoOf(k))) { n++; k--; } return n; };
  const twarde = (a, z, sa, ea, d) => {
    const st = stan[a.id];
    if (absZ(a.id, d)) return 'absencja';
    const dy = dyspoZ(a.id, d);
    if (dy) {
      if (dy.type === 'unavailable') return 'niedostępny';
      if (dy.type === 'from_time' && mn(z.start) < mn(dy.startTime)) return `dostępny od ${dy.startTime}`;
      if (dy.type === 'until_time' && mn(z.start) + durMin(z.start, z.end) > mn(dy.endTime)) return `dostępny do ${dy.endTime}`;
      if (dy.type === 'specific_shift' && (mn(z.start) < mn(dy.startTime) || mn(z.start) + durMin(z.start, z.end) > mn(dy.endTime))) return `okno ${dy.startTime}–${dy.endTime}`;
    }
    for (const [bs, be] of st.bloki) {
      if (sa < be && ea > bs) return 'nakładanie';
      if (bs >= ea && bs - ea < 660) return 'odpoczynek 11 h';
      if (sa >= be && sa - be < 660) return 'odpoczynek 11 h';
    }
    const wDobie = st.bloki.filter(([bs]) => Math.floor(bs / 1440) === dayNum(d)).reduce((x, [bs, be]) => x + (be - bs), 0) + (ea - sa);
    if (wDobie > 720) return '12 h w dobie';
    if (dniZRzedu(st, d) >= 6) return '7. dzień z rzędu';
    const nom = nominal[a.id]; if (nom && st.godz + (ea - sa) / 60 > nom * 1.15) return 'ponad nominał';
    return null;
  };
  const ocena = (a, z, d) => {
    const m = model[a.id] || { afinicznosc: {}, startPref: [], dowPref: [] };
    const st = stan[a.id];
    const af = z.station ? (m.afinicznosc[z.station] || 0.02) : Math.max(0.05, ...Object.values(m.afinicznosc || {}), 0.05);
    const sp = m.startPref && m.startPref.length ? m.startPref[Math.floor(mn(z.start) / 60)] * 6 : 0.25;
    const dp = m.dowPref && m.dowPref.length ? m.dowPref[dowOf(d)] * 7 : 1;
    const nom = nominal[a.id] || 0;
    const fair = nom ? Math.max(-1, Math.min(1, (nom - st.godz) / nom)) : (st.godz > 0 ? -st.godz / 160 : 0.3);
    const dy = dyspoZ(a.id, d);
    const dost = dy && dy.type === 'available' ? 1 : dy ? 0.6 : 0.2;
    const ciag = dniZRzedu(st, d);
    return W.afin * af + W.start * Math.min(1.5, sp) + W.dow * Math.min(1.5, dp) + W.fair * fair + W.dost * dost - W.ciag * Math.max(0, ciag - 4) + rand() * 0.05;
  };
  const wynik = [];
  const posort = [...zmianyWszystkie].sort((x, y) => x.date.localeCompare(y.date) || (y.wymagana ? 1 : 0) - (x.wymagana ? 1 : 0) || mn(x.start) - mn(y.start));
  for (const z of posort) {
    const sa = dayNum(z.date) * 1440 + mn(z.start), ea = sa + durMin(z.start, z.end);
    let best = null; const odrzuceni = {};
    for (const a of crew) {
      const powod = twarde(a, z, sa, ea, z.date);
      if (powod) { odrzuceni[powod] = (odrzuceni[powod] || 0) + 1; continue; }
      const sc = ocena(a, z, z.date);
      if (!best || sc > best.sc) best = { a, sc };
    }
    if (best) {
      const m = model[best.a.id] || { afinicznosc: {} };
      const stacja = z.station || (m.topStanowiska && m.topStanowiska[0] ? m.topStanowiska[0].st : 'OBSADA');
      stan[best.a.id].bloki.push([sa, ea]); stan[best.a.id].godz += (ea - sa) / 60; stan[best.a.id].dni.add(z.date);
      wynik.push({ ...z, station: stacja, accountId: best.a.id, name: best.a.grafikName || best.a.name, display: best.a.name, score: round2(best.sc), afinicznosc: round2(m.afinicznosc[stacja] || 0), hours: round2((ea - sa) / 60) });
    } else {
      wynik.push({ ...z, station: z.station || 'OBSADA', accountId: null, name: null, display: null, nieobsadzona: true, powody: odrzuceni, hours: round2((ea - sa) / 60) });
    }
  }
  // C. reperacja: zamiany par tego samego dnia poprawiające sumę score (2 przebiegi)
  for (let pass = 0; pass < 2; pass++) {
    const obs = wynik.filter((w) => w.accountId);
    for (let i = 0; i < obs.length; i++) for (let j = i + 1; j < obs.length; j++) {
      const A = obs[i], B = obs[j]; if (A.date !== B.date || A.accountId === B.accountId) continue;
      const kA = crew.find((c) => c.id === A.accountId), kB = crew.find((c) => c.id === B.accountId);
      const mA = model[kA.id] || { afinicznosc: {} }, mB = model[kB.id] || { afinicznosc: {} };
      const teraz = (mA.afinicznosc[A.station] || 0) + (mB.afinicznosc[B.station] || 0);
      const poZam = (mA.afinicznosc[B.station] || 0) + (mB.afinicznosc[A.station] || 0);
      if (poZam > teraz + 0.05 && durMin(A.start, A.end) === durMin(B.start, B.end)) {
        // zamiana stanowisk (ten sam czas i data) — nie narusza ograniczeń czasowych
        const st = A.station; A.station = B.station; B.station = st;
        A.afinicznosc = round2(mA.afinicznosc[A.station] || 0); B.afinicznosc = round2(mB.afinicznosc[B.station] || 0);
      }
    }
  }
  const godzOsob = Object.fromEntries(crew.map((a) => [a.id, { name: a.name, godz: round2(stan[a.id].godz), nominal: nominal[a.id] || null, dni: stan[a.id].dni.size }]));
  return { przypisania: wynik, godzOsob };
}

// ── Pełny przebieg ────────────────────────────────────────────────────────────
export function ulozGrafik(input, dane) {
  const { from, to, aop = {}, wymagania = [], seed = 42, splh = 420, opts = {} } = input;
  const { accounts, historia, salesHist, hourlyProfile, absences, avail, istniejace } = dane;
  const dni = []; for (let n = dayNum(from); n <= dayNum(to); n++) dni.push(isoOf(n));
  if (!dni.length || dni.length > 62) throw new Error('Okres musi mieć od 1 do 62 dni.');
  const { model, priorGrupy } = modelOsob(historia, accounts, { dzis: from });
  const rozklad = rozkladDni(dni, aop, salesHist);
  const crewMax = Number(aop.crewHoursMax) || 0;
  // godziny MGR już w grafiku (kierownik) — nie ruszamy; budżet crew per dzień ∝ sprzedaż dnia
  const mgrIst = (istniejace || []).filter((s) => { const a = accounts.find((k) => k.id === s.accountId); return a && MGRF.has(a.funkcja); });
  const crewIst = (istniejace || []).filter((s) => { const a = accounts.find((k) => k.id === s.accountId); return a && !MGRF.has(a.funkcja); });
  const crewIstH = crewIst.reduce((a, s) => a + durMin(s.start, s.end) / 60, 0);
  const budzetCrew = Math.max(0, crewMax - crewIstH);
  const wymPerDzien = (d) => wymagania.filter((w) => !w.dni || !w.dni.length || w.dni.includes(dowOf(d))).map((w) => ({ station: w.station, start: w.start, end: w.end }));
  const minWym = dni.reduce((a, d) => a + wymPerDzien(d).reduce((x, w) => x + durMin(w.start, w.end) / 60, 0), 0);
  const skala = budzetCrew > 0 ? budzetCrew : minWym;
  const zmiany = []; const perDzien = [];
  const profilDow = (dw) => hourlyProfile && hourlyProfile[String(dw)] ? hourlyProfile[String(dw)] : null;
  rozklad.forEach((r) => {
    const budzet = Math.max(wymPerDzien(r.date).reduce((x, w) => x + durMin(w.start, w.end) / 60, 0), skala * r.udzial);
    const wym48 = krzywaDnia(r.sales, splh, profilDow(r.dow), opts.podloga || 1);
    // odejmij pokrycie MGR już w grafiku (manager liczy się do obsady)
    mgrIst.filter((s) => s.date === r.date).forEach((s) => { const a = slotOf(s.start), e = a + Math.round(durMin(s.start, s.end) / 30); for (let i = a; i < Math.min(48, e); i++) wym48[i] = Math.max(0, wym48[i] - 1); });
    const zd = zmianyDnia(r.date, wymPerDzien(r.date), wym48, budzet, opts);
    zmiany.push(...zd.zmiany);
    perDzien.push({ date: r.date, dow: r.dow, sales: r.sales, trx: r.trx, budzetH: round2(budzet), uzyteH: zd.uzyteH, deficytH: zd.deficytH, zmian: zd.zmiany.length, wymagane: zd.zmiany.filter((z) => z.wymagana).length });
  });
  const nominal = {};
  accounts.forEach((a) => { if (a.umowa === 'UOP' && a.wymiarTygH) nominal[a.id] = round2(Number(a.wymiarTygH) / 7 * dni.length); });
  const { przypisania, godzOsob } = przypisz(zmiany, accounts, { model, absences, avail, istniejace, seed, nominal, wagi: opts.wagi });
  const obsadzone = przypisania.filter((p) => p.accountId);
  const godzCrew = obsadzone.reduce((a, p) => a + p.hours, 0);
  const koszt = obsadzone.reduce((a, p) => { const k = accounts.find((x) => x.id === p.accountId); return a + (!k ? 0 : k.umowa === 'UOP' ? (Number(k.stawka) || 0) / 160 * p.hours : (Number(k.stawka) || 0) * p.hours); }, 0);
  const zg = ocenZgodnosc([...(istniejace || []), ...obsadzone.map((p) => ({ date: p.date, name: p.name, accountId: p.accountId, start: p.start, end: p.end }))], accounts, { from, to });
  const wymaganeOgolem = przypisania.filter((p) => p.wymagana).length, wymaganeObsadzone = przypisania.filter((p) => p.wymagana && p.accountId).length;
  const sredniaAfin = obsadzone.length ? round2(obsadzone.reduce((a, p) => a + (p.afinicznosc || 0), 0) / obsadzone.length) : 0;
  return {
    okres: { from, to, dni: dni.length }, aop: { ...aop, splh },
    podsumowanie: {
      zmian: przypisania.length, obsadzone: obsadzone.length, nieobsadzone: przypisania.length - obsadzone.length,
      godzinyCrew: round2(godzCrew + crewIstH), limitCrew: crewMax || null, godzinyMgrIstniejace: round2(mgrIst.reduce((a, s) => a + durMin(s.start, s.end) / 60, 0)),
      kosztSzac: Math.round(koszt), sprzedazAOP: Number(aop.sales) || 0, colSzac: aop.sales ? round2(koszt / Number(aop.sales) * 100) : null,
      pokrycieWymagan: wymaganeOgolem ? round2(wymaganeObsadzone / wymaganeOgolem * 100) : 100, deficytPopytuH: round2(perDzien.reduce((a, d) => a + d.deficytH, 0)),
      sredniaAfinicznosc: sredniaAfin, naruszenia: zg.summary,
    },
    perDzien, przypisania, godzOsob, naruszenia: zg.violations.slice(0, 80), model: Object.fromEntries(Object.entries(model).map(([id, m]) => [id, { grupa: m.grupa, n: m.n, top: m.topStanowiska, srGodzinMies: m.srGodzinMies }])), priorGrupy,
  };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function zbierzDane(from, to) {
  const accounts = (await kv.get('accounts:list')) || [];
  const idx = (await kv.get('sched:index')) || [];
  const fromYm = from.slice(0, 7);
  const histYm = idx.filter((ym) => ym < fromYm).slice(-6);
  const okresYm = [...new Set([from.slice(0, 7), to.slice(0, 7)])];
  const historia = []; const istniejace = [];
  for (const ym of histYm) { const m = await kv.get(`sched:${ym}`); if (m) historia.push(...(m.shifts || [])); }
  for (const ym of okresYm) { const m = await kv.get(`sched:${ym}`); if (m) (m.shifts || []).forEach((s) => { if (s.date >= from && s.date <= to) istniejace.push(s); else historia.push(s); }); }
  const sd = (await kv.get('sales:data')) || {};
  let hourlyProfile = null;
  try { const { profilGodzinowy } = await import('./sales.js'); hourlyProfile = profilGodzinowy(sd.hourly || {}).profil; if (!Object.keys(hourlyProfile || {}).length) hourlyProfile = null; } catch {}
  const absences = (await kv.get('absences:list')) || [];
  const avail = (await kv.get('avail:reqs')) || [];
  return { accounts, historia, salesHist: sd.sales || {}, hourlyProfile, absences, avail, istniejace };
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });
  try {
    const s = await requireRole(req, res, ['asm', 'kierownik']);
    if (!s) return;
    const akcja = (req.query || {}).action;
    if (req.method === 'GET') {
      const props = (await kv.get(PROP_KEY)) || [];
      if (akcja === 'model') {
        const to = new Date().toISOString().slice(0, 10);
        const dane = await zbierzDane(to, to);
        const { model, priorGrupy } = modelOsob(dane.historia, dane.accounts);
        return res.json({ success: true, model, priorGrupy, historiaZmian: dane.historia.length });
      }
      return res.json({ success: true, proposals: props.map((p) => ({ id: p.id, createdAt: p.createdAt, by: p.by, okres: p.okres, podsumowanie: p.podsumowanie, applied: !!p.applied })) , proposal: (req.query || {}).id ? props.find((p) => p.id === req.query.id) || null : null });
    }
    if (req.method === 'POST' && akcja === 'generate') {
      const b = req.body || {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.from || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.to || '')) || b.from > b.to) return res.status(400).json({ success: false, error: 'Podaj poprawny okres od–do.' });
      const wymagania = (Array.isArray(b.wymagania) ? b.wymagania : []).filter((w) => w && w.station && /^\d{2}:\d{2}$/.test(w.start) && /^\d{2}:\d{2}$/.test(w.end)).map((w) => ({ station: String(w.station).toUpperCase(), start: w.start, end: w.end, dni: Array.isArray(w.dni) ? w.dni.map(Number) : [] }));
      const dane = await zbierzDane(b.from, b.to);
      const wynik = ulozGrafik({ from: b.from, to: b.to, aop: b.aop || {}, wymagania, seed: Number(b.seed) || 42, splh: Number(b.splh) || 420, opts: { podloga: Number(b.podloga) || 1 } }, dane);
      const prop = { id: 'ap' + Date.now().toString(36), createdAt: new Date().toISOString(), by: s.name, ...wynik, wymagania };
      const props = ((await kv.get(PROP_KEY)) || []).filter((p) => !p.applied).slice(0, 4);
      props.unshift(prop);
      await kv.set(PROP_KEY, props);
      await audit({ ...aktor(s), action: 'autoplan.generate', target: `${b.from}..${b.to}`, after: { zmian: wynik.podsumowanie.zmian, obsadzone: wynik.podsumowanie.obsadzone, crewH: wynik.podsumowanie.godzinyCrew } });
      return res.json({ success: true, proposal: prop });
    }
    if (req.method === 'POST' && akcja === 'apply') {
      if (s.role !== 'asm') return res.status(403).json({ success: false, error: 'Zastosowanie propozycji wymaga roli ASM.' });
      const id = String((req.body || {}).id || '');
      const props = (await kv.get(PROP_KEY)) || [];
      const prop = props.find((p) => p.id === id);
      if (!prop) return res.status(404).json({ success: false, error: 'Nie znaleziono propozycji.' });
      const shifts = prop.przypisania.filter((p) => p.accountId).map((p) => ({ date: p.date, name: p.name, accountId: p.accountId, station: p.station, start: p.start, end: p.end, hours: p.hours, autoplan: prop.id }));
      prop.applied = new Date().toISOString(); prop.appliedBy = s.name;
      await kv.set(PROP_KEY, props);
      await audit({ ...aktor(s), action: 'autoplan.apply', target: id, after: { zmian: shifts.length } });
      return res.json({ success: true, shifts, zmian: shifts.length });
    }
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
