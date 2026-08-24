// REX Cloud — testy dymne (Q-1 z raportu weryfikacji P4).
// Uruchomienie: npm test  (zaślepka Upstash w pamięci, bez sieci).
// Każde kryterium ma jawny PASS/FAIL; wyjście != 0 przy dowolnym FAIL.
import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import crypto from 'crypto';

process.env.SESSION_SECRET = 'test-secret';
process.env.KV_REST_API_URL = 'https://mock.upstash.local';
process.env.KV_REST_API_TOKEN = 'x';
process.env.PAYROLL_ENABLED = process.env.PAYROLL_ENABLED || '';

const db = new Map();
globalThis.fetch = async (url, opts) => {
  const w = (c) => { const [op, k, v] = c; switch (String(op).toUpperCase()) {
    case 'GET': return db.has(k) ? db.get(k) : null;
    case 'SET': db.set(k, v); return 'OK';
    case 'DEL': return db.delete(k) ? 1 : 0;
    case 'INCR': { const n = (Number(db.get(k)) || 0) + 1; db.set(k, String(n)); return n; }
    case 'EXPIRE': return 1; default: return null; } };
  const b = JSON.parse(opts.body);
  const wynik = Array.isArray(b[0]) ? b.map((c) => ({ result: w(c) })) : { result: w(b) };
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => wynik, text: async () => JSON.stringify(wynik) };
};

const { signSession } = await import('../lib/auth.js');
const schedule = (await import('../lib/schedule.js')).default;
const timesheets = (await import('../lib/timesheets.js')).default;
const forecast = (await import('../lib/forecast.js')).default;
const monthlyForecastMod = await import('../lib/monthly-forecast.js');
const monthlyForecast = monthlyForecastMod.default;
const absences = (await import('../lib/absences.js')).default;
const audit = (await import('../lib/audit.js')).default;
const { kv } = await import('../lib/_helpers.js');

