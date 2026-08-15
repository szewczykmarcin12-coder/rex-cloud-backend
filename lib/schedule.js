import { randomUUID } from 'crypto';
import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit, aktor } from './audit.js';
import { absencjaZatwierdzona } from './absences.js';
import { dostepnoscDnia, dyspozycjaNaDzien } from './availability.js';

// ── WFM-01: publikacja grafiku — pracownik widzi wyłącznie opublikowany snapshot ──
const pubKey = (ym) => `sched:pub:${ym}`;
const pubHistKey = (ym) => `sched:pubhist:${ym}`;
const readPub = async (ym) => await kv.get(pubKey(ym));
// Audyt P4 (P4-06): pracownik NIGDY nie widzi kopii roboczej — wyłącznie opublikowany snapshot.
// Miesiąc bez publikacji = brak grafiku dla pracowników (jawny stan, bez obejścia widoku draft).
const readForEmployee = async (ym) => { const pub = await readPub(ym); return pub || { shifts: [], roster: [], meta: {}, niepublikowany: true }; };

// ── WFM-05: konflikty grafiku ──
const minuty = (t) => { const [h, mm] = String(t || '0:0').split(':').map(Number); return h * 60 + (mm || 0); };
function kolizjaZmian(shifts, kand, pomijaSid) {
  const a1 = minuty(kand.start); let b1 = minuty(kand.end); if (b1 <= a1) b1 += 1440;
  return (shifts || []).find((x) => {
    if (!x.accountId || !kand.accountId || x.accountId !== kand.accountId) return false;
    if (x.date !== kand.date || (pomijaSid && x.sid === pomijaSid)) return false;
    if (x.rola === 'instruktor' || String(x.station || '').toUpperCase() === 'INSTRUKTOR') return false;
    const a2 = minuty(x.start); let b2 = minuty(x.end); if (b2 <= a2) b2 += 1440;
    return a1 < b2 && a2 < b1;
  });
}
function ostrzezeniaOdpoczynku(shifts, kand, pomijaSid) {
  // dyrektywa 11 h odpoczynku dobowego: sprawdzamy sąsiednie dni tego samego konta
  if (!kand.accountId) return [];
  const out = [];
  const dzien = (base, delta) => { const d = new Date(base); d.setDate(d.getDate() + delta); return d.toISOString().slice(0, 10); };
  const startK = minuty(kand.start); let endK = minuty(kand.end); if (endK <= startK) endK += 1440;
  (shifts || []).forEach((x) => {
    if (x.accountId !== kand.accountId || (pomijaSid && x.sid === pomijaSid)) return;
    if (x.rola === 'instruktor' || String(x.station || '').toUpperCase() === 'INSTRUKTOR') return;
    const sX = minuty(x.start); let eX = minuty(x.end); if (eX <= sX) eX += 1440;
    if (x.date === dzien(kand.date, -1)) {
      const przerwa = (1440 + startK) - eX;
      if (przerwa < 660) out.push(`odpoczynek ${Math.round(przerwa / 60)} h po zmianie ${x.date} ${x.start}–${x.end} (wymagane 11 h)`);
    }
    if (x.date === dzien(kand.date, 1)) {
      const przerwa = (1440 + sX) - endK;
      if (przerwa < 660) out.push(`odpoczynek ${Math.round(przerwa / 60)} h przed zmianą ${x.date} ${x.start}–${x.end} (wymagane 11 h)`);
    }
  });
  return out;
}
// blokady: nakładanie zmian, zatwierdzona absencja, niedostępność (WFM-02);
// ostrzeżenia: odpoczynek <11 h, poza oknem dostępności, reguły umowy (WFM-04)
const DNI_TYG = ['niedzielę', 'poniedziałek', 'wtorek', 'środę', 'czwartek', 'piątek', 'sobotę'];
async function sprawdzKonflikty(m, kand, pomijaSid) {
  const kol = kolizjaZmian(m.shifts, kand, pomijaSid);
  if (kol) return { blad: `Konflikt: ${kand.name} ma już zmianę ${kol.start}–${kol.end} (${kol.station}) tego dnia.` };
  const warnings = ostrzezeniaOdpoczynku(m.shifts, kand, pomijaSid);
  if (kand.accountId) {
    const ab = await absencjaZatwierdzona(kand.accountId, kand.date);
    if (ab) return { blad: `Konflikt: ${kand.name} ma zatwierdzoną absencję (${ab.type}) ${ab.from}–${ab.to}.` };
    // WFM-02: zatwierdzona dostępność
    const av = await dostepnoscDnia(kand.accountId, kand.date);
    if (av && av.tryb === 'brak') return { blad: `Konflikt: ${kand.name} jest niedostępny w ${DNI_TYG[new Date(kand.date).getDay()]} (zatwierdzona dostępność).` };
    if (av && av.tryb === 'okno') {
      if (minuty(kand.start) < minuty(av.od) || minuty(kand.end) > minuty(av.do)) warnings.push(`poza oknem dostępności ${av.od}–${av.do}`);
    }
    // Dyspozycje dzienne (WorkRhythm): zatwierdzona „nie mogę" blokuje; ograniczenia godzin ostrzegają
    const dy = await dyspozycjaNaDzien(kand.accountId, kand.date);
    if (dy) {
      if (dy.type === 'unavailable') return { blad: `Konflikt: ${kand.name} zgłosił(a) „nie mogę pracować" na ${kand.date} (dyspozycja zatwierdzona).` };
      if (dy.type === 'from_time' && minuty(kand.start) < minuty(dy.startTime)) warnings.push(`dyspozycja: może od ${dy.startTime}`);
      if (dy.type === 'until_time' && minuty(kand.end) > minuty(dy.endTime)) warnings.push(`dyspozycja: może do ${dy.endTime}`);
      if (dy.type === 'specific_shift' && (minuty(kand.start) < minuty(dy.startTime) || minuty(kand.end) > minuty(dy.endTime))) warnings.push(`dyspozycja: preferowana zmiana ${dy.startTime}–${dy.endTime}`);
    }
    // WFM-04: reguły umowy konta
    try {
      const konta = (await kv.get('accounts:list')) || [];
      const konto = konta.find((k) => k.id === kand.accountId);
      if (konto) {
        const godzKand = kand.hours != null ? Number(kand.hours) : (() => { let a = minuty(kand.start), b = minuty(kand.end); if (b <= a) b += 1440; return (b - a) / 60; })();
        if (konto.maxDobaH && godzKand > Number(konto.maxDobaH)) warnings.push(`zmiana ${godzKand} h przekracza limit dobowy ${konto.maxDobaH} h`);
        if (Array.isArray(konto.stanowiska) && konto.stanowiska.length && !konto.stanowiska.map((x) => String(x).toUpperCase()).includes(String(kand.station || '').toUpperCase())) {
          warnings.push(`stanowisko ${kand.station} poza kwalifikacjami (${konto.stanowiska.join(', ')})`);
        }
        if (konto.wymiarTygH) {
          const d = new Date(kand.date); const pon = new Date(d); pon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
          const dni = Array.from({ length: 7 }, (_, i) => { const x = new Date(pon); x.setDate(pon.getDate() + i); return x.toISOString().slice(0, 10); });
          const sumaTyg = (m.shifts || []).filter((x) => x.accountId === kand.accountId && dni.includes(x.date) && (!pomijaSid || x.sid !== pomijaSid) && x.rola !== 'instruktor')
            .reduce((a, x) => a + (Number(x.hours) || 0), 0) + godzKand;
          if (sumaTyg > Number(konto.wymiarTygH)) warnings.push(`suma tygodnia ${sumaTyg.toFixed(1)} h przekracza wymiar ${konto.wymiarTygH} h`);
        }
      }
    } catch {}
  }
  return { warnings };
}

