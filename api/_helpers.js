import { Redis } from '@upstash/redis';

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Klient Upstash Redis. Obsługuje obie konwencje nazw zmiennych:
//  - KV_REST_API_URL / KV_REST_API_TOKEN          (Upstash zarządzany przez Vercel)
//  - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (własne konto Upstash)
// get/set działają tak samo jak w @vercel/kv (auto-serializacja JSON),
// więc reszta kodu (schedule.js, admin-auth.js) nie wymaga zmian.
export const kv = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});
