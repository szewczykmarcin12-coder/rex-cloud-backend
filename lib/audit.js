// DATA-04: niezmienny dziennik audytu. Wpisy tylko dopisywane (append-only),
// brak endpointu kasującego. Klucz audit:log (najnowsze na początku, limit 2000).
// Wpis: { at, iso, actor, role, action, target, before, after, reason, requestId }
import crypto from 'crypto';
import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';

const KEY = 'audit:log';
const MAX = 2000;

export async function audit(entry) {
  try {
    const log = (await kv.get(KEY)) || [];
    log.unshift({
      at: Date.now(),
      iso: new Date().toISOString(),
      requestId: entry.requestId || crypto.randomUUID(),
      ...entry,
    });
    if (log.length > MAX) log.length = MAX;
    await kv.set(KEY, log);
  } catch (e) { console.error('[audit] zapis nieudany:', e && e.message); }
}

// aktor z sesji — do wpisów audytowych
export const aktor = (s) => ({ actor: (s && (s.login || s.name)) || 'nieznany', role: (s && s.role) || null });

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });
  try {
    // dziennik jest niezmienny — wyłącznie odczyt, wyłącznie ASM
    if (req.method === 'GET') {
      if (!(await requireRole(req, res, ['asm']))) return;
      const { limit, action, actor: fAktor } = req.query || {};
      let log = (await kv.get(KEY)) || [];
      if (action) log = log.filter((e) => String(e.action || '').includes(String(action)));
      if (fAktor) log = log.filter((e) => String(e.actor || '').toUpperCase().includes(String(fAktor).toUpperCase()));
      const n = Math.min(Number(limit) || 100, 500);
      return res.json({ success: true, total: log.length, entries: log.slice(0, n) });
    }
    return res.status(405).json({ success: false, error: 'Dziennik audytu jest niezmienny — dozwolony tylko odczyt.' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
