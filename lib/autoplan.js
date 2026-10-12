import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit, aktor } from './audit.js';
import { ocenZgodnosc } from './compliance.js';
import { dyspozycjaObowiazuje, ocenOknoDyspozycji } from './availability.js';
import { SLOTOW, KROK, norm as normSt, mn, hhmm, slotOd, slotDo, slotCzas, durMin, dowOf, wymaganiaDnia, definicjaStanowiska, jestMgrStanowisko, pokrycieDnia, czytajModel } from './work-model.js';
import { kwalifikacja, stanDanychKwalifikacji, maDaneKwalifikacji } from './qualifications.js';
import { audytGrafiku } from './schedule-audit.js';

// ═══════════════════════════════════════════════════════════════════════════════════
//  AUTOPLAN v2 — najpierw wymagane stanowiska w czasie, potem ludzie
// ═══════════════════════════════════════════════════════════════════════════════════
//  1. OBSADA PODSTAWOWA: instancje szablonów z zatwierdzonego modelu pracy restauracji (otwarcie, środek,
//     zamknięcie, zadania, MANAGER) dla każdego dnia okresu. Bez modelu: wymagania z formularza.
//     Istniejące zmiany (np. zaimportowany grafik kierowników) pokrywają instancje i liczą się do budżetu.
//  2. OBSADA DODATKOWA: prognoza sprzedaży → wymagana liczba osób co 15 min (SPLH) minus obsada podstawowa
//     (kierownik liczony udziałem operacyjnym) → bloki dopełniające w granicach JEDNEGO budżetu godzin zespołu.
//  3. WYKONALNOŚĆ PRZED: dla każdej instancji pula kandydatów (kwalifikacja z macierzy, dyspozycja, absencja,
//     limit godzin); instancje bez kandydata i stanowiska bez puli raportowane zanim cokolwiek się przypisze.
//  4. PRZYPISANIE CAŁEGO OKRESU: instancje w kolejności (podstawowa → krytyczna → najmniej kandydatów → data),
//     twarde reguły identyczne z zapisem grafiku (okno dyspozycji w dobie 06→06, 12 h w bloku, 11 h odpoczynku,
//     brak nakładania, max godzin osoby, 6 dni z rzędu), punktacja: kwalifikacja, cel godzin, nawyki, ciągłość,
//     oszczędzanie rzadkich specjalistów.
//  5. NAPRAWA LUK (najpoważniejsze najpierw): przesunięcie w granicach elastyczności, podział na dwa dyżury,
//     wydłużenie sąsiada (w limicie 12 h), zamiana osoby z obsady dodatkowej. Każda luka ma powód i podpowiedź.
//  6. KOMPLETNOŚĆ PO: audyt grafiku (ciągłość stanowisk co 15 min, kierownik, dyspozycje, czas pracy) +
//     silnik zgodności. Luka krytyczna = status „niekompletny” — nie do publikacji, eksport roboczy możliwy.
// ═══════════════════════════════════════════════════════════════════════════════════

const PROP_KEY = 'autoplan:proposals';
const MGRF = new Set(['RGM', 'ASM', 'SM', 'JSM']);
const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ')
  .replace(/Ą/g, 'A').replace(/Ć/g, 'C').replace(/Ę/g, 'E').replace(/Ł/g, 'L').replace(/Ń/g, 'N').replace(/Ó/g, 'O').replace(/Ś/g, 'S').replace(/Ź/g, 'Z').replace(/Ż/g, 'Z');
const dayNum = (iso) => Math.floor(Date.UTC(...iso.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))) / 86400000);
const isoOf = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const round2 = (x) => Math.round(x * 100) / 100;
const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const DOW_QSR = [0.155, 0.125, 0.128, 0.132, 0.138, 0.158, 0.164];
const PROF_H = { 6: .006, 7: .012, 8: .02, 9: .03, 10: .045, 11: .065, 12: .085, 13: .09, 14: .08, 15: .07, 16: .07, 17: .078, 18: .085, 19: .08, 20: .065, 21: .045, 22: .028, 23: .016, 0: .008, 1: .004 };
const STACJE_PRODUKCYJNE = ['KANAPKI / WRAPY', 'KONTROLER', 'PANIEROWANIE', 'SMAŻENIE', 'FRYTKI', 'DESERY / NAPOJE', 'PHU'];

// ── Model osoby z historii (nawyki — tylko punktacja, nigdy kwalifikacja) ──────
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
    stacje.forEach((st) => { afin[st] = ((cnt[st] || 0) + alpha * (priorG[g][st] || 0)) / (n + alpha); });
    const sh = startH[a.id] || new Array(24).fill(0); const shS = sh.reduce((x, y) => x + y, 0) || 1;
    const dc = dowC[a.id] || new Array(7).fill(0); const dcS = dc.reduce((x, y) => x + y, 0) || 1;
    const mies = Object.values(godzinM[a.id] || {});
    model[a.id] = { grupa: g, n: round2(n), afinicznosc: afin, startPref: sh.map((x) => x / shS), dowPref: dc.map((x) => (dcS ? x / dcS : 1 / 7)), srGodzinMies: mies.length ? round2(mies.reduce((x, y) => x + y, 0) / mies.length) : null, ostatniaZmiana: ostatnio[a.id] || null, topStanowiska: Object.entries(afin).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([st, p]) => ({ st, p: round2(p) })) };
  });
  return { model, priorGrupy: priorG };
}

// ── Rozkład sprzedaży planu na dni ───────────────────────────────────────────────
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

// ── Krzywa popytu w dobie (48 slotów po 30 min od 06:00) ─────────────────────────
export function krzywaDnia(salesDnia, splh, profilGodz = null, podloga = 1) {
  const prof = {}; let s = 0;
  for (let h = 0; h < 24; h++) { const key = String(h).padStart(2, '0'); const v = profilGodz && profilGodz[key] != null ? profilGodz[key] : (PROF_H[h] || 0); prof[h] = v; s += v; }
  const wym = new Array(48).fill(0);
  for (let i = 0; i < 48; i++) { const h = (6 + Math.floor(i / 2)) % 24; const udz = s ? prof[h] / s : 0; const godzSprz = salesDnia * udz; wym[i] = godzSprz > 0 ? Math.max(podloga, Math.round(godzSprz / splh)) : 0; }
  return wym;
}
const na96 = (w48) => { const o = new Array(SLOTOW).fill(0); for (let i = 0; i < SLOTOW; i++) o[i] = w48[Math.floor(i / 2)] || 0; return o; };

// ── Cele i limity godzin pracownika (zamiast „tyg ÷ 7 × dni” i tolerancji 15 %) ──
export function celeGodzin(accounts, dni, absences = [], paramy = {}) {
  const dniRobocze = dni.filter((d) => { const w = dowOf(d); return w >= 1 && w <= 5; }).length;
  const out = {};
  accounts.forEach((a) => {
    const absDni = (absences || []).filter((x) => x.accountId === a.id && x.status === 'approved').reduce((n, x) => n + dni.filter((d) => d >= x.from && d <= x.to && dowOf(d) >= 1 && dowOf(d) <= 5).length, 0);
    const jawne = a.godzCel != null || a.godzMin != null || a.godzMax != null;
    if (a.umowa === 'UOP' && a.wymiarTygH) {
      const etat = round2(Number(a.wymiarTygH) / 5 * Math.max(0, dniRobocze - absDni));
      const cel = a.godzCel != null ? Number(a.godzCel) : etat;
      out[a.id] = { cel, min: a.godzMin != null ? Number(a.godzMin) : cel, max: a.godzMax != null ? Number(a.godzMax) : round2(cel + (Number(paramy.nadgodzinyPlanH) || 0)), zrodlo: jawne ? 'konto' : 'etat', dniRobocze, absencjaDni: absDni };
    } else {
      const maxDom = round2(Math.max(12 * Math.min(dni.length, 2), (Number(paramy.maxGodzUZ) || 160) * dni.length / 30));   // krótkie okresy: nie blokuj pojedynczej zmiany
      out[a.id] = { cel: a.godzCel != null ? Number(a.godzCel) : null, min: a.godzMin != null ? Number(a.godzMin) : 0, max: a.godzMax != null ? Number(a.godzMax) : maxDom, zrodlo: jawne ? 'konto' : 'domyślne', dniRobocze, absencjaDni: absDni };
    }
  });
  return out;
}

