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

## v3.7 — REX WorkRhythm Modules v1.0.0 (dyspozycyjność + T&A wg wzorca)

- **Dyspozycje dzienne** — `/api/availability?reqs=1` + `?action=request` / `?action=decide`:
  pięć typów (mogę / nie mogę / od godziny / do godziny / konkretna zmiana), powtarzalność
  tygodniowa z datą końca, komentarz pracownika i notatka managera, statusy pending/approved/
  rejected, konflikt liczony względem OPUBLIKOWANEGO grafiku. Zatwierdzone „nie mogę pracować"
  blokuje planowanie zmiany (409); ograniczenia godzin dają ostrzeżenia.
- **Panel: strona „Dyspozycyjność"** (menu WorkRhythm) — wygląd 1:1 z wzorca: KPI, zakładki
  filtrów, siatka tydzień×zespół, kolejka zgłoszeń i panel decyzji z notatką managera.
- **Panel: moduł Time & Attendance** — widok live wg wzorca: KPI (w pracy / przerwa /
  zakończone / terminale), Live attendance, karta terminala POS i tabela surowych odbić,
  odświeżanie co 10 s; poniżej dotychczasowe zamykanie tygodni (CLOSED na serwerze).
- **Aplikacja pracownika: strona „Dyspozycyjność"** — wygląd 1:1 z wzorca: wybór tygodnia
  i dnia, kafelki typów, godziny co 15 min, przełącznik powtarzalności, komentarz 0–500 znaków,
  lista „Nadchodzące dyspozycje" ze statusami i notatką managera.
- Testy: `npm test` → 31 asercji (dyspozycje: zgłoszenie, walidacja dat, decyzje, blokada
  planera, konflikt z publikacją, RBAC).

## v3.7.1 — okno dyspozycji + poprawki widoczności

- **Okno składania dyspozycji**: pracownicy składają dyspozycje wyłącznie na KOLEJNY miesiąc,
  do 20. dnia bieżącego miesiąca. Po terminie okno zamyka się automatycznie; otworzyć/zamknąć
  może je wyłącznie ASM (pasek na stronie Dyspozycyjność w panelu; audyt window-open/close).
  Powtarzalność tygodniowa przycinana do końca miesiąca docelowego. Wpisy z panelu bez ograniczeń.
- **Fix (panel)**: strona Dyspozycyjność pobiera wszystkie zgłoszenia (KPI i kolejka globalne;
  siatka filtruje po wybranym tygodniu), start na pierwszym tygodniu miesiąca docelowego.
- **Fix (T&A live)**: status osoby liczony z NAJNOWSZEGO odbicia (błąd wybierał najstarsze).
- Aplikacja pracownika: baner miesiąca docelowego i terminu, dni spoza miesiąca wyszarzone,
  przycisk wysyłki nieaktywny po zamknięciu okna.
- Testy: 36 asercji (okno: zły miesiąc 400, zamknięte 403, otwarcie tylko ASM, przycięcie repeatUntil).

## v3.7.2 — auto-sync Actual, pełne nazwiska, porządek w aplikacji

- **Actual = automat**: widok Wykonanie sam pobiera odbicia z REX Clock przy otwarciu dnia
  i odświeża je co 60 s. Wpisy z odbić (source: clock) są aktualizowane, ręczne korekty
  kierownika NIGDY nie są nadpisywane. Przycisk „Synchronizuj teraz" został jako wymuszenie.
- **Pełne nazwiska w Actual**: wiersze pokazują imię i nazwisko z konta pracownika;
  alias z matrycy grafiku widoczny w dymku (title).
- **Aplikacja pracownika**: usunięta karta „Moja dostępność" z zakładki Urlopy i wnioski —
  dyspozycyjność ma własną stronę zgodną z wzorcem WorkRhythm.

## v3.8 — Planowanie obsady (zintegrowany moduł Planowanie i popyt)

Nowa domyślna zakładka „Planowanie obsady" spina istniejące silniki w jeden ekran:

