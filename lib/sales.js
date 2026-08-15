import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit, aktor } from './audit.js';

// Dane sprzedażowe + parametry optymalizatora. Klucz sales:data:
//   { sales: { 'YYYY-MM-DD': gross }, checks: { 'YYYY-MM-DD': n }, params: {...} }
const KEY = 'sales:data';
const EMPTY = { sales: {}, checks: {}, params: null, meta: null };

// P4: raport braków — dni bez sprzedaży w ostatnich 30 zakończonych dobach
function raportBrakow(sales) {
  const braki = [];
  const d = new Date(); d.setDate(d.getDate() - 1);
  for (let i = 0; i < 30; i++) {
    const k = d.toISOString().slice(0, 10);
    if (sales[k] == null) braki.push(k);
    d.setDate(d.getDate() - 1);
  }
  return braki.reverse();
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });

  try {
    if (req.method === 'GET') {
      if (!(await requireRole(req, res, ['asm', 'kierownik']))) return;
      const d = (await kv.get(KEY)) || EMPTY;
      return res.json({ success: true, sales: d.sales || {}, checks: d.checks || {}, params: d.params || null, meta: d.meta || null, braki: raportBrakow(d.sales || {}) });
    }

    if (req.method === 'PUT') {
      const s = await requireRole(req, res, ['asm']);
      if (!s) return;
      const { sales, checks, params, source } = req.body || {};
      const cur = (await kv.get(KEY)) || EMPTY;
      const noweDni = sales && typeof sales === 'object' && !Array.isArray(sales) ? Object.keys(sales).length : 0;
      const next = {
        sales: sales && typeof sales === 'object' && !Array.isArray(sales) ? { ...(cur.sales || {}), ...sales } : (cur.sales || {}),
        checks: checks && typeof checks === 'object' && !Array.isArray(checks) ? { ...(cur.checks || {}), ...checks } : (cur.checks || {}),
        params: params && typeof params === 'object' && !Array.isArray(params) ? params : (cur.params || null),
        // P4: wersja i świeżość danych sprzedażowych — Excel pozostaje trybem awaryjnym do czasu POS
        meta: noweDni ? { wersja: ((cur.meta && cur.meta.wersja) || 0) + 1, importedAt: new Date().toISOString(), source: source || 'excel', importedBy: s.name, dniWImporcie: noweDni } : (cur.meta || null),
      };
      await kv.set(KEY, next);
      if (noweDni) await audit({ ...aktor(s), action: 'sales.import', target: `wersja ${next.meta.wersja}`, after: { dni: noweDni, source: next.meta.source } });
      return res.json({ success: true, dni: Object.keys(next.sales).length, meta: next.meta, braki: raportBrakow(next.sales) });
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
