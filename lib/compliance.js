import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';

// ═══════════ Silnik zgodności z prawem pracy (PL) — biblioteka reguł ═══════════
// Czysta funkcja ocenZgodnosc() + endpoint GET /api/compliance?month=YYYY-MM.
// Każde naruszenie ma kod, poziom (block = blokuje publikację, warn = ostrzeżenie),
// osobę, datę i komunikat. Publikacja z naruszeniami "block" wymaga force + uzasadnienia.

export const REGULY = [
  { code: 'ODP_DOBOWY', level: 'block', name: 'Odpoczynek dobowy 11 h', opis: 'Między końcem a początkiem kolejnej zmiany musi być co najmniej 11 godzin (art. 132 KP).' },
  { code: 'DZIEN_12H', level: 'block', name: 'Maks. 12 h w dobie', opis: 'Łączny czas pracy w dobie nie może przekroczyć 12 godzin (system równoważny).' },
  { code: 'ODP_TYGODNIOWY', level: 'warn', name: 'Odpoczynek tygodniowy 35 h', opis: 'W każdym tygodniu przysługuje nieprzerwany odpoczynek 35 godzin (art. 133 KP).' },
  { code: 'DOBA_PRACOWNICZA', level: 'warn', name: 'Doba pracownicza (UOP)', opis: 'Rozpoczęcie pracy przed upływem 24 h od poprzedniego startu oznacza pracę w tej samej dobie (nadgodziny).' },
  { code: 'TYDZIEN_48H', level: 'warn', name: 'Ponad 48 h w tygodniu', opis: 'Tygodniowy czas pracy z nadgodzinami nie powinien przekraczać 48 godzin (art. 131 KP).' },
  { code: 'DNI_7', level: 'warn', name: '7 dni pracy z rzędu w tygodniu', opis: 'Brak dnia wolnego w tygodniu kalendarzowym.' },
];

const REG = Object.fromEntries(REGULY.map((r) => [r.code, r]));
const mn = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const dayNum = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return Math.floor(Date.UTC(y, m - 1, d) / 86400000); };
const isoOf = (num) => new Date(num * 86400000).toISOString().slice(0, 10);
const dow = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; }; // 0 = pon
const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ')
  .replace(/Ą/g, 'A').replace(/Ć/g, 'C').replace(/Ę/g, 'E').replace(/Ł/g, 'L').replace(/Ń/g, 'N').replace(/Ó/g, 'O').replace(/Ś/g, 'S').replace(/Ź/g, 'Z').replace(/Ż/g, 'Z');