// DATA-02: stabilny identyfikator zmiany — przetrwa edycję godzin/osoby/stanowiska
const newSid = () => 'sh_' + randomUUID();
// DATA-03: każda mutacja podbija wersję miesiąca; klient może przekazać expectedVersion
const saveMonth = async (ym, m) => { m.version = (m.version || 0) + 1; m.meta = { ...(m.meta || {}), version: m.version }; await kv.set(`sched:${ym}`, m); return m.version; };
const konfliktWersji = (m, expected) => expected != null && String(expected) !== '' && Number(expected) !== (m.version || 0);
const ODP_KONFLIKT = (res, m) => res.status(409).json({ success: false, konflikt: true, error: 'Konflikt wersji — grafik został w międzyczasie zmieniony przez kogoś innego. Odśwież i spróbuj ponownie.', version: m.version || 0 });

// Normalizacja nazwiska do dopasowania (wielkie litery, bez polskich znaków)
function normalizeName(name) {
  if (!name) return '';
  return name.toString().trim().toUpperCase().replace(/\s+/g, ' ')
    .replace(/Ą/g, 'A').replace(/Ć/g, 'C').replace(/Ę/g, 'E').replace(/Ł/g, 'L')
    .replace(/Ń/g, 'N').replace(/Ó/g, 'O').replace(/Ś/g, 'S').replace(/Ź/g, 'Z').replace(/Ż/g, 'Z');
}

