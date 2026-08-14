import { Redis } from '@upstash/redis';

// ── CORS z allowlistą (SEC-05) ──
// ALLOWED_ORIGINS: lista originów rozdzielona przecinkami, np.
//   "https://rex-cloud-admin.vercel.app,https://rex-cloud-app.vercel.app,https://rex-clock.vercel.app"
// Gdy zmienna jest ustawiona: origin spoza listy NIE dostaje nagłówka CORS (przeglądarka blokuje).
// Gdy nie jest ustawiona: tryb otwarty (dev) — odbijamy origin żądania i logujemy ostrzeżenie.
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
export const corsConfigured = allowedOrigins.length > 0;
let corsWarned = false;

export function cors(res, req) {
  const origin = req && req.headers ? (req.headers.origin || req.headers.Origin) : null;
  if (corsConfigured) {
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    // origin spoza listy lub brak: bez nagłówka Allow-Origin
  } else {
    if (!corsWarned) { corsWarned = true; console.warn('[REX Cloud] ALLOWED_ORIGINS nie ustawione — CORS w trybie otwartym (dev).'); }
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    if (origin) res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Adres i token bazy — obsługa obu konwencji nazw zmiennych:
//  - KV_REST_API_URL / KV_REST_API_TOKEN               (Upstash zarządzany przez Vercel)
//  - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (własne konto Upstash)
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const kvConfigured = Boolean(url && token);

if (!kvConfigured) {
  console.error(
    '[REX Cloud] Brak adresu/tokenu bazy Upstash. Widoczne klucze env pasujące do KV/UPSTASH/REDIS:',
    Object.keys(process.env).filter((k) => /KV|UPSTASH|REDIS/i.test(k))
  );
}

export const kv = new Redis({ url: url || 'https://placeholder.invalid', token: token || 'placeholder' });
