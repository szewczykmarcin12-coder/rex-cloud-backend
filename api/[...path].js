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
import templates from '../lib/templates.js';
import clock from '../lib/clock.js';

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
  'templates': templates,
  'clock': clock,
};

export default async function handler(req, res) {
  // Nazwę endpointu ustalamy przede wszystkim z adresu URL — nie polegamy na tym,
  // że runtime wypełni parametr trasy (req.query.path). Fallback: query.path.
  let nazwa = '';
  try {
    const sciezka = String(req.url || '').split('?')[0];           // np. /api/health
    const czesci = sciezka.split('/').map((x) => x.trim()).filter(Boolean);
    const iApi = czesci.indexOf('api');
    const po = iApi >= 0 ? czesci.slice(iApi + 1) : czesci;
    nazwa = (po[0] || '').toLowerCase();
  } catch (e) { nazwa = ''; }

  if (!nazwa) {
    const raw = (req.query && req.query.path) || [];
    const segmenty = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x || '').trim()).filter(Boolean);
    nazwa = (segmenty[0] || '').toLowerCase();
  }

  // /api lub /api/ — pokaż listę endpointów zamiast błędu
  if (!nazwa) {
    cors(res, req);
    if (req.method === 'OPTIONS') return res.status(200).end();
    return res.status(200).json({ success: true, api: 'REX Cloud', dostepne: Object.keys(TRASY), wskazowka: 'Sprawdź stan wdrożenia: /api/health' });
  }

  const cel = TRASY[nazwa];
  if (!cel) {
    cors(res, req);
    if (req.method === 'OPTIONS') return res.status(200).end();
    return res.status(404).json({ success: false, error: `Nieznany endpoint: /api/${nazwa}`, url: req.url || null, dostepne: Object.keys(TRASY) });
  }

  // Bezpiecznik: nawet nieprzewidziany crash handlera zwraca JSON z nagłówkami CORS,
  // zamiast gołej 500-tki bez CORS (która w przeglądarce wygląda jak "Failed to fetch").
  try {
    return await cel(req, res);
  } catch (e) {
    try { cors(res, req); } catch {}
    console.error('REX handler crash:', nazwa, e);
    if (!res.headersSent) return res.status(500).json({ success: false, error: `Błąd serwera w /api/${nazwa}: ${(e && e.message) || 'nieznany'}` });
  }
}
