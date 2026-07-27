import { Redis } from '@upstash/redis';

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Adres i token bazy — obsługa obu konwencji nazw zmiennych:
//  - KV_REST_API_URL / KV_REST_API_TOKEN               (Upstash zarządzany przez Vercel)
//  - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (własne konto Upstash)
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// Czy baza jest w ogóle skonfigurowana (do czytelnych błędów w API)
export const kvConfigured = Boolean(url && token);

if (!kvConfigured) {
  // Trafi do logów funkcji w Vercel — pokaże, jakie klucze env faktycznie istnieją
  console.error(
    '[REX Cloud] Brak adresu/tokenu bazy Upstash. Widoczne klucze env pasujące do KV/UPSTASH/REDIS:',
    Object.keys(process.env).filter((k) => /KV|UPSTASH|REDIS/i.test(k))
  );
}

// Uwaga: gdy url/token są puste, tworzenie klienta nie rzuca błędu od razu —
// dopiero pierwsze zapytanie daje "Failed to parse URL from /pipeline".
// Dlatego w endpointach sprawdzamy kvConfigured i zwracamy czytelny komunikat.
export const kv = new Redis({ url: url || 'https://placeholder.invalid', token: token || 'placeholder' });
