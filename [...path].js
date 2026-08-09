import { cors } from '../lib/_helpers.js';
import schedule from '../lib/schedule.js';
import adminAuth from '../lib/admin-auth.js';
import planning from '../lib/planning.js';
import swaps from '../lib/swaps.js';
import timesheets from '../lib/timesheets.js';
import accounts from '../lib/accounts.js';
import budget from '../lib/budget.js';
import sales from '../lib/sales.js';
import health from '../lib/health.js';

// Jedna funkcja serverless obsługuje wszystkie endpointy /api/*.
// Dzięki temu projekt zajmuje 1 z 12 dostępnych funkcji na planie Hobby,
// a adresy pozostają bez zmian: /api/schedule, /api/accounts?action=auth itd.
const TRASY = {
  'schedule': schedule,
  'admin-auth': adminAuth,
  'planning': planning,
  'swaps': swaps,
  'timesheets': timesheets,
  'accounts': accounts,
  'budget': budget,
  'sales': sales,
  'health': health,
};

export default async function handler(req, res) {
  const raw = (req.query && req.query.path) || [];
  const segmenty = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x || '').trim()).filter(Boolean);
  const nazwa = (segmenty[0] || '').toLowerCase();

  // /api lub /api/ — pokaż listę endpointów zamiast błędu
  if (!nazwa) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    return res.status(200).json({ success: true, api: 'REX Cloud', dostepne: Object.keys(TRASY), wskazowka: 'Sprawdź stan wdrożenia: /api/health' });
  }

  const cel = TRASY[nazwa];
  if (!cel) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    return res.status(404).json({ success: false, error: `Nieznany endpoint: /api/${nazwa}`, dostepne: Object.keys(TRASY) });
  }

  return cel(req, res);
}
