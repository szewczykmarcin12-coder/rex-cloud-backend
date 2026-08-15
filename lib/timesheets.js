import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit, aktor } from './audit.js';

// Czas pracy (Working Time) — jeden klucz ts:data:
//   { actuals: { [shiftKey]: { start, end, breaks:[{type,platna,start,end}] } },
//     completed: { [YYYY-MM-DD]: true },
//     weekStatus: { [YYYY-MM-DD(monday)]: { reviewed, closed } } }
const KEY = 'ts:data';
const EMPTY = { actuals: {}, completed: {}, weekStatus: {} };

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona. W Vercel: projekt backendu → Storage → Redis (Upstash) → podłącz, a potem wdróż ponownie.' });

  try {
    if (req.method === 'GET') {
      if (!(await requireRole(req, res, ['asm', 'kierownik']))) return;
      const d = (await kv.get(KEY)) || EMPTY;
      return res.json({ success: true, actuals: d.actuals || {}, completed: d.completed || {}, weekStatus: d.weekStatus || {} });
    }

    if (req.method === 'PUT') {
      const s = await requireRole(req, res, ['asm', 'kierownik']);
      if (!s) return;
      const { data } = req.body || {};
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return res.status(400).json({ success: false, error: 'Nieprawidłowe dane czasu pracy' });
      }
      const next = {
        actuals: data.actuals && typeof data.actuals === 'object' ? data.actuals : {},
        completed: data.completed && typeof data.completed === 'object' ? data.completed : {},
        weekStatus: data.weekStatus && typeof data.weekStatus === 'object' ? data.weekStatus : {},
      };
      // audyt: porównanie z poprzednim stanem (ile wpisów wykonania przybyło/zmieniono/ubyło)
      const stary = (await kv.get(KEY)) || EMPTY;
      const sA = stary.actuals || {}, nA = next.actuals;
      const dodane = Object.keys(nA).filter((k) => !(k in sA)).length;
      const zmienione = Object.keys(nA).filter((k) => k in sA && JSON.stringify(nA[k]) !== JSON.stringify(sA[k])).length;
      const usuniete = Object.keys(sA).filter((k) => !(k in nA)).length;
      await kv.set(KEY, next);
      if (dodane || zmienione || usuniete) audit({ ...aktor(s), action: 'timesheet.write', target: 'ts:data', after: { dodane, zmienione, usuniete } });
      return res.json({ success: true });
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