- **Pasek tygodnia** (nr tygodnia ISO, nawigacja, „Dzisiaj"), **scenariusze popytu**
  (bazowy / oszczędny −10% / bezpieczny +10%) i status **Preliminary/Published** liczony
  z pubinfo (wersja, różnice, potwierdzenia — przycisk „Porównaj").
- **KPI tygodnia**: Plan/Required Hours (silnik slotowy 15 min zasilany prognozą /forecast),
  Excess/Deficit, SPLH i COL% względem prognozy sprzedaży, Labor Cost wg stawek kont,
  Schedule Score (kara za niedobór/nadmiar).
- **Demand vs Coverage**: wykres 96 slotów (Required vs Scheduled) + **Coverage heatmap**
  z klikalnymi slotami (szczegóły: wymagane/plan/kto na zmianie).
- **Zakładki dni** (kropka przy niedoborze, Required/Plan/Coverage dnia) + **Gantt zespołu**:
  pełne nazwiska, role, kolory stanowisk, ostrzeżenia konfliktów (absencje + dyspozycje),
  wiersze **„Otwarta zmiana"** generowane z niedoborów (klik = prefill dodania).
- **Dodaj zmianę** (modal ze wszystkimi walidacjami WFM-05 po stronie backendu),
  „Szablon dnia" → Blueprints, **Opublikuj grafik** dla miesięcy tygodnia.
- **Smart Scheduler**: wskaźnik Score, rekomendacje z wpływem (uzupełnij niedobór,
  skróć nadmiar z wyliczonym kosztem, konflikty dyspozycji) oraz **„Uruchom optymalizator"**
  — istniejący silnik szablonów dokłada propozycje na rezydualny niedobór („Użyj" = prefill).

Dotychczasowe zakładki „Optymalizacja i prognoza" i „Budżet (COL)" pozostały obok.

## v3.9 — import dopisujący godziny (np. MGR) + wybór stanowisk

- `POST /api/schedule?action=add-bulk` — DOPISUJE zmiany do istniejącego grafiku (nie zastępuje
  miesiąca): sid + wersja miesiąca + audyt `schedule.import-add`, automatyczne przypisanie kont
  po nazwisku/aliasach, duplikaty (osoba+data+godziny) pomijane i raportowane, osoby bez kont
  wskazane w odpowiedzi.
- Import w panelu: obok „Zastąp miesiąc" nowy przycisk **„Dodaj godziny do grafiku (dopisz)"**;
  pasek wyboru stanowiska z opcją **„Zastosuj dla wszystkich"** oraz edycją per wiersz w podglądzie.
- Nowy format zapasowy pliku: prosta tabela XLSX `Nazwisko | Data | Od | Do | [Godziny] | [Stanowisko]`
  (np. arkusz godzin MGR) — daty `RRRR-MM-DD` lub `DD.MM.RRRR`, czasy `HH:MM` lub excelowe.

## v3.10 — Blueprints i ShiftCycles wg wzorca WorkRhythm

- **Blueprints (Szablony tygodniowe)** — nowy układ: biblioteka kart z mini-podglądem godzin
  Pn–Nd, ulubione (★) i duplikacja (backend: `?action=fav`, `?action=duplicate`; lista zwraca
  `dniH[7]` i `fav`), panel szczegółu z siatką kategorie (Manager/Kuchnia/Front/Dispatch) × dni
  („N zmian"), wierszem Open Shift (sloty bez przypisanego konta), stopką statystyk
  (godziny, peak coverage vs krzywa, przerwy należne, otwarte zmiany) oraz kartą
  „Zapisz aktualny grafik jako Blueprint". Zastosowanie: modal tygodnia + przypisań slotów.
- **ShiftCycles (Rotacje cykliczne)** — nowy układ: pasek rotacji (nazwa, ACTIVE DRAFT,
  śr. coverage, godziny/cykl, weekendy OFF/osobę, konflikty z absencjami), zakładki cykli
  z datami (Preliminary/Draft), siatka zespołów A/B/C/Liderzy (podział slotów Blueprinta po
  dominującej kategorii; wzorzec dnia = najczęstszy przedział, etykiety Opening/Lunch/Closing,
  OFF Regeneracja) z limitem h/tydz. na osobę, sekcja „Obsada vs idealna" (% per dzień)
  i „Aktywuj ShiftCycles" — nałożenie cykli przez istniejący silnik szablonów.