// ── Przechowywanie per miesiąc ─────────────────────────────────────────
// Każdy miesiąc pod kluczem  sched:YYYY-MM  = { shifts, roster, meta }
// Indeks miesięcy pod kluczem sched:index   = ['2026-07','2026-08', ...]
const INDEX_KEY = 'sched:index';
const monthKey = (ym) => `sched:${ym}`;

const readIndex = async () => (await kv.get(INDEX_KEY)) || [];
const readMonth = async (ym) => (await kv.get(monthKey(ym))) || { shifts: [], roster: [], meta: {} };
// dopisanie sid brakującym zmianom (migracja starych danych; bez podbijania wersji)
const readMonthEnsure = async (ym) => {
  const m = await readMonth(ym);
  let changed = false;
  (m.shifts || []).forEach((s) => { if (!s.sid) { s.sid = newSid(); changed = true; } });
  if (changed) await kv.set(monthKey(ym), m);
  return m;
};

async function readAll() {
  const idx = await readIndex();
  let shifts = [];
  const rosterSet = new Set();
  const months = [];
  for (const ym of idx) {
    const m = await readMonthEnsure(ym);
    shifts = shifts.concat(m.shifts || []);
    (m.roster || []).forEach((r) => rosterSet.add(r));
    months.push({ key: ym, meta: m.meta || {}, count: (m.shifts || []).length, version: m.version || 0 });
  }
  months.sort((a, b) => a.key.localeCompare(b.key));
  return { shifts, roster: [...rosterSet].sort(), months };
}

// Migracja ze starego pojedynczego klucza schedule:data (jeśli istnieje)
async function migrateLegacy() {
  const idx = await readIndex();
  if (idx.length) return;
  const legacy = await kv.get('schedule:data');
  if (legacy && Array.isArray(legacy.shifts) && legacy.shifts.length) {
    const first = legacy.shifts.map((s) => s.date).sort()[0];
    const ym = (legacy.meta && legacy.meta.year != null && legacy.meta.month != null)
      ? `${legacy.meta.year}-${String(legacy.meta.month + 1).padStart(2, '0')}`
      : first.slice(0, 7);
    await kv.set(monthKey(ym), legacy);
    await kv.set(INDEX_KEY, [ym]);
    await kv.del('schedule:data');
  }
}


// Zestaw nazw, pod którymi dana osoba występuje w grafiku (nazwa główna + aliasy z konta).
// Dzięki temu dwóch pracowników o tym samym nazwisku (np. MATI KOLSKI vs KOLSKI) się nie miesza.
async function kluczeOsoby(name) {
  const t = normalizeName(name);
  try {
    const konta = (await kv.get('accounts:list')) || [];
    const k = konta.find((a) => normalizeName(a.grafikName || '') === t || (a.aliasy || []).some((x) => normalizeName(x) === t) || normalizeName(a.name || '') === t);
    if (k) {
      const zestaw = [k.grafikName, ...(k.aliasy || [])].filter(Boolean).map(normalizeName);
      if (zestaw.length) return zestaw;
    }
  } catch (e) { /* brak kont — dopasowanie po samej nazwie */ }
  return [t];
}


