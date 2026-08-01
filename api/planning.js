import { kv, cors, kvConfigured } from './_helpers.js';

// Cały obiekt planowania trzymany pod jednym kluczem:
//   plan:data = { [YYYY-MM]: { planTotal, mgr: {date:h}, mgrFunk: {date:h} } }
const KEY = 'plan:data';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) {
    return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona. W Vercel: projekt backendu → Storage → Redis (Upstash) → podłącz, a potem wdróż ponownie.' });
  }

  try {
    if (req.method === 'GET') {
      const planowanie = (await kv.get(KEY)) || {};
      return res.json({ success: true, planowanie });
    }

    if (req.method === 'PUT') {
      const { planowanie } = req.body || {};
      if (typeof planowanie !== 'object' || planowanie === null || Array.isArray(planowanie)) {
        return res.status(400).json({ success: false, error: 'Nieprawidłowe dane planowania' });
      }
      await kv.set(KEY, planowanie);
      return res.json({ success: true });
    }

    if (req.method === 'DELETE') {
      await kv.del(KEY);
      return res.json({ success: true });
    }

    return res.status(405).json({ success: false, error: 'Metoda niedozwolona' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
