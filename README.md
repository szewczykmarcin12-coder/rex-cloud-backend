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

---

## v3.1 — bezpieczeństwo (P0 + SEC-01…05, sierpień 2026)

Wdrożone wg dokumentu „Plan bezpieczeństwa, spójności danych i rozwoju":

- **SEC-01 Sesje i ochrona API** — każda trasa poza `health` i logowaniem wymaga nagłówka
  `Authorization: Bearer <token>` (HMAC, ważność 12 h). Role: `asm`, `kierownik`, `pracownik`.
- **SEC-02 RBAC** — macierz uprawnień: pracownik widzi tylko własne zmiany, stawki i budżet
  wyłącznie dla ASM, kierownik bez danych płacowych.
- **SEC-03 PIN-y** — scrypt z unikalną solą (format `s2:sól:hash`), stare hashe SHA-256 migrowane
  automatycznie przy logowaniu; blokada brute-force (8 prób / 15 min); brak haseł w localStorage.
- **SEC-04 Terminal i karta** — rejestr terminali (`clock:terminals`) zarządzany przez ASM w panelu;
  odbicie kartą wyłącznie po hashu tokenu karty — login NIE jest substytutem karty.
- **SEC-05 CORS** — allowlista originów przez env `ALLOWED_ORIGINS`; bez konfiguracji tryb otwarty (dev) z ostrzeżeniem w logach.
- **R-03/TNA-01** — `GET /api/clock?action=projection&date=YYYY-MM-DD` buduje timesheet z odbić
  (pary IN/OUT, przerwy, anomalie); odbicia surowe są append-only.
- **R-04/COR-02** — usunięto symulację wbić i automatyczne tworzenie Actual z planu.

### Zmienne środowiskowe (Vercel → Settings → Environment Variables)

| Zmienna | Wymagana | Opis |
|---|---|---|
| `ALLOWED_ORIGINS` | zalecana | originy frontendów po przecinku, np. `https://rex-cloud-admin.vercel.app,https://rex-cloud-app.vercel.app,https://rex-clock.vercel.app` |
| `ASM_BOOTSTRAP_LOGIN` | przy 1. uruchomieniu | startowy login ASM |
| `ASM_BOOTSTRAP_PASSWORD` | przy 1. uruchomieniu | startowe hasło ASM (min. 8 znaków) |
| `ADMIN_BOOTSTRAP_PIN` | przy 1. uruchomieniu | startowy PIN kierownika zmiany (6 cyfr) |
| `SESSION_SECRET` | opcjonalna | sekret podpisu sesji; bez niej generowany raz i trzymany w Redis (`auth:secret`) |

Domyślne hasła (`123456`, `asm12345`) zostały **usunięte** — bez zmiennych bootstrap logowanie
zwraca czytelny błąd konfiguracji. Bootstrap działa tylko, gdy klucz nie istnieje jeszcze w bazie.

### Pierwsze uruchomienie po aktualizacji
1. Ustaw zmienne bootstrap + `ALLOWED_ORIGINS`, wdróż (`vercel --prod`).
2. Zaloguj się do panelu jako ASM i zmień hasło startowe (Ustawienia).
3. Ustawienia → **Terminale REX Clock** → dodaj identyfikatory terminali (np. `K003-POS-01`) —
   do tego czasu terminal nie przyjmie odbić.
4. Karty pracowników przypisz przez `POST /api/accounts?action=card&id=…` (token karty jest hashowany).

## v3.2 — spójność danych i audyt (P2: DATA-02/03/04, COR-01/03, TNA-05)

- **DATA-02** — każda zmiana grafiku ma stabilny `sid` (UUID) nadawany przy imporcie/dodaniu;
  stare dane dostają sid automatycznie przy pierwszym odczycie. Edycja godzin/osoby/stanowiska
  nie zmienia tożsamości zmiany.
- **DATA-03** — każdy miesiąc ma pole `version` podbijane przy każdej mutacji; edycje przyjmują
  `expectedVersion` i zwracają **409 Conflict** zamiast cichego nadpisania przy równoległej pracy
  dwóch kierowników. Panel automatycznie odświeża dane po konflikcie.
- **DATA-04** — niezmienny dziennik audytu (`audit:log`, append-only, bez endpointu kasującego):
  logowania (udane i nieudane), edycje grafiku (before/after), importy, zamiany, zapisy wykonania,
  operacje na kontach i terminalach. `GET /api/audit` (ASM) + podgląd w Ustawieniach panelu.
- **COR-01** — zatwierdzenie zamiany przepisuje także `accountId` — nowy pracownik widzi zmianę,
  poprzedni nie; obie strony i aktor zapisane w audycie.
- **COR-03** — wykonanie (Actual) kluczowane po `sid`, więc edycja planu nie osieroca wpisów;
  usunięcie planu nie dotyka odbić (event store Clock pozostaje nietknięty).
- **TNA-05** — dashboard pokazuje alert „bez odbicia po starcie" (zaplanowana zmiana wystartowała
  >15 min temu, brak wejścia na terminalu).
- **COR-07** — walidacja PIN 4–8 cyfr ujednolicona przy tworzeniu i zmianie.
