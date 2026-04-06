# REX Cloud Backend v2.0

Backend API z Vercel KV (baza danych) zamiast GitHub.

## Setup

1. Zainstaluj Vercel CLI: `npm i -g vercel`
2. Połącz projekt: `vercel link`
3. Dodaj Vercel KV Storage:
   - Wejdź na https://vercel.com/dashboard → Twój projekt → Storage → Create → KV
   - Lub: `vercel storage create kv`
4. Zmienne środowiskowe (KV_REST_API_URL, KV_REST_API_TOKEN) zostaną automatycznie dodane
5. Deploy: `vercel --prod`

## Endpointy API

### POST /api/auth
Login (admin lub pracownik).
```json
{ "login": "jan.kowalski", "pin": "1234", "role": "employee" }
```
Dla admina: `{ "login": "admin", "pin": "1234", "role": "admin" }`

### GET/POST/PUT/DELETE /api/users
Zarządzanie użytkownikami (admin).

### GET/POST/PUT/DELETE /api/shifts
Zarządzanie zmianami/grafikiem.

### GET/POST/PUT/DELETE /api/requests
Wnioski pracowników.

## Domyślny admin
Login: `admin`, PIN: `1234`
(Tworzony automatycznie przy pierwszym logowaniu)
