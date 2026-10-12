import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { dyspozycjaObowiazuje, ocenOknoDyspozycji } from './availability.js';
import { SLOTOW, KROK, norm, mn, slotOd, slotDo, slotCzas, durMin, odcinkiZmiany, pokrycieDnia, wymaganiaDnia, definicjaStanowiska, jestMgrStanowisko, czytajModel } from './work-model.js';

// ═══════════════════════════════════════════════════════════════════════════════════
//  AUDYT GRAFIKU — jakość operacyjna przed wskaźnikami zbiorczymi
// ═══════════════════════════════════════════════════════════════════════════════════
//  Jedna funkcja audytGrafiku(shifts, ctx) dla: autoplanu (kontrola po wygenerowaniu), bramki publikacji,
//  widoku Grafiku i zestawu testów. Każdy problem ma kod, wagę, dzień, przedział, osobę/stanowisko, opis
//  i propozycję naprawy. Wagi: krytyczna (blokuje uznanie grafiku za gotowy), wazna (do decyzji), info.
//  Czas pracy: zmiana (blok scalony) > 12 h, odpoczynek < 11 h, nakładanie. Dyspozycje: pusty dzień = niedostępny,
//  okno przez północ, „23:59” rozróżnione od „do zamknięcia”. Stanowiska: ciągłość co 15 min względem modelu pracy
//  (albo koperty dnia), brak stanowiska w dniu, brak kierownika, nadwyżka kierowników, duplikaty, odcinki bez czasu.
// ═══════════════════════════════════════════════════════════════════════════════════