const fH = (min) => `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;

export function ocenZgodnosc(shifts, accounts, opts = {}) {
  const { from = null, to = null } = opts;
  const konta = accounts || [];
  const poId = new Map(konta.map((a) => [a.id, a]));
  const poNaz = new Map(konta.flatMap((a) => [a.grafikName, a.name, ...(a.aliasy || [])].filter(Boolean).map((n) => [norm(n), a])));
  const kontoZ = (s) => poId.get(s.accountId) || poNaz.get(norm(s.name)) || null;

  // normalizacja: bez wpisów instruktorskich (adnotacje pary), bez pustych czasów
  const osoby = new Map();
  (shifts || []).forEach((s) => {
    if (!s || !s.date || !s.start || !s.end || s.rola === 'instruktor') return;
    const k = kontoZ(s);
    const key = k ? `id:${k.id}` : `n:${norm(s.name)}`;
    const startAbs = dayNum(s.date) * 1440 + mn(s.start);
    let dur = mn(s.end) - mn(s.start); if (dur <= 0) dur += 1440;
    const o = osoby.get(key) || { key, name: k ? k.name : (s.name || '?'), umowa: k ? (k.umowa || '') : '', zmiany: [] };
    o.zmiany.push({ date: s.date, startAbs, endAbs: startAbs + dur, dur, start: s.start, end: s.end });
    osoby.set(key, o);
  });

  const violations = [];
  const wZakresie = (d) => (!from || d >= from) && (!to || d <= to);
  const dodaj = (code, o, date, message, extra = {}) => { if (!wZakresie(date)) return; violations.push({ code, level: REG[code].level, rule: REG[code].name, accountKey: o.key, name: o.name, date, message, ...extra }); };

  for (const o of osoby.values()) {
    const z = o.zmiany.sort((a, b) => a.startAbs - b.startAbs);

    // bloki: zmiany tego samego dnia stykające się / nachodzące traktujemy jak jedną (dzielona zmiana)
    const bloki = [];
    z.forEach((x) => {
      const last = bloki[bloki.length - 1];
      if (last && x.date === last.date && x.startAbs <= last.endAbs + 60) { last.endAbs = Math.max(last.endAbs, x.endAbs); last.end = x.end; }
      else bloki.push({ ...x });
    });

    // DZIEN_12H: suma w dobie kalendarzowej
    const perDay = {};
    z.forEach((x) => { perDay[x.date] = (perDay[x.date] || 0) + x.dur; });
    Object.entries(perDay).forEach(([d, min]) => { if (min > 720) dodaj('DZIEN_12H', o, d, `${fH(min)} pracy w dobie ${d} — limit 12 h.`, { minutes: min }); });

    // ODP_DOBOWY + DOBA_PRACOWNICZA: między kolejnymi blokami z różnych dni
    for (let i = 1; i < bloki.length; i++) {
      const a = bloki[i - 1], b = bloki[i];
      if (a.date === b.date) continue;
      const przerwa = b.startAbs - a.endAbs;
      if (przerwa < 660) dodaj('ODP_DOBOWY', o, b.date, `Tylko ${fH(Math.max(0, przerwa))} odpoczynku między ${a.date} ${a.start}–${a.end} a ${b.date} ${b.start}–${b.end} (wymagane 11 h).`, { minutes: przerwa });
      if (o.umowa === 'UOP' && b.startAbs < a.startAbs + 1440 && przerwa >= 660) dodaj('DOBA_PRACOWNICZA', o, b.date, `Start ${b.date} ${b.start} przypada przed upływem 24 h od startu ${a.date} ${a.start} — praca w tej samej dobie pracowniczej.`);
    }

    // tygodnie kalendarzowe (pon–nd)
    const tygodnie = {};
    z.forEach((x) => { const wk = dayNum(x.date) - dow(x.date); (tygodnie[wk] = tygodnie[wk] || []).push(x); });
    Object.entries(tygodnie).forEach(([wkStr, lista]) => {
      const wk = Number(wkStr);
      const godz = lista.reduce((a, x) => a + x.dur, 0);
      const dni = new Set(lista.map((x) => x.date));
      const wkIso = isoOf(wk), wkEndIso = isoOf(wk + 6);
      if (godz > 2880) dodaj('TYDZIEN_48H', o, wkIso, `${fH(godz)} w tygodniu ${wkIso}–${wkEndIso} (limit 48 h).`, { minutes: godz });
      if (dni.size >= 7) dodaj('DNI_7', o, wkIso, `Praca przez 7 dni w tygodniu ${wkIso}–${wkEndIso} — brak dnia wolnego.`);
      // odpoczynek tygodniowy: najdłuższa przerwa w oknie tygodnia (z granicami okna)
      const wStart = wk * 1440, wEnd = (wk + 7) * 1440;
      const wBloki = bloki.filter((b) => b.endAbs > wStart && b.startAbs < wEnd).sort((a, b) => a.startAbs - b.startAbs);
      let maxGap = 0, cursor = wStart;
      wBloki.forEach((b) => { maxGap = Math.max(maxGap, b.startAbs - cursor); cursor = Math.max(cursor, b.endAbs); });
      maxGap = Math.max(maxGap, wEnd - cursor);
      if (dni.size >= 5 && maxGap < 2100) dodaj('ODP_TYGODNIOWY', o, wkIso, `Najdłuższy odpoczynek w tygodniu ${wkIso}–${wkEndIso} to ${fH(maxGap)} (wymagane 35 h).`, { minutes: maxGap });
    });
  }

  violations.sort((a, b) => (a.level === b.level ? 0 : a.level === 'block' ? -1 : 1) || a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'pl'));
  const summary = { block: violations.filter((v) => v.level === 'block').length, warn: violations.filter((v) => v.level === 'warn').length, osoby: new Set(violations.map((v) => v.accountKey)).size };
  const perDate = {};
  violations.forEach((v) => { perDate[v.date] = (perDate[v.date] || 0) + 1; });
  return { violations, summary, perDate, reguly: REGULY };
}

const prevYm = (ym) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const nextYm = (ym) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

// ocena miesiąca z kontekstem sąsiednich miesięcy (odpoczynek na granicy miesiąca)
export async function ocenMiesiac(ym) {
  const [cur, prev, next] = await Promise.all([kv.get(`sched:${ym}`), kv.get(`sched:${prevYm(ym)}`), kv.get(`sched:${nextYm(ym)}`)]);
  const konta = (await kv.get('accounts:list')) || [];
  const shifts = [...((prev && prev.shifts) || []), ...((cur && cur.shifts) || []), ...((next && next.shifts) || [])];
  return ocenZgodnosc(shifts, konta, { from: `${ym}-01`, to: `${ym}-31` });
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });
  try {
    if (req.method === 'GET') {
      if (!(await requireRole(req, res, ['asm', 'kierownik']))) return;
      const ym = String((req.query || {}).month || '');
      if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ success: false, error: 'Podaj miesiąc YYYY-MM.' });
      const wynik = await ocenMiesiac(ym);
      const from = (req.query || {}).from, to = (req.query || {}).to;
      const violations = (from || to) ? wynik.violations.filter((v) => (!from || v.date >= from) && (!to || v.date <= to)) : wynik.violations;
      return res.json({ success: true, month: ym, violations, summary: { block: violations.filter((v) => v.level === 'block').length, warn: violations.filter((v) => v.level === 'warn').length }, reguly: REGULY });
    }
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
