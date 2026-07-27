import { kv, cors, kvConfigured } from './_helpers.js';

// Normalize a name for matching: uppercase, trim, collapse spaces, strip Polish diacritics
function normalizeName(name) {
  if (!name) return '';
  return name.toString().trim().toUpperCase().replace(/\s+/g, ' ')
    .replace(/Ą/g, 'A').replace(/Ć/g, 'C').replace(/Ę/g, 'E').replace(/Ł/g, 'L')
    .replace(/Ń/g, 'N').replace(/Ó/g, 'O').replace(/Ś/g, 'S').replace(/Ź/g, 'Z').replace(/Ż/g, 'Z');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona. W Vercel: projekt backendu → Storage → Redis (Upstash) → podłącz, a potem wdróż ponownie (vercel --prod).' });

  try {
    // GET /api/schedule            -> full schedule (admin)
    // GET /api/schedule?name=X     -> shifts for one employee (app login by name)
    // GET /api/schedule?roster=1   -> just the list of employee names
    if (req.method === 'GET') {
      const { name, roster } = req.query;
      const data = await kv.get('schedule:data') || { shifts: [], roster: [], meta: {} };

      if (roster) {
        return res.json({ success: true, roster: data.roster, meta: data.meta });
      }

      if (name) {
        const target = normalizeName(name);
        const mine = data.shifts.filter(s => normalizeName(s.name) === target);
        // Determine display name (original casing) from roster if available
        const match = data.roster.find(r => normalizeName(r) === target);
        return res.json({ success: true, shifts: mine, displayName: match || name, meta: data.meta, found: mine.length > 0 || !!match });
      }

      return res.json({ success: true, shifts: data.shifts, roster: data.roster, meta: data.meta });
    }

    // PUT /api/schedule - admin imports full schedule (replaces everything)
    if (req.method === 'PUT') {
      const { shifts, roster, meta } = req.body;
      if (!Array.isArray(shifts)) return res.status(400).json({ success: false, error: 'Tablica zmian wymagana' });

      const data = {
        shifts,
        roster: Array.isArray(roster) ? roster : [...new Set(shifts.map(s => s.name))].sort(),
        meta: meta || { importedAt: new Date().toISOString() }
      };
      data.meta.importedAt = new Date().toISOString();
      await kv.set('schedule:data', data);
      return res.json({ success: true, count: shifts.length, roster: data.roster });
    }

    // DELETE /api/schedule - clear all
    if (req.method === 'DELETE') {
      await kv.set('schedule:data', { shifts: [], roster: [], meta: {} });
      return res.json({ success: true });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
