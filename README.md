# REX Cloud Backend

Backend API do synchronizacji kalendarza i wniosków REX Cloud z GitHub.

## Deployment na Vercel

### 1. Skopiuj pliki do swojego repozytorium backendu
### 2. W GitHub dodaj plik `requests.json` z zawartością: `[]`
### 3. Zrób commit i push

## API Endpoints

### GET /api/calendar
Pobiera kalendarz z GitHub.

### POST /api/calendar
Zapisuje kalendarz do GitHub.

### GET /api/requests
Pobiera wszystkie wnioski.

### POST /api/requests
Dodaje nowy wniosek.

Request body:
```json
{
  "request": {
    "date": "2025-02-10",
    "type": "no_work",
    "employeeId": 1,
    "employeeName": "Jan Kowalski"
  }
}
```

### PUT /api/requests
Aktualizuje wniosek (np. zmienia status).

Request body:
```json
{
  "requestId": "req_123456789",
  "updates": { "status": "approved" }
}
```

### DELETE /api/requests
Usuwa wniosek.

Request body:
```json
{
  "requestId": "req_123456789"
}
```
