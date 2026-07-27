# REX Cloud Backend v3.0

Backend dla systemu grafików importowanych z matrycy Excel. Baza: Vercel KV.

## Setup

1. `npm i -g vercel`
2. `vercel link`
3. Dodaj Storage → KV w dashboardzie Vercel (zmienne KV_REST_API_URL / KV_REST_API_TOKEN dodadzą się same)
4. `vercel --prod`

## Endpointy

### GET /api/schedule
- `?name=NAZWISKO` → zmiany danego pracownika (logowanie po imieniu w aplikacji)
- `?roster=1` → lista nazwisk z importu
- bez parametru → cały grafik (panel admina)

### PUT /api/schedule
Import całego grafiku (admin). Body: `{ shifts: [...], roster: [...], meta: {...} }`
Zastępuje poprzedni import.

### DELETE /api/schedule
Czyści cały grafik.

### POST /api/admin-auth
`{ "pin": "1234" }` → logowanie do panelu admina.
Domyślny PIN: **1234** (ustawiany automatycznie przy pierwszym logowaniu).

### PUT /api/admin-auth
`{ "currentPin": "1234", "newPin": "9999" }` → zmiana PIN admina.

## Format zmiany (shift)
```json
{ "name": "PASIONEK", "date": "2026-08-01", "start": "06:00", "end": "16:00", "hours": 10, "station": "PANIEROWANIE" }
```
