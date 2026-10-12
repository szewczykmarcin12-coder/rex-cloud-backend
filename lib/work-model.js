import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit, aktor } from './audit.js';

// ═══════════════════════════════════════════════════════════════════════════════════
//  MODEL PRACY RESTAURACJI — słownik stanowisk + zatwierdzona biblioteka zmian operacyjnych
// ═══════════════════════════════════════════════════════════════════════════════════
//  Zapis: params:work-model = { version, status: 'brak'|'propozycja'|'zatwierdzony', biblioteka: [szablon],
//    stanowiska: { KOD: { krytyczne, zastepstwa: [KOD], admin } }, przekazanieMin, mgrOperacyjnyUdzial,
//    zrodlo: { plik, od, do }, approvedBy, approvedAt, uwagi: [] }
//  Szablon zmiany: { id, station, start, end, dni: [0..6], liczba, typ: 'podstawowa'|'dodatkowa',
//    rola: 'otwarcie'|'srodek'|'zamkniecie'|'zadanie', flexMin, minH, maxH, zadanieOkresowe, uwaga? }
//
//  Czas liczymy w dobie operacyjnej 06:00 → 06:00 w slotach 15 min (96 slotów). „16:00–02:00” to sloty 40..80.
//  Obsada PODSTAWOWA zapewnia działanie restauracji (otwarcie, środek, zamknięcie, zadania), obsada DODATKOWA
//  odpowiada na prognozowane obciążenie. Prognoza nie może usunąć obowiązkowego zamknięcia.
// ═══════════════════════════════════════════════════════════════════════════════════

export const MODEL_KEY = 'params:work-model';
export const KROK = 15;
export const SLOTOW = 96;
export const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

// Słownik stanowisk: FRYTKI i SMAŻENIE to osobne stanowiska (nie utożsamiamy automatycznie).
export const SLOWNIK_STANOWISK = [
  { kod: 'MANAGER', grupa: 'mgr', krytyczne: true, opis: 'Prowadzenie zmiany (obecność wymagana przez cały czas pracy restauracji)' },
  { kod: 'MGR FUNKCYJNE', grupa: 'mgr', krytyczne: false, admin: true, opis: 'Czas administracyjny kierownika (nie liczy się jako obsada produkcyjna)' },
  { kod: 'KONTROLER', grupa: 'front', krytyczne: true, opis: 'Kasa / wydawanie / kontrola zamówień' },
  { kod: 'KANAPKI / WRAPY', grupa: 'kuchnia', krytyczne: true, opis: 'Składanie kanapek i wrapów' },
  { kod: 'PANIEROWANIE', grupa: 'kuchnia', krytyczne: true, opis: 'Panierowanie kurczaka' },
  { kod: 'SMAŻENIE', grupa: 'kuchnia', krytyczne: true, opis: 'Frytownice — kurczak' },
  { kod: 'FRYTKI', grupa: 'kuchnia', krytyczne: false, opis: 'Frytki i dodatki (osobne stanowisko od SMAŻENIA)' },
  { kod: 'DESERY / NAPOJE', grupa: 'front', krytyczne: false },
  { kod: 'PHU', grupa: 'front', krytyczne: false, opis: 'Pakowanie / hold unit' },
  { kod: 'DISPATCHER', grupa: 'front', krytyczne: false, opis: 'Koordynacja dostaw i zamówień online' },
  { kod: 'WSPARCIE WIECZORNE / FLEX', grupa: 'wsparcie', krytyczne: false, zastepstwa: ['ZMYWAK', 'FRYTKI', 'PHU'] },
  { kod: 'ZMYWAK', grupa: 'wsparcie', krytyczne: false },
  { kod: 'PREP', grupa: 'wsparcie', krytyczne: false, zadanieOkresowe: true, opis: 'Przygotowanie produkcji — zadanie okresowe' },
  { kod: 'DOSTAWA', grupa: 'wsparcie', krytyczne: false, zadanieOkresowe: true, opis: 'Przyjęcie dostawy — zadanie okresowe, nie 8-godzinne stanowisko' },
];
const SLOWNIK = Object.fromEntries(SLOWNIK_STANOWISK.map((s) => [s.kod, s]));
export const definicjaStanowiska = (model, kod) => ({ kod: norm(kod), grupa: 'inne', krytyczne: false, ...(SLOWNIK[norm(kod)] || {}), ...(((model || {}).stanowiska || {})[norm(kod)] || {}) });
export const jestMgrStanowisko = (kod) => ['MANAGER', 'MGR FUNKCYJNE'].includes(norm(kod));
export const jestAdminStanowisko = (model, kod) => !!definicjaStanowiska(model, kod).admin;