const mkRes = () => { const r = { code: 200, headers: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.send = (b) => { r.body = b; return r; }; r.end = () => r; return r; };
const call = async (h, req) => { const res = mkRes(); await h(req, res); return res; };

let pass = 0, fail = 0;
const T = (nazwa, warunek) => { if (warunek) { pass++; console.log('  PASS', nazwa); } else { fail++; console.log('  FAIL', nazwa); } };

const asm = { authorization: 'Bearer ' + await signSession({ role: 'asm', name: 'ASM', login: 'ASM' }) };
const emp = { authorization: 'Bearer ' + await signSession({ role: 'pracownik', accountId: 'uA', name: 'Jan Kowal', grafikName: 'KOWAL', login: 'JANKOW001' }) };
await kv.set('accounts:list', [{ id: 'uA', name: 'Jan Kowal', grafikName: 'KOWAL', aliasy: [], login: 'JANKOW001', funkcja: 'CREW', umowa: 'UZ', stawka: 30 }]);

console.log('— SEC-01: sesje i role —');
T('brak sesji → 401', (await call(timesheets, { method: 'GET', headers: {}, query: {} })).code === 401);
T('pracownik na trasie admina → 403', (await call(timesheets, { method: 'GET', headers: emp, query: {} })).code === 403);

console.log('— DATA-02/03: sid i wersje —');
await call(schedule, { method: 'PUT', headers: asm, query: {}, body: { shifts: [
  { date: '2026-08-10', name: 'KOWAL', station: 'FRYTKI', start: '08:00', end: '16:00', hours: 8 },
  { date: '2026-08-11', name: 'KOWAL', station: 'FRYTKI', start: '08:00', end: '16:00', hours: 8 },
], meta: { year: 2026, month: 7 } } });
const mies = await kv.get('sched:2026-08');
T('import nadaje sid', mies.shifts.every((x) => !!x.sid));
const sid1 = mies.shifts[0].sid;
T('konflikt wersji → 409', (await call(schedule, { method: 'POST', headers: asm, query: { action: 'update' }, body: { sid: sid1, date: '2026-08-10', nowe: { start: '09:00' }, expectedVersion: 99 } })).code === 409);

console.log('— WFM-01: publikacja bez wycieku draftu (P4-06) —');
let r = await call(schedule, { method: 'GET', headers: emp, query: { accountId: 'uA' } });
T('miesiąc niepublikowany → pracownik NIE widzi draftu', r.body.shifts.length === 0);
await call(schedule, { method: 'POST', headers: asm, query: { action: 'publish' }, body: { month: '2026-08' } });
r = await call(schedule, { method: 'GET', headers: emp, query: { accountId: 'uA' } });
T('po publikacji pracownik widzi snapshot', r.body.shifts.length === 2);
await call(schedule, { method: 'POST', headers: asm, query: { action: 'publish' }, body: { month: '2026-08' } });
const hist = await kv.get('sched:pubhist:2026-08');
T('poprzednia wersja publikacji w historii append-only', Array.isArray(hist) && hist.length === 1 && hist[0].wersjaPub === 1);

console.log('— WFM-03/05: absencja blokuje planowanie —');
r = await call(absences, { method: 'POST', headers: emp, query: {}, body: { type: 'urlop', from: '2026-08-20', to: '2026-08-21' } });
await call(absences, { method: 'PUT', headers: asm, query: {}, body: { id: r.body.absence.id, action: 'approve' } });
T('zmiana w urlop → 409', (await call(schedule, { method: 'POST', headers: asm, query: { action: 'add' }, body: { date: '2026-08-20', name: 'KOWAL', start: '08:00', end: '16:00', accountId: 'uA' } })).code === 409);

console.log('— P4-11: walidacja forecast —');
T('data 2026-99-99 odrzucona', (await call(forecast, { method: 'POST', headers: asm, query: { action: 'override' }, body: { date: '2026-99-99', value: 100, reason: 'test' } })).code === 400);
T('Infinity odrzucone', (await call(forecast, { method: 'POST', headers: asm, query: { action: 'override' }, body: { date: '2026-08-20', value: 'Infinity', reason: 'test' } })).code === 400);
T('wartość > limitu odrzucona', (await call(forecast, { method: 'POST', headers: asm, query: { action: 'override' }, body: { date: '2026-08-20', value: 99999999, reason: 'test' } })).code === 400);

console.log('— P0-1/P4-02: payroll i CLOSED —');
delete process.env.PAYROLL_ENABLED;
T('payroll bez flagi → 403 (sandbox)', (await call(timesheets, { method: 'GET', headers: asm, query: { action: 'payroll', week: '2026-08-10' } })).code === 403);
process.env.PAYROLL_ENABLED = 'true';
T('payroll otwartego tygodnia → 409', (await call(timesheets, { method: 'GET', headers: asm, query: { action: 'payroll', week: '2026-08-10' } })).code === 409);
T('PUT nie może ustawić CLOSED', (await call(timesheets, { method: 'PUT', headers: asm, query: {}, body: { data: { actuals: {}, completed: {}, weekStatus: { '2026-08-10': { closed: true } } } } })).code === 409);
r = await call(timesheets, { method: 'POST', headers: asm, query: { action: 'close-week' }, body: { week: '2026-08-10' } });
T('close-week działa i podpisuje aktora', r.code === 200 && r.body.weekStatus.closedBy === 'ASM');
const stanTs = await kv.get('ts:data');
r = await call(timesheets, { method: 'PUT', headers: asm, query: {}, body: { data: { actuals: { [`sid:${sid1}`]: { start: '09:00', end: '17:00', breaks: [] } }, completed: {}, weekStatus: stanTs.weekStatus } } });
T('edycja Actual w zamkniętym tygodniu → 409', r.code === 409);
T('reopen bez powodu → 400', (await call(timesheets, { method: 'POST', headers: asm, query: { action: 'reopen-week' }, body: { week: '2026-08-10' } })).code === 400);

console.log('— WFM-10: kontrakt eksportu —');
await kv.set('ts:data', { actuals: { [`sid:${sid1}`]: { start: '08:05', end: '16:10', breaks: [{ platna: false, start: '12:00', end: '12:30' }] } }, completed: {}, weekStatus: { '2026-08-10': { reviewed: true, closed: true } } });
const e1 = await call(timesheets, { method: 'GET', headers: asm, query: { action: 'payroll', week: '2026-08-10' } });
const e2 = await call(timesheets, { method: 'GET', headers: asm, query: { action: 'payroll', week: '2026-08-10' } });
T('minuty płatne = Actual − przerwy niepłatne (455)', e1.body.rows[0].minPaid === 455);
T('te same dane → identyczny hash', e1.body.hash === e2.body.hash && e1.body.hash.length === 64);
T('wersje eksportu rosną, exportId unikalny', e2.body.wersja === e1.body.wersja + 1 && e1.body.exportId !== e2.body.exportId);
await kv.set('accounts:list', [{ id: 'uA', name: '=HYPERLINK("evil")', grafikName: 'KOWAL', aliasy: [], login: 'JANKOW001', umowa: 'UZ', stawka: 30 }]);
const csv = await call(timesheets, { method: 'GET', headers: asm, query: { action: 'payroll', week: '2026-08-10', format: 'csv' } });
T('CSV injection zneutralizowany (P4-09)', csv.body.includes(`"'=HYPERLINK`));

console.log('— WorkRhythm: dyspozycje dzienne + okno składania —');
const availMod = await import('../lib/availability.js');
const availability = availMod.default;
// miesiąc docelowy = kolejny miesiąc (reguła okna)
r = await call(availability, { method: 'GET', headers: emp, query: { window: '1' } });
const okno0 = r.body.okno;
T('stan okna dostępny (targetMonth = kolejny miesiąc)', r.code === 200 && /^\d{4}-\d{2}$/.test(okno0.targetMonth));
const dTarget = (dd) => `${okno0.targetMonth}-${dd}`;
// zły miesiąc (bieżący) → 400
const dzisMies = new Date().toISOString().slice(0, 7);
r = await call(availability, { method: 'POST', headers: emp, query: { action: 'request' }, body: { date: `${dzisMies}-28`, type: 'available' } });
T('dyspozycja na bieżący miesiąc odrzucona (tylko kolejny)', r.code === 400);
// zamknięte okno (ręcznie przez ASM) → 403; otwarcie → przechodzi
await call(availability, { method: 'POST', headers: asm, query: { action: 'window' }, body: { open: false } });
r = await call(availability, { method: 'POST', headers: emp, query: { action: 'request' }, body: { date: dTarget('10'), type: 'available' } });
T('zamknięte okno blokuje pracownika (403)', r.code === 403);
T('pracownik nie może otworzyć okna', (await call(availability, { method: 'POST', headers: emp, query: { action: 'window' }, body: { open: true } })).code === 403);
await call(availability, { method: 'POST', headers: asm, query: { action: 'window' }, body: { open: true } });
r = await call(availability, { method: 'POST', headers: emp, query: { action: 'request' }, body: { date: dTarget('10'), type: 'unavailable', note: 'zajęcia' } });
T('po otwarciu przez ASM zgłoszenie przyjęte (pending)', r.code === 200 && r.body.request.status === 'pending');
const dyId = r.body.request.id;
T('data 2026-99-99 w dyspozycji odrzucona', (await call(availability, { method: 'POST', headers: emp, query: { action: 'request' }, body: { date: '2026-99-99', type: 'available' } })).code === 400);
// powtarzalność przycięta do miesiąca docelowego
r = await call(availability, { method: 'POST', headers: emp, query: { action: 'request' }, body: { date: dTarget('03'), type: 'from_time', startTime: '14:00', recurrence: 'weekly', repeatUntil: '2099-01-01' } });
T('repeatUntil przycięty do miesiąca docelowego', r.code === 200 && r.body.request.repeatUntil.slice(0, 7) === okno0.targetMonth);
T('pending NIE blokuje planera', (await call(schedule, { method: 'POST', headers: asm, query: { action: 'add' }, body: { date: dTarget('10'), name: 'KOWAL', start: '08:00', end: '12:00', accountId: 'uA' } })).code === 200);
r = await call(availability, { method: 'POST', headers: asm, query: { action: 'decide' }, body: { id: dyId, status: 'approved', managerNote: 'ok' } });
T('decyzja managera zapisana', r.code === 200 && r.body.request.status === 'approved');
r = await call(schedule, { method: 'POST', headers: asm, query: { action: 'add' }, body: { date: dTarget('10'), name: 'KOWAL', start: '13:00', end: '17:00', accountId: 'uA' } });
T('zatwierdzone „nie mogę" blokuje planera (409)', r.code === 409 && String(r.body.error).includes('nie mogę'));
r = await call(availability, { method: 'GET', headers: asm, query: { reqs: '1' } });
T('panel widzi wszystkie zgłoszenia bez filtra zakresu', r.code === 200 && r.body.requests.length >= 2 && typeof r.body.requests[0].conflict === 'boolean');
T('pracownik nie może decydować', (await call(availability, { method: 'POST', headers: emp, query: { action: 'decide' }, body: { id: dyId, status: 'approved' } })).code === 403);

console.log('— Zamiany i podgląd zespołu po kontach —');
await kv.set('accounts:list', [{ id: 'uA', name: 'Jan Kowal', grafikName: 'KOWAL', aliasy: [], login: 'JANKOW001', funkcja: 'CREW', umowa: 'UZ', stawka: 30 }]);   // reset po teście CSV-injection
const swapsH = (await import('../lib/swaps.js')).default;
r = await call(swapsH, { method: 'POST', headers: emp, query: {}, body: { requester: 'KOWAL', shift: { date: '2026-08-11', station: 'FRYTKI', start: '08:00', end: '16:00' } } });
T('zamiana zapisuje requesterAccountId (konto, nie alias)', r.code === 200 && r.body.swap.requesterAccountId === 'uA');
r = await call(swapsH, { method: 'GET', headers: emp, query: {} });
const swX = r.body.swaps[0];
T('GET zamian zwraca pełne imię i nazwisko', swX.requesterDisplay === 'Jan Kowal');
r = await call(schedule, { method: 'GET', headers: emp, query: { month: '2026-08' } });
T('podgląd zespołu: pełne nazwiska + flaga mine', r.code === 200 && r.body.shifts.some((x) => x.name === 'Jan Kowal' && x.mine === true));

console.log('— Import dopisujący (add-bulk) —');
const przedAB = ((await kv.get('sched:2026-08')) || { shifts: [] }).shifts.length;
r = await call(schedule, { method: 'POST', headers: asm, query: { action: 'add-bulk' }, body: { shifts: [
  { date: '2026-08-12', name: 'KOWAL', start: '06:00', end: '14:00', station: 'MANAGER' },
  { date: '2026-08-12', name: 'KOWAL', start: '06:00', end: '14:00', station: 'MANAGER' },
  { date: '2026-08-13', name: 'NOWAK-MGR', start: '14:00', end: '22:00', station: 'MGR FUNKCYJNE' },
] } });
T('add-bulk dopisuje i pomija duplikaty', r.code === 200 && r.body.dodane === 2 && r.body.pominiete === 1);
const poAB = (await kv.get('sched:2026-08')).shifts;
T('zmiany DOPISANE do istniejących (nie zastąpione)', poAB.length === przedAB + 2);
T('dopisane mają sid i przypisane konto po nazwisku', poAB.filter((x) => x.dodana).every((x) => x.sid) && poAB.some((x) => x.date === '2026-08-12' && x.accountId === 'uA'));
T('osoba bez konta raportowana', Object.keys(r.body.nieprzypisane).includes('NOWAK-MGR'));
r = await call(schedule, { method: 'POST', headers: asm, query: { action: 'add-bulk' }, body: { shifts: [{ date: '2026-08-12', name: 'KOWAL', start: '06:00', end: '14:00' }] } });
T('ponowny import tego samego = 0 dodanych', r.body.dodane === 0 && r.body.pominiete === 1);

console.log('— Blueprints: ulubione i duplikacja —');
const templates = (await import('../lib/templates.js')).default;
r = await call(templates, { method: 'POST', headers: asm, query: { action: 'save' }, body: { weekStart: '2026-08-10', name: 'Lunch Peak Standard' } });
T('zapis Blueprinta z tygodnia grafiku', r.code === 200 && r.body.template.sloty >= 1);
const tplId = r.body.template.id;
r = await call(templates, { method: 'POST', headers: asm, query: { action: 'fav' }, body: { id: tplId } });
T('przełączenie ulubionego', r.code === 200 && r.body.fav === true);
r = await call(templates, { method: 'POST', headers: asm, query: { action: 'duplicate' }, body: { id: tplId } });
T('duplikacja szablonu', r.code === 200 && r.body.template.name.includes('(kopia)'));
r = await call(templates, { method: 'GET', headers: asm, query: {} });
T('lista z dniH (mini-podgląd) i flagą fav', r.code === 200 && Array.isArray(r.body.templates[0].dniH) && r.body.templates[0].dniH.length === 7 && r.body.templates.some((t) => t.fav));

console.log('— Szkolenia: para instruktor↔uczeń —');
await kv.set('sched:2026-10', { shifts: [
  { sid: 'shG', date: '2026-10-16', name: 'GNELA', station: 'FRYTKI', start: '10:00', end: '18:00', hours: 8, accountId: 'uG' },
  { sid: 'shR', date: '2026-10-16', name: 'RYBOWICZ', station: 'KONTROLER', start: '10:00', end: '18:00', hours: 8, accountId: 'uR' },
  { sid: 'shZ', date: '2026-10-16', name: 'GRZYB', station: 'PREP', start: '10:00', end: '18:00', hours: 8, accountId: 'uZ' },
  { sid: 'shP', date: '2026-10-16', name: 'PABIAN', station: 'SMAŻENIE', start: '10:00', end: '18:00', hours: 8, accountId: 'uP' },
], roster: ['GNELA', 'RYBOWICZ', 'GRZYB', 'PABIAN'], meta: {}, version: 1 });
const idx10 = (await kv.get('sched:index')) || []; if (!idx10.includes('2026-10')) await kv.set('sched:index', [...idx10, '2026-10'].sort());
r = await call(schedule, { method: 'POST', headers: asm, query: { action: 'szkolenie' }, body: { date: '2026-10-16', instruktor: { sid: 'shR' }, uczen: 'GNELA' } });
T('para 1: RYBOWICZ szkoli GNELĘ', r.code === 200 && r.body.instruktor === 'RYBOWICZ' && r.body.uczen === 'GNELA');
r = await call(schedule, { method: 'POST', headers: asm, query: { action: 'szkolenie' }, body: { date: '2026-10-16', instruktor: { sid: 'shP' }, uczen: 'GRZYB' } });
T('para 2: PABIAN szkoli GRZYBA', r.code === 200 && r.body.uczen === 'GRZYB');
let m10 = await kv.get('sched:2026-10');
const gnela = m10.shifts.find((x) => x.sid === 'shG'), grzyb = m10.shifts.find((x) => x.sid === 'shZ');
T('uczniowie mają właściwych partnerów (bez zamiany par)', gnela.rola === 'training' && gnela.partner === 'RYBOWICZ' && grzyb.rola === 'training' && grzyb.partner === 'PABIAN');
const techR = m10.shifts.filter((x) => x.rola === 'instruktor');
T('wiersze techniczne INSTRUKTOR wskazują właściwych uczniów', techR.length === 2 && techR.some((x) => x.name === 'RYBOWICZ' && x.partner === 'GNELA') && techR.some((x) => x.name === 'PABIAN' && x.partner === 'GRZYB'));
T('instruktor nie może szkolić siebie', (await call(schedule, { method: 'POST', headers: asm, query: { action: 'szkolenie' }, body: { date: '2026-10-16', instruktor: { sid: 'shR' }, uczen: 'RYBOWICZ' } })).code === 400);
r = await call(schedule, { method: 'POST', headers: asm, query: { action: 'szkolenie' }, body: { date: '2026-10-16', instruktor: { sid: 'shR' }, uczen: null } });
m10 = await kv.get('sched:2026-10');
T('rozpięcie pary czyści ucznia i wiersz techniczny', r.code === 200 && !m10.shifts.find((x) => x.sid === 'shG').rola && m10.shifts.filter((x) => x.rola === 'instruktor' && x.name === 'RYBOWICZ').length === 0);

console.log('— ORDO Employee Hub: rejestracja czasu sesją pracownika —');
const clockH = (await import('../lib/clock.js')).default;
r = await call(clockH, { method: 'GET', headers: emp, query: { action: 'hub-state' } });
T('hub-state dla pracownika (stan off)', r.code === 200 && r.body.state === 'off');
r = await call(clockH, { method: 'POST', headers: emp, query: { action: 'hub-event' }, body: { action: 'clock_in', clientEventId: 'hub-1' } });
T('wejście z Employee Hub (bez terminala)', r.code === 200 && r.body.state === 'working');
r = await call(clockH, { method: 'POST', headers: emp, query: { action: 'hub-event' }, body: { action: 'clock_in', clientEventId: 'hub-1b' } });
T('podwójne wejście odrzucone (409)', r.code === 409);
r = await call(clockH, { method: 'POST', headers: emp, query: { action: 'hub-event' }, body: { action: 'break_start', breakType: 'unpaid', clientEventId: 'hub-2' } });
T('przerwa → stan break', r.code === 200 && r.body.state === 'break');
r = await call(clockH, { method: 'POST', headers: emp, query: { action: 'hub-event' }, body: { action: 'break_end', clientEventId: 'hub-3' } });
await call(clockH, { method: 'POST', headers: emp, query: { action: 'hub-event' }, body: { action: 'clock_out', clientEventId: 'hub-4' } });
r = await call(clockH, { method: 'GET', headers: emp, query: { action: 'hub-state' } });
T('pełny cykl IN→BREAK→OUT zapisany (method=app)', r.code === 200 && r.body.state === 'off' && r.body.events.length === 4 && r.body.events.every((e) => e.method === 'app'));
T('hub-event wymaga sesji pracownika', (await call(clockH, { method: 'POST', headers: asm, query: { action: 'hub-event' }, body: { action: 'clock_in' } })).code === 403);

console.log('— DATA-04: audyt niezmienny —');
T('DELETE audytu → 405', (await call(audit, { method: 'DELETE', headers: asm, query: {} })).code === 405);

console.log('— P5: miesięczny Forecast + COL —');
const histSales = {}, histChecks = {};
for (let i = 1; i <= 70; i++) {
  const d = new Date('2026-09-01T00:00:00Z'); d.setUTCDate(d.getUTCDate() - i);
  const ds = d.toISOString().slice(0, 10), w = d.getUTCDay();
  histSales[ds] = 36000 + (w === 5 || w === 6 ? 9000 : 0) + i * 11;
  histChecks[ds] = 1250 + (w === 5 || w === 6 ? 280 : 0) + i;
}
await kv.set('sales:data', { sales: histSales, checks: histChecks });
await kv.set('accounts:list', [
  { id: 'uCrew', name: 'Anna Crew', grafikName: 'CREW', funkcja: 'CREW', umowa: 'UOP', stawka: 5200, wymiarTygH: 40 },
  { id: 'uMgr', name: 'Marek RGM', grafikName: 'RGM', funkcja: 'RGM', umowa: 'UOP', stawka: 7600, wymiarTygH: 40 },
  { id: 'uFunc', name: 'Jan SM', grafikName: 'SM', funkcja: 'SM', umowa: 'UOP', stawka: 6500, wymiarTygH: 40 },
  { id: 'uUz', name: 'Ula Zlecenie', grafikName: 'UZ', funkcja: 'CREW', umowa: 'UZ', stawka: 32, zus: false },
]);
const genReq = { method: 'POST', headers: asm, query: { action: 'generate' }, body: {
  month: '2026-09', monthlySales: 1500000, monthlyTransactions: 60000, expectedVersion: 0,
  settings: { historyWeeks: 8, targetSplh: 420, targetMpt: 4, indirectPct: 0.12, colTargetPct: 25, managerToleranceHours: 10, fixedHours: { manager: 176, functionalManager: 176, training: 40, managerTraining: 20 }, rates: { crew: 36, manager: 54, functionalManager: 47, training: 36, managerTraining: 50 } },
} };
r = await call(monthlyForecast, genReq);
const p5v1 = r.body.plan;
T('generowanie planu → 200 i valid', r.code === 200 && r.body.success && p5v1.valid);
T('suma sprzedaży miesiąca zachowana co do grosza', p5v1.totals.sales === 1500000 && p5v1.days.reduce((a, x) => a + x.sales, 0).toFixed(2) === '1500000.00');
T('suma transakcji miesiąca zachowana', p5v1.totals.transactions === 60000 && p5v1.days.reduce((a, x) => a + x.transactions, 0) === 60000);
T('każdy dzień ma 96 slotów 15-min', p5v1.days.length === 30 && p5v1.days.every((x) => x.slots.length === 96));
T('UOP crew ma zapewniony nominał', p5v1.totals.hours.crew >= p5v1.totals.contractHoursByCategory.crew);
T('MGR w przedziale etat ±10 h', p5v1.contracts.filter((x) => x.category !== 'crew').every((x) => x.plannedHours >= x.minHours && x.plannedHours <= x.maxHours));
T('COL ma rozbicie na 5 kategorii', monthlyForecastMod.FORECAST_CATEGORIES.every((c) => Number.isFinite(p5v1.totals.costByCategory[c])));

r = await call(monthlyForecast, { method: 'POST', headers: asm, query: { action: 'adjust' }, body: { month: '2026-09', expectedVersion: p5v1.version, date: '2026-09-05', patch: { sales: 90000, transactions: 3300, hours: { training: 8 } }, reason: 'lokalne wydarzenie' } });
const p5v2 = r.body.plan;
T('korekta dnia zapisana i podbija wersję', r.code === 200 && p5v2.version === p5v1.version + 1 && p5v2.days.find((x) => x.date === '2026-09-05').sales === 90000);
T('po korekcie sumy miesiąca nadal dokładne', p5v2.totals.sales === 1500000 && p5v2.totals.transactions === 60000 && p5v2.totals.hours.training === 40);
T('stara wersja korekty → 409', (await call(monthlyForecast, { method: 'POST', headers: asm, query: { action: 'adjust' }, body: { month: '2026-09', expectedVersion: p5v1.version, date: '2026-09-06', patch: { sales: 40000 }, reason: 'test konfliktu' } })).code === 409);

r = await call(monthlyForecast, { method: 'POST', headers: asm, query: { action: 'lock' }, body: { month: '2026-09', expectedVersion: p5v2.version } });
const p5locked = r.body.plan;
T('poprawny Forecast można zablokować', r.code === 200 && p5locked.status === 'LOCKED');
const over = await monthlyForecastMod.enforceLockedForecast('2026-09', [{ date: '2026-09-01', station: 'FRYTKI', hours: p5locked.totals.hours.crew + 0.25 }]);
T('blokada odrzuca przekroczenie godzin grafiku', over.locked === true && over.ok === false && over.violations.some((x) => x.includes('Crew')));
const scheduleOver = await call(schedule, { method: 'POST', headers: asm, query: { action: 'add' }, body: { date: '2026-09-02', name: 'UZ', accountId: 'uUz', station: 'FRYTKI', start: '00:00', end: '01:00', hours: p5locked.totals.hours.crew + 0.25 } });
T('API grafiku egzekwuje zablokowany limit Forecast', scheduleOver.code === 409 && scheduleOver.body.forecastLimit === true);
const publishBlocked = await call(schedule, { method: 'POST', headers: asm, query: { action: 'publish' }, body: { month: '2026-09' } });
T('publikacja blokowana przy niedoborze godzin UOP', publishBlocked.code === 409 && publishBlocked.body.forecastLimit === true && publishBlocked.body.violations.some((x) => x.includes('UOP')));
T('zablokowanego planu nie można regenerować', (await call(monthlyForecast, { ...genReq, body: { ...genReq.body, expectedVersion: p5locked.version } })).code === 423);
T('odblokowanie bez powodu odrzucone', (await call(monthlyForecast, { method: 'POST', headers: asm, query: { action: 'unlock' }, body: { month: '2026-09', expectedVersion: p5locked.version, reason: '' } })).code === 400);

console.log('— P4-03: regresja syntetycznego Actual —');
try {
  const app = readFileSync(new URL('../../rex-cloud-admin/src/App.jsx', import.meta.url), 'utf-8');
  T('brak generowania Actual z planu (±%)', !/planDaily\.map\([^)]*%\s*11/.test(app) && !app.includes('Wbicia zasymulowane'));
  T('brak Math.random w danych wykonania', !/actual[A-Za-z]*\s*=[^;]*Math\.random/.test(app));
} catch { T('App.jsx dostępny do kontroli regresji', false); }

console.log(`\nWynik: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
