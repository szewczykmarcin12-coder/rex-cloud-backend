import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit, aktor } from './audit.js';

// ═══════════ Konfiguracja jednostki (work center) ═══════════
// GET /api/org — każda zalogowana rola (Studio i Employee Hub); PUT /api/org — ASM.
// Fundament pod multi-unit: dane jednostki przestają być wpisane na stałe w kodzie.
const KEY = 'org:unit';
export const DOMYSLNA = { code: 'PLK 201043', name: 'Galeria Krakowska', city: 'Kraków', brand: 'Popeyes', region: 'Małopolska', openFrom: '06:00', openTo: '02:00', timezone: 'Europe/Warsaw' };

export async function czytajJednostke() { return { ...DOMYSLNA, ...((await kv.get(KEY)) || {}) }; }

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });
  try {
    if (req.method === 'GET') {
      if (!(await requireRole(req, res, ['asm', 'kierownik', 'pracownik']))) return;
      return res.json({ success: true, unit: await czytajJednostke() });
    }
    if (req.method === 'PUT') {
      const s = await requireRole(req, res, ['asm']);
      if (!s) return;
      const b = req.body || {};
      const czysc = (v, max = 80) => String(v == null ? '' : v).trim().slice(0, max);
      const przed = await czytajJednostke();
      const next = {
        code: czysc(b.code) || przed.code, name: czysc(b.name) || przed.name, city: czysc(b.city) || przed.city,
        brand: czysc(b.brand) || przed.brand, region: czysc(b.region) || przed.region,
        openFrom: /^\d{2}:\d{2}$/.test(String(b.openFrom || '')) ? b.openFrom : przed.openFrom,
        openTo: /^\d{2}:\d{2}$/.test(String(b.openTo || '')) ? b.openTo : przed.openTo,
        timezone: przed.timezone,
      };
      await kv.set(KEY, next);
      await audit({ ...aktor(s), action: 'org.update', target: next.code, before: przed, after: next });
      return res.json({ success: true, unit: next });
    }
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