export const MODEL_DOMYSLNY = { version: 0, status: 'brak', biblioteka: [], stanowiska: {}, przekazanieMin: 0, mgrOperacyjnyUdzial: 0.7, mgrNaZmianie: 1, uwagi: [] };

// ── czas ────────────────────────────────────────────────────────────────────────
export const mn = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
export const hhmm = (min) => `${String(Math.floor(((min % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((min % 60) + 60) % 60).padStart(2, '0')}`;
export const opMin = (t) => { let x = mn(t) - 360; if (x < 0) x += 1440; return x; };                 // minuty od 06:00
export const slotOd = (t) => Math.floor(opMin(t) / KROK);
export const slotDo = (start, end) => { const s = opMin(start); let e = opMin(end); if (e <= s) e += 1440; return Math.min(SLOTOW, Math.ceil(e / KROK)); };
export const slotCzas = (i) => hhmm(360 + i * KROK);
export const durMin = (a, b) => { let d = mn(b) - mn(a); if (d <= 0) d += 1440; return d; };
export const dowOf = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();
export const DNI_PL = ['Nd', 'Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'Sb'];

// ── odcinki zmiany: [{start, end, station}] — gdy brak, cała zmiana na s.station ──
export function odcinkiZmiany(s) {
  if (Array.isArray(s.segmenty) && s.segmenty.length) return s.segmenty.map((o) => ({ start: o.start, end: o.end, station: norm(o.station || s.station) }));
  return [{ start: s.start, end: s.end, station: norm(s.station) }];
}

// ── pokrycie slotów dnia: { [station]: Array(96) liczba osób }, osoby per slot ──
export function pokrycieDnia(shiftsDnia) {
  const out = {};
  (shiftsDnia || []).forEach((s) => {
    if (!s.start || !s.end || s.rola === 'instruktor') return;
    odcinkiZmiany(s).forEach((o) => {
      const st = o.station || 'OBSADA';
      const arr = out[st] = out[st] || new Array(SLOTOW).fill(0);
      for (let i = slotOd(o.start); i < slotDo(o.start, o.end); i++) arr[i]++;
    });
  });
  return out;
}

const rolaSzablonu = (station, start, end) => {
  const def = SLOWNIK[norm(station)] || {};
  if (def.zadanieOkresowe) return 'zadanie';
  const s = opMin(start); let e = opMin(end); if (e <= s) e += 1440;
  if (s <= 3 * 60) return 'otwarcie';          // start do 09:00
  if (e >= 16 * 60) return 'zamkniecie';       // koniec 22:00 lub później
  return 'srodek';
};

// przedziały ciągłe w tablicy boolowskiej slotów → [[a, b)]
const przedzialy = (arr) => { const out = []; let a = -1; for (let i = 0; i <= arr.length; i++) { const v = i < arr.length && arr[i]; if (v && a < 0) a = i; if (!v && a >= 0) { out.push([a, i]); a = -1; } } return out; };

// ── Wyprowadzenie biblioteki zmian z istniejącego grafiku (propozycja do zatwierdzenia) ──
//  Dla każdego stanowiska i dnia tygodnia: krzywa obsady per dzień → poziom występujący w ≥ progPodstawowa dni
//  (warstwa podstawowa) i ≥ progDodatkowa dni (dodatkowa). Warstwy rozkładamy na szablony; przedziały dłuższe
//  niż maxH dzielimy w najczęstszej rzeczywistej granicy zmian. Krótkie przerwy w warstwie podstawowej stanowisk
//  krytycznych uzupełniamy i oznaczamy jako „do potwierdzenia” — luka 16:00–18:00 w PANIEROWANIU nie staje się szablonem.
export function wyprowadzBiblioteke(shifts, opts = {}) {
  const { progPodstawowa = 0.5, progDodatkowa = 0.25, maxH = 10, minH = 4, minSzablonH = 3, lukaUzupelnijH = 2, from = null, to = null } = opts;
  const zm = (shifts || []).filter((s) => s.date && s.start && s.end && s.station && s.rola !== 'instruktor' && (!from || s.date >= from) && (!to || s.date <= to));
  const daty = [...new Set(zm.map((s) => s.date))].sort();
  const datyDow = [[], [], [], [], [], [], []]; daty.forEach((d) => datyDow[dowOf(d)].push(d));
  const wgDaty = {}; zm.forEach((s) => (wgDaty[s.date] = wgDaty[s.date] || []).push(s));
  const pokr = {}; daty.forEach((d) => { pokr[d] = pokrycieDnia(wgDaty[d]); });
  const stacje = [...new Set(zm.flatMap((s) => odcinkiZmiany(s).map((o) => o.station)))].filter(Boolean);
  const uwagi = []; const szablony = []; let idN = 0;
  const granice = (st, dw) => { const h = {}; zm.filter((s) => dowOf(s.date) === dw && norm(s.station) === st).forEach((s) => { [slotOd(s.start), slotDo(s.start, s.end)].forEach((x) => { h[x] = (h[x] || 0) + 1; }); }); return h; };
  const podziel = (a, b, gr) => {
    if ((b - a) * KROK / 60 <= maxH) return [[a, b]];
    const minS = Math.ceil(minH * 60 / KROK);
    let best = null;
    Object.entries(gr).forEach(([x, n]) => { const i = Number(x); if (i - a >= minS && b - i >= minS && (!best || n > best.n || (n === best.n && Math.abs(i - (a + b) / 2) < Math.abs(best.i - (a + b) / 2)))) best = { i, n }; });
    const i = best ? best.i : a + Math.round((b - a) / 2 / 4) * 4;
    return [...podziel(a, i, gr), ...podziel(i, b, gr)];
  };
  stacje.forEach((st) => {
    const def = SLOWNIK[st] || {};
    for (let dw = 0; dw < 7; dw++) {
      const dd = datyDow[dw]; if (!dd.length) continue;
      const krzywe = dd.map((d) => (pokr[d][st] || new Array(SLOTOW).fill(0)));
      const poziom = (prog) => { const out = new Array(SLOTOW).fill(0); for (let i = 0; i < SLOTOW; i++) { const v = krzywe.map((k) => k[i]).sort((x, y) => y - x); const idx = Math.ceil(dd.length * prog) - 1; out[i] = v[Math.max(0, Math.min(v.length - 1, idx))]; } return out; };
      const baza = poziom(progPodstawowa), dod = poziom(progDodatkowa);
      const gr = granice(st, dw);
      const warstwy = (krzywa, typ, odejmij = null) => {
        const maxK = Math.max(0, ...krzywa);
        for (let k = 1; k <= maxK; k++) {
          const maska = krzywa.map((v, i) => v >= k && !(odejmij && odejmij[i] >= k));
          let prz = przedzialy(maska);
          // uzupełnij krótkie przerwy w warstwie podstawowej (stanowiska krytyczne, poziom 1)
          if (typ === 'podstawowa' && k === 1 && def.krytyczne && prz.length > 1) {
            const scalone = [prz[0]];
            for (let j = 1; j < prz.length; j++) { const last = scalone[scalone.length - 1]; const luka = (prz[j][0] - last[1]) * KROK / 60; if (luka <= lukaUzupelnijH) { uwagi.push({ typ: 'luka-uzupelniona', station: st, dow: dw, od: slotCzas(last[1]), do: slotCzas(prz[j][0]), opis: `${st} ${DNI_PL[dw]}: w ≥ ${Math.round(progPodstawowa * 100)} % dni brak obsady ${slotCzas(last[1])}–${slotCzas(prz[j][0])} — w propozycji uzupełnione, potwierdź.` }); last[1] = prz[j][1]; } else scalone.push(prz[j]); }
            prz = scalone;
          }
          prz.forEach(([a, b]) => podziel(a, b, gr).forEach(([x, y]) => {
            if ((y - x) * KROK / 60 < (def.zadanieOkresowe ? 2 : minSzablonH)) return;   // krótkie fragmenty to nakładki przekazania, nie szablony
            szablony.push({ station: st, start: slotCzas(x), end: slotCzas(y), dow: dw, typ, k });
          }));
        }
      };
      warstwy(baza, 'podstawowa');
      warstwy(dod, 'dodatkowa', baza);
    }
  });
  // scalanie identycznych szablonów z różnych dni tygodnia
  const mapa = new Map();
  szablony.forEach((t) => { const key = `${t.station}|${t.start}|${t.end}|${t.typ}`; const e = mapa.get(key) || { ...t, dni: new Set(), liczbaDow: {} }; e.dni.add(t.dow); e.liczbaDow[t.dow] = (e.liczbaDow[t.dow] || 0) + 1; mapa.set(key, e); });
  const biblioteka = [...mapa.values()].map((t) => {
    const def = SLOWNIK[t.station] || {};
    const liczba = Math.max(...Object.values(t.liczbaDow));
    const h = durMin(t.start, t.end) / 60;
    return { id: 'tpl' + (++idN), station: t.station, start: t.start, end: t.end, dni: [...t.dni].sort(), liczba, liczbaDow: liczba > 1 ? t.liczbaDow : undefined, typ: t.typ, rola: rolaSzablonu(t.station, t.start, t.end), godzin: Math.round(h * 100) / 100, flexMin: def.zadanieOkresowe ? 120 : 60, minH: Math.min(minH, h), maxH: Math.max(maxH, h), zadanieOkresowe: !!def.zadanieOkresowe, krytyczne: !!def.krytyczne };
  }).sort((a, b) => a.station.localeCompare(b.station) || mn(a.start) - mn(b.start) || a.typ.localeCompare(b.typ));
  // zmiany > 12 h nie mogą zostać szablonem; informacja dla zatwierdzającego
  const dlugie = zm.filter((s) => durMin(s.start, s.end) > 720);
  if (dlugie.length) uwagi.push({ typ: 'zmiany-ponad-12h', liczba: dlugie.length, opis: `${dlugie.length} zmian w źródle trwa ponad 12 h — nie trafiają do szablonów jako wzorzec.` });
  const stanowiskaOut = {}; stacje.forEach((st) => { stanowiskaOut[st] = { krytyczne: !!(SLOWNIK[st] || {}).krytyczne, admin: !!(SLOWNIK[st] || {}).admin, zadanieOkresowe: !!(SLOWNIK[st] || {}).zadanieOkresowe, zastepstwa: (SLOWNIK[st] || {}).zastepstwa || [], wSlowniku: !!SLOWNIK[st] }; if (!SLOWNIK[st]) uwagi.push({ typ: 'stanowisko-poza-slownikiem', station: st, opis: `Stanowisko „${st}” nie występuje w słowniku — potwierdź nazwę albo dodaj do słownika.` }); });
  const godzBaza = biblioteka.filter((t) => t.typ === 'podstawowa').reduce((a, t) => a + t.godzin * t.liczba * t.dni.length, 0);
  const godzDod = biblioteka.filter((t) => t.typ === 'dodatkowa').reduce((a, t) => a + t.godzin * t.liczba * t.dni.length, 0);
  return { biblioteka, stanowiska: stanowiskaOut, uwagi, statystyki: { zmianZrodlowych: zm.length, dni: daty.length, od: daty[0] || null, do: daty[daty.length - 1] || null, szablonow: biblioteka.length, podstawowych: biblioteka.filter((t) => t.typ === 'podstawowa').length, godzinTygodniaPodstawa: Math.round(godzBaza), godzinTygodniaDodatkowa: Math.round(godzDod) } };
}

// ── Wymagania dnia z modelu: instancje szablonów + krzywe wymaganej obsady per stanowisko ──
export function wymaganiaDnia(model, date, opts = {}) {
  const { typy = ['podstawowa', 'dodatkowa'] } = opts;
  const dw = dowOf(date);
  const instancje = [];
  ((model || {}).biblioteka || []).filter((t) => typy.includes(t.typ) && (!t.dni || !t.dni.length || t.dni.includes(dw))).forEach((t) => {
    const n = t.liczbaDow && t.liczbaDow[dw] != null ? t.liczbaDow[dw] : (t.liczba || 1);
    for (let i = 0; i < n; i++) instancje.push({ tplId: t.id, date, station: norm(t.station), start: t.start, end: t.end, typ: t.typ, rola: t.rola || rolaSzablonu(t.station, t.start, t.end), flexMin: t.flexMin != null ? t.flexMin : 60, minH: t.minH || 4, maxH: t.maxH || 10, krytyczne: definicjaStanowiska(model, t.station).krytyczne, zadanieOkresowe: !!t.zadanieOkresowe, nr: i + 1 });
  });
  const wymagane = {};
  instancje.filter((x) => x.typ === 'podstawowa').forEach((x) => { const arr = wymagane[x.station] = wymagane[x.station] || new Array(SLOTOW).fill(0); for (let i = slotOd(x.start); i < slotDo(x.start, x.end); i++) arr[i]++; });
  return { date, dow: dw, instancje, wymagane };
}

// ── Zapis / odczyt ───────────────────────────────────────────────────────────────
export async function czytajModel() { return { ...MODEL_DOMYSLNY, ...((await kv.get(MODEL_KEY)) || {}) }; }
export async function zatwierdzonyModel() { const m = await czytajModel(); return m.status === 'zatwierdzony' && (m.biblioteka || []).length ? m : null; }

const czasOk = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
export function normalizujSzablon(t, i) {
  if (!t || !t.station || !czasOk(t.start) || !czasOk(t.end)) return null;
  const dni = Array.isArray(t.dni) ? t.dni.map(Number).filter((d) => d >= 0 && d <= 6) : [0, 1, 2, 3, 4, 5, 6];
  const h = durMin(t.start, t.end) / 60;
  if (h > 12) return null;
  return { id: String(t.id || 'tpl' + (i + 1)), station: norm(t.station), start: t.start, end: t.end, dni: [...new Set(dni)].sort(), liczba: Math.max(1, Math.min(6, Number(t.liczba) || 1)), liczbaDow: t.liczbaDow && typeof t.liczbaDow === 'object' ? t.liczbaDow : undefined, typ: t.typ === 'dodatkowa' ? 'dodatkowa' : 'podstawowa', rola: ['otwarcie', 'srodek', 'zamkniecie', 'zadanie'].includes(t.rola) ? t.rola : rolaSzablonu(t.station, t.start, t.end), godzin: Math.round(h * 100) / 100, flexMin: Math.max(0, Math.min(240, Number(t.flexMin) || 0)), minH: Math.max(2, Math.min(h, Number(t.minH) || 4)), maxH: Math.max(h, Math.min(12, Number(t.maxH) || 10)), zadanieOkresowe: !!t.zadanieOkresowe, krytyczne: !!t.krytyczne, nazwa: t.nazwa ? String(t.nazwa).slice(0, 60) : undefined };
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });
  try {
    const akcja = (req.query || {}).action || '';
    if (req.method === 'GET') {
      if (!(await requireRole(req, res, ['asm', 'kierownik']))) return;
      const model = await czytajModel();
      if (akcja === 'dzien') { const d = String((req.query || {}).date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ success: false, error: 'Podaj datę.' }); return res.json({ success: true, ...wymaganiaDnia(model, d) }); }
      return res.json({ success: true, model, slownik: SLOWNIK_STANOWISK });
    }
    const s = await requireRole(req, res, ['asm']);
    if (!s) return;
    // POST ?action=derive {from, to} — propozycja biblioteki z grafiku w bazie (albo body.shifts)
    if (req.method === 'POST' && akcja === 'derive') {
      const b = req.body || {};
      let shifts = Array.isArray(b.shifts) ? b.shifts : null;
      if (!shifts) {
        const yms = [...new Set([String(b.from || '').slice(0, 7), String(b.to || '').slice(0, 7)].filter((x) => /^\d{4}-\d{2}$/.test(x)))];
        shifts = []; for (const ym of yms) { const m = await kv.get(`sched:${ym}`); if (m) shifts.push(...(m.shifts || [])); }
      }
      if (!shifts.length) return res.status(400).json({ success: false, error: 'Brak zmian do analizy — wskaż okres z grafikiem albo prześlij zmiany.' });
      const w = wyprowadzBiblioteke(shifts, { from: b.from || null, to: b.to || null, progPodstawowa: Number(b.progPodstawowa) || 0.5, progDodatkowa: Number(b.progDodatkowa) || 0.25 });
      const przed = await czytajModel();
      const model = { ...przed, version: (przed.version || 0) + 1, status: 'propozycja', biblioteka: w.biblioteka, stanowiska: { ...(przed.stanowiska || {}), ...Object.fromEntries(Object.entries(w.stanowiska).map(([k, v]) => [k, { ...(przed.stanowiska || {})[k], krytyczne: v.krytyczne, admin: v.admin, zadanieOkresowe: v.zadanieOkresowe, zastepstwa: ((przed.stanowiska || {})[k] || {}).zastepstwa || v.zastepstwa }])) }, uwagi: w.uwagi, zrodlo: { plik: b.plik || null, od: w.statystyki.od, do: w.statystyki.do, zmian: w.statystyki.zmianZrodlowych }, statystyki: w.statystyki, proposedAt: new Date().toISOString(), proposedBy: s.name, approvedAt: null, approvedBy: null };
      await kv.set(MODEL_KEY, model);
      await audit({ ...aktor(s), action: 'work-model.derive', target: `${w.statystyki.od}..${w.statystyki.do}`, after: { szablonow: w.biblioteka.length } });
      return res.json({ success: true, model, slownik: SLOWNIK_STANOWISK });
    }
    // PUT — edycja biblioteki / parametrów (status wraca do propozycji), ?action=approve — zatwierdzenie
    if (req.method === 'PUT' || (req.method === 'POST' && akcja === 'save')) {
      const b = req.body || {}; const przed = await czytajModel();
      const biblioteka = Array.isArray(b.biblioteka) ? b.biblioteka.map(normalizujSzablon).filter(Boolean) : przed.biblioteka;
      const stanowiska = b.stanowiska && typeof b.stanowiska === 'object' ? Object.fromEntries(Object.entries(b.stanowiska).map(([k, v]) => [norm(k), { krytyczne: !!v.krytyczne, admin: !!v.admin, zadanieOkresowe: !!v.zadanieOkresowe, zastepstwa: Array.isArray(v.zastepstwa) ? v.zastepstwa.map(norm) : [] }])) : przed.stanowiska;
      const model = { ...przed, version: (przed.version || 0) + 1, status: 'propozycja', biblioteka, stanowiska, przekazanieMin: b.przekazanieMin != null ? Math.max(0, Math.min(60, Number(b.przekazanieMin) || 0)) : przed.przekazanieMin, mgrOperacyjnyUdzial: b.mgrOperacyjnyUdzial != null ? Math.max(0, Math.min(1, Number(b.mgrOperacyjnyUdzial))) : przed.mgrOperacyjnyUdzial, mgrNaZmianie: b.mgrNaZmianie != null ? Math.max(0, Math.min(3, Number(b.mgrNaZmianie) || 0)) : przed.mgrNaZmianie, approvedAt: null, approvedBy: null, updatedAt: new Date().toISOString(), updatedBy: s.name };
      await kv.set(MODEL_KEY, model);
      await audit({ ...aktor(s), action: 'work-model.save', after: { szablonow: biblioteka.length, version: model.version } });
      return res.json({ success: true, model });
    }
    if (req.method === 'POST' && akcja === 'approve') {
      const przed = await czytajModel();
      if (!(przed.biblioteka || []).length) return res.status(400).json({ success: false, error: 'Biblioteka zmian jest pusta — nie ma czego zatwierdzić.' });
      const model = { ...przed, status: 'zatwierdzony', approvedAt: new Date().toISOString(), approvedBy: s.name };
      await kv.set(MODEL_KEY, model);
      await audit({ ...aktor(s), action: 'work-model.approve', after: { version: model.version, szablonow: model.biblioteka.length } });
      return res.json({ success: true, model });
    }
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
