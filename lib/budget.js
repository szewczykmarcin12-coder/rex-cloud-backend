import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';

// Plan budżetu (COL). Klucz budget:data:
//   { employees:[...], settings:{...}, sprzedaz:{}, transakcje:{}, dniS:{} }
const KEY = 'budget:data';
const EMPTY = { employees: [], settings: null, sprzedaz: {}, transakcje: {}, dniS: {} };

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });

  try {
    if (req.method === 'GET') {
      if (!(await requireRole(req, res, ['asm']))) return;
      const d = (await kv.get(KEY)) || EMPTY;
      return res.json({ success: true, data: d });
    }
    if (req.method === 'PUT') {
      if (!(await requireRole(req, res, ['asm']))) return;
      const { data } = req.body || {};
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return res.status(400).json({ success: false, error: 'Nieprawidłowe dane budżetu' });
      await kv.set(KEY, data);
      return res.json({ success: true });
    }
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