// ── Przypisanie zmian do KONT pracowników ──
// Zamiast dopasowywać po nazwisku przy każdym zapytaniu, robimy to RAZ przy imporcie:
// każda zmiana dostaje accountId. To rozwiązuje dwóch pracowników o tym samym nazwisku.
async function wczytajKonta() { try { return (await kv.get('accounts:list')) || []; } catch (e) { return []; } }
function mapaNazw(konta) {
  const m = new Map();
  konta.forEach((a) => {
    [a.grafikName, ...(a.aliasy || [])].filter(Boolean).forEach((n) => m.set(normalizeName(n), a.id));
  });
  // pełne imię i nazwisko tylko jako ostatnia deska ratunku i tylko gdy nie ma konfliktu
  konta.forEach((a) => { const k = normalizeName(a.name || ''); if (k && !m.has(k)) m.set(k, a.id); });
  return m;
}
function przypiszZmiany(shifts, konta) {
  const m = mapaNazw(konta);
  const nieprzypisane = {};
  const out = (shifts || []).map((s) => {
    const id = m.get(normalizeName(s.name));
    if (id) return { ...s, accountId: id };
    const { accountId, ...reszta } = s;                 // stare, nieaktualne przypisanie kasujemy
    nieprzypisane[s.name] = (nieprzypisane[s.name] || 0) + 1;
    return reszta;
  });
  return { shifts: out, nieprzypisane };
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona. W Vercel: projekt backendu → Storage → Redis (Upstash) → podłącz, a potem wdróż ponownie (vercel --prod).' });

  try {
    await migrateLegacy();

    // ── GET ──
    if (req.method === 'GET') {
      const sesja = await requireRole(req, res, ['asm', 'kierownik', 'pracownik']);
      if (!sesja) return;
      let { name, roster, month, accountId } = req.query;
      // Pracownik: wyłącznie własne zmiany (macierz: R własny); dzień zespołu bez accountId
      if (sesja.role === 'pracownik') {
        if (accountId && accountId !== sesja.accountId) accountId = sesja.accountId;
        if (name) name = sesja.grafikName || sesja.name;
        if (!accountId && !name && month) {
          const m = await readForEmployee(month);
          return res.json({ success: true, shifts: (m.shifts || []).map(({ accountId: _a, ...rz }) => rz), meta: m.meta, opublikowany: !m.niepublikowany });
        }
        if (!accountId && !name) accountId = sesja.accountId;
      }

      // Po identyfikatorze konta — jednoznacznie, bez zgadywania po nazwisku
      if (accountId) {
        // WFM-01: pracownik dostaje zmiany z OPUBLIKOWANYCH snapshotów + status potwierdzeń
        if (sesja.role === 'pracownik') {
          const idx = await readIndex();
          let mine = []; const publikacje = [];
          for (const ym of idx) {
            const m = await readForEmployee(ym);
            mine = mine.concat((m.shifts || []).filter((x) => x.accountId === accountId));
            if (!m.niepublikowany) publikacje.push({ month: ym, wersjaPub: m.wersjaPub || 0, at: m.at || null, potwierdzone: !!((m.confirmations || {})[accountId]) });
          }
          return res.json({ success: true, shifts: mine, found: true, publikacje });
        }
        if (month) { const m = await readMonth(month); return res.json({ success: true, shifts: (m.shifts || []).filter((s) => s.accountId === accountId), meta: m.meta }); }
        const all = await readAll();
        const mine = all.shifts.filter((s) => s.accountId === accountId);
        return res.json({ success: true, shifts: mine, found: true, months: all.months });
      }

      // Konkretny miesiąc
      if (month) {
        const m = sesja.role === 'pracownik' ? await readMonth(month) : await readMonthEnsure(month);
        if (name) {
          const klucze = await kluczeOsoby(name);
          return res.json({ success: true, shifts: (m.shifts || []).filter((s) => klucze.includes(normalizeName(s.name))), meta: m.meta });
        }
        return res.json({ success: true, shifts: m.shifts, roster: m.roster, meta: m.meta });
      }

      // WFM-01: status publikacji miesiąca (wersja, potwierdzenia, różnice vs kopia robocza)
      if (req.query.action === 'pubinfo' && req.query.pubmonth) {
        if (!['asm', 'kierownik'].includes(sesja.role)) return res.status(403).json({ success: false, error: 'Brak uprawnień.' });
        const ym = req.query.pubmonth;
        const working = await readMonthEnsure(ym);
        const pub = await readPub(ym);
        let roznice = null;
        if (pub) {
          const wMap = new Map((working.shifts || []).map((x) => [x.sid, x]));
          const pMap = new Map((pub.shifts || []).map((x) => [x.sid, x]));
          const dodane = [...wMap.keys()].filter((k) => !pMap.has(k)).length;
          const usuniete = [...pMap.keys()].filter((k) => !wMap.has(k)).length;
          const zmienione = [...wMap.keys()].filter((k) => { const a = wMap.get(k), b = pMap.get(k); return b && (a.date !== b.date || a.start !== b.start || a.end !== b.end || a.station !== b.station || a.name !== b.name); }).length;
          roznice = { dodane, usuniete, zmienione, razem: dodane + usuniete + zmienione };
        }
        const konta = (await kv.get('accounts:list')) || [];
        const potw = pub ? Object.entries(pub.confirmations || {}).map(([aid, v]) => ({ name: (konta.find((k) => k.id === aid) || {}).name || aid, at: v.at })) : [];
        const zKontami = new Set((pub ? pub.shifts : []).filter((x) => x.accountId).map((x) => x.accountId));
        const hist = (await kv.get(pubHistKey(ym))) || [];
        return res.json({ success: true, month: ym, opublikowany: !!pub, wersjaPub: pub ? pub.wersjaPub : 0, at: pub ? pub.at : null, by: pub ? pub.by : null, zmianRoboczych: (working.shifts || []).length, zmianOpublikowanych: pub ? (pub.shifts || []).length : 0, roznice, potwierdzenia: potw, osobOczekiwane: zKontami.size, historiaWersji: hist.map((h) => ({ wersjaPub: h.wersjaPub, at: h.at, by: h.by, zastapionaAt: h.zastapionaAt, zmian: (h.shifts || []).length })) });
      }

      const all = await readAll();

      if (roster) {
        return res.json({ success: true, roster: all.roster, months: all.months });
      }

      // Logowanie po nazwisku — zmiany ze WSZYSTKICH miesięcy
      if (name) {
        const konta = await wczytajKonta();
        const konto = konta.find((a) => [a.grafikName, ...(a.aliasy || []), a.name].filter(Boolean).some((n) => normalizeName(n) === normalizeName(name)));
        const klucze = await kluczeOsoby(name);
        const mine = konto ? all.shifts.filter((s) => s.accountId ? s.accountId === konto.id : klucze.includes(normalizeName(s.name)))
                           : all.shifts.filter((s) => klucze.includes(normalizeName(s.name)));
        const match = all.roster.find((r) => klucze.includes(normalizeName(r)));
        return res.json({ success: true, shifts: mine, displayName: match || name, found: mine.length > 0 || !!match, months: all.months });
      }

      // Cały grafik (panel admina) — wszystkie miesiące scalone + lista miesięcy
      const latest = all.months[all.months.length - 1];
      return res.json({ success: true, shifts: all.shifts, roster: all.roster, months: all.months, meta: latest ? latest.meta : {} });
    }

    // ── PUT: import jednego miesiąca (dodaje/zastępuje TYLKO ten miesiąc) ──
    // POST ?action=add — dopisz pojedynczą zmianę do miesiąca (np. manager dodany z poziomu planowania)
    if (req.method === 'POST' && req.query && req.query.action === 'add') {
      const sesjaMod = await requireRole(req, res, ['asm', 'kierownik']); if (!sesjaMod) return;
      const { date, name, station, start, end, hours, accountId } = req.body || {};
      if (!date || !name || !start || !end) return res.status(400).json({ success: false, error: 'Wymagane: data, osoba, godzina od i do' });
      const ym = String(date).slice(0, 7);
      const m = (await kv.get(monthKey(ym))) || { shifts: [], roster: [], meta: {} };
      if (konfliktWersji(m, (req.body || {}).expectedVersion)) return ODP_KONFLIKT(res, m);
      const godz = hours != null ? Number(hours) : (() => { const [h1, m1] = start.split(':').map(Number); const [h2, m2] = end.split(':').map(Number); let a = h1 * 60 + m1, b = h2 * 60 + m2; if (b <= a) b += 1440; return (b - a) / 60; })();
      const osoba = String(name).trim().toUpperCase();
      let idKonta = accountId || null;
      if (!idKonta) { const konta = await wczytajKonta(); idKonta = mapaNazw(konta).get(normalizeName(osoba)) || null; }
      const zmiana = { sid: newSid(), date, name: osoba, station: (station || 'MANAGER').toUpperCase(), start, end, hours: godz, dodana: true, ...(idKonta ? { accountId: idKonta } : {}) };
      const kfl = await sprawdzKonflikty(m, zmiana, null);                 // WFM-05
      if (kfl.blad) return res.status(409).json({ success: false, error: kfl.blad });
      m.shifts = [...(m.shifts || []), zmiana];
      if (!(m.roster || []).some((r) => normalizeName(r) === normalizeName(osoba))) m.roster = [...(m.roster || []), osoba];
      const wersja = await saveMonth(ym, m);
      const idx = (await kv.get(INDEX_KEY)) || [];
      if (!idx.includes(ym)) await kv.set(INDEX_KEY, [...idx, ym].sort());
      await audit({ ...aktor(sesjaMod), action: 'schedule.add', target: `${ym}/${zmiana.sid}`, after: zmiana });
      return res.json({ success: true, shift: zmiana, version: wersja, warnings: kfl.warnings || [] });
    }

    // WFM-01: publikacja miesiąca — zamrożony snapshot dla pracowników (tylko ASM)
    if (req.method === 'POST' && req.query && req.query.action === 'publish') {
      const sesjaPub = await requireRole(req, res, ['asm']);
      if (!sesjaPub) return;
      const ym = (req.body || {}).month;
      if (!ym) return res.status(400).json({ success: false, error: 'Wskaż miesiąc do publikacji.' });
      const working = await readMonthEnsure(ym);
      if (!(working.shifts || []).length) return res.status(400).json({ success: false, error: 'Ten miesiąc nie ma żadnych zmian.' });
      const poprzedni = await readPub(ym);
      // P4-06: poprzednia wersja publikacji trafia do historii append-only (nie znika przy nadpisaniu)
      if (poprzedni) {
        const hist = (await kv.get(pubHistKey(ym))) || [];
        hist.unshift({ ...poprzedni, zastapionaAt: new Date().toISOString() });
        if (hist.length > 12) hist.length = 12;
        await kv.set(pubHistKey(ym), hist);
      }
      const pub = {
        shifts: working.shifts, roster: working.roster, meta: { ...(working.meta || {}) },
        baseVersion: working.version || 0,
        wersjaPub: (poprzedni ? poprzedni.wersjaPub : 0) + 1,
        at: new Date().toISOString(), by: sesjaPub.name,
        confirmations: {},                                   // nowa wersja = potwierdzenia od nowa
      };
      await kv.set(pubKey(ym), pub);
      await audit({ ...aktor(sesjaPub), action: 'schedule.publish', target: ym, after: { wersjaPub: pub.wersjaPub, zmian: pub.shifts.length } });
      return res.json({ success: true, month: ym, wersjaPub: pub.wersjaPub, zmian: pub.shifts.length });
    }

    // WFM-01: potwierdzenie zapoznania się z grafikiem (pracownik)
    if (req.method === 'POST' && req.query && req.query.action === 'confirm') {
      const sesjaC = await requireRole(req, res, ['pracownik']);
      if (!sesjaC) return;
      const ym = (req.body || {}).month;
      const pub = ym ? await readPub(ym) : null;
      if (!pub) return res.status(404).json({ success: false, error: 'Ten miesiąc nie został jeszcze opublikowany.' });
      pub.confirmations = { ...(pub.confirmations || {}), [sesjaC.accountId]: { at: Date.now(), name: sesjaC.name } };
      await kv.set(pubKey(ym), pub);
      await audit({ ...aktor(sesjaC), action: 'schedule.confirm', target: `${ym} v${pub.wersjaPub}` });
      return res.json({ success: true, month: ym, wersjaPub: pub.wersjaPub });
    }

    // POST ?action=przypisz — ponowne przypisanie zmian do kont we WSZYSTKICH miesiącach
    if (req.method === 'POST' && req.query && req.query.action === 'przypisz') {
      const sesjaMod = await requireRole(req, res, ['asm', 'kierownik']); if (!sesjaMod) return;
      const konta = await wczytajKonta();
      const idx = await readIndex();
      let razem = 0, przypisane = 0; const nieprzypisane = {};
      for (const ym of idx) {
        const m = await readMonth(ym);
        const w = przypiszZmiany(m.shifts || [], konta);
        m.shifts = w.shifts;
        await kv.set(monthKey(ym), m);
        razem += w.shifts.length;
        przypisane += w.shifts.filter((s) => s.accountId).length;
        Object.entries(w.nieprzypisane).forEach(([n, c]) => { nieprzypisane[n] = (nieprzypisane[n] || 0) + c; });
      }
      return res.json({ success: true, razem, przypisane, nieprzypisane, miesiace: idx.length });
    }

    // POST ?action=update — edycja zmiany (planowanej): godziny / stanowisko / osoba
    if (req.method === 'POST' && req.query && req.query.action === 'update') {
      const sesjaMod = await requireRole(req, res, ['asm', 'kierownik']); if (!sesjaMod) return;
      const { sid, date, name, start, end, nowe } = req.body || {};
      if (!nowe || (!sid && !(date && name && start && end))) return res.status(400).json({ success: false, error: 'Wymagane: sid albo identyfikacja zmiany (date, name, start, end) i nowe wartości' });
      const ym = String(date).slice(0, 7);
      const m = await kv.get(monthKey(ym));
      if (!m) return res.status(404).json({ success: false, error: 'Brak grafiku dla tego miesiąca' });
      if (konfliktWersji(m, (req.body || {}).expectedVersion)) return ODP_KONFLIKT(res, m);
      // DATA-02: preferuj stabilny identyfikator; atrybuty tylko jako zapas dla starych danych
      let idx = sid ? (m.shifts || []).findIndex((s) => s.sid === sid) : -1;
      if (idx < 0) idx = (m.shifts || []).findIndex((s) => s.date === date && normalizeName(s.name) === normalizeName(name) && s.start === start && s.end === end);
      if (idx < 0) return res.status(404).json({ success: false, error: 'Nie znaleziono zmiany' });
      const st = m.shifts[idx];
      const nStart = nowe.start || st.start, nEnd = nowe.end || st.end;
      const godz = (() => { const [h1, m1] = nStart.split(':').map(Number); const [h2, m2] = nEnd.split(':').map(Number); let a = h1 * 60 + m1, b = h2 * 60 + m2; if (b <= a) b += 1440; return (b - a) / 60; })();
      let osoba = st.name, idKonta = st.accountId || null;
      if (nowe.name && String(nowe.name).trim()) {
        osoba = String(nowe.name).trim().toUpperCase();
        const konta = await wczytajKonta();
        idKonta = nowe.accountId || mapaNazw(konta).get(normalizeName(osoba)) || null;
        if (!(m.roster || []).some((r) => normalizeName(r) === normalizeName(osoba))) m.roster = [...(m.roster || []), osoba];
      }
      const kandydat = { ...st, sid: st.sid || newSid(), name: osoba, station: (nowe.station || st.station || '').toUpperCase(), start: nStart, end: nEnd, hours: godz, ...(idKonta ? { accountId: idKonta } : {}) };
      const kfl = await sprawdzKonflikty(m, kandydat, st.sid);             // WFM-05
      if (kfl.blad) return res.status(409).json({ success: false, error: kfl.blad });
      m.shifts[idx] = kandydat;
      const wersja = await saveMonth(ym, m);
      await audit({ ...aktor(sesjaMod), action: 'schedule.update', target: `${ym}/${m.shifts[idx].sid}`, before: st, after: m.shifts[idx] });
      return res.json({ success: true, przed: { date, name: st.name, start, end }, shift: m.shifts[idx], version: wersja, warnings: kfl.warnings || [] });
    }

    // POST ?action=remove — usuń dopisaną zmianę
    if (req.method === 'POST' && req.query && req.query.action === 'remove') {
      const sesjaMod = await requireRole(req, res, ['asm', 'kierownik']); if (!sesjaMod) return;
      const { sid, date, name, start, end } = req.body || {};
      const ym = String(date || '').slice(0, 7);
      const m = await kv.get(monthKey(ym));
      if (!m) return res.status(404).json({ success: false, error: 'Brak grafiku dla tego miesiąca' });
      if (konfliktWersji(m, (req.body || {}).expectedVersion)) return ODP_KONFLIKT(res, m);
      const przed = (m.shifts || []).length;
      const usuwane = (m.shifts || []).filter((s) => sid ? s.sid === sid : (s.date === date && normalizeName(s.name) === normalizeName(name) && s.start === start && s.end === end));
      m.shifts = (m.shifts || []).filter((s) => !usuwane.includes(s));
      const wersja = await saveMonth(ym, m);
      // COR-03: kasujemy wyłącznie PLAN — odbicia (clock:*) i wykonanie pozostają nietknięte
      for (const u of usuwane) await audit({ ...aktor(sesjaMod), action: 'schedule.remove', target: `${ym}/${u.sid || 'legacy'}`, before: u });
      return res.json({ success: true, usuniete: przed - m.shifts.length, version: wersja });
    }

    if (req.method === 'PUT') {
      const sesjaMod = await requireRole(req, res, ['asm']); if (!sesjaMod) return;
      const { shifts: shiftsIn, roster, meta } = req.body;
      const shifts = shiftsIn;
      if (!Array.isArray(shifts) || shifts.length === 0) return res.status(400).json({ success: false, error: 'Tablica zmian wymagana' });

      let ym = (meta && meta.year != null && meta.month != null)
        ? `${meta.year}-${String(meta.month + 1).padStart(2, '0')}`
        : null;
      if (!ym) {
        const first = shifts.map((s) => s.date).filter(Boolean).sort()[0];
        if (first) ym = first.slice(0, 7);
      }
      if (!ym) return res.status(400).json({ success: false, error: 'Nie można ustalić miesiąca grafiku (brak dat).' });

      // Przypisanie zmian do kont pracowników — jedno źródło prawdy dla całej aplikacji
      const konta = await wczytajKonta();
      const wynik = przypiszZmiany(shifts, konta);

      const stary = await kv.get(monthKey(ym));
      const data = {
        shifts: wynik.shifts.map((s) => ({ ...s, sid: s.sid || newSid() })),
        roster: Array.isArray(roster) ? roster : [...new Set(shifts.map((s) => s.name))].sort(),
        meta: { ...(meta || {}), ym, importedAt: new Date().toISOString() },
        version: (stary && stary.version) || 0,
      };
      await saveMonth(ym, data);
      await audit({ ...aktor(sesjaMod), action: 'schedule.import', target: ym, before: { zmian: (stary && (stary.shifts || []).length) || 0 }, after: { zmian: data.shifts.length } });
      const idx = await readIndex();
      if (!idx.includes(ym)) { idx.push(ym); idx.sort(); await kv.set(INDEX_KEY, idx); }

      const all = await readAll();
      const przypisane = wynik.shifts.filter((s) => s.accountId).length;
      return res.json({ success: true, month: ym, count: shifts.length, przypisane, nieprzypisane: wynik.nieprzypisane, months: all.months });
    }

    // ── DELETE: ?month=YYYY-MM usuwa jeden miesiąc; bez parametru czyści wszystko ──
    if (req.method === 'DELETE') {
      const sesjaMod = await requireRole(req, res, ['asm']); if (!sesjaMod) return;
      const { month } = req.query;
      if (month) {
        await kv.del(monthKey(month));
        const idx = (await readIndex()).filter((m) => m !== month);
        await kv.set(INDEX_KEY, idx);
        await audit({ ...aktor(sesjaMod), action: 'schedule.delete-month', target: month });
        return res.json({ success: true, deleted: month });
      }
      const idx = await readIndex();
      for (const ym of idx) await kv.del(monthKey(ym));
      await kv.set(INDEX_KEY, []);
      return res.json({ success: true });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
