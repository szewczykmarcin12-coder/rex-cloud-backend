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
