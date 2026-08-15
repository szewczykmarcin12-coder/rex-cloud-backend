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

## v3.3 — Workforce Core (P3: WFM-01/03/05, TNA-06)

- **WFM-01 Publikacja grafiku** — `POST /api/schedule?action=publish` (ASM) tworzy zamrożony
  snapshot miesiąca (`sched:pub:YYYY-MM`) z numerem wersji. Pracownicy widzą wyłącznie
  opublikowaną wersję (miesiące sprzed pierwszej publikacji: tryb przejściowy — kopia robocza).
  Edycje robocze nie zmieniają widoku pracowników do kolejnej publikacji; panel pokazuje różnice
  (+dodane/±zmienione/−usunięte). Pracownik potwierdza grafik (`?action=confirm`), panel widzi
  licznik potwierdzeń; nowa wersja zeruje potwierdzenia.
- **WFM-03 Absencje** — `/api/absences`: wniosek pracownika (urlop / na żądanie / L4 / inne),
  decyzja ASM/kierownika w panelu (strona „Zamiany i wnioski"), wycofanie własnego wniosku,
  ochrona przed nakładającymi się zakresami; wpis z panelu = od razu zatwierdzony.
- **WFM-05 Konflikty grafiku** — dodanie/edycja zmiany: BLOKADA przy nakładaniu się zmian tej samej
  osoby i przy zatwierdzonej absencji (409 z czytelnym komunikatem); OSTRZEŻENIE przy odpoczynku
  dobowym < 11 h (zapis przechodzi, panel pokazuje ostrzeżenie).
- **TNA-06** — zamknięcie / ponowne otwarcie / przegląd tygodnia trafia do audytu z podpisem aktora.

## v3.4 — dostępność, reguły umów, jakość danych (P3: WFM-02/04/12 · P4: dane sprzedażowe)

- **WFM-02 Dostępność** — `/api/availability`: pracownik ustawia tygodniowy wzorzec
  (dostępny / niedostępny / okno godzin) w aplikacji („Urlopy i wnioski"); propozycja czeka na
  akceptację kierownika (karta „Propozycje dostępności" w panelu, podświetlone zmienione dni).
  Po zatwierdzeniu: dzień „niedostępny" BLOKUJE planowanie (409), zmiana poza oknem godzin
  daje ostrzeżenie.
- **WFM-04 Umowy i reguły pracy** — konto ma: wymiar tygodniowy (h), maks. godzin na dobę,
  listę dozwolonych stanowisk (formularz pracownika, sekcja „Reguły pracy"). Planer ostrzega
  przy przekroczeniu limitu dobowego/tygodniowego i stanowisku poza kwalifikacjami.
- **WFM-12 Alerty** — badge przy „Giełdzie zamian" sumuje: zamiany do akceptacji + otwarte
  wnioski urlopowe + oczekujące propozycje dostępności.
- **P4 / dane sprzedażowe** — import sprzedaży dostaje wersję, znacznik czasu, źródło i autora
  (audyt `sales.import`); `GET /api/sales` zwraca raport braków z ostatnich 30 dni; zakładka
  „Dane" w Planowaniu pokazuje pasek jakości danych (świeżość + brakujące dni).

## v3.5 — prognoza i rozliczenia (P4: prognoza dnia, KPI błędu, WFM-10 payroll)

- **Prognoza dnia (P4)** — `/api/forecast`: deterministyczny baseline sezonowy (mediana dnia
  tygodnia z 8 tygodni × tłumiony trend 4-tyg. 0,85–1,15). Ręczna korekta dnia WYMAGA
  uzasadnienia i trafia do audytu (`forecast.override`). Panel: sekcja „Jakość prognozy"
  w Planowaniu (kafelki 14 dni, korekty oznaczone).
- **KPI błędu prognozy** — backtest MAPE/WAPE na 28 zakończonych dniach; prognoza w backteście
  liczona wyłącznie z danych sprzed danego dnia (bez zaglądania w przyszłość — kryterium P4).
- **WFM-10 Payroll** — `GET /api/timesheets?action=payroll&week=YYYY-MM-DD[&format=csv]` (ASM):
  eksport płatnych minut WYŁĄCZNIE z tygodni CLOSED (409 dla otwartych). Jedna formuła płatnych
  minut (Actual − przerwy niepłatne, tylko zmiany z realnym wykonaniem) — identyczna z ekranem
  Actual (kryterium G2/A-15). Zmiany bez odbić raportowane osobno. Eksport audytowany.
  Panel: przycisk „Payroll CSV" przy zamkniętym tygodniu w Time & Attendance.

## v3.6 — poprawki z raportu weryfikacji P4 (15.08.2026)

Zamknięte zalecenia audytu:

- **P0-1** — payroll za flagą: bez `PAYROLL_ENABLED=true` endpoint zwraca 403 (tryb sandbox).
- **P0-2 / P4-03** — usunięty OSTATNI syntetyczny Actual (wykres budżetu liczył plan ±5%);
  wykonanie w budżecie liczone z ts:data; test regresji w repo zakazuje powrotu wzorca.
- **P0-3** — produkcja fail-closed: bez `SESSION_SECRET` i `ALLOWED_ORIGINS` backend odmawia
  pracy (503, poza /api/health); frontendy budują lokalny Tailwind (bez Play CDN);
  xlsx podniesiony do 0.20.3 z cdn.sheetjs.com (łatki ReDoS/prototype pollution).
- **P4-02 / TNA-06** — CLOSED to stan serwera: `POST /api/timesheets?action=close-week`
  (ASM/kierownik) i `reopen-week` (tylko ASM, wymaga powodu). PUT odrzuca każdą zmianę flagi
  closed oraz każdą modyfikację wykonania/dni w zamkniętym tygodniu (409).
- **WFM-10 kontrakt eksportu** — payroll ma exportId (UUID), wersję per tydzień, sha256 danych
  (te same dane → identyczny hash), historię eksportów (`payroll:exports`) i nagłówek w CSV.
- **P4-09** — neutralizacja CSV injection (komórki od `= + - @ TAB` prefiksowane apostrofem).
- **P4-10** — wszystkie wywołania audytu awaitowane (brak gubienia wpisów na serverless).
- **P4-11** — forecast waliduje daty prawdziwym parserem (2026-99-99 odpada), wartości
  skończone 0–5 mln, uzasadnienie 3–200 znaków.
- **P4-06** — pracownik nigdy nie widzi kopii roboczej (usunięty fallback przejściowy);
  poprzednie wersje publikacji trafiają do historii append-only (`sched:pubhist:*`),
  pubinfo zwraca `historiaWersji`.
- **Q-1 / ENG-03** — `npm test` = `test/smoke.mjs`: 24 asercje pokrywające SEC/DATA/WFM/P4
  (sesje, wersje, publikacja, absencje, CLOSED, kontrakt payrollu, CSV injection, regresja
  syntetycznego Actual).

**Uwaga wdrożeniowa:** po tej wersji pracownicy widzą wyłącznie OPUBLIKOWANE miesiące —
po wdrożeniu opublikuj bieżące miesiące w panelu (WorkRhythm → Schedule → Publikacja grafiku).
Produkcja wymaga env: `SESSION_SECRET`, `ALLOWED_ORIGINS`; payroll dodatkowo `PAYROLL_ENABLED=true`.

Poza zakresem kodu (wymagają decyzji/infrastruktury): migracja do Postgres z tenant/site
(P1-1), sesje HttpOnly cookie (P1-2), kolejka offline terminala (P2-1), integracja POS.