export const KODY = {
  ZMIANA_PONAD_12H: { waga: 'krytyczna', nazwa: 'Zmiana dłuższa niż 12 h' },
  ODPOCZYNEK_11H: { waga: 'krytyczna', nazwa: 'Odpoczynek krótszy niż 11 h' },
  NAKLADANIE: { waga: 'krytyczna', nazwa: 'Nakładające się zmiany tej samej osoby' },
  DYSPO_NIEDOSTEPNY: { waga: 'krytyczna', nazwa: 'Zmiana w dniu niedostępności' },
  DYSPO_POZA_OKNEM: { waga: 'krytyczna', nazwa: 'Zmiana poza zadeklarowanymi godzinami' },
  DYSPO_2359: { waga: 'wazna', nazwa: 'Dostępność „do 23:59” a zmiana po północy' },
  DYSPO_NADPISANA: { waga: 'info', nazwa: 'Dyspozycja nadpisana przez managera' },
  DYSPO_BRAK_DEKLARACJI: { waga: 'info', nazwa: 'Brak deklaracji dyspozycji w miesiącu' },
  BRAK_MGR: { waga: 'krytyczna', nazwa: 'Brak kierownika zmiany' },
  LUKA_STANOWISKA: { waga: 'krytyczna', nazwa: 'Przerwa w obsadzie stanowiska' },
  BRAK_STANOWISKA_W_DNIU: { waga: 'wazna', nazwa: 'Wymagane stanowisko bez zmiany w dniu' },
  NADWYZKA_MGR: { waga: 'wazna', nazwa: 'Więcej kierowników niż wymaga model' },
  DUPLIKAT_ZMIANY: { waga: 'wazna', nazwa: 'Powielona zmiana kierownicza' },
  ODCINKI_BEZ_CZASU: { waga: 'wazna', nazwa: 'Zmiana stanowiska w dyżurze bez godziny przejścia' },
  BRAK_KWALIFIKACJI: { waga: 'krytyczna', nazwa: 'Osoba bez potwierdzonej kwalifikacji na stanowisku' },
};
const MGRF = new Set(['RGM', 'ASM', 'SM', 'JSM']);
const dayNum = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return Math.floor(Date.UTC(y, m - 1, d) / 86400000); };
const przedzialy = (arr) => { const out = []; let a = -1; for (let i = 0; i <= arr.length; i++) { const v = i < arr.length && arr[i]; if (v && a < 0) a = i; if (!v && a >= 0) { out.push([a, i]); a = -1; } } return out; };
const fH = (min) => { const h = Math.floor(min / 60), m = min % 60; return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`; };

export function audytGrafiku(shifts, ctx = {}) {
  const { accounts = [], avail = [], absences = [], model = null, from = null, to = null, sasiednie = [], matrix = null, opts = {} } = ctx;
  const { maxDobaH = 12, odpoczynekH = 11, interpretacja2359 = 'koniec-dnia', tolerancjaLukiMin = 0, mapa = true, dyspoWymagana = true, kwalifikacje = false } = opts;
  const poId = new Map(accounts.map((a) => [a.id, a]));
  const poNaz = new Map(accounts.flatMap((a) => [a.grafikName, a.name, ...(a.aliasy || [])].filter(Boolean).map((n) => [norm(n), a])));
  const kontoZ = (s) => poId.get(s.accountId) || poNaz.get(norm(s.name)) || null;
  const wZakresie = (d) => (!from || d >= from) && (!to || d <= to);
  const problemy = [];
  const dodaj = (kod, p) => { if (p.date && !wZakresie(p.date)) return; problemy.push({ kod, waga: (KODY[kod] || {}).waga || 'info', nazwa: (KODY[kod] || {}).nazwa || kod, ...p }); };

  const robocze = (shifts || []).filter((s) => s && s.date && s.start && s.end && s.rola !== 'instruktor');
  // ── osoby: bloki absolutne (minuty) z sąsiednimi dniami ─────────────────────
  const osoby = new Map();
  [...robocze, ...(sasiednie || [])].forEach((s) => {
    const k = kontoZ(s); const key = k ? `id:${k.id}` : `n:${norm(s.name)}`;
    const o = osoby.get(key) || { key, konto: k, name: k ? k.name : (s.name || '?'), zmiany: [] };
    const sa = dayNum(s.date) * 1440 + mn(s.start);
    o.zmiany.push({ s, date: s.date, sa, ea: sa + durMin(s.start, s.end) });
    osoby.set(key, o);
  });
  for (const o of osoby.values()) {
    const z = o.zmiany.sort((a, b) => a.sa - b.sa);
    // nakładanie
    for (let i = 1; i < z.length; i++) if (z[i].sa < z[i - 1].ea && z[i].date === z[i - 1].date && z[i].s.start !== z[i - 1].s.start) dodaj('NAKLADANIE', { date: z[i].date, od: z[i].s.start, do: z[i - 1].s.end, accountId: o.konto && o.konto.id, name: o.name, opis: `${o.name}: zmiany ${z[i - 1].s.start}–${z[i - 1].s.end} i ${z[i].s.start}–${z[i].s.end} nakładają się.`, naprawa: 'Połącz w jedną zmianę z odcinkami albo usuń duplikat.' });
    // bloki scalone (stykające się zmiany = jedna doba pracy)
    const bloki = [];
    z.forEach((x) => { const last = bloki[bloki.length - 1]; if (last && x.sa <= last.ea + 1) { last.ea = Math.max(last.ea, x.ea); last.koniec = x.s.end; last.stacje.push(norm(x.s.station)); } else bloki.push({ date: x.date, sa: x.sa, ea: x.ea, start: x.s.start, koniec: x.s.end, stacje: [norm(x.s.station)] }); });
    bloki.forEach((b) => { const d = b.ea - b.sa; if (d > maxDobaH * 60) dodaj('ZMIANA_PONAD_12H', { date: b.date, od: b.start, do: b.koniec, accountId: o.konto && o.konto.id, name: o.name, station: b.stacje[0], minuty: d, opis: `${o.name}, ${b.date}: ${b.stacje.join(' + ')} ${b.start}–${b.koniec} = ${fH(d)} (limit ${maxDobaH} h).`, naprawa: 'Podziel na dwie osoby albo skróć i dodaj krótszy dyżur — nie wolno łatać obsady wydłużaniem pracy.' }); });
    for (let i = 1; i < bloki.length; i++) { const r = bloki[i].sa - bloki[i - 1].ea; if (r < odpoczynekH * 60) dodaj('ODPOCZYNEK_11H', { date: bloki[i].date, od: bloki[i].start, do: bloki[i].koniec, accountId: o.konto && o.konto.id, name: o.name, minuty: r, opis: `${o.name}: koniec ${bloki[i - 1].date} ${bloki[i - 1].koniec}, start ${bloki[i].date} ${bloki[i].start} — tylko ${fH(Math.max(0, r))} odpoczynku (wymagane ${odpoczynekH} h).`, naprawa: `Przesuń start ${bloki[i].date} na ${slotCzas(Math.ceil(((bloki[i - 1].ea + odpoczynekH * 60) % 1440 - 360 + 1440) % 1440 / KROK))} lub później, albo zamień osobę.` }); }
  }

  // ── dyspozycje: pusty dzień = niedostępny, okna, 23:59 ──────────────────────
  if (dyspoWymagana) {
    const miesiaceZDekl = new Map();   // accountId → Set(ym) z jakąkolwiek zatwierdzoną deklaracją
    (avail || []).forEach((r) => { if (r.status !== 'approved' || !r.accountId) return; const s = miesiaceZDekl.get(r.accountId) || new Set(); s.add(String(r.date).slice(0, 7)); if (r.recurrence === 'weekly') s.add('*'); miesiaceZDekl.set(r.accountId, s); });
    const bezDekl = new Map();
    robocze.forEach((s) => {
      const k = kontoZ(s); if (!k) return;
      const ym = s.date.slice(0, 7);
      const dekl = miesiaceZDekl.get(k.id);
      const maDeklMies = !!(dekl && (dekl.has(ym) || dekl.has('*')));
      if (!maDeklMies) { if (!bezDekl.has(k.id)) bezDekl.set(k.id, { name: k.name, n: 0, date: s.date }); bezDekl.get(k.id).n++; return; }
      const moje = (avail || []).filter((r) => r.accountId === k.id && r.status === 'approved' && dyspozycjaObowiazuje(r, s.date));
      const rq = moje.find((r) => r.date === s.date) || moje[0] || null;
      if (s.mimoDyspozycji) { dodaj('DYSPO_NADPISANA', { date: s.date, od: s.start, do: s.end, accountId: k.id, name: k.name, station: norm(s.station), opis: `${k.name}, ${s.date} ${s.start}–${s.end}: dyspozycja nadpisana (${s.mimoDyspozycji.by || 'manager'}${s.mimoDyspozycji.reason ? ': ' + s.mimoDyspozycji.reason : ''}).` }); return; }
      if (!rq) { dodaj('DYSPO_NIEDOSTEPNY', { date: s.date, od: s.start, do: s.end, accountId: k.id, name: k.name, station: norm(s.station), opis: `${k.name}, ${s.date} ${s.start}–${s.end}: brak dyspozycji na ten dzień (puste pole = niedostępność).`, naprawa: 'Potwierdź dostępność z pracownikiem (nadpisanie z adnotacją) albo zamień osobę.' }); return; }
      const ok = ocenOknoDyspozycji(rq, s.start, s.end);
      if (!ok) return;
      if (ok.kod === 'niedostepny') { dodaj('DYSPO_NIEDOSTEPNY', { date: s.date, od: s.start, do: s.end, accountId: k.id, name: k.name, station: norm(s.station), opis: `${k.name}, ${s.date} ${s.start}–${s.end}: zgłoszona niedostępność.`, naprawa: 'Zamień osobę albo nadpisz dyspozycję po potwierdzeniu z pracownikiem.' }); return; }
      const koniecDnia = ['23:59', '00:00', '24:00'].includes(String(rq.endTime || ''));
      const poPolnocy = mn(s.end) <= mn(s.start);
      if ((ok.kod === 'do' || ok.kod === 'okno') && koniecDnia && poPolnocy) {
        if (interpretacja2359 === 'do-zamkniecia') return;
        dodaj('DYSPO_2359', { date: s.date, od: s.start, do: s.end, accountId: k.id, name: k.name, station: norm(s.station), opis: `${k.name}, ${s.date} ${s.start}–${s.end}: dostępność „do ${rq.endTime}” odczytana jako koniec dnia, a zmiana kończy się po północy.`, naprawa: 'Ustal z zespołem, czy „23:59” znaczy „do zamknięcia” (parametr interpretacji) albo skróć zmianę do 24:00.' });
        return;
      }
      dodaj('DYSPO_POZA_OKNEM', { date: s.date, od: s.start, do: s.end, accountId: k.id, name: k.name, station: norm(s.station), opis: `${k.name}, ${s.date} ${s.start}–${s.end}: poza oknem (${ok.opis}).`, naprawa: 'Przesuń zmianę do okna dostępności albo zamień osobę.' });
    });
    bezDekl.forEach((v, aid) => dodaj('DYSPO_BRAK_DEKLARACJI', { date: v.date, accountId: aid, name: v.name, opis: `${v.name}: ${v.n} zmian, brak jakiejkolwiek deklaracji dyspozycji w tym miesiącu.`, naprawa: 'Zbierz dyspozycję albo oznacz konto jako „bez dyspozycji” (np. kierownik).' }));
  }
  // absencje
  (absences || []).filter((x) => x.status === 'approved').forEach((x) => robocze.filter((s) => s.accountId === x.accountId && s.date >= x.from && s.date <= x.to).forEach((s) => dodaj('DYSPO_NIEDOSTEPNY', { date: s.date, od: s.start, do: s.end, accountId: s.accountId, name: (poId.get(s.accountId) || {}).name || s.name, station: norm(s.station), opis: `${(poId.get(s.accountId) || {}).name || s.name}, ${s.date}: zmiana w czasie zatwierdzonej absencji (${x.type || 'absencja'}).`, naprawa: 'Usuń zmianę albo zamień osobę.' })));

  // ── kwalifikacje (opcjonalnie, gdy przekazano macierz) ──────────────────────
  if (kwalifikacje && matrix) {
    robocze.forEach((s) => { const k = kontoZ(s); if (!k) return; odcinkiZmiany(s).forEach((o) => { const w = ((matrix[k.id] || {})[o.station]); const lista = Array.isArray(k.stanowiska) && k.stanowiska.length ? k.stanowiska.map(norm) : null; const okK = (w && w.zatwierdzone && Number(w.poziom) >= 2) || (lista && lista.includes(o.station)); if (!okK && !jestMgrStanowisko(o.station)) dodaj('BRAK_KWALIFIKACJI', { date: s.date, od: o.start, do: o.end, accountId: k.id, name: k.name, station: o.station, opis: `${k.name}, ${s.date} ${o.start}–${o.end}: brak potwierdzonej kwalifikacji „samodzielny” na ${o.station}.`, naprawa: 'Uzupełnij macierz kwalifikacji albo zamień osobę.' }); }); });
  }

  // ── stanowiska: ciągłość, brak w dniu, kierownik, nadwyżka, duplikaty, odcinki ──
  const daty = [...new Set(robocze.map((s) => s.date))].filter(wZakresie).sort();
  const mapaOut = {};
  daty.forEach((date) => {
    const dnia = robocze.filter((s) => s.date === date);
    const pokr = pokrycieDnia(dnia);
    const wym = model ? wymaganiaDnia(model, date) : null;
    // kierownik: stanowisko MANAGER lub konto kierownicze na stanowisku nieadministracyjnym
    const mgr = new Array(SLOTOW).fill(0); const wszyscy = new Array(SLOTOW).fill(0);
    dnia.forEach((s) => { const k = kontoZ(s); odcinkiZmiany(s).forEach((o) => { const jestM = o.station === 'MANAGER' || (k && MGRF.has(k.funkcja) && !definicjaStanowiska(model, o.station).admin); for (let i = slotOd(o.start); i < slotDo(o.start, o.end); i++) { wszyscy[i]++; if (jestM) mgr[i]++; } }); });
    // okno pracy dnia: z modelu (unia szablonów podstawowych) albo koperta wszystkich zmian
    const okno = new Array(SLOTOW).fill(false);
    if (wym && wym.instancje.some((x) => x.typ === 'podstawowa')) wym.instancje.filter((x) => x.typ === 'podstawowa').forEach((x) => { for (let i = slotOd(x.start); i < slotDo(x.start, x.end); i++) okno[i] = true; });
    else for (let i = 0; i < SLOTOW; i++) okno[i] = wszyscy[i] > 0;
    // bez modelu: kontrola kierownika tylko gdy grafik w ogóle zawiera zmiany kierownicze (inaczej dane nie obejmują kierowników)
    const sprawdzajMgr = opts.sprawdzajMgr !== false && (!!model || robocze.some((s) => { const k = kontoZ(s); return jestMgrStanowisko(s.station) || (k && MGRF.has(k.funkcja)); }));
    if (sprawdzajMgr) przedzialy(okno.map((w, i) => w && wszyscy[i] > 0 && mgr[i] === 0)).forEach(([a, b]) => { if ((b - a) * KROK > tolerancjaLukiMin) dodaj('BRAK_MGR', { date, od: slotCzas(a), do: slotCzas(b), station: 'MANAGER', opis: `${date} ${slotCzas(a)}–${slotCzas(b)}: pracuje zespół, ale nie ma kierownika zmiany.`, naprawa: 'Wydłuż zmianę kierownika albo dodaj zmianę MANAGER / MGR dyżurny.' }); });
    const stacje = new Set([...Object.keys(pokr), ...Object.keys((wym || {}).wymagane || {})]);
    stacje.forEach((st) => {
      if (st === 'OBSADA' || !st) return;
      const def = definicjaStanowiska(model, st);
      const obs = pokr[st] || new Array(SLOTOW).fill(0);
      const req = wym && wym.wymagane[st] ? wym.wymagane[st] : null;
      if (req) {
        if (req.some((v) => v > 0) && !obs.some((v) => v > 0)) { dodaj('BRAK_STANOWISKA_W_DNIU', { date, station: st, waga: def.krytyczne ? 'krytyczna' : 'wazna', od: slotCzas(req.findIndex((v) => v > 0)), do: slotCzas(req.length - [...req].reverse().findIndex((v) => v > 0)), opis: `${date}: model pracy wymaga ${st} (${przedzialy(req.map((v) => v > 0)).map(([a, b]) => `${slotCzas(a)}–${slotCzas(b)}`).join(', ')}), a w grafiku nie ma żadnej zmiany na tym stanowisku.`, naprawa: def.zastepstwa && def.zastepstwa.length ? `Dodaj zmianę albo zapisz, kto przejmuje zadania (${def.zastepstwa.join(', ')}).` : 'Dodaj zmianę albo zapisz, kto przejmuje zadania.' }); }
        else przedzialy(req.map((v, i) => v > obs[i])).forEach(([a, b]) => { if ((b - a) * KROK > tolerancjaLukiMin) dodaj('LUKA_STANOWISKA', { date, od: slotCzas(a), do: slotCzas(b), station: st, waga: def.krytyczne ? 'krytyczna' : 'wazna', brakOsob: Math.max(...req.slice(a, b).map((v, i) => v - obs[a + i])), opis: `${date}, ${st} ${slotCzas(a)}–${slotCzas(b)}: brak obsady (wymagane ${Math.max(...req.slice(a, b))}, jest ${Math.min(...obs.slice(a, b))}).`, naprawa: 'Sprawdź wcześniejszy start zmiany zamykającej, późniejszy koniec otwierającej albo krótszy dyżur / zastępstwo.' }); });
        if (st === 'MANAGER') przedzialy(obs.map((v, i) => v > req[i] && req[i] > 0)).forEach(([a, b]) => { if ((b - a) * KROK >= 120) dodaj('NADWYZKA_MGR', { date, od: slotCzas(a), do: slotCzas(b), station: st, opis: `${date} ${slotCzas(a)}–${slotCzas(b)}: ${Math.max(...obs.slice(a, b))} osób MANAGER przy wymaganych ${Math.max(...req.slice(a, b))}.`, naprawa: 'Przypisz cel nadwyżce (szkolenie, inwentaryzacja, wsparcie) albo przesuń zmianę.' }); });
      } else if (!jestMgrStanowisko(st)) {
        // bez modelu: ciągłość w kopercie dnia stanowiska (pierwszy start → ostatni koniec)
        const idx = obs.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
        if (idx.length) { const a0 = idx[0], b0 = idx[idx.length - 1] + 1; przedzialy(obs.map((v, i) => i >= a0 && i < b0 && v === 0)).forEach(([a, b]) => { if ((b - a) * KROK > tolerancjaLukiMin) dodaj('LUKA_STANOWISKA', { date, od: slotCzas(a), do: slotCzas(b), station: st, waga: def.krytyczne ? 'krytyczna' : 'wazna', opis: `${date}, ${st} ${slotCzas(a)}–${slotCzas(b)}: przerwa między zmianami na tym stanowisku.`, naprawa: 'Sprawdź wcześniejszy start zmiany zamykającej, późniejszy koniec otwierającej albo krótszy dyżur / zastępstwo.' }); }); }
      }
    });
    // duplikaty kierownicze (identyczne godziny, to samo stanowisko, 2+ osoby)
    const dup = {};
    dnia.forEach((s) => { if (!jestMgrStanowisko(s.station)) return; const k = `${norm(s.station)}|${s.start}|${s.end}`; (dup[k] = dup[k] || []).push(kontoZ(s) ? kontoZ(s).name : s.name); });
    Object.entries(dup).forEach(([k, os]) => { if (os.length > 1) { const [st, start, end] = k.split('|'); dodaj('DUPLIKAT_ZMIANY', { date, od: start, do: end, station: st, opis: `${date}: ${os.length} osoby ${st} ${start}–${end} (${os.join(', ')}).`, naprawa: 'Potwierdź potrzebę (szkolenie, dodatkowe obowiązki) i zapisz cel — albo przesuń jedną ze zmian.' }); } });
    // odcinki bez czasu
    dnia.forEach((s) => { const et = String(s.station || ''); if ((s.stacjaDocelowa || /→|->/.test(et)) && !(Array.isArray(s.segmenty) && s.segmenty.length)) dodaj('ODCINKI_BEZ_CZASU', { date, od: s.start, do: s.end, accountId: s.accountId, name: (kontoZ(s) || {}).name || s.name, station: norm(et.split(/→|->/)[0]), opis: `${(kontoZ(s) || {}).name || s.name}, ${date} ${s.start}–${s.end}: ${et}${s.stacjaDocelowa ? ' → ' + s.stacjaDocelowa : ''} bez godziny przejścia.`, naprawa: 'Zapisz odcinki, np. 12:00–17:00 KANAPKI, 17:00–20:00 PREP — osoba nie może być liczona na obu stanowiskach naraz.' }); });
    if (mapa) {
      const m = {}; stacje.forEach((st) => { if (!st || st === 'OBSADA') return; const obs = pokr[st] || new Array(SLOTOW).fill(0); const req = wym && wym.wymagane[st] ? wym.wymagane[st] : new Array(SLOTOW).fill(0); const o48 = [], r48 = []; for (let i = 0; i < SLOTOW; i += 2) { o48.push(Math.max(obs[i], obs[i + 1])); r48.push(Math.max(req[i], req[i + 1])); } m[st] = { obsada: o48, wymagane: r48 }; });
      mapaOut[date] = { stanowiska: m, mgr: (() => { const a = []; for (let i = 0; i < SLOTOW; i += 2) a.push(Math.max(mgr[i], mgr[i + 1])); return a; })(), razem: (() => { const a = []; for (let i = 0; i < SLOTOW; i += 2) a.push(Math.max(wszyscy[i], wszyscy[i + 1])); return a; })() };
    }
  });

  const rank = { krytyczna: 0, wazna: 1, info: 2 };
  problemy.sort((a, b) => rank[a.waga] - rank[b.waga] || String(a.date || '').localeCompare(String(b.date || '')) || String(a.od || '').localeCompare(String(b.od || '')));
  const perKod = {}; problemy.forEach((p) => { perKod[p.kod] = (perKod[p.kod] || 0) + 1; });
  const perDate = {}; problemy.forEach((p) => { if (p.date) perDate[p.date] = (perDate[p.date] || 0) + (p.waga === 'krytyczna' ? 1 : 0); });
  const podsumowanie = { krytyczne: problemy.filter((p) => p.waga === 'krytyczna').length, wazne: problemy.filter((p) => p.waga === 'wazna').length, info: problemy.filter((p) => p.waga === 'info').length, perKod, osoby: new Set(problemy.filter((p) => p.accountId).map((p) => p.accountId)).size };
  return { problemy, podsumowanie, perDate, gotowy: podsumowanie.krytyczne === 0, mapa: mapa ? mapaOut : undefined, kody: KODY };
}

// ── zbiorcze „co o tym decyduje”: tekst dla managera ──────────────────────────
export function streszczenieAudytu(a) {
  const p = a.podsumowanie; const top = Object.entries(p.perKod).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, n]) => `${(KODY[k] || {}).nazwa || k}: ${n}`);
  return p.krytyczne ? `Grafik niekompletny — ${p.krytyczne} problemów krytycznych (${top.join('; ')}).` : p.wazne ? `Brak problemów krytycznych; ${p.wazne} do decyzji (${top.join('; ')}).` : 'Brak problemów operacyjnych.';
}

const prevYm = (ym) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const nextYm = (ym) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

export async function audytMiesiaca(ym, opts = {}) {
  const [cur, prev, next, accounts, avail, absences, model, matrix, paramy] = await Promise.all([kv.get(`sched:${ym}`), kv.get(`sched:${prevYm(ym)}`), kv.get(`sched:${nextYm(ym)}`), kv.get('accounts:list'), kv.get('avail:reqs'), kv.get('absences:list'), czytajModel(), kv.get('quals:matrix'), kv.get('params:planning')]);
  const shifts = ((cur && cur.shifts) || []);
  const sasiednie = [...((prev && prev.shifts) || []), ...((next && next.shifts) || [])].filter((s) => s.date === `${prevYm(ym)}-31` || s.date >= `${prevYm(ym)}-28` || s.date <= `${nextYm(ym)}-02`);
  const uzyty = model && model.status === 'zatwierdzony' ? model : (opts.modelPropozycja ? model : null);
  const w = audytGrafiku(shifts, { accounts: accounts || [], avail: avail || [], absences: absences || [], model: uzyty, matrix, sasiednie, from: `${ym}-01`, to: `${ym}-31`, opts: { interpretacja2359: (paramy || {}).interpretacja2359 || 'koniec-dnia', tolerancjaLukiMin: (model || {}).przekazanieMin || 0, ...(opts.opts || {}) } });
  // Bramka publikacji: bez zatwierdzonego modelu pracy luki stanowisk i kierownika są informacją, nie blokadą
  const blokujace = w.problemy.filter((p) => p.waga === 'krytyczna' && (uzyty || !['BRAK_MGR', 'LUKA_STANOWISKA'].includes(p.kod)));
  return { ...w, modelZatwierdzony: !!uzyty, blokujace, podsumowanie: { ...w.podsumowanie, blokujace: blokujace.length } };
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });
  try {
    if (!(await requireRole(req, res, ['asm', 'kierownik']))) return;
    if (req.method === 'GET') {
      const ym = String((req.query || {}).month || '');
      if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ success: false, error: 'Podaj miesiąc YYYY-MM.' });
      const w = await audytMiesiaca(ym, { modelPropozycja: (req.query || {}).propozycja === '1' });
      const d = (req.query || {}).date;
      return res.json({ success: true, month: ym, podsumowanie: w.podsumowanie, gotowy: w.gotowy, streszczenie: streszczenieAudytu(w), problemy: d ? w.problemy.filter((p) => p.date === d) : w.problemy.slice(0, 400), perDate: w.perDate, mapa: d ? { [d]: (w.mapa || {})[d] } : undefined, kody: KODY });
    }
    // POST { shifts, from, to } — audyt przekazanych zmian (np. przed zapisem albo z pliku) na danych z bazy
    if (req.method === 'POST') {
      const b = req.body || {}; const shifts = Array.isArray(b.shifts) ? b.shifts : [];
      if (!shifts.length) return res.status(400).json({ success: false, error: 'Brak zmian do audytu.' });
      const [accounts, avail, absences, model, matrix] = await Promise.all([kv.get('accounts:list'), kv.get('avail:reqs'), kv.get('absences:list'), czytajModel(), kv.get('quals:matrix')]);
      const w = audytGrafiku(shifts, { accounts: accounts || [], avail: avail || [], absences: absences || [], model: model.status === 'zatwierdzony' || b.uzyjPropozycji ? model : null, matrix, from: b.from || null, to: b.to || null, opts: { interpretacja2359: b.interpretacja2359 || 'koniec-dnia', dyspoWymagana: b.dyspoWymagana !== false, mapa: !!b.mapa } });
      return res.json({ success: true, podsumowanie: w.podsumowanie, gotowy: w.gotowy, streszczenie: streszczenieAudytu(w), problemy: w.problemy.slice(0, 400), perDate: w.perDate, mapa: w.mapa });
    }
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
