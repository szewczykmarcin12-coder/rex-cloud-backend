# REX Cloud Backend

Backend API do synchronizacji kalendarza REX Cloud z GitHub.

## Deployment na Vercel

### 1. Sklonuj to repozytorium
### 2. Połącz z Vercel
### 3. Skonfiguruj Environment Variables w Vercel:

| Nazwa | Wartość |
|-------|---------|
| `GITHUB_TOKEN` | Twój Personal Access Token z GitHub |
| `REPO_OWNER` | `marcin-12` |
| `REPO_NAME` | `rex-calendar` |
| `FILE_PATH` | `kalendarz.ics` |

### 4. Deploy!

## API Endpoints

### GET /api/calendar
Pobiera kalendarz z GitHub.

**Response:**
```json
{
  "success": true,
  "content": "BEGIN:VCALENDAR...",
  "sha": "abc123..."
}
```

### POST /api/calendar
Zapisuje kalendarz do GitHub.

**Request body:**
```json
{
  "content": "BEGIN:VCALENDAR...",
  "sha": "abc123...",
  "message": "Aktualizacja kalendarza"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Calendar updated successfully",
  "sha": "def456..."
}
```

## Użycie w aplikacji

```javascript
const API_URL = 'https://twoja-nazwa.vercel.app/api/calendar';

// Pobierz kalendarz
const response = await fetch(API_URL);
const data = await response.json();
console.log(data.content);

// Zapisz kalendarz
await fetch(API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    content: 'BEGIN:VCALENDAR...',
    sha: data.sha
  })
});
```
