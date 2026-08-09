import { kv, cors, kvConfigured } from './_helpers.js';

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

async function readAll() {
  const idx = await readIndex();
  let shifts = [];
  const rosterSet = new Set();
  const months = [];
  for (const ym of idx) {
    const m = await readMonth(ym);
    shifts = shifts.concat(m.shifts || []);
    (m.roster || []).forEach((r) => rosterSet.add(r));
    months.push({ key: ym, meta: m.meta || {}, count: (m.shifts || []).length });
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

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona. W Vercel: projekt backendu → Storage → Redis (Upstash) → podłącz, a potem wdróż ponownie (vercel --prod).' });

  try {
    await migrateLegacy();

    // ── GET ──
    if (req.method === 'GET') {
      const { name, roster, month } = req.query;

      // Konkretny miesiąc
      if (month) {
        const m = await readMonth(month);
        if (name) {
          const klucze = await kluczeOsoby(name);
          return res.json({ success: true, shifts: (m.shifts || []).filter((s) => klucze.includes(normalizeName(s.name))), meta: m.meta });
        }
        return res.json({ success: true, shifts: m.shifts, roster: m.roster, meta: m.meta });
      }

      const all = await readAll();

      if (roster) {
        return res.json({ success: true, roster: all.roster, months: all.months });
      }

      // Logowanie po nazwisku — zmiany ze WSZYSTKICH miesięcy
      if (name) {
        const klucze = await kluczeOsoby(name);
        const mine = all.shifts.filter((s) => klucze.includes(normalizeName(s.name)));
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
      const { date, name, station, start, end, hours } = req.body || {};
      if (!date || !name || !start || !end) return res.status(400).json({ success: false, error: 'Wymagane: data, osoba, godzina od i do' });
      const ym = String(date).slice(0, 7);
      const m = (await kv.get(monthKey(ym))) || { shifts: [], roster: [], meta: {} };
      const godz = hours != null ? Number(hours) : (() => { const [h1, m1] = start.split(':').map(Number); const [h2, m2] = end.split(':').map(Number); let a = h1 * 60 + m1, b = h2 * 60 + m2; if (b <= a) b += 1440; return (b - a) / 60; })();
      const osoba = String(name).trim().toUpperCase();
      const zmiana = { date, name: osoba, station: (station || 'MANAGER').toUpperCase(), start, end, hours: godz, dodana: true };
      m.shifts = [...(m.shifts || []), zmiana];
      if (!(m.roster || []).some((r) => normalizeName(r) === normalizeName(osoba))) m.roster = [...(m.roster || []), osoba];
      await kv.set(monthKey(ym), m);
      const idx = (await kv.get(INDEX_KEY)) || [];
      if (!idx.includes(ym)) await kv.set(INDEX_KEY, [...idx, ym].sort());
      return res.json({ success: true, shift: zmiana });
    }

    // POST ?action=remove — usuń dopisaną zmianę
    if (req.method === 'POST' && req.query && req.query.action === 'remove') {
      const { date, name, start, end } = req.body || {};
      const ym = String(date || '').slice(0, 7);
      const m = await kv.get(monthKey(ym));
      if (!m) return res.status(404).json({ success: false, error: 'Brak grafiku dla tego miesiąca' });
      const przed = (m.shifts || []).length;
      m.shifts = (m.shifts || []).filter((s) => !(s.date === date && normalizeName(s.name) === normalizeName(name) && s.start === start && s.end === end));
      await kv.set(monthKey(ym), m);
      return res.json({ success: true, usuniete: przed - m.shifts.length });
    }

    if (req.method === 'PUT') {
      const { shifts, roster, meta } = req.body;
      if (!Array.isArray(shifts) || shifts.length === 0) return res.status(400).json({ success: false, error: 'Tablica zmian wymagana' });

      let ym = (meta && meta.year != null && meta.month != null)
        ? `${meta.year}-${String(meta.month + 1).padStart(2, '0')}`
        : null;
      if (!ym) {
        const first = shifts.map((s) => s.date).filter(Boolean).sort()[0];
        if (first) ym = first.slice(0, 7);
      }
      if (!ym) return res.status(400).json({ success: false, error: 'Nie można ustalić miesiąca grafiku (brak dat).' });

      const data = {
        shifts,
        roster: Array.isArray(roster) ? roster : [...new Set(shifts.map((s) => s.name))].sort(),
        meta: { ...(meta || {}), ym, importedAt: new Date().toISOString() },
      };
      await kv.set(monthKey(ym), data);
      const idx = await readIndex();
      if (!idx.includes(ym)) { idx.push(ym); idx.sort(); await kv.set(INDEX_KEY, idx); }

      const all = await readAll();
      return res.json({ success: true, month: ym, count: shifts.length, months: all.months });
    }

    // ── DELETE: ?month=YYYY-MM usuwa jeden miesiąc; bez parametru czyści wszystko ──
    if (req.method === 'DELETE') {
      const { month } = req.query;
      if (month) {
        await kv.del(monthKey(month));
        const idx = (await readIndex()).filter((m) => m !== month);
        await kv.set(INDEX_KEY, idx);
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
