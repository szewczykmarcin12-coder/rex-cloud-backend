import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';

// Dane sprzedażowe + parametry optymalizatora. Klucz sales:data:
//   { sales: { 'YYYY-MM-DD': gross }, checks: { 'YYYY-MM-DD': n }, params: {...} }
const KEY = 'sales:data';
const EMPTY = { sales: {}, checks: {}, params: null };

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });

  try {
    if (req.method === 'GET') {
      if (!(await requireRole(req, res, ['asm', 'kierownik']))) return;
      const d = (await kv.get(KEY)) || EMPTY;
      return res.json({ success: true, sales: d.sales || {}, checks: d.checks || {}, params: d.params || null });
    }

    if (req.method === 'PUT') {
      if (!(await requireRole(req, res, ['asm']))) return;
      const { sales, checks, params } = req.body || {};
      const cur = (await kv.get(KEY)) || EMPTY;
      const next = {
        sales: sales && typeof sales === 'object' && !Array.isArray(sales) ? { ...(cur.sales || {}), ...sales } : (cur.sales || {}),
        checks: checks && typeof checks === 'object' && !Array.isArray(checks) ? { ...(cur.checks || {}), ...checks } : (cur.checks || {}),
        params: params && typeof params === 'object' && !Array.isArray(params) ? params : (cur.params || null),
      };
      await kv.set(KEY, next);
      return res.json({ success: true, dni: Object.keys(next.sales).length });
    }

    if (req.method === 'DELETE') {
      if (!(await requireRole(req, res, ['asm']))) return;
      await kv.set(KEY, EMPTY);
      return res.json({ success: true });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
