# REX Cloud Backend v3.0

Backend dla systemu grafików importowanych z Excela. Baza: **Upstash Redis** (przez Marketplace w Vercel).

## Setup

1. `npm i -g vercel`
2. `vercel link`
3. W panelu Vercel: projekt backendu → **Storage** → **Create / Connect Database** → wybierz **Redis (Upstash)** z Marketplace → utwórz/podłącz do tego projektu.
   Vercel doda zmienne środowiskowe automatycznie (`KV_REST_API_URL` + `KV_REST_API_TOKEN`,
   a przy własnym koncie Upstash `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — kod obsługuje obie).
4. `vercel --prod` (po podłączeniu bazy koniecznie wdróż ponownie, żeby zmienne się załadowały).

## Klient bazy
`api/_helpers.js` tworzy klienta `@upstash/redis`, czytając URL i token z którejkolwiek z par
zmiennych powyżej. `get`/`set` działają tak samo jak w dawnym `@vercel/kv` (auto-serializacja JSON).

## Endpointy

### GET /api/schedule
- `?name=NAZWISKO` → zmiany danego pracownika (logowanie po imieniu w aplikacji)
- `?roster=1` → lista nazwisk z importu
- bez parametru → cały grafik (panel admina)

### PUT /api/schedule
Import całego grafiku (admin). Body: `{ shifts: [...], roster: [...], meta: {...} }`. Zastępuje poprzedni.

### DELETE /api/schedule
Czyści cały grafik.

### POST /api/admin-auth
`{ "pin": "1234" }` → logowanie do panelu admina. Domyślny PIN **1234** (ustawiany przy pierwszym logowaniu).

### PUT /api/admin-auth
`{ "currentPin": "1234", "newPin": "9999" }` → zmiana PIN admina.

## Klucze w Redis
- `schedule:data` = `{ shifts, roster, meta }`
- `admin:pin` = hash SHA-256 PIN-u
