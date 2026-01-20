# REX Cloud Backend

Backend API dla systemu REX Cloud - obsługuje kalendarz zmian i wnioski pracowników.

## Endpointy

### `/api/calendar`
- `GET` - pobierz kalendarz (plik ICS)
- `POST` - zapisz kalendarz

### `/api/requests`
- `GET` - pobierz wszystkie wnioski
- `POST` - dodaj nowy wniosek
- `PUT` - zaktualizuj wniosek (np. zmień status)
- `DELETE` - usuń wniosek
- `PATCH` - bulk update wielu wniosków

## Konfiguracja

### Zmienne środowiskowe (Vercel)

```
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
GITHUB_OWNER=twoj-username
GITHUB_REPO=rex-cloud-data
```

### Jak uzyskać GITHUB_TOKEN:
1. Idź do GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Kliknij "Generate new token (classic)"
3. Nadaj nazwę np. "REX Cloud Backend"
4. Zaznacz uprawnienia: `repo` (full control)
5. Wygeneruj i skopiuj token

### Repozytorium danych (rex-cloud-data)
Utwórz repozytorium na GitHubie z plikami:
- `calendar.ics` - pusty kalendarz ICS
- `requests.json` - pusta tablica `[]`

## Deploy na Vercel

```bash
npm i -g vercel
vercel login
vercel --prod
```

Następnie dodaj zmienne środowiskowe w panelu Vercel:
Project Settings → Environment Variables

## Użycie w aplikacjach

### Aplikacja mobilna (dodawanie wniosku):
```javascript
const response = await fetch('https://rex-cloud-backend.vercel.app/api/requests', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    request: {
      date: '2025-02-10',
      type: 'vacation',
      employeeId: 1,
      employeeName: 'Jan Kowalski'
    }
  })
});
```

### Panel admina (zmiana statusu):
```javascript
const response = await fetch('https://rex-cloud-backend.vercel.app/api/requests', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    requestId: 'req_123456789',
    updates: { status: 'approved' }
  })
});
```
