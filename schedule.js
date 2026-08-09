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
          const t = normalizeName(name);
          return res.json({ success: true, shifts: (m.shifts || []).filter((s) => normalizeName(s.name) === t), meta: m.meta });
        }
        return res.json({ success: true, shifts: m.shifts, roster: m.roster, meta: m.meta });
      }

      const all = await readAll();

      if (roster) {
        return res.json({ success: true, roster: all.roster, months: all.months });
      }

      // Logowanie po nazwisku — zmiany ze WSZYSTKICH miesięcy
      if (name) {
        const t = normalizeName(name);
        const mine = all.shifts.filter((s) => normalizeName(s.name) === t);
        const match = all.roster.find((r) => normalizeName(r) === t);
        return res.json({ success: true, shifts: mine, displayName: match || name, found: mine.length > 0 || !!match, months: all.months });
      }

      // Cały grafik (panel admina) — wszystkie miesiące scalone + lista miesięcy
      const latest = all.months[all.months.length - 1];
      return res.json({ success: true, shifts: all.shifts, roster: all.roster, months: all.months, meta: latest ? latest.meta : {} });
    }

    // ── PUT: import jednego miesiąca (dodaje/zastępuje TYLKO ten miesiąc) ──
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