// ── Pełny przebieg ─────────────────────────────────────────────────────────────
export function ulozGrafik(input, dane) {
  const { from, to, aop = {}, wymagania = [], seed = 42, splh = 420, opts = {} } = input;
  const { accounts = [], historia = [], salesHist = {}, hourlyProfile = null, absences = [], avail = [], istniejace = [], sasiednie = [], workModel = null, matrix = null, paramy = {} } = dane;
  const dni = []; for (let n = dayNum(from); n <= dayNum(to); n++) dni.push(isoOf(n));
  if (!dni.length || dni.length > 62) throw new Error('Okres musi mieć od 1 do 62 dni.');
  const rand = rng(seed);
  const W = { kwal: 2.5, afin: 1.5, start: 1.0, dow: 0.5, fair: 2.0, dost: 0.8, ciag: 0.5, rzadkosc: 1.5, kontynuacja: 0.6, ...(opts.wagi || {}) };
  const interpretacja2359 = opts.interpretacja2359 || paramy.interpretacja2359 || 'koniec-dnia';
  const model = workModel && (workModel.status === 'zatwierdzony' || opts.uzyjPropozycjiModelu) && (workModel.biblioteka || []).length ? workModel : null;
  const mgrUdzial = model ? (model.mgrOperacyjnyUdzial != null ? model.mgrOperacyjnyUdzial : 0.7) : 0.7;
  const aktywne = accounts.filter((a) => a.aktywny !== false);
  const { model: nawyki } = modelOsob(historia, accounts, { dzis: from });
  const stanKw = stanDanychKwalifikacji(matrix, aktywne, []);
  const trybKw = stanKw.tryb;   // 'macierz' | 'macierz-czesciowa' | 'brak'
  const cele = celeGodzin(aktywne, dni, absences, paramy);

  // ── 1. instancje obsady podstawowej ────────────────────────────────────────────
  let idI = 0;
  const instancje = [];
  const wymLegacy = (d) => (wymagania || []).filter((w) => !w.dni || !w.dni.length || w.dni.includes(dowOf(d))).map((w) => ({ station: normSt(w.station), start: w.start, end: w.end }));
  dni.forEach((d) => {
    if (model) wymaganiaDnia(model, d, { typy: ['podstawowa'] }).instancje.forEach((x) => instancje.push({ id: 'i' + (++idI), ...x, zrodlo: 'model' }));
    wymLegacy(d).forEach((w) => instancje.push({ id: 'i' + (++idI), date: d, station: w.station, start: w.start, end: w.end, typ: 'podstawowa', rola: 'wymaganie', flexMin: 0, minH: 4, maxH: 12, krytyczne: definicjaStanowiska(model, w.station).krytyczne, zrodlo: 'formularz' }));
  });
  instancje.forEach((x) => { x.hours = round2(durMin(x.start, x.end) / 60); x.sa = dayNum(x.date) * 1440 + mn(x.start); x.ea = x.sa + durMin(x.start, x.end); });
  // istniejące zmiany pokrywają instancje (≥ 75 % długości, to samo stanowisko, ten dzień)
  const istOkres = (istniejace || []).filter((s) => s.date >= from && s.date <= to && s.start && s.end);
  const wolneIst = new Set(istOkres.map((s) => s.sid || `${s.accountId}|${s.date}|${s.start}`));
  instancje.forEach((x) => {
    const kand = istOkres.filter((s) => s.date === x.date && normSt(s.station) === x.station && wolneIst.has(s.sid || `${s.accountId}|${s.date}|${s.start}`)).map((s) => { const sa = dayNum(s.date) * 1440 + mn(s.start), ea = sa + durMin(s.start, s.end); const ov = Math.max(0, Math.min(ea, x.ea) - Math.max(sa, x.sa)); return { s, ov }; }).filter((k) => k.ov >= (x.ea - x.sa) * 0.75).sort((a, b) => b.ov - a.ov);
    if (kand.length) { x.pokrytaPrzez = kand[0].s.sid || kand[0].s.name; x.pokrytaIstniejaca = true; wolneIst.delete(kand[0].s.sid || `${kand[0].s.accountId}|${kand[0].s.date}|${kand[0].s.start}`); }
  });

  // ── budżet: JEDEN limit dla całego zespołu ────────────────────────────────────
  const godzIst = istOkres.reduce((a, s) => a + durMin(s.start, s.end) / 60, 0);
  const kontoZ = (s) => aktywne.find((k) => k.id === s.accountId) || aktywne.find((k) => norm(k.grafikName || k.name) === norm(s.name));
  const jestMgrZmiana = (s) => jestMgrStanowisko(s.station) || !!(kontoZ(s) && MGRF.has(kontoZ(s).funkcja));
  const godzIstMgr = istOkres.filter(jestMgrZmiana).reduce((a, s) => a + durMin(s.start, s.end) / 60, 0);
  const bazaDoObsadzenia = instancje.filter((x) => !x.pokrytaIstniejaca);
  const godzBaza = bazaDoObsadzenia.reduce((a, x) => a + x.hours, 0);
  const godzBazaMgr = bazaDoObsadzenia.filter((x) => jestMgrStanowisko(x.station)).reduce((a, x) => a + x.hours, 0);
  let limitH = Number(aop.totalHours) || Number(aop.hoursAop) || 0; let limitZrodlo = limitH ? 'total' : null;
  if (!limitH && Number(aop.crewHoursMax) > 0) { limitH = round2(Number(aop.crewHoursMax) + godzIstMgr + godzBazaMgr); limitZrodlo = 'crew+mgr'; }
  const budzetDodatkowy = limitH ? Math.max(0, limitH - godzIst - godzBaza) : 0;

  const kwalWstepna = (a, st) => {
    if (jestMgrStanowisko(st)) {
      const q = kwalifikacja(matrix, a, st);
      if (q.zatwierdzone && q.poziom >= 2) return { ok: true, poziom: q.poziom, zrodlo: q.zrodlo };
      if (maDaneKwalifikacji(matrix, a)) return { ok: false, powod: MGRF.has(a.funkcja) ? `brak kwalifikacji: ${st}` : 'nie kierownik' };   // macierz rozstrzyga
      return MGRF.has(a.funkcja) ? { ok: true, poziom: 2, zrodlo: 'funkcja' } : { ok: false, powod: 'nie kierownik' };
    }
    if (MGRF.has(a.funkcja) && !opts.kierownicyNaCrew) return { ok: false, powod: 'kierownik (stanowisko crew)' };
    const q = kwalifikacja(matrix, a, st);
    if (q.zrodlo === 'brak' && maDaneKwalifikacji(matrix, a)) return { ok: false, powod: `brak kwalifikacji: ${st}` };   // osoba ma macierz, stanowiska w niej nie ma = brak uprawnienia
    if (q.zatwierdzone) return q.poziom >= 2 ? { ok: true, poziom: q.poziom, zrodlo: q.zrodlo } : q.poziom === 1 ? { ok: true, poziom: 1, zrodlo: q.zrodlo, nadzor: true } : { ok: false, powod: `brak kwalifikacji: ${st}` };
    const af = (nawyki[a.id] || { afinicznosc: {} }).afinicznosc[st] || 0;
    if (af >= 0.05) return { ok: true, poziom: 2, zrodlo: 'historia', niepotwierdzona: true, af };
    return { ok: true, poziom: 0, zrodlo: 'brak', niepotwierdzona: true, bezHistorii: true, af };   // ostatnia deska ratunku — jawnie oznaczona
  };
  const kwal = kwalWstepna;
  // ── 2. obsada dodatkowa z prognozy ────────────────────────────────────────────
  const rozklad = rozkladDni(dni, aop, salesHist);
  const profilDow = (dw) => hourlyProfile && hourlyProfile[String(dw)] ? hourlyProfile[String(dw)] : null;
  const perDzien = []; let budzetPozostaly = budzetDodatkowy;
  // stanowiska obsady dodatkowej: produkcyjne z modelu (albo z wymagań i historii zespołu), tylko z niepustą pulą kandydatów
  const maPule = (st) => aktywne.some((a) => { const k = kwalWstepna(a, st); return k.ok && !k.bezHistorii; });
  const zHistorii = Object.entries(Object.values(nawyki).reduce((acc, m) => { Object.entries(m.afinicznosc || {}).forEach(([st, p]) => { acc[st] = (acc[st] || 0) + p; }); return acc; }, {})).sort((a, b) => b[1] - a[1]).map(([st]) => st);
  const stacjeProd = (model ? [...new Set(model.biblioteka.map((t) => normSt(t.station)))] : [...new Set([...instancje.map((x) => x.station), ...zHistorii])]).filter((st) => st && st !== 'OBSADA' && !jestMgrStanowisko(st) && !definicjaStanowiska(model, st).zadanieOkresowe && !['ZMYWAK'].includes(st) && maPule(st));
  const stacjeDod = stacjeProd.length ? stacjeProd : STACJE_PRODUKCYJNE.filter(maPule).slice(0, 3);
  rozklad.forEach((r) => {
    const wym96 = Number(aop.sales) > 0 ? na96(krzywaDnia(r.sales, splh, profilDow(r.dow), opts.podloga || 1)) : new Array(SLOTOW).fill(0);
    const baza = new Array(SLOTOW).fill(0); const bazaSt = {};
    const dodajPokrycie = (st, start, end, waga) => { for (let i = slotOd(start); i < slotDo(start, end); i++) { baza[i] += waga; if (waga === 1) (bazaSt[st] = bazaSt[st] || new Array(SLOTOW).fill(0))[i]++; } };
    instancje.filter((x) => x.date === r.date).forEach((x) => dodajPokrycie(x.station, x.start, x.end, jestMgrStanowisko(x.station) ? (definicjaStanowiska(model, x.station).admin ? 0 : mgrUdzial) : 1));
    istOkres.filter((s) => s.date === r.date && !instancje.some((x) => x.pokrytaPrzez === (s.sid || s.name) && x.date === s.date)).forEach((s) => dodajPokrycie(normSt(s.station), s.start, s.end, jestMgrZmiana(s) ? (definicjaStanowiska(model, s.station).admin ? 0 : mgrUdzial) : 1));
    const deficyt = wym96.map((w, i) => Math.max(0, w - baza[i]));
    let dodane = 0, dodaneH = 0;
    // (a) szablony dodatkowe z modelu, jeśli prognoza ich potrzebuje
    if (model) wymaganiaDnia(model, r.date, { typy: ['dodatkowa'] }).instancje.forEach((x) => {
      const a = slotOd(x.start), b = slotDo(x.start, x.end); const h = durMin(x.start, x.end) / 60;
      if (h < 3) return;   // fragmenty krótsze niż 3 h nie są dyżurem
      const srDef = deficyt.slice(a, b).reduce((s, v) => s + v, 0) / Math.max(1, b - a);
      if (srDef >= 0.5 && budzetPozostaly >= h) { instancje.push({ id: 'i' + (++idI), ...x, hours: round2(h), sa: dayNum(x.date) * 1440 + mn(x.start), ea: dayNum(x.date) * 1440 + mn(x.start) + durMin(x.start, x.end), zrodlo: 'model-dodatkowa' }); for (let i = a; i < b; i++) { deficyt[i] = Math.max(0, deficyt[i] - 1); baza[i]++; } (bazaSt[x.station] = bazaSt[x.station] || new Array(SLOTOW).fill(0)); for (let i = a; i < b; i++) bazaSt[x.station][i]++; budzetPozostaly -= h; dodane++; dodaneH += h; }
    });
    // (b) bloki dopełniające: długość 8/6/5/4 h, start co 30 min, największe pokrycie deficytu na godzinę
    let guard = 0;
    while (budzetPozostaly >= 4 && deficyt.some((v) => v > 0) && guard++ < 40) {
      let best = null;
      for (const bh of [8, 6, 5, 4]) { if (bh > budzetPozostaly + 1e-9) continue; const len = bh * 4; for (let s = 0; s + len <= SLOTOW; s += 2) { let gain = 0; for (let i = s; i < s + len; i++) gain += deficyt[i] > 0 ? 1 : 0; const sc = gain / len + gain * 0.002; if (gain >= len * 0.5 && (!best || sc > best.sc + 1e-9)) best = { s, len, sc, bh }; } }
      if (!best) break;
      // stanowisko: produkcyjne z najniższym stosunkiem obsady do udziału w obsadzie podstawowej w tym oknie
      let st = stacjeDod[0], najn = Infinity;
      stacjeDod.forEach((k) => { const b = bazaSt[k] || new Array(SLOTOW).fill(0); const w = b.slice(best.s, best.s + best.len).reduce((x, y) => x + y, 0); const wsz = Object.values(bazaSt).reduce((x, arr) => x + arr.slice(best.s, best.s + best.len).reduce((p, q) => p + q, 0), 0) || 1; const udz = w / wsz; const ratio = udz / (1 / stacjeDod.length); if (ratio < najn) { najn = ratio; st = k; } });
      const start = slotCzas(best.s), end = slotCzas(best.s + best.len);
      instancje.push({ id: 'i' + (++idI), date: r.date, station: st, start, end, typ: 'dodatkowa', rola: 'popyt', flexMin: 60, minH: 4, maxH: 10, krytyczne: false, hours: best.bh, sa: dayNum(r.date) * 1440 + mn(start), ea: dayNum(r.date) * 1440 + mn(start) + best.bh * 60, zrodlo: 'prognoza' });
      for (let i = best.s; i < best.s + best.len; i++) { deficyt[i] = Math.max(0, deficyt[i] - 1); baza[i]++; } (bazaSt[st] = bazaSt[st] || new Array(SLOTOW).fill(0)); for (let i = best.s; i < best.s + best.len; i++) bazaSt[st][i]++;
      budzetPozostaly -= best.bh; dodane++; dodaneH += best.bh;
    }
    perDzien.push({ date: r.date, dow: r.dow, sales: r.sales, trx: r.trx, podstawowaH: round2(instancje.filter((x) => x.date === r.date && x.typ === 'podstawowa').reduce((a, x) => a + x.hours, 0)), dodatkowaH: round2(dodaneH), dodatkowych: dodane, deficytPopytuH: round2(deficyt.reduce((a, v) => a + v, 0) / 4), szczyt: Math.max(...wym96) });
  });

  // ── kandydaci: filtry statyczne (kwalifikacja, absencja, dyspozycja, funkcja) ──
  const absZ = (aid, d) => absences.some((x) => x.accountId === aid && x.status === 'approved' && x.from <= d && d <= x.to);
  const dyspoZ = (aid, d) => { const moje = avail.filter((r) => r.accountId === aid && r.status === 'approved' && dyspozycjaObowiazuje(r, d)); return moje.find((r) => r.date === d) || moje[0] || null; };
  const miesiaceDekl = new Map(); avail.forEach((r) => { if (r.status !== 'approved' || !r.accountId) return; const s = miesiaceDekl.get(r.accountId) || new Set(); s.add(String(r.date).slice(0, 7)); if (r.recurrence === 'weekly') s.add('*'); miesiaceDekl.set(r.accountId, s); });
  const maDekl = (aid, d) => { const s = miesiaceDekl.get(aid); return !!(s && (s.has(d.slice(0, 7)) || s.has('*'))); };
  const oknoOk = (rq, start, end) => { const ok = ocenOknoDyspozycji(rq, start, end); if (!ok) return null; if (interpretacja2359 === 'do-zamkniecia' && (ok.kod === 'do' || ok.kod === 'okno') && ['23:59', '00:00', '24:00'].includes(String(rq.endTime || '')) && mn(end) <= mn(start) && (ok.kod === 'do' || mn(start) >= mn(rq.startTime || '00:00'))) return null; return ok; };
  const statyczny = (a, x) => {
    if (absZ(a.id, x.date)) return 'absencja';
    const dy = dyspoZ(a.id, x.date);
    if (dy) { const ok = oknoOk(dy, x.start, x.end); if (ok) return ok.kod === 'niedostepny' ? 'niedostępny' : ok.opis; }
    else if (opts.pustyDzienNiedostepny !== false && maDekl(a.id, x.date)) return 'brak dyspozycji na ten dzień';
    const k = kwal(a, x.station); if (!k.ok) return k.powod;
    const c = cele[a.id]; if (c && c.max != null && x.hours > c.max) return 'ponad limit godzin';
    return null;
  };
  const pula = (x) => { const okK = [], slabi = [], powody = {}; aktywne.forEach((a) => { const p = statyczny(a, x); if (p) { powody[p] = (powody[p] || 0) + 1; return; } const k = kwal(a, x.station); (k.bezHistorii ? slabi : okK).push(a); }); return { okK, slabi, powody }; };

  // ── 3. wykonalność przed przypisaniem ─────────────────────────────────────────
  const doObsadzenia = instancje.filter((x) => !x.pokrytaIstniejaca);
  doObsadzenia.forEach((x) => { const p = pula(x); x.kandydatow = p.okK.length; x.kandydatowSlabych = p.slabi.length; x.powodyStat = p.powody; });
  const stacjeWym = [...new Set(instancje.map((x) => x.station))];
  const puleStanowisk = {};
  stacjeWym.forEach((st) => { const q = aktywne.filter((a) => kwal(a, st).ok && !kwal(a, st).niepotwierdzona).length; const h = aktywne.filter((a) => { const k = kwal(a, st); return k.ok && k.zrodlo === 'historia'; }).length; let maxRownoczesnie = 0; dni.forEach((d) => { const arr = new Array(SLOTOW).fill(0); instancje.filter((x) => x.date === d && x.station === st).forEach((x) => { for (let i = slotOd(x.start); i < slotDo(x.start, x.end); i++) arr[i]++; }); maxRownoczesnie = Math.max(maxRownoczesnie, ...arr); }); puleStanowisk[st] = { potwierdzeni: q, zHistorii: h, maxRownoczesnie, godzinOkres: round2(instancje.filter((x) => x.station === st).reduce((a, x) => a + x.hours, 0)) }; });
  const problemyWyk = [];
  if (limitH && godzIst + godzBaza > limitH + 0.01) problemyWyk.push({ typ: 'budzet', waga: 'krytyczna', opis: `Obsada podstawowa (${round2(godzBaza)} h) z istniejącymi zmianami (${round2(godzIst)} h) przekracza limit ${limitH} h o ${round2(godzIst + godzBaza - limitH)} h.`, naprawa: 'Zmniejsz liczbę szablonów podstawowych w modelu pracy albo podnieś limit godzin.' });
  Object.entries(puleStanowisk).forEach(([st, p]) => { if (p.potwierdzeni + p.zHistorii === 0) problemyWyk.push({ typ: 'pula', waga: 'krytyczna', station: st, opis: `${st}: nikt nie ma potwierdzonej kwalifikacji ani historii na tym stanowisku (wymagane ${p.godzinOkres} h).`, naprawa: 'Uzupełnij macierz kwalifikacji albo zmień stanowisko w szablonie.' }); else if (p.potwierdzeni + p.zHistorii < p.maxRownoczesnie + 1) problemyWyk.push({ typ: 'pula', waga: 'wazna', station: st, opis: `${st}: pula ${p.potwierdzeni + p.zHistorii} osób przy ${p.maxRownoczesnie} wymaganych równocześnie — brak rezerwy na dni wolne i absencje.`, naprawa: 'Przeszkol dodatkowe osoby albo wpisz je do macierzy.' }); else if (p.potwierdzeni === 0) problemyWyk.push({ typ: 'kwalifikacje', waga: 'wazna', station: st, opis: `${st}: kandydaci tylko z historii (${p.zHistorii}), bez potwierdzenia w macierzy.`, naprawa: 'Zatwierdź propozycje kwalifikacji w Pracownikach.' }); });
  const bezKand = doObsadzenia.filter((x) => x.kandydatow === 0);
  bezKand.forEach((x) => problemyWyk.push({ typ: 'instancja', waga: x.typ === 'podstawowa' ? (x.krytyczne ? 'krytyczna' : 'wazna') : 'info', date: x.date, station: x.station, od: x.start, do: x.end, opis: `${x.date}, ${x.station} ${x.start}–${x.end}: ${x.kandydatowSlabych ? `tylko ${x.kandydatowSlabych} kandydatów bez historii stanowiska` : 'brak kandydata'} (${Object.entries(x.powodyStat).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(', ')}).`, naprawa: 'Zbierz dyspozycje na ten dzień, przeszkol osobę albo zmień godziny szablonu.' }));
  const wykonalnosc = { ok: !problemyWyk.some((p) => p.waga === 'krytyczna'), problemy: problemyWyk, puleStanowisk, instancjiBezKandydata: bezKand.length, trybKwalifikacji: trybKw, osobBezDanychKwalifikacji: stanKw.bezDanych.length };

  // ── 4. przypisanie całego okresu ──────────────────────────────────────────────
  const stan = {}; aktywne.forEach((a) => { stan[a.id] = { bloki: [], godz: 0, dni: new Set(), ostatnie: {} }; });
  const dodajBlok = (aid, sa, ea, date, st, liczGodz = true) => { const s = stan[aid]; if (!s) return; s.bloki.push([sa, ea]); if (liczGodz) s.godz += (ea - sa) / 60; s.dni.add(date); if (st) s.ostatnie[date] = { st, start: sa % 1440 }; };
  istOkres.forEach((s) => { const k = kontoZ(s); if (k) dodajBlok(k.id, dayNum(s.date) * 1440 + mn(s.start), dayNum(s.date) * 1440 + mn(s.start) + durMin(s.start, s.end), s.date, normSt(s.station)); });
  (sasiednie || []).forEach((s) => { const k = kontoZ(s); if (k) dodajBlok(k.id, dayNum(s.date) * 1440 + mn(s.start), dayNum(s.date) * 1440 + mn(s.start) + durMin(s.start, s.end), s.date, normSt(s.station), false); });
  const dniZRzedu = (st, d) => { let n = 0, k = dayNum(d) - 1; while (st.dni.has(isoOf(k))) { n++; k--; } return n; };
  const blokPo = (st, sa, ea) => { let a = sa, b = ea; let zm = true; while (zm) { zm = false; for (const [bs, be] of st.bloki) { if (bs <= b + 1 && be >= a - 1) { if (bs < a) { a = bs; zm = true; } if (be > b) { b = be; zm = true; } } } } return b - a; };
  const twardeDyn = (a, sa, ea, d, h) => {
    const st = stan[a.id];
    for (const [bs, be] of st.bloki) {
      if (sa < be && ea > bs) return 'nakładanie';
      if (bs >= ea && bs - ea < 660 && bs - ea > 1) return 'odpoczynek 11 h';
      if (sa >= be && sa - be < 660 && sa - be > 1) return 'odpoczynek 11 h';
    }
    if (blokPo(st, sa, ea) > 720) return '12 h w dobie';
    if (dniZRzedu(st, d) >= 6) return '7. dzień z rzędu';
    const c = cele[a.id]; if (c && c.max != null && st.godz + h > c.max + 1e-9) return 'limit godzin osoby';
    return null;
  };
  const rzadkie = {}; stacjeWym.forEach((st) => { if (!definicjaStanowiska(model, st).krytyczne) return; const os = aktywne.filter((a) => { const k = kwal(a, st); return k.ok && !k.bezHistorii; }); if (os.length <= 3) os.forEach((a) => (rzadkie[a.id] = rzadkie[a.id] || []).push(st)); });
  const ocena = (a, x, k) => {
    const m = nawyki[a.id] || { afinicznosc: {}, startPref: [], dowPref: [] };
    const st = stan[a.id];
    const kw = k.zrodlo === 'historia' ? 0.55 : k.poziom >= 3 ? 1 : k.poziom === 2 ? 0.9 : k.poziom === 1 ? 0.4 : 0.1;
    const af = m.afinicznosc[x.station] || 0;
    const sp = m.startPref && m.startPref.length ? Math.min(1.5, m.startPref[Math.floor(mn(x.start) / 60)] * 6) : 0.25;
    const dp = m.dowPref && m.dowPref.length ? Math.min(1.5, m.dowPref[dowOf(x.date)] * 7) : 1;
    const c = cele[a.id] || {}; const fair = c.cel ? Math.max(-1, Math.min(1, (c.cel - st.godz) / c.cel)) : c.max ? Math.max(-1, 1 - st.godz / c.max) : 0;
    const dy = dyspoZ(a.id, x.date); const dost = dy && dy.type === 'available' ? 1 : dy ? 0.7 : 0.3;
    const ciag = Math.max(0, dniZRzedu(st, x.date) - 4);
    const wczoraj = st.ostatnie[isoOf(dayNum(x.date) - 1)]; const kont = wczoraj && wczoraj.st === x.station && Math.abs(wczoraj.start - mn(x.start)) <= 120 ? 1 : 0;
    const rz = (rzadkie[a.id] || []).some((s2) => s2 !== x.station && instancje.some((y) => y.date === x.date && y.station === s2 && !y.accountId && !y.pokrytaIstniejaca && y.id !== x.id)) ? 1 : 0;
    return W.kwal * kw + W.afin * af + W.start * sp + W.dow * dp + W.fair * fair + W.dost * dost - W.ciag * ciag + W.kontynuacja * kont - W.rzadkosc * rz + rand() * 0.05;
  };
  const sprobuj = (x, { bezSlabych = false, wyklucz = null } = {}) => {
    const sa = x.sa, ea = x.ea; let best = null; const odrzuceni = {};
    for (const a of aktywne) {
      if (wyklucz && wyklucz.has(a.id)) continue;
      const p1 = statyczny(a, x); if (p1) { odrzuceni[p1] = (odrzuceni[p1] || 0) + 1; continue; }
      const k = kwal(a, x.station); if (bezSlabych && k.bezHistorii) { odrzuceni['bez historii stanowiska'] = (odrzuceni['bez historii stanowiska'] || 0) + 1; continue; }
      if (k.nadzor && !instancje.some((y) => y.date === x.date && y.station === x.station && y.accountId && y.accountId !== a.id && y.sa <= sa && y.ea >= ea && y.poziomKw >= 2)) { odrzuceni['w szkoleniu bez nadzoru'] = (odrzuceni['w szkoleniu bez nadzoru'] || 0) + 1; continue; }
      const p2 = twardeDyn(a, sa, ea, x.date, x.hours); if (p2) { odrzuceni[p2] = (odrzuceni[p2] || 0) + 1; continue; }
      const sc = ocena(a, x, k) - (k.bezHistorii ? 3 : 0);
      if (!best || sc > best.sc) best = { a, sc, k };
    }
    return { best, odrzuceni };
  };
  const przypiszDo = (x, best, naprawa = null) => {
    x.accountId = best.a.id; x.name = best.a.grafikName || best.a.name; x.display = best.a.name; x.score = round2(best.sc); x.poziomKw = best.k.poziom; x.kwalifikacjaZrodlo = best.k.zrodlo;
    if (best.k.niepotwierdzona) x.kwalifikacjaNiepotwierdzona = true; if (best.k.bezHistorii) x.bezHistoriiStanowiska = true; if (best.k.nadzor) x.wSzkoleniu = true;
    x.afinicznosc = round2((nawyki[best.a.id] || { afinicznosc: {} }).afinicznosc[x.station] || 0);
    if (naprawa) x.naprawa = naprawa;
    dodajBlok(best.a.id, x.sa, x.ea, x.date, x.station);
  };
  const zdejmij = (x) => { const s = stan[x.accountId]; if (s) { s.bloki = s.bloki.filter(([a, b]) => !(a === x.sa && b === x.ea)); s.godz -= x.hours; if (!s.bloki.some(([a]) => Math.floor(a / 1440) === dayNum(x.date))) s.dni.delete(x.date); } delete x.accountId; delete x.name; delete x.display; delete x.naprawa; };
  const rank = (x) => (x.typ === 'podstawowa' ? 0 : 2) + (x.krytyczne ? 0 : 1);
  const kolejka = doObsadzenia.slice().sort((a, b) => rank(a) - rank(b) || (a.kandydatow || 0) - (b.kandydatow || 0) || a.date.localeCompare(b.date) || a.sa - b.sa);
  for (const x of kolejka) {
    let r = sprobuj(x, { bezSlabych: true });
    if (!r.best && x.typ === 'podstawowa') r = sprobuj(x);
    if (r.best) przypiszDo(x, r.best); else { x.nieobsadzona = true; x.powody = r.odrzuceni; }
  }

  // ── 5. naprawa luk (podstawowe, krytyczne najpierw) ───────────────────────────
  const luki = doObsadzenia.filter((x) => x.nieobsadzona && x.typ === 'podstawowa').sort((a, b) => (a.krytyczne ? 0 : 1) - (b.krytyczne ? 0 : 1) || a.date.localeCompare(b.date));
  const nowe = [];
  for (const x of luki) {
    const proby = [];
    // (a) przesunięcie w granicach elastyczności
    let ok = false;
    if (x.flexMin > 0) {
      for (let delta = 30; delta <= x.flexMin && !ok; delta += 30) for (const sgn of [-1, 1]) {
        const y = { ...x, start: hhmm(mn(x.start) + sgn * delta), end: hhmm(mn(x.end) + sgn * delta), sa: x.sa + sgn * delta, ea: x.ea + sgn * delta };
        const r = sprobuj(y, { bezSlabych: true });
        if (r.best) { Object.assign(x, { start: y.start, end: y.end, sa: y.sa, ea: y.ea }); delete x.nieobsadzona; delete x.powody; przypiszDo(x, r.best, `przesunięcie ${sgn > 0 ? '+' : '−'}${delta} min`); ok = true; break; }
      }
      proby.push(ok ? 'przesunięcie: tak' : `przesunięcie ±${x.flexMin} min: nikt`);
    }
    // (b) podział na dwa dyżury
    if (!ok && x.hours >= 2 * x.minH) {
      const mid = x.sa + Math.round((x.ea - x.sa) / 2 / 60) * 60;
      const p1 = { ...x, id: x.id + 'a', end: hhmm(mid), ea: mid, hours: round2((mid - x.sa) / 60) }, p2 = { ...x, id: x.id + 'b', start: hhmm(mid), sa: mid, hours: round2((x.ea - mid) / 60) };
      delete p1.nieobsadzona; delete p1.powody; delete p2.nieobsadzona; delete p2.powody;
      const r1 = sprobuj(p1, { bezSlabych: true }); if (r1.best) { przypiszDo(p1, r1.best, 'podział dyżuru'); const r2 = sprobuj(p2, { bezSlabych: true, wyklucz: new Set([p1.accountId]) }); if (r2.best) { przypiszDo(p2, r2.best, 'podział dyżuru'); x.zastapionaPrzez = [p1.id, p2.id]; x.podzielona = true; nowe.push(p1, p2); ok = true; } else zdejmij(p1); }
      proby.push(ok ? 'podział: tak' : 'podział na dwa dyżury: nikt na drugą część');
    }
    // (c) wydłużenie sąsiada na tym samym stanowisku (do 12 h bloku i limitu godzin)
    if (!ok) {
      const sas = instancje.filter((y) => y.accountId && y.date === x.date && y.station === x.station && (y.ea === x.sa || y.sa === x.ea));
      for (const y of sas) {
        const a = aktywne.find((k) => k.id === y.accountId); if (!a) continue;
        const przod = y.ea === x.sa; const nowySa = przod ? y.sa : x.sa, nowyEa = przod ? x.ea : y.ea;
        const h = (nowyEa - nowySa) / 60; const c = cele[a.id] || {};
        if (h > 12 || (c.max != null && stan[a.id].godz - y.hours + h > c.max + 1e-9)) continue;
        const dy = dyspoZ(a.id, x.date); if (dy && oknoOk(dy, hhmm(nowySa % 1440), hhmm(nowyEa % 1440))) continue;
        // odpoczynek po wydłużeniu
        const s = stan[a.id]; const inne = s.bloki.filter(([bs, be]) => !(bs === y.sa && be === y.ea)); if (inne.some(([bs, be]) => (bs >= nowyEa && bs - nowyEa < 660) || (nowySa >= be && nowySa - be < 660) || (nowySa < be && nowyEa > bs))) continue;
        s.bloki = inne; s.bloki.push([nowySa, nowyEa]); s.godz += h - y.hours;
        y.start = hhmm(nowySa % 1440); y.end = hhmm(nowyEa % 1440); y.sa = nowySa; y.ea = nowyEa; y.hours = round2(h); y.naprawa = `wydłużenie o ${x.hours} h (pokrywa ${x.start}–${x.end})`;
        x.pokrytaPrzez = y.id; x.pokrytaWydluzeniem = true; delete x.nieobsadzona; ok = true; break;
      }
      proby.push(ok ? 'wydłużenie sąsiada: tak' : 'wydłużenie sąsiada: brak (12 h / limit / dyspozycja)');
    }
    // (d) zamiana: osoba z obsady dodatkowej tego dnia, kwalifikowana tu
    if (!ok) {
      const dod = instancje.filter((y) => y.accountId && y.date === x.date && y.typ === 'dodatkowa' && y.sa < x.ea && y.ea > x.sa);
      for (const y of dod) {
        const a = aktywne.find((k) => k.id === y.accountId); if (!a) continue;
        const k = kwal(a, x.station); if (!k.ok || k.bezHistorii) continue;
        const zapis = { accountId: y.accountId, name: y.name, display: y.display };
        zdejmij(y);
        const p1 = statyczny(a, x); const p2 = p1 ? null : twardeDyn(a, x.sa, x.ea, x.date, x.hours);
        if (!p1 && !p2) { const sc = ocena(a, x, k); delete x.nieobsadzona; delete x.powody; przypiszDo(x, { a, sc, k }, `zamiana: ${a.name} z obsady dodatkowej ${y.start}–${y.end}`); const r = sprobuj(y, { bezSlabych: true, wyklucz: new Set([a.id]) }); if (r.best) przypiszDo(y, r.best, 'uzupełnienie po zamianie'); else { y.nieobsadzona = true; y.powody = r.odrzuceni; } ok = true; break; }
        // cofnij
        y.accountId = zapis.accountId; y.name = zapis.name; y.display = zapis.display; dodajBlok(a.id, y.sa, y.ea, y.date, y.station);
      }
      proby.push(ok ? 'zamiana: tak' : 'zamiana z obsadą dodatkową: nikt kwalifikowany');
    }
    x.proby = proby;
    if (!ok) { const top = Object.entries(x.powody || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(', '); x.wyjasnienie = `${x.date}, ${x.station} ${x.start}–${x.end}: brak obsady (${top || 'brak kandydatów'}). Próby: ${proby.join('; ')}. Sprawdź wcześniejszy start zmiany zamykającej, zastępstwo albo zbierz dyspozycję.`; }
  }
  instancje.push(...nowe);

  // ── 6. wynik, audyt, statusy ──────────────────────────────────────────────────
  const przypisania = instancje.filter((x) => !x.podzielona && !x.pokrytaIstniejaca && !x.pokrytaWydluzeniem).map((x) => ({ id: x.id, date: x.date, station: x.station, start: x.start, end: x.end, hours: x.hours, typ: x.typ, rola: x.rola, krytyczne: x.krytyczne, wymagana: x.typ === 'podstawowa', zrodlo: x.zrodlo, accountId: x.accountId || null, name: x.name || null, display: x.display || null, score: x.score, afinicznosc: x.afinicznosc, kwalifikacjaZrodlo: x.kwalifikacjaZrodlo, ...(x.kwalifikacjaNiepotwierdzona ? { kwalifikacjaNiepotwierdzona: true } : {}), ...(x.bezHistoriiStanowiska ? { bezHistoriiStanowiska: true } : {}), ...(x.wSzkoleniu ? { wSzkoleniu: true } : {}), ...(x.naprawa ? { naprawa: x.naprawa } : {}), ...(x.accountId ? {} : { nieobsadzona: true, powody: x.powody || {}, proby: x.proby || [], wyjasnienie: x.wyjasnienie || null }) }));
  const obsadzone = przypisania.filter((p) => p.accountId);
  const pokryteIst = instancje.filter((x) => x.pokrytaIstniejaca).length;
  const zmianyWynik = obsadzone.map((p) => ({ date: p.date, name: p.name, accountId: p.accountId, station: p.station, start: p.start, end: p.end, hours: p.hours }));
  const wszystkie = [...istOkres, ...zmianyWynik];
  const aud = audytGrafiku(wszystkie, { accounts, avail, absences, model, matrix, sasiednie, from, to, opts: { interpretacja2359, tolerancjaLukiMin: (model || {}).przekazanieMin || 0, mapa: opts.mapa !== false, dyspoWymagana: opts.pustyDzienNiedostepny !== false } });
  const zg = ocenZgodnosc([...wszystkie, ...(sasiednie || [])], accounts, { from: isoOf(dayNum(from) - 1), to: isoOf(dayNum(to) + 1) });
  const godzCrew = wszystkie.filter((s) => !jestMgrZmiana(s)).reduce((a, s) => a + durMin(s.start, s.end) / 60, 0);
  const godzMgrOper = wszystkie.filter((s) => jestMgrZmiana(s) && !definicjaStanowiska(model, s.station).admin).reduce((a, s) => a + durMin(s.start, s.end) / 60, 0);
  const godzMgrAdmin = wszystkie.filter((s) => jestMgrZmiana(s) && definicjaStanowiska(model, s.station).admin).reduce((a, s) => a + durMin(s.start, s.end) / 60, 0);
  const godzRazem = godzCrew + godzMgrOper + godzMgrAdmin;
  const bezStawki = new Map();
  const koszt = obsadzone.reduce((a, p) => { const k = accounts.find((x) => x.id === p.accountId); if (!k || !(Number(k.stawka) > 0)) { if (k) bezStawki.set(k.id, k.name); return a; } return a + (k.umowa === 'UOP' ? Number(k.stawka) / 160 * p.hours : Number(k.stawka) * p.hours); }, 0);
  const godzZeStawka = obsadzone.reduce((a, p) => { const k = accounts.find((x) => x.id === p.accountId); return a + (k && Number(k.stawka) > 0 ? p.hours : 0); }, 0);
  const godzObs = obsadzone.reduce((a, p) => a + p.hours, 0);
  const pokrycieStawek = godzObs ? round2(godzZeStawka / godzObs * 100) : 100;
  const deficytStanowisk = {};
  przypisania.filter((p) => p.wymagana && (!p.accountId || p.bezHistoriiStanowiska || p.kwalifikacjaNiepotwierdzona)).forEach((p) => { const d = deficytStanowisk[p.station] = deficytStanowisk[p.station] || { nieobsadzoneH: 0, bezKwalifikacjiH: 0, niepotwierdzoneH: 0, dni: new Set() }; if (!p.accountId) d.nieobsadzoneH += p.hours; else if (p.bezHistoriiStanowiska) d.bezKwalifikacjiH += p.hours; else d.niepotwierdzoneH += p.hours; d.dni.add(p.date); });
  Object.values(deficytStanowisk).forEach((d) => { d.nieobsadzoneH = round2(d.nieobsadzoneH); d.bezKwalifikacjiH = round2(d.bezKwalifikacjiH); d.niepotwierdzoneH = round2(d.niepotwierdzoneH); d.dni = d.dni.size; });
  const deficytTwardy = Object.fromEntries(Object.entries(deficytStanowisk).filter(([, d]) => d.nieobsadzoneH > 0 || d.bezKwalifikacjiH > 0));
  const wymaganeOgolem = instancje.filter((x) => x.typ === 'podstawowa' && !x.podzielona).length, wymaganeObsadzone = instancje.filter((x) => x.typ === 'podstawowa' && !x.podzielona && (x.accountId || x.pokrytaIstniejaca || x.pokrytaWydluzeniem)).length;
  const godzOsob = Object.fromEntries(aktywne.map((a) => { const c = cele[a.id] || {}; const g = round2(stan[a.id].godz); const odch = c.cel != null ? round2(g - c.cel) : null; const dniOs = [...stan[a.id].dni].filter((d) => d >= from && d <= to); const wyj = []; if (c.cel != null && g < c.cel - 4) { const brakDysp = dni.filter((d) => !stan[a.id].dni.has(d) && !dyspoZ(a.id, d) && maDekl(a.id, d)).length; const niedost = dni.filter((d) => { const dy = dyspoZ(a.id, d); return dy && dy.type === 'unavailable'; }).length; if (brakDysp) wyj.push(`brak dyspozycji w ${brakDysp} dniach`); if (niedost) wyj.push(`niedostępny w ${niedost} dniach`); if (!brakDysp && !niedost) wyj.push('za mało pasujących zmian w modelu'); } if (c.max != null && g >= c.max - 1e-9) wyj.push('osiągnięty limit maksimum'); return [a.id, { name: a.name, godz: g, cel: c.cel != null ? c.cel : null, min: c.min != null ? c.min : null, max: c.max != null ? c.max : null, zrodloCelu: c.zrodlo, nominal: c.cel != null ? c.cel : null, odchylenie: odch, dni: dniOs.length, weekendy: dniOs.filter((d) => dowOf(d) === 0 || dowOf(d) === 6).length, otwarcia: instancje.filter((x) => x.accountId === a.id && x.rola === 'otwarcie').length, zamkniecia: instancje.filter((x) => x.accountId === a.id && x.rola === 'zamkniecie').length, wyjasnienie: wyj.join('; ') || null }]; }));
  const kompletna = wymaganeOgolem > 0 && wymaganeObsadzone === wymaganeOgolem && !Object.keys(deficytTwardy).length && aud.podsumowanie.krytyczne === 0 && !(zg.summary && zg.summary.block);
  const lukiOut = przypisania.filter((p) => !p.accountId && p.wymagana).map((p) => ({ date: p.date, station: p.station, start: p.start, end: p.end, krytyczne: p.krytyczne, powody: p.powody, proby: p.proby, wyjasnienie: p.wyjasnienie }));
  return {
    okres: { from, to, dni: dni.length }, aop: { ...aop, splh, limitH: limitH || null, limitZrodlo: aop.limitZrodlo || limitZrodlo }, modelPracy: model ? { version: model.version, status: model.status, szablonow: model.biblioteka.length } : null,
    wykonalnosc,
    podsumowanie: {
      zmian: przypisania.length, obsadzone: obsadzone.length, nieobsadzone: przypisania.length - obsadzone.length, pokryteIstniejacymi: pokryteIst,
      podstawowych: wymaganeOgolem, podstawowychObsadzonych: wymaganeObsadzone, dodatkowych: przypisania.filter((p) => !p.wymagana).length,
      godzinyRazem: round2(godzRazem), godzinyCrew: round2(godzCrew), godzinyMgr: round2(godzMgrOper + godzMgrAdmin), godzinyMgrOperacyjne: round2(godzMgrOper), godzinyMgrAdministracyjne: round2(godzMgrAdmin), godzinyIstniejace: round2(godzIst),
      limitH: limitH || null, limitCrew: Number(aop.crewHoursMax) || null, wykorzystanieLimituPct: limitH ? round2(godzRazem / limitH * 100) : null, godzinyMgrIstniejace: round2(godzIstMgr),
      kosztSzac: bezStawki.size ? null : Math.round(koszt), kosztCzesciowy: Math.round(koszt), pokrycieStawekPct: pokrycieStawek, bezStawki: [...bezStawki.values()],
      sprzedazAOP: Number(aop.sales) || 0, colSzac: aop.sales && !bezStawki.size ? round2(koszt / Number(aop.sales) * 100) : null, mpt: Number(aop.transactions) > 0 ? round2(Number(aop.transactions) / Math.max(1, godzRazem)) : null,
      pokrycieWymagan: wymaganeOgolem ? round2(wymaganeObsadzone / wymaganeOgolem * 100) : 100, deficytPopytuH: round2(perDzien.reduce((a, d) => a + d.deficytPopytuH, 0)),
      deficytStanowisk, napraw: instancje.filter((x) => x.naprawa).length, naruszenia: zg.summary, audyt: aud.podsumowanie,
    },
    statusy: {
      budzet: limitH ? (godzRazem <= limitH + 0.01 ? 'ok' : 'przekroczony') : 'brak limitu',
      obsada: wymaganeOgolem && wymaganeObsadzone === wymaganeOgolem && !Object.keys(deficytTwardy).length ? 'pelna' : 'czesciowa',
      dane: { stawki: bezStawki.size ? `brak dla ${bezStawki.size} osób (${pokrycieStawek} % godzin ze stawką)` : 'ok', kwalifikacje: trybKw === 'macierz' ? 'macierz kwalifikacji' : trybKw === 'macierz-czesciowa' ? `macierz częściowa (${stanKw.bezDanych.length} osób bez danych — historia)` : 'tylko historia (brak macierzy)', modelPracy: model ? `zatwierdzony v${model.version}` : 'brak — wymagania z formularza' },
      kwalifikacje: Object.values(deficytStanowisk).some((d) => d.niepotwierdzoneH > 0 || d.bezKwalifikacjiH > 0) ? 'niepotwierdzone' : 'potwierdzone',
      reguly: zg.summary && zg.summary.block ? 'blokady' : zg.summary && zg.summary.warn ? 'ostrzezenia' : 'ok',
      operacyjnie: aud.podsumowanie.krytyczne ? 'luki krytyczne' : aud.podsumowanie.wazne ? 'do decyzji' : 'ok',
      wykonalnosc: wykonalnosc.ok ? 'ok' : 'problemy',
      kompletna,
    },
    luki: lukiOut, audyt: { podsumowanie: aud.podsumowanie, problemy: aud.problemy.slice(0, 150), perDate: aud.perDate }, mapa: aud.mapa,
    perDzien, przypisania, godzOsob, naruszenia: zg.violations.slice(0, 80),
    model: Object.fromEntries(Object.entries(nawyki).map(([id, m]) => [id, { grupa: m.grupa, n: m.n, top: m.topStanowiska, srGodzinMies: m.srGodzinMies }])),
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
  const sasiednie = []; const dPrzed = isoOf(dayNum(from) - 1), dPo = isoOf(dayNum(to) + 1);
  const ymS = [...new Set([...okresYm, dPrzed.slice(0, 7), dPo.slice(0, 7)])];
  for (const ym of ymS) { const m = await kv.get(`sched:${ym}`); if (m) (m.shifts || []).forEach((s) => { if (s.date >= from && s.date <= to) istniejace.push(s); else { if ((s.date === dPrzed || s.date === dPo) && s.accountId) sasiednie.push(s); if (okresYm.includes(ym)) historia.push(s); } }); }
  const sd = (await kv.get('sales:data')) || {};
  let hourlyProfile = null;
  try { const { profilGodzinowy, profilSrodDzienny } = await import('./sales.js'); hourlyProfile = profilGodzinowy(sd.hourly || {}).profil; if (!Object.keys(hourlyProfile || {}).length) { const sdz = profilSrodDzienny(sd.intraday); hourlyProfile = sdz ? sdz.hourlyDow : null; } } catch {}
  const absences = (await kv.get('absences:list')) || [];
  const avail = (await kv.get('avail:reqs')) || [];
  const workModel = await czytajModel();
  const matrix = (await kv.get('quals:matrix')) || {};
  const paramy = (await kv.get('params:planning')) || {};
  return { accounts, historia, salesHist: sd.sales || {}, hourlyProfile, absences, avail, istniejace, sasiednie, workModel, matrix, paramy };
}

const odchudz = (p) => { const { mapa, naruszenia, model, ...reszta } = p; return { ...reszta, audyt: p.audyt ? { podsumowanie: p.audyt.podsumowanie, perDate: p.audyt.perDate, problemy: (p.audyt.problemy || []).slice(0, 60) } : undefined }; };

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
      return res.json({ success: true, proposals: props.map((p) => ({ id: p.id, createdAt: p.createdAt, by: p.by, okres: p.okres, podsumowanie: p.podsumowanie, statusy: p.statusy, applied: !!p.applied })), proposal: (req.query || {}).id ? props.find((p) => p.id === req.query.id) || null : null });
    }
    if (req.method === 'POST' && (akcja === 'generate' || akcja === 'feasibility')) {
      const b = req.body || {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.from || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.to || '')) || b.from > b.to) return res.status(400).json({ success: false, error: 'Podaj poprawny okres od–do.' });
      const wymagania = (Array.isArray(b.wymagania) ? b.wymagania : []).filter((w) => w && w.station && /^\d{2}:\d{2}$/.test(w.start) && /^\d{2}:\d{2}$/.test(w.end)).map((w) => ({ station: String(w.station).toUpperCase(), start: w.start, end: w.end, dni: Array.isArray(w.dni) ? w.dni.map(Number) : [] }));
      const dane = await zbierzDane(b.from, b.to);
      const { zatwierdzonyPlan, czytajParametry } = await import('./month-plan.js');
      const paramy = await czytajParametry();
      const aop = { ...(b.aop || {}) }; let zrodloAop = 'manual';
      const mies = [...new Set([b.from.slice(0, 7), b.to.slice(0, 7)])];
      const udzialDni = (m) => { const [y, mm] = m.split('-').map(Number); const nDni = new Date(Date.UTC(y, mm, 0)).getUTCDate(); let dniW = 0; for (let d = 1; d <= nDni; d++) { const k = `${m}-${String(d).padStart(2, '0')}`; if (k >= b.from && k <= b.to) dniW++; } return dniW / nDni; };
      if (!(Number(aop.sales) > 0)) { let sS = 0, sT = 0, ok = false; for (const m of mies) { const mp = await zatwierdzonyPlan(m); if (!mp) continue; ok = true; sS += mp.sales * udzialDni(m); sT += mp.transactions * udzialDni(m); } if (ok) { aop.sales = Math.round(sS); aop.transactions = Math.round(sT); zrodloAop = 'month-plan'; } }
      // limit: godziny AOP całego zespołu z Planu miesiąca (hoursAop); zgodność wsteczna: crewHours → crew + kierownicy
      if (!(Number(aop.totalHours) > 0) && !(Number(aop.crewHoursMax) > 0)) { let sH = 0, sC = 0, okH = false, okC = false; for (const m of mies) { const mp = await zatwierdzonyPlan(m); if (!mp) continue; if (mp.hoursAop != null) { okH = true; sH += mp.hoursAop * udzialDni(m); } if (mp.crewHours != null) { okC = true; sC += mp.crewHours * udzialDni(m); } } if (okH) { aop.totalHours = Math.round(sH * 4) / 4; aop.limitZrodlo = 'month-plan:hoursAop'; } else if (okC) { aop.crewHoursMax = Math.round(sC * 4) / 4; aop.limitZrodlo = 'month-plan:crewHours'; } }
      const wynik = ulozGrafik({ from: b.from, to: b.to, aop, wymagania, seed: Number(b.seed) || 42, splh: Number(b.splh) || paramy.splh || 420, opts: { podloga: Number(b.podloga) || 1, interpretacja2359: b.interpretacja2359 || paramy.interpretacja2359, uzyjPropozycjiModelu: !!b.uzyjPropozycjiModelu, mapa: akcja === 'generate' } }, dane);
      wynik.aopZrodlo = zrodloAop;
      if (akcja === 'feasibility') return res.json({ success: true, wykonalnosc: wynik.wykonalnosc, aop: wynik.aop, modelPracy: wynik.modelPracy, statusy: { dane: wynik.statusy.dane }, podstawowych: wynik.podsumowanie.podstawowych });
      const prop = { id: 'ap' + Date.now().toString(36), createdAt: new Date().toISOString(), by: s.name, ...wynik, wymagania };
      const props = ((await kv.get(PROP_KEY)) || []).filter((p) => !p.applied).slice(0, 3).map(odchudz);
      props.unshift(prop);
      await kv.set(PROP_KEY, props);
      await audit({ ...aktor(s), action: 'autoplan.generate', target: `${b.from}..${b.to}`, after: { zmian: wynik.podsumowanie.zmian, obsadzone: wynik.podsumowanie.obsadzone, razemH: wynik.podsumowanie.godzinyRazem, kompletna: wynik.statusy.kompletna } });
      return res.json({ success: true, proposal: prop });
    }
    if (req.method === 'POST' && akcja === 'apply') {
      if (s.role !== 'asm') return res.status(403).json({ success: false, error: 'Zastosowanie propozycji wymaga roli ASM.' });
      const id = String((req.body || {}).id || '');
      const props = (await kv.get(PROP_KEY)) || [];
      const prop = props.find((p) => p.id === id);
      if (!prop) return res.status(404).json({ success: false, error: 'Nie znaleziono propozycji.' });
      const kompletna = !!(prop.statusy && prop.statusy.kompletna);
      const shifts = prop.przypisania.filter((p) => p.accountId).map((p) => ({ date: p.date, name: p.name, accountId: p.accountId, station: p.station, start: p.start, end: p.end, hours: p.hours, autoplan: prop.id, ...(kompletna ? {} : { draftNiekompletny: true }) }));
      prop.applied = new Date().toISOString(); prop.appliedBy = s.name;
      await kv.set(PROP_KEY, props);
      await audit({ ...aktor(s), action: 'autoplan.apply', target: id, after: { zmian: shifts.length, kompletna } });
      return res.json({ success: true, shifts, zmian: shifts.length, kompletna, nieobsadzone: prop.przypisania.filter((p) => !p.accountId).length });
    }
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
