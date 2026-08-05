import { kv, cors, kvConfigured } from './_helpers.js';

// Czas pracy (Working Time) — jeden klucz ts:data:
//   { actuals: { [shiftKey]: { start, end, breaks:[{type,platna,start,end}] } },
//     completed: { [YYYY-MM-DD]: true },
//     weekStatus: { [YYYY-MM-DD(monday)]: { reviewed, closed } } }
const KEY = 'ts:data';
const EMPTY = { actuals: {}, completed: {}, weekStatus: {} };

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona. W Vercel: projekt backendu → Storage → Redis (Upstash) → podłącz, a potem wdróż ponownie.' });

  try {
    if (req.method === 'GET') {
      const d = (await kv.get(KEY)) || EMPTY;
      return res.json({ success: true, actuals: d.actuals || {}, completed: d.completed || {}, weekStatus: d.weekStatus || {} });
    }

    if (req.method === 'PUT') {
      const { data } = req.body || {};
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return res.status(400).json({ success: false, error: 'Nieprawidłowe dane czasu pracy' });
      }
      const next = {
        actuals: data.actuals && typeof data.actuals === 'object' ? data.actuals : {},
        completed: data.completed && typeof data.completed === 'object' ? data.completed : {},
        weekStatus: data.weekStatus && typeof data.weekStatus === 'object' ? data.weekStatus : {},
      };
      await kv.set(KEY, next);
      return res.json({ success: true });
    }

    if (req.method === 'DELETE') {
      await kv.set(KEY, EMPTY);
      return res.json({ success: true });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
