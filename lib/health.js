import { kv, cors, kvConfigured } from './_helpers.js';

// Diagnostyka wdrożenia: GET /api/health
// Pokazuje, czy funkcje działają i czy baza (Upstash Redis) jest podłączona.
export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const out = {
    success: true,
    status: 'ok',
    czas: new Date().toISOString(),
    node: process.version,
    bazaSkonfigurowana: kvConfigured,
    zmienneSrodowiskowe: {
      KV_REST_API_URL: Boolean(process.env.KV_REST_API_URL),
      KV_REST_API_TOKEN: Boolean(process.env.KV_REST_API_TOKEN),
      UPSTASH_REDIS_REST_URL: Boolean(process.env.UPSTASH_REDIS_REST_URL),
      UPSTASH_REDIS_REST_TOKEN: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN),
    },
    endpointy: ['schedule', 'admin-auth', 'planning', 'swaps', 'timesheets', 'accounts', 'budget', 'sales'],
  };

  if (!kvConfigured) {
    out.status = 'brak bazy';
    out.wskazowka = 'W Vercel: projekt backendu → Storage → podłącz Upstash Redis, a potem wdróż ponownie (Redeploy).';
    return res.status(200).json(out);
  }

  try {
    await kv.set('health:ping', new Date().toISOString());
    const v = await kv.get('health:ping');
    out.zapisOdczyt = v ? 'ok' : 'brak odczytu';
  } catch (e) {
    out.status = 'blad bazy';
    out.zapisOdczyt = 'blad';
    out.error = e.message;
  }
  return res.status(200).json(out);
}
