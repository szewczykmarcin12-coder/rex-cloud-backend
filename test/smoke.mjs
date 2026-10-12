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

import fs from 'fs';
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
T('zatwierdzone „nie mogę": planer zatrzymuje się z pytaniem (409, dyspozycja:true), nie z twardą blokadą', r.code === 409 && r.body.dyspozycja === true && String(r.body.error).includes('nie mogę'));
r = await call(schedule, { method: 'POST', headers: asm, query: { action: 'add' }, body: { date: dTarget('10'), name: 'KOWAL', start: '13:00', end: '17:00', accountId: 'uA', mimoDyspozycji: true, aktualizujDyspozycje: true, powod: 'potwierdził telefonicznie' } });
T('manager potwierdza → zmiana dodana, oznaczona „mimo dyspozycji”, ostrzeżenie w odpowiedzi', r.code === 200 && r.body.shift.mimoDyspozycji && r.body.shift.mimoDyspozycji.reason === 'potwierdził telefonicznie' && r.body.warnings.some((w) => /mimo zgłoszonej niedostępności/.test(w)));
const sidMimo = r.body.shift.sid;
r = await call(availability, { method: 'GET', headers: asm, query: { reqs: '1' } });
const dyPo = r.body.requests.filter((x) => x.accountId === 'uA' && x.date === dTarget('10'));
T('dyspozycja na ten dzień zmieniona na „dostępny” z adnotacją managera (stare „nie mogę” nie wraca)', dyPo.length >= 1 && dyPo.every((x) => x.type !== 'unavailable' || x.status !== 'approved') && dyPo.some((x) => x.type === 'available' && x.nadpisanie && x.nadpisanie.poprzedni && x.nadpisanie.poprzedni.type === 'unavailable'));
T('kolejna zmiana tego dnia nie pyta już o dyspozycję (konflikt nakładania to inna sprawa)', (await call(schedule, { method: 'POST', headers: asm, query: { action: 'add' }, body: { date: dTarget('10'), name: 'KOWAL', start: '18:00', end: '21:00', accountId: 'uA' } })).body.dyspozycja !== true);
r = await call(schedule, { method: 'GET', headers: asm, query: {} }); const mZ = r.body.shifts.find((x) => x.sid === sidMimo);
T('zmiana mimo dyspozycji zapisana w grafiku z autorem i czasem', mZ && mZ.mimoDyspozycji && mZ.mimoDyspozycji.by === 'ASM');
r = await call(audit, { method: 'GET', headers: asm, query: { action: 'availability.override' } });
T('audyt: availability.override', r.code === 200 && (r.body.entries || []).some((e) => e.action === 'availability.override'));
// wariant bez aktualizacji dyspozycji: zmiana dodana, „nie mogę” zostaje
await call(availability, { method: 'POST', headers: emp, query: { action: 'request' }, body: { date: dTarget('11'), type: 'unavailable' } });
const dy11 = (await call(availability, { method: 'GET', headers: asm, query: { reqs: '1' } })).body.requests.find((x) => x.accountId === 'uA' && x.date === dTarget('11'));
await call(availability, { method: 'POST', headers: asm, query: { action: 'decide' }, body: { id: dy11.id, status: 'approved' } });
r = await call(schedule, { method: 'POST', headers: asm, query: { action: 'add' }, body: { date: dTarget('11'), name: 'KOWAL', start: '13:00', end: '17:00', accountId: 'uA', mimoDyspozycji: true, aktualizujDyspozycje: false } });
T('bez aktualizacji dyspozycji: zmiana dodana, „nie mogę” pozostaje zatwierdzone', r.code === 200 && (await call(availability, { method: 'GET', headers: asm, query: { reqs: '1' } })).body.requests.some((x) => x.accountId === 'uA' && x.date === dTarget('11') && x.type === 'unavailable' && x.status === 'approved'));
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

console.log('— COMPLIANCE: biblioteka reguł prawa pracy —');
const { ocenZgodnosc } = await import('../lib/compliance.js');
const kontaT = [{ id: 'uA', name: 'Jan Kowal', grafikName: 'KOWAL', umowa: 'UOP' }];
let zg = ocenZgodnosc([{ date: '2026-10-05', name: 'KOWAL', start: '14:00', end: '22:00' }, { date: '2026-10-06', name: 'KOWAL', start: '06:00', end: '14:00' }], kontaT);
T('8 h przerwy między zmianami → ODP_DOBOWY (block)', zg.violations.some((v) => v.code === 'ODP_DOBOWY' && v.level === 'block'));
zg = ocenZgodnosc([{ date: '2026-10-07', name: 'KOWAL', start: '07:00', end: '12:00' }, { date: '2026-10-07', name: 'KOWAL', start: '12:00', end: '16:00' }], kontaT);
T('dzielona zmiana 7–12 + 12–16 bez fałszywego alarmu', zg.summary.block === 0 && zg.summary.warn === 0);
zg = ocenZgodnosc([{ date: '2026-10-08', name: 'KOWAL', start: '06:00', end: '19:00' }], kontaT);
T('13 h w dobie → DZIEN_12H (block)', zg.violations.some((v) => v.code === 'DZIEN_12H' && v.level === 'block'));
zg = ocenZgodnosc([{ date: '2026-10-05', name: 'KOWAL', start: '14:00', end: '22:00' }, { date: '2026-10-06', name: 'KOWAL', start: '10:00', end: '18:00' }], kontaT);
T('doba pracownicza UOP → ostrzeżenie', zg.violations.some((v) => v.code === 'DOBA_PRACOWNICZA' && v.level === 'warn') && zg.summary.block === 0);
zg = ocenZgodnosc(['05', '06', '07', '08', '09', '10', '11'].map((d) => ({ date: `2026-10-${d}`, name: 'KOWAL', start: '08:00', end: '16:00' })), kontaT);
T('7 dni / 56 h / brak 35 h → trzy ostrzeżenia tygodniowe', ['DNI_7', 'TYDZIEN_48H', 'ODP_TYGODNIOWY'].every((c) => zg.violations.some((v) => v.code === c)));
zg = ocenZgodnosc([{ date: '2026-10-05', name: 'KOWAL', start: '22:00', end: '06:00' }, { date: '2026-10-06', name: 'KOWAL', start: '17:00', end: '23:00' }], kontaT);
T('zmiana nocna 22–06 liczona przez północ (11 h zachowane)', !zg.violations.some((v) => v.code === 'ODP_DOBOWY'));

console.log('— COMPLIANCE: bramka publikacji —');
await call(schedule, { method: 'PUT', headers: asm, query: {}, body: { shifts: [
  { date: '2026-10-05', name: 'KOWAL', station: 'FRYTKI', start: '14:00', end: '22:00', hours: 8 },
  { date: '2026-10-06', name: 'KOWAL', station: 'FRYTKI', start: '06:00', end: '14:00', hours: 8 },
], meta: { year: 2026, month: 9 } } });
let rp = await call(schedule, { method: 'POST', headers: asm, query: { action: 'publish' }, body: { month: '2026-10' } });
T('publikacja z naruszeniem block → 409 compliance', rp.code === 409 && rp.body.compliance === true && rp.body.violations.length >= 1);
rp = await call(schedule, { method: 'POST', headers: asm, query: { action: 'publish' }, body: { month: '2026-10', force: true } });
T('wymuszenie bez uzasadnienia → 400', rp.code === 400);
rp = await call(schedule, { method: 'POST', headers: asm, query: { action: 'publish' }, body: { month: '2026-10', force: true, reason: 'zgoda pracownika na dodatkową zmianę' } });
T('wymuszenie z uzasadnieniem publikuje', rp.code === 200 && rp.body.success === true);
const audLog = await kv.get('audit:log');
T('wymuszona publikacja odnotowana w audycie', Array.isArray(audLog) && audLog.some((e) => e.action === 'schedule.publish-forced'));
const complianceH = (await import('../lib/compliance.js')).default;
const rc = await call(complianceH, { method: 'GET', headers: asm, query: { month: '2026-10' } });
T('GET /compliance zwraca naruszenia miesiąca', rc.code === 200 && rc.body.summary.block >= 1 && Array.isArray(rc.body.reguly));

console.log('— KPI snapshoty (cron) + jednostka —');
const kpiH = (await import('../lib/kpi.js')).default;
const rk = await call(kpiH, { method: 'GET', headers: asm, query: { job: 'nightly', date: '2026-10-06' }, url: '/api/kpi-nightly?job=nightly' });
T('snapshot KPI dnia liczy plan i naruszenia', rk.code === 200 && rk.body.snapshoty[0].planH >= 8 && rk.body.snapshoty[0].naruszenia.block >= 1);
T('cron bez sekretu i bez sesji → 401', (await call(kpiH, { method: 'GET', headers: {}, query: {}, url: '/api/kpi-nightly' })).code === 401);
const rk2 = await call(kpiH, { method: 'GET', headers: asm, query: { days: 30 }, url: '/api/kpi' });
T('odczyt snapshotów do Analityki', rk2.code === 200 && rk2.body.snapshots.length >= 1);
const orgH = (await import('../lib/org.js')).default;
const ro = await call(orgH, { method: 'PUT', headers: asm, query: {}, body: { name: 'Testowa', code: 'PLK 1' } });
T('konfiguracja jednostki zapisana przez ASM', ro.code === 200 && ro.body.unit.name === 'Testowa');
T('pracownik może odczytać jednostkę', (await call(orgH, { method: 'GET', headers: emp, query: {} })).body.unit.code === 'PLK 1');
T('pracownik nie zmieni jednostki → 403', (await call(orgH, { method: 'PUT', headers: emp, query: {}, body: { name: 'X' } })).code === 403);

console.log('— Dyspozycje: zgłoszenie całego miesiąca + wariant od–do —');
const availH = (await import('../lib/availability.js')).default;
const kontaBak = (await kv.get('accounts:list')) || [];
if (!kontaBak.some((k) => k.id === 'uA')) await kv.set('accounts:list', [...kontaBak, { id: 'uA', name: 'Jan Kowal', grafikName: 'KOWAL', aliasy: [], login: 'JANKOW001', funkcja: 'CREW', umowa: 'UZ', stawka: 30 }]);
const oknoB = (await call(availH, { method: 'GET', headers: emp, query: { window: '1' } })).body.okno;
const targetM = oknoB.targetMonth;
await call(availH, { method: 'POST', headers: asm, query: { action: 'window' }, body: { open: true } });
let rb = await call(availH, { method: 'POST', headers: emp, query: { action: 'request-bulk' }, body: { items: [
  { date: `${targetM}-03`, type: 'available' }, { date: `${targetM}-04`, type: 'unavailable' },
  { date: `${targetM}-05`, type: 'specific_shift', startTime: '10:00', endTime: '20:00' }, { date: `${targetM}-06`, type: 'from_time', startTime: '14:00' },
] } });
T('zbiorcze zgłoszenie 4 dni przyjęte', rb.code === 200 && rb.body.dni === 4);
rb = await call(availH, { method: 'POST', headers: emp, query: { action: 'request-bulk' }, body: { items: [{ date: `${targetM}-05`, type: 'specific_shift', startTime: '12:00', endTime: '18:00' }] } });
const lista = await kv.get('avail:reqs');
T('ponowne zgłoszenie dnia zastępuje poprzedni wpis (jedna aktywna dyspozycja/dzień)', rb.code === 200 && lista.filter((r) => r.accountId === 'uA' && r.date === `${targetM}-05`).length === 1 && lista.find((r) => r.accountId === 'uA' && r.date === `${targetM}-05`).startTime === '12:00');
rb = await call(availH, { method: 'POST', headers: emp, query: { action: 'request-bulk' }, body: { items: [{ date: `${targetM}-07`, type: 'specific_shift', startTime: '10:00' }] } });
T('od–do bez końca → 400', rb.code === 400);
rb = await call(availH, { method: 'POST', headers: emp, query: { action: 'request-bulk' }, body: { items: [{ date: '2026-01-05', type: 'available' }] } });
T('dzień poza miesiącem docelowym → 400', rb.code === 400);

console.log('— Import dyspozycji (ASM, wiele osób, autozatwierdzenie) —');
rb = await call(availH, { method: 'POST', headers: asm, query: { action: 'request-bulk' }, body: { autoApprove: true, items: [
  { accountId: 'uA', date: '2026-12-03', type: 'specific_shift', startTime: '10:00', endTime: '20:00' },
  { accountId: 'uA', date: '2026-12-04', type: 'unavailable' },
] } });
const listaImp = await kv.get('avail:reqs');
T('ASM importuje dyspozycje wielu dat z accountId per pozycja', rb.code === 200 && rb.body.dni === 2);
T('autozatwierdzenie ustawia status approved z autorem', listaImp.filter((r) => r.date === '2026-12-03' && r.accountId === 'uA').every((r) => r.status === 'approved' && r.managerName === 'ASM'));
T('ASM nie podlega oknu miesiąca docelowego', listaImp.some((r) => r.date === '2026-12-04'));
T('pracownik nie może podać cudzego accountId', (await call(availH, { method: 'POST', headers: emp, query: { action: 'request-bulk' }, body: { items: [{ accountId: 'uB', date: `${targetM}-09`, type: 'available' }] } })).code !== 200 || !(await kv.get('avail:reqs')).some((r) => r.accountId === 'uB'));

console.log('— Decyzja zbiorcza dyspozycji —');
const pendIds = (await kv.get('avail:reqs')).filter((r) => r.accountId === 'uA' && r.status === 'pending').map((r) => r.id);
rb = await call(availH, { method: 'POST', headers: asm, query: { action: 'decide-bulk' }, body: { ids: pendIds, status: 'approved', managerNote: 'cały miesiąc' } });
T('decide-bulk zatwierdza wszystkie oczekujące osoby', rb.code === 200 && rb.body.zmienione === pendIds.length && pendIds.length >= 3);
T('po decyzji brak oczekujących u osoby', !(await kv.get('avail:reqs')).some((r) => r.accountId === 'uA' && r.status === 'pending'));
T('pracownik nie może decydować zbiorczo → 403', (await call(availH, { method: 'POST', headers: emp, query: { action: 'decide-bulk' }, body: { ids: pendIds, status: 'approved' } })).code === 403);

console.log('— AOP AUTOPLAN: model statystyczny + układanie —');
const ap = await import('../lib/autoplan.js');
const kontaAP = [
  { id: 'c1', name: 'Ala Kanapka', grafikName: 'KANAPKA', funkcja: 'CREW', umowa: 'UOP', wymiarTygH: 40, stawka: 4800 },
  { id: 'c2', name: 'Bartek Frytka', grafikName: 'FRYTKA', funkcja: 'CREW', umowa: 'UZ', stawka: 30 },
  { id: 'c3', name: 'Celina Nowa', grafikName: 'NOWA', funkcja: 'CREW', umowa: 'UZ', stawka: 30 },
  { id: 'm1', name: 'Marek Manager', grafikName: 'MANAGER1', funkcja: 'SM', umowa: 'UOP', wymiarTygH: 40, stawka: 7000 },
];
const histAP = [];
for (let d = 1; d <= 28; d++) { const ds = `2026-08-${String(d).padStart(2, '0')}`; if (d % 7 !== 0) { histAP.push({ date: ds, accountId: 'c1', name: 'KANAPKA', station: 'KANAPKI / WRAPY', start: '06:00', end: '14:00', hours: 8 }); histAP.push({ date: ds, accountId: 'c2', name: 'FRYTKA', station: 'FRYTKI', start: '14:00', end: '22:00', hours: 8 }); } }
histAP.push({ date: '2026-08-05', accountId: 'c1', name: 'KANAPKA', station: 'FRYTKI', start: '06:00', end: '14:00', hours: 8 });
const { model: mdl, priorGrupy } = ap.modelOsob(histAP, kontaAP, { dzis: '2026-10-01' });
T('afiniczność: Ala → KANAPKI dominuje (>0.8)', mdl.c1.afinicznosc['KANAPKI / WRAPY'] > 0.8 && mdl.c1.afinicznosc['FRYTKI'] < 0.15);
T('afiniczność sumuje się do ~1 (Dirichlet)', Math.abs(Object.values(mdl.c1.afinicznosc).reduce((a, b) => a + b, 0) - 1) < 1e-6);
T('nowa osoba dziedziczy prior grupy crew', mdl.c3.n === 0 && Math.abs(mdl.c3.afinicznosc['KANAPKI / WRAPY'] - priorGrupy.crew['KANAPKI / WRAPY']) < 1e-6);
T('nawyk startu: Ala rano (6), Bartek popołudnie (14)', mdl.c1.startPref[6] > mdl.c1.startPref[14] && mdl.c2.startPref[14] > mdl.c2.startPref[6]);
const rz = ap.rozkladDni(['2026-10-05', '2026-10-06', '2026-10-09', '2026-10-10'], { sales: 100000, transactions: 4000 }, {});
T('rozkład AOP na dni zachowuje sumę sprzedaży', Math.abs(rz.reduce((a, r) => a + r.sales, 0) - 100000) < 1 && rz[3].sales > rz[0].sales);
const kd = ap.krzywaDnia(40000, 420, null, 1);
T('krzywa dnia: szczyt 12–14 i 18–19 wyższy niż 06', kd[13] > kd[0] && kd[25] > kd[0] && kd.length === 48);
const wynik = ap.ulozGrafik({ from: '2026-10-05', to: '2026-10-11', aop: { crewHoursMax: 200, totalHours: 260, sales: 300000, transactions: 12000 }, wymagania: [{ station: 'KANAPKI / WRAPY', start: '06:00', end: '14:00', dni: [] }], seed: 7 },
  { accounts: kontaAP, historia: histAP, salesHist: {}, hourlyProfile: null, absences: [{ accountId: 'c2', status: 'approved', from: '2026-10-07', to: '2026-10-07' }], avail: [{ accountId: 'c3', status: 'approved', type: 'unavailable', date: '2026-10-08', recurrence: 'once' }], istniejace: [] });
const ps = wynik.podsumowanie;
T('wymagane KANAPKI od 06:00 obsadzone każdego dnia', ps.pokrycieWymagan === 100 && wynik.przypisania.filter((p) => p.wymagana).length === 7);
T('wymagana zmiana kanapek trafia do Ali (afiniczność)', wynik.przypisania.filter((p) => p.wymagana && p.accountId === 'c1').length >= 5);
T('limit godzin CREW nie przekroczony', ps.godzinyCrew <= 200 + 0.01);
T('absencja Bartka 07.10 respektowana', !wynik.przypisania.some((p) => p.accountId === 'c2' && p.date === '2026-10-07'));
T('niedostępność Celiny 08.10 respektowana', !wynik.przypisania.some((p) => p.accountId === 'c3' && p.date === '2026-10-08'));
T('0 twardych naruszeń KP w propozycji', ps.naruszenia.block === 0);
T('każda osoba ≤ 12 h/dobę i bez nakładania', (() => { const perDay = {}; wynik.przypisania.filter((p) => p.accountId).forEach((p) => { perDay[`${p.accountId}|${p.date}`] = (perDay[`${p.accountId}|${p.date}`] || 0) + p.hours; }); return Object.values(perDay).every((h) => h <= 12); })());
const wynik2 = ap.ulozGrafik({ from: '2026-10-05', to: '2026-10-11', aop: { crewHoursMax: 200, sales: 300000 }, wymagania: [{ station: 'KANAPKI / WRAPY', start: '06:00', end: '14:00' }], seed: 7 }, { accounts: kontaAP, historia: histAP, salesHist: {}, hourlyProfile: null, absences: [], avail: [], istniejace: [] });
T('deterministyczność (ten sam seed → ten sam wynik)', JSON.stringify(wynik2.przypisania.map((p) => [p.date, p.start, p.accountId])) === JSON.stringify(ap.ulozGrafik({ from: '2026-10-05', to: '2026-10-11', aop: { crewHoursMax: 200, sales: 300000 }, wymagania: [{ station: 'KANAPKI / WRAPY', start: '06:00', end: '14:00' }], seed: 7 }, { accounts: kontaAP, historia: histAP, salesHist: {}, hourlyProfile: null, absences: [], avail: [], istniejace: [] }).przypisania.map((p) => [p.date, p.start, p.accountId])));
await kv.set('accounts:list', kontaAP);
const apH = ap.default;
const rg = await call(apH, { method: 'POST', headers: asm, query: { action: 'generate' }, body: { from: '2026-10-05', to: '2026-10-11', aop: { crewHoursMax: 200, sales: 300000, transactions: 12000 }, wymagania: [{ station: 'KANAPKI / WRAPY', start: '06:00', end: '14:00' }] } });
T('POST autoplan generate → propozycja zapisana', rg.code === 200 && rg.body.proposal && rg.body.proposal.id);
const ra = await call(apH, { method: 'POST', headers: asm, query: { action: 'apply' }, body: { id: rg.body.proposal.id } });
T('apply zwraca zmiany do add-bulk (tylko obsadzone)', ra.code === 200 && ra.body.shifts.length === rg.body.proposal.podsumowanie.obsadzone);
T('pracownik nie wygeneruje propozycji → 403', (await call(apH, { method: 'POST', headers: emp, query: { action: 'generate' }, body: {} })).code === 403);



console.log('— Audyt 11.10: okna przez północ, odpoczynek z sąsiednich dni, deficyt stanowiskowy, stawki, statusy —');
const avMod = await import('../lib/availability.js');
T('okno 22:00–02:00: zmiana 22:00–02:00 mieści się, 20:00–02:00 nie', avMod.ocenOknoDyspozycji({ type: 'specific_shift', startTime: '22:00', endTime: '02:00' }, '22:00', '02:00') === null && avMod.ocenOknoDyspozycji({ type: 'specific_shift', startTime: '22:00', endTime: '02:00' }, '20:00', '02:00').kod === 'okno');
T('„do 23:30” to ograniczenie: zmiana do 23:00 OK, do 23:45 nie; „do 02:00” działa przez północ', avMod.ocenOknoDyspozycji({ type: 'until_time', endTime: '23:30' }, '16:00', '23:00') === null && avMod.ocenOknoDyspozycji({ type: 'until_time', endTime: '23:30' }, '16:00', '23:45').kod === 'do' && avMod.ocenOknoDyspozycji({ type: 'until_time', endTime: '02:00' }, '18:00', '01:30') === null && avMod.ocenOknoDyspozycji({ type: 'until_time', endTime: '02:00' }, '18:00', '02:30').kod === 'do');
T('„od 22:00”: zmiana 22:00–06:00 OK, 21:00–02:00 nie', avMod.ocenOknoDyspozycji({ type: 'from_time', startTime: '22:00' }, '22:00', '06:00') === null && avMod.ocenOknoDyspozycji({ type: 'from_time', startTime: '22:00' }, '21:00', '02:00').kod === 'od');
// odpoczynek: zmiana 30.09 18:00–02:00 poza okresem → 1.10 06:00 narusza 11 h już w generatorze
const wSas = ap.ulozGrafik({ from: '2026-10-01', to: '2026-10-01', aop: { crewHoursMax: 20, sales: 30000 }, wymagania: [{ station: 'KANAPKI / WRAPY', start: '06:00', end: '14:00' }], seed: 7 },
  { accounts: kontaAP.filter((k) => k.id === 'c1' || k.id === 'm1'), historia: histAP, salesHist: {}, hourlyProfile: null, absences: [], avail: [], istniejace: [], sasiednie: [{ date: '2026-09-30', accountId: 'c1', name: 'KANAPKA', station: 'KANAPKI / WRAPY', start: '18:00', end: '02:00', hours: 8 }] });
T('generator widzi zmianę z dnia przed okresem: Ala nie dostaje 06:00 po nocce (odpoczynek 11 h), zmiana zostaje nieobsadzona z powodem', !wSas.przypisania.some((p) => p.accountId === 'c1' && p.start === '06:00') && wSas.przypisania.some((p) => p.wymagana && !p.accountId && p.powody && p.powody['odpoczynek 11 h']));
// deficyt stanowiskowy: wymagany PREP, nikt nie ma historii PREP → obsadzone z flagą, deficyt raportowany, stanowisko nie zamienione
const wPrep = ap.ulozGrafik({ from: '2026-10-05', to: '2026-10-06', aop: { crewHoursMax: 60, sales: 60000 }, wymagania: [{ station: 'PREP', start: '08:00', end: '16:00' }, { station: 'FRYTKI', start: '08:00', end: '16:00' }], seed: 7 },
  { accounts: kontaAP, historia: histAP, salesHist: {}, hourlyProfile: null, absences: [], avail: [], istniejace: [] });
T('wymagana zmiana PREP zachowuje stanowisko PREP (bez zamiany w reperacji) i jest w deficycie stanowiskowym', wPrep.przypisania.filter((p) => p.wymagana && p.station === 'PREP').length === 2 && wPrep.podsumowanie.deficytStanowisk.PREP && wPrep.podsumowanie.deficytStanowisk.PREP.bezKwalifikacjiH + wPrep.podsumowanie.deficytStanowisk.PREP.nieobsadzoneH >= 8 && wPrep.statusy.obsada === 'czesciowa' && wPrep.statusy.kompletna === false);
T('macierz kwalifikacji konta jest twarda: osoba bez PREP na liście stanowisk nie dostaje PREP', (() => { const k2 = kontaAP.map((k) => ({ ...k, stanowiska: k.id === 'c2' ? ['FRYTKI'] : k.id === 'c1' ? ['KANAPKI / WRAPY'] : k.id === 'c3' ? ['PREP'] : [] })); const w = ap.ulozGrafik({ from: '2026-10-05', to: '2026-10-05', aop: { crewHoursMax: 30, sales: 30000 }, wymagania: [{ station: 'PREP', start: '08:00', end: '16:00' }], seed: 7 }, { accounts: k2, historia: histAP, salesHist: {}, hourlyProfile: null, absences: [], avail: [], istniejace: [] }); const z = w.przypisania.find((p) => p.wymagana); return z.accountId === 'c3' && !w.podsumowanie.deficytStanowisk.PREP; })());
// stawki: brak stawki u jednej osoby → koszt null, pokrycie < 100, status danych
const kBez = kontaAP.map((k) => (k.id === 'c2' ? { ...k, stawka: 0 } : k));
const wBez = ap.ulozGrafik({ from: '2026-10-05', to: '2026-10-07', aop: { crewHoursMax: 80, sales: 90000 }, wymagania: [{ station: 'KANAPKI / WRAPY', start: '06:00', end: '14:00' }, { station: 'FRYTKI', start: '12:00', end: '20:00' }], seed: 7 }, { accounts: kBez, historia: histAP, salesHist: {}, hourlyProfile: null, absences: [], avail: [], istniejace: [] });
T('brak stawki ≠ 0 zł: kosztSzac null, COL null, lista braków, pokrycie stawek < 100 %', wBez.przypisania.some((p) => p.accountId === 'c2') ? (wBez.podsumowanie.kosztSzac === null && wBez.podsumowanie.colSzac === null && wBez.podsumowanie.bezStawki.includes('Bartek Frytka') && wBez.podsumowanie.pokrycieStawekPct < 100 && /brak dla 1/.test(wBez.statusy.dane.stawki)) : true);
T('statusy osobno: budżet w limicie przy niepełnej obsadzie nie daje „kompletna”', wPrep.statusy.budzet === 'ok' && wPrep.statusy.kompletna === false);

console.log('— POS: Sales Day by Day + Daily Operations → sales:data (netto), profil śróddzienny → P5 / autoplan —');
const salesH = (await import('../lib/sales.js')).default;
const salesMod = await import('../lib/sales.js');
const posPayload = JSON.parse(fs.readFileSync(new URL('./fixtures/pos-import-2026-08-09.json', import.meta.url), 'utf8'));
await kv.set('sales:data', { sales: {}, checks: {} });
r = await call(salesH, { method: 'PUT', headers: asm, query: {}, body: posPayload });
T('import POS: 61 dni + profil śróddzienny przyjęte', r.code === 200 && r.body.dni === 61 && r.body.intraday === true && r.body.meta.basis === 'net');
r = await call(salesH, { method: 'GET', headers: asm, query: {} });
const sdGet = r.body;
T('GET /sales: netto, brutto i paragony per dzień (1.08: 37 833,30 / 41 075,17 / 835)', Math.round(sdGet.sales['2026-08-01']) === 37833 && sdGet.salesGross['2026-08-01'] === 41075.17 && sdGet.checks['2026-08-01'] === 835);
T('GET /sales: profil 96 slotów sumuje się do 1, szczyt 14:30, profil godzinowy per dow z intraday', sdGet.intradayProfile && Math.abs(sdGet.intradayProfile.weights96.reduce((a, x) => a + x, 0) - 1) < 1e-6 && sdGet.intradayProfile.weights96.indexOf(Math.max(...sdGet.intradayProfile.weights96)) === 34 && sdGet.hourlyProfileSource === 'intraday' && Object.keys(sdGet.hourlyProfile).length === 7);
T('profil śróddzienny odrzuca śmieci (400)', (await call(salesH, { method: 'PUT', headers: asm, query: {}, body: { intraday: { slots: { 'zle': { sales: 1 } } } } })).code === 400);
// P5 na realnej historii: rozkład na dni + sloty wg zmierzonego profilu
r = await call(monthlyForecast, { method: 'POST', headers: asm, query: { action: 'generate' }, body: { month: '2026-10', monthlySales: 850000, monthlyTransactions: 21000, expectedVersion: 0, settings: { targetSplh: 420 } } });
const p5pos = r.body && r.body.plan;
T('P5 październik z historii POS: suma zachowana, weekend > wtorek, profil zmierzony', r.code === 200 && p5pos && p5pos.totals.sales === 850000 && p5pos.intraday.source === 'measured' && p5pos.days.find((d) => d.date === '2026-10-04').sales > p5pos.days.find((d) => d.date === '2026-10-06').sales && !p5pos.warnings.some((w) => /standardowe założenie QSR/.test(w)));
const slotMax = p5pos.days[0].slots.reduce((m, s) => (s.sales > m.sales ? s : m), p5pos.days[0].slots[0]);
T('sloty 15 min dnia wg zmierzonego profilu: szczyt 14:30, 03:00 puste', slotMax.time === '14:30' && p5pos.days[0].slots.find((s) => s.time === '03:00').sales === 0);
const sl12 = p5pos.days[0].slots.find((s) => s.time === '12:00'), sl04 = p5pos.days[0].slots.find((s) => s.time === '04:00');
T('wymagana obsada = crew z popytu + manager na zmianie (1 w godzinach otwarcia 06–02, 0 o 04:00)', sl12.requiredMgr === 1 && Math.abs(sl12.requiredPeople - (sl12.requiredCrew + 1)) < 1e-9 && sl04.requiredMgr === 0 && sl04.requiredPeople === sl04.requiredCrew);
T('bez profilu — ostrzeżenie o założeniu QSR', monthlyForecastMod.buildMonthlyForecast({ month: '2026-10', monthlySales: 850000, monthlyTransactions: 21000, history: { sales: sdGet.sales, checks: sdGet.checks } }).warnings.some((w) => /standardowe założenie QSR/.test(w)));
const sdz = salesMod.profilSrodDzienny(await kv.get('sales:data').then((x) => x.intraday));
T('autoplan: krzywa dnia z profilu śróddziennego ma szczyt 14–15, zero w nocy', (() => { const w = ap.krzywaDnia(35000, 420, sdz.hourlyDow['1']); const i = w.indexOf(Math.max(...w)); return i >= 14 && i <= 18 && w[40] === 0; })());


console.log('— P4 v2: hybryda vs mediana, wybór po backteście, świeżość danych —');
const fc = await import('../lib/forecast.js');
const bt = fc.backtestModeli(posPayload.sales, 28, '2026-10-01');
T('backtest na realnych danych: hybryda wyraźnie lepsza od mediany (8,5 % vs 12,8 % MAPE) i wybrana', bt.wybrany === 'hybryda' && bt.hybryda.mape < bt.mediana.mape - 3 && bt.hybryda.dni === 28 && bt.mediana.dni === 28);
T('hybryda liczy się wyłącznie z danych sprzed dnia (asOf) — wynik dla 15.09 nie zmienia się po dopisaniu późniejszych dni', fc.baselineHybryda(posPayload.sales, '2026-09-15') === fc.baselineHybryda(Object.fromEntries(Object.entries(posPayload.sales).filter(([d]) => d < '2026-09-15')), '2026-09-15'));
T('hybryda: anomalia jednego dnia (×3) przesuwa poziom o < 6 %', (() => { const s2 = { ...posPayload.sales, '2026-09-27': posPayload.sales['2026-09-27'] * 3 }; return Math.abs(fc.baselineHybryda(s2, '2026-10-05') / fc.baselineHybryda(posPayload.sales, '2026-10-05') - 1) < 0.06; })());
T('determinizm: te same dane → ta sama prognoza', fc.baselineFor(posPayload.sales, '2026-10-05') === fc.baselineFor({ ...posPayload.sales }, '2026-10-05'));
T('za mało historii (1 tydzień) → hybryda bez pełnych 4 tygodni nadal działa, 5 dni → mediana jako domyślna', (() => { const t = Object.fromEntries(Object.entries(posPayload.sales).filter(([d]) => d >= '2026-09-24')); const k = Object.fromEntries(Object.entries(posPayload.sales).filter(([d]) => d >= '2026-09-26')); return fc.baselineHybryda(t, '2026-10-05') != null && fc.backtestModeli(k, 28, '2026-10-01').wybrany === 'mediana'; })());
r = await call(forecast, { method: 'GET', headers: asm, query: { days: '7' } });
T('GET /forecast: oba baseline per dzień, modele z MAPE, świeżość danych (rytm wtorkowy)', r.code === 200 && r.body.modele && r.body.modele.wybrany && r.body.days[0].baselineMediana != null && r.body.days[0].baselineHybryda != null && r.body.dane && r.body.dane.rytm.includes('wtorek') && /^\d{4}-\d{2}-\d{2}$/.test(r.body.dane.nastepnyImport) && new Date(r.body.dane.nastepnyImport + 'T00:00:00Z').getUTCDay() === 2);
const sw = fc.swiezoscDanych({ sales: posPayload.sales, meta: { importedAt: '2026-10-03T10:00:00Z' } }, '2026-10-13');
T('świeżość: 13.10 bez nowego importu → dane z 30.09 przeterminowane, następny wtorek poprawny', sw.przeterminowane === true && sw.dniOdOstatniego === 13 && sw.nastepnyImport === '2026-10-20' && sw.okno8[0] === '2026-08-06');
T('świeżość: 6.10 (wtorek) po imporcie do 5.10 → aktualne', fc.swiezoscDanych({ sales: { ...posPayload.sales, '2026-10-05': 30000 } }, '2026-10-06').przeterminowane === false);
r = await call(salesH, { method: 'GET', headers: asm, query: {} });
T('GET /sales zwraca świeżość', r.body.swiezosc && r.body.swiezosc.ostatniDzien === '2026-09-30');


console.log('— PLAN MIESIĄCA: propozycja totalu z historii, wersje, jedno źródło dla P5 i autoplanu —');
const mpMod = await import('../lib/month-plan.js'); const monthPlan = mpMod.default;
const prop = mpMod.propozycjaMiesiaca({ month: '2026-10', sales: posPayload.sales, checks: posPayload.checks, asOf: '2026-10-03' });
T('propozycja października z 8 tygodni: ok, w pasmie 700–900 tys., trend ujemny ograniczony do −4 %/tydz., skład 5 pt/5 sb', prop.ok && prop.sales > 700000 && prop.sales < 900000 && prop.trendTygPct === -4 && prop.tygodniHistorii === 8 && prop.sklad.Pt === 5 && prop.sklad.Sb === 5 && prop.low < prop.sales && prop.high > prop.sales);
T('propozycja liczona na dzień asOf — 20.09 nie widzi danych po 20.09 (inny poziom niż 3.10)', mpMod.propozycjaMiesiaca({ month: '2026-10', sales: posPayload.sales, checks: posPayload.checks, asOf: '2026-09-20' }).sales !== prop.sales && mpMod.propozycjaMiesiaca({ month: '2026-10', sales: posPayload.sales, checks: posPayload.checks, asOf: '2026-09-20' }).tygodniHistorii === 7);
T('bez danych rok wcześniej: sezon z indeksu — październik ze startu QSR (1,00), wrzesień już wyuczony z własnego wykonania (słabszy) → mnożnik 1,03–1,10, komunikat o uczeniu, szersze pasmo', !prop.yoy.dostepne && prop.sezon.idxCel.zrodlo === 'default' && prop.sezon.idxBaza.zrodlo === 'learned' && prop.sezon.idxRatio > 1.03 && prop.sezon.idxRatio < 1.10 && prop.powody.some((x) => /nauczy się/.test(x)) && prop.pasmoPct >= 9);
T('rok wcześniej jest tylko słabym głosem (waga 30 %): syntetyczny IX 2025 = −20 % vs VIII 2025 przesuwa propozycję, ale nie rządzi nią', (() => { const s2 = { ...posPayload.sales }; Object.entries(posPayload.sales).forEach(([d, v]) => { s2[`2025-${d.slice(5)}`] = v * 0.9; }); const r0 = mpMod.propozycjaMiesiaca({ month: '2026-09', sales: posPayload.sales, checks: posPayload.checks, asOf: '2026-08-31' }); const r = mpMod.propozycjaMiesiaca({ month: '2026-09', sales: s2, checks: posPayload.checks, asOf: '2026-08-31' }); const r1 = mpMod.propozycjaMiesiaca({ month: '2026-09', sales: s2, checks: posPayload.checks, asOf: '2026-08-31', yoyWeight: 1 }); return r.yoy.dostepne && r.sales < r0.sales && r.sales > r1.sales && r.yoy.factor === 0.8; })());
// indeks sezonowy: start → ręczny → wyuczony; zdarzenia
const idx0 = mpMod.indeksSezonowy(posPayload.sales, {});
T('indeks sezonowy: sierpień i wrzesień 2026 kompletne → wyuczone (n=1) zmieszane z priorem, pozostałe miesiące start QSR', idx0.idx['8'].zrodlo === 'learned' && idx0.idx['9'].zrodlo === 'learned' && idx0.idx['8'].factor > idx0.idx['9'].factor && idx0.idx['12'].zrodlo === 'default' && idx0.idx['12'].factor === 1.08 && idx0.miesiecyHistorii === 2);
T('ręczny indeks nadpisuje wyuczony', mpMod.indeksSezonowy(posPayload.sales, { '9': 0.9 }).idx['9'].factor === 0.9 && mpMod.indeksSezonowy(posPayload.sales, { '9': 0.9 }).idx['9'].zrodlo === 'manual');
const ev = [{ id: 'e1', name: 'Kampania kanapkowa', typ: 'promo', from: '2026-10-06', to: '2026-10-19', upliftPct: 8 }, { id: 'e2', name: 'Wszystkich Świętych', typ: 'closure', from: '2026-11-01', to: '2026-11-01', upliftPct: -100 }];
T('mnożnik zdarzeń: promo +8 %, zamknięcie = 0, dzień bez zdarzeń = 1', mpMod.mnoznikZdarzen(ev, '2026-10-10').factor === 1.08 && mpMod.mnoznikZdarzen(ev, '2026-11-01').factor === 0 && mpMod.mnoznikZdarzen(ev, '2026-10-25').factor === 1);
const propEv = mpMod.propozycjaMiesiaca({ month: '2026-10', sales: posPayload.sales, checks: posPayload.checks, asOf: '2026-10-03', events: ev });
T('propozycja z promocją: 14 dni × +8 % podnosi total i jest nazwana w powodach', propEv.sales > prop.sales && propEv.zdarzenia.includes('Kampania kanapkowa') && propEv.wplywZdarzen > 0 && propEv.dni.find((d) => d.date === '2026-10-10').events.length === 1);
T('walidacja zdarzenia: od > do, brak nazwy, wpływ poza zakresem', !!mpMod.normalizujZdarzenie({ name: 'x', from: '2026-10-10', to: '2026-10-01' }).error && !!mpMod.normalizujZdarzenie({ name: '', from: '2026-10-10', to: '2026-10-11' }).error && !!mpMod.normalizujZdarzenie({ name: 'Promo', from: '2026-10-10', to: '2026-10-11', upliftPct: 500 }).error && !mpMod.normalizujZdarzenie({ name: 'Promo', typ: 'promo', from: '2026-10-10', to: '2026-10-11', upliftPct: 8 }).error);
T('za mało historii → brak propozycji z powodem', mpMod.propozycjaMiesiaca({ month: '2026-10', sales: { '2026-09-30': 1000 }, checks: {}, asOf: '2026-10-03' }).ok === false);
r = await call(monthPlan, { method: 'GET', headers: asm, query: { month: '2026-10' } });
T('GET /month-plan: propozycja + brak planu + parametry wspólne + lista miesięcy', r.code === 200 && r.body.proposal.ok && r.body.plan === null && r.body.params.splh === 420 && r.body.miesiace.length === 6);
r = await call(monthPlan, { method: 'POST', headers: asm, query: { action: 'save' }, body: { month: '2026-10', sales: 700000, transactions: 18000, source: 'manual', proposal: prop, expectedVersion: 0 } });
T('odchylenie > 3 % od propozycji bez uzasadnienia → 400', r.code === 400);
T('godziny CREW > godziny AOP → 400', (await call(monthPlan, { method: 'POST', headers: asm, query: { action: 'save' }, body: { month: '2026-10', sales: 700000, transactions: 18000, hoursAop: 3000, crewHours: 3100, source: 'proposal', expectedVersion: 0 } })).code === 400);
r = await call(monthPlan, { method: 'POST', headers: asm, query: { action: 'save' }, body: { month: '2026-10', sales: 700000, transactions: 18000, hoursAop: 1200, crewHours: 1000, source: 'manual', reason: 'remont galerii 12–20.10', proposal: prop, expectedVersion: 0 } });
T('zapis z uzasadnieniem → DRAFT v1 z migawką propozycji i limitem godzin AOP', r.code === 200 && r.body.plan.status === 'DRAFT' && r.body.plan.version === 1 && r.body.plan.proposal.sales === prop.sales && r.body.plan.reason.includes('remont') && r.body.plan.hoursAop === 1200 && r.body.plan.crewHours === 1000);
T('stara wersja → 409', (await call(monthPlan, { method: 'POST', headers: asm, query: { action: 'save' }, body: { month: '2026-10', sales: 710000, transactions: 18000, source: 'proposal', expectedVersion: 0 } })).code === 409);
T('kierownik nie zapisze planu (403)', (await call(monthPlan, { method: 'POST', headers: { authorization: 'Bearer ' + await signSession({ role: 'kierownik', name: 'K' }) }, query: { action: 'save' }, body: { month: '2026-10', sales: 1, transactions: 1 } })).code === 403);
// przed zatwierdzeniem P5 bez własnej sprzedaży → błąd walidacji
await kv.set('forecast:monthly:2026-10', null);
T('P5 bez sprzedaży i bez zatwierdzonego planu → 400', (await call(monthlyForecast, { method: 'POST', headers: asm, query: { action: 'generate' }, body: { month: '2026-10', expectedVersion: 0 } })).code === 400);
r = await call(monthPlan, { method: 'POST', headers: asm, query: { action: 'approve' }, body: { month: '2026-10', expectedVersion: 1 } });
T('zatwierdzenie → APPROVED v2', r.code === 200 && r.body.plan.status === 'APPROVED' && r.body.plan.version === 2 && r.body.plan.approvedBy === 'ASM');
r = await call(monthlyForecast, { method: 'POST', headers: asm, query: { action: 'generate' }, body: { month: '2026-10', expectedVersion: 0 } });
T('P5 bez własnych liczb bierze sprzedaż i transakcje z zatwierdzonego Planu miesiąca i zapisuje źródło', r.code === 200 && r.body.plan.totals.sales === 700000 && r.body.plan.totals.transactions === 18000 && r.body.plan.salesSource === 'month-plan v2' && r.body.plan.input.settings.targetSplh === 420);
T('P5 porównuje plan godzin z limitem AOP (1200 h) i ostrzega przy przekroczeniu', r.body.plan.aopHours === 1200 && typeof r.body.plan.aopHeadroom === 'number' && (r.body.plan.aopHeadroom >= 0 || r.body.plan.warnings.some((w) => /limit AOP/.test(w))));
await call(monthPlan, { method: 'POST', headers: asm, query: { action: 'params' }, body: { splh: 450, mpt: 3.5, podloga: 2 } });
r = await call(monthPlan, { method: 'GET', headers: asm, query: { params: '1' } });
T('wspólne parametry planowania zapisane (SPLH 450) i zwracane', r.body.params.splh === 450 && r.body.params.mpt === 3.5);
r = await call(monthlyForecast, { method: 'POST', headers: asm, query: { action: 'generate' }, body: { month: '2026-10', expectedVersion: 1 } });
T('P5 używa wspólnego SPLH, chyba że wywołanie poda własny', r.body.plan.input.settings.targetSplh === 450);
r = await call(ap.default, { method: 'POST', headers: asm, query: { action: 'generate' }, body: { from: '2026-10-05', to: '2026-10-11', aop: { crewHoursMax: 200 }, wymagania: [] } });
T('autoplan bez sprzedaży w formularzu bierze ją z Planu miesiąca proporcjonalnie do dni (7/31 × 700 000)', r.code === 200 && r.body.proposal && r.body.proposal.aopZrodlo === 'month-plan' && Math.abs(r.body.proposal.aop.sales - Math.round(700000 * 7 / 31)) <= 1);
r = await call(ap.default, { method: 'POST', headers: asm, query: { action: 'generate' }, body: { from: '2026-10-05', to: '2026-10-11', aop: {}, wymagania: [] } });
T('autoplan bez limitu w formularzu bierze godziny AOP całego zespołu z Planu miesiąca (7/31 × 1200 h) — jeden budżet crew + kierownicy', r.code === 200 && Math.abs(r.body.proposal.aop.totalHours - Math.round(1200 * 7 / 31 * 4) / 4) < 0.3 && r.body.proposal.aop.limitZrodlo === 'month-plan:hoursAop' && r.body.proposal.podsumowanie.limitH === r.body.proposal.aop.totalHours);
r = await call(monthPlan, { method: 'POST', headers: asm, query: { action: 'event-save' }, body: { name: 'Kampania kanapkowa', typ: 'promo', from: '2026-10-06', to: '2026-10-19', upliftPct: 8 } });
const evId = r.body.event && r.body.event.id;
await call(monthPlan, { method: 'POST', headers: asm, query: { action: 'event-save' }, body: { name: 'Wszystkich Świętych', typ: 'closure', from: '2026-11-01', to: '2026-11-01' } });
T('API zdarzeń: zapis z audytem, lista posortowana, zamknięcie dostaje −100', r.code === 200 && !!evId && (await call(monthPlan, { method: 'GET', headers: asm, query: { month: '2026-11' } })).body.events.length === 2 && (await call(monthPlan, { method: 'GET', headers: asm, query: { month: '2026-11' } })).body.events[1].upliftPct === -100);
r = await call(forecast, { method: 'GET', headers: asm, query: { from: '2026-10-08', days: '3' } });
T('P4: prognoza dnia w promocji = model × 1,08, zdarzenie nazwane', r.body.days[0].eventFactor === 1.08 && r.body.days[0].baseline === Math.round(r.body.days[0].baselineModel * 1.08) && r.body.days[0].events[0] === 'Kampania kanapkowa');
r = await call(monthlyForecast, { method: 'POST', headers: asm, query: { action: 'generate' }, body: { month: '2026-11', monthlySales: 750000, monthlyTransactions: 19000, expectedVersion: 0 } });
T('P5: dzień zamknięty (1.11) dostaje 0 zł, suma miesiąca zachowana, zdarzenia zapisane w planie', r.code === 200 && r.body.plan.days.find((d) => d.date === '2026-11-01').sales === 0 && r.body.plan.totals.sales === 750000 && r.body.plan.events.some((e) => e.date === '2026-11-01' && e.factor === 0));
r = await call(monthPlan, { method: 'GET', headers: asm, query: { month: '2026-10' } });
T('GET /month-plan: indeks sezonowy i kalibracja (październik z planem, bez wykonania; wrzesień z wykonaniem bez planu)', r.body.sezon && r.body.sezon.idx['10'] && Array.isArray(r.body.kalibracja) && r.body.kalibracja.some((k) => k.month === '2026-10' && k.plan === 700000 && k.actual === null) && r.body.kalibracja.some((k) => k.month === '2026-09' && k.kompletny && k.plan === null));
r = await call(monthPlan, { method: 'POST', headers: asm, query: { action: 'season-save' }, body: { manual: { '12': 1.15, '13': 2 } } });
T('season-save: ręczny grudzień 1,15, nieprawidłowy miesiąc pominięty', r.code === 200 && r.body.sezon.idx['12'].factor === 1.15 && r.body.sezon.idx['12'].zrodlo === 'manual');
T('event-delete usuwa i audytuje', (await call(monthPlan, { method: 'POST', headers: asm, query: { action: 'event-delete' }, body: { id: evId } })).body.events.length === 1);
T('ponowne otwarcie zatwierdzonego planu wymaga powodu', (await call(monthPlan, { method: 'POST', headers: asm, query: { action: 'reopen' }, body: { month: '2026-10', expectedVersion: 2 } })).code === 400 && (await call(monthPlan, { method: 'POST', headers: asm, query: { action: 'reopen' }, body: { month: '2026-10', expectedVersion: 2, reason: 'nowy cel z centrali' } })).body.plan.status === 'DRAFT');

console.log('— P0 (12.10): model pracy, kwalifikacje, audyt grafiku, autoplan stanowisko-najpierw — zestaw testów z grafiku października —');
const wm = await import('../lib/work-model.js');
const qm = await import('../lib/qualifications.js');
const sa = await import('../lib/schedule-audit.js');
const WZ = JSON.parse(readFileSync(new URL('./fixtures/grafik-2026-10-wzorzec.json', import.meta.url), 'utf-8'));
const HIST89 = JSON.parse(readFileSync(new URL('./fixtures/grafik-2026-08-09-historia.json', import.meta.url), 'utf-8'));
T('wzorzec: 459 zmian, 3 z „→” (stanowisko docelowe bez godziny przejścia)', WZ.shifts.length === 459 && WZ.shifts.filter((x) => x.stacjaDocelowa).length === 3);
// — model pracy wyprowadzony z pliku —
const bib = wm.wyprowadzBiblioteke(WZ.shifts);
const szab = (st, a, b, typ = 'podstawowa') => bib.biblioteka.find((t) => t.station === st && t.start === a && t.end === b && t.typ === typ);
T('biblioteka: MANAGER 06–16, 12–22, 16–02 codziennie jako obsada podstawowa', ['06:00|16:00', '12:00|22:00', '16:00|02:00'].every((k) => { const [a, b] = k.split('|'); const t = szab('MANAGER', a, b); return t && t.dni.length === 7; }));
T('biblioteka: PANIEROWANIE otwarcie 06–16 i zamknięcie 16–02 codziennie; luka 16–18 w piątki uzupełniona z adnotacją „potwierdź”', szab('PANIEROWANIE', '06:00', '16:00').dni.length === 7 && szab('PANIEROWANIE', '16:00', '02:00').dni.length === 7 && bib.uwagi.some((u) => u.typ === 'luka-uzupelniona' && u.station === 'PANIEROWANIE' && u.od === '16:00' && u.do === '18:00'));
T('biblioteka: DOSTAWA to zadanie 5 h we wt/czw/sb, PREP zadanie wieczorne, ZMYWAK zamknięcie — nie 8-godzinne stanowiska', szab('DOSTAWA', '07:00', '12:00').rola === 'zadanie' && szab('DOSTAWA', '07:00', '12:00').dni.join('') === '246' && bib.biblioteka.filter((t) => t.station === 'PREP' && t.typ === 'podstawowa').every((t) => t.rola === 'zadanie' && t.godzin <= 5) && bib.biblioteka.filter((t) => t.station === 'ZMYWAK').every((t) => t.rola === 'zamkniecie'));
T('biblioteka: zmiany > 12 h ze źródła nie stają się szablonem (uwaga: 3), żaden szablon nie przekracza 10 h ani nie jest krótszy niż 2 h', bib.uwagi.some((u) => u.typ === 'zmiany-ponad-12h' && u.liczba === 3) && bib.biblioteka.every((t) => t.godzin <= 10 && t.godzin >= 2));
T('model: wymagania dnia (piątek 16.10) — ≥ 12 instancji podstawowych, PANIEROWANIE ciągłe o 17:00, 2 kierowników o 20:00', (() => { const d = wm.wymaganiaDnia({ biblioteka: bib.biblioteka }, '2026-10-16'); return d.instancje.filter((x) => x.typ === 'podstawowa').length >= 12 && d.wymagane.PANIEROWANIE && d.wymagane.PANIEROWANIE[wm.slotOd('17:00')] >= 1 && d.wymagane.MANAGER[wm.slotOd('20:00')] === 2; })());
T('normalizacja szablonu odrzuca > 12 h i złe czasy', wm.normalizujSzablon({ station: 'X', start: '06:00', end: '20:00' }, 0) === null && wm.normalizujSzablon({ station: 'X', start: '6:00', end: '14:00' }, 0) === null && wm.normalizujSzablon({ station: 'kontroler', start: '06:00', end: '14:00', dni: [1, 2] }, 0).station === 'KONTROLER');
// — audyt bez modelu: dokładnie wady wskazane w analizie —
const A0 = sa.audytGrafiku(WZ.shifts, { accounts: [], avail: [], model: null, opts: { dyspoWymagana: false } });
const kodP0 = (k) => A0.problemy.filter((p) => p.kod === k);
T('audyt wykrywa 3 zmiany > 12 h (4.10: KONTROLER 16 h, PANIEROWANIE 15 h, KANAPKI 13 h)', kodP0('ZMIANA_PONAD_12H').length === 3 && kodP0('ZMIANA_PONAD_12H').every((p) => p.date === '2026-10-04') && kodP0('ZMIANA_PONAD_12H').some((p) => p.minuty === 960));
T('audyt wykrywa 15 odpoczynków < 11 h (w tym 6 h KAJA GRZYBEK 3→4.10 i 8 h 4→5.10)', kodP0('ODPOCZYNEK_11H').length === 15 && kodP0('ODPOCZYNEK_11H').some((p) => p.minuty === 360 && p.name === 'KAJA GRZYBEK') && kodP0('ODPOCZYNEK_11H').some((p) => p.minuty === 480 && p.date === '2026-10-05'));
const lukaP0 = (d, st, a, b) => kodP0('LUKA_STANOWISKA').some((p) => p.date === d && p.station === st && p.od === a && p.do === b);
T('audyt wykrywa przerwy stanowisk: KANAPKI 11.10 16–17 i 15.10 15–18; PANIEROWANIE 16–18 w 16/19/21/23/26/30.10 i 16–17 w 18/22/25/28.10', lukaP0('2026-10-11', 'KANAPKI / WRAPY', '16:00', '17:00') && lukaP0('2026-10-15', 'KANAPKI / WRAPY', '15:00', '18:00') && ['16', '19', '21', '23', '26', '30'].every((d) => lukaP0(`2026-10-${d}`, 'PANIEROWANIE', '16:00', '18:00')) && ['18', '22', '25', '28'].every((d) => lukaP0(`2026-10-${d}`, 'PANIEROWANIE', '16:00', '17:00')));
T('audyt: powielone zmiany kierownicze (1.10 MGR FUNKCYJNE 09–17; 22/27/31.10 MANAGER 18–02) jako „do decyzji”, nie błąd', kodP0('DUPLIKAT_ZMIANY').length === 4 && kodP0('DUPLIKAT_ZMIANY').every((p) => p.waga === 'wazna') && kodP0('DUPLIKAT_ZMIANY').filter((p) => p.station === 'MANAGER' && p.od === '18:00').length === 3);
T('audyt: 3 zmiany ze zmianą stanowiska bez godziny przejścia (KONTROLER → PREP itd.)', kodP0('ODCINKI_BEZ_CZASU').length === 3 && kodP0('ODCINKI_BEZ_CZASU').some((p) => p.name === 'KAJA GRZYBEK' && p.date === '2026-10-28'));
T('audyt: brak kierownika 14.10 01:00–02:00 (MANAGER do 01:00, zespół do 02:00); grafik niegotowy', kodP0('BRAK_MGR').length === 1 && kodP0('BRAK_MGR')[0].date === '2026-10-14' && kodP0('BRAK_MGR')[0].od === '01:00' && A0.gotowy === false);
T('audyt: każdy problem ma opis i propozycję naprawy; streszczenie po polsku', A0.problemy.filter((p) => p.waga !== 'info').every((p) => p.opis && p.naprawa) && /niekompletny/.test(sa.streszczenieAudytu(A0)));
const MODEL_WZ = { ...wm.MODEL_DOMYSLNY, version: 1, status: 'zatwierdzony', biblioteka: bib.biblioteka, stanowiska: bib.stanowiska };
const A1 = sa.audytGrafiku(WZ.shifts, { accounts: [], avail: [], model: MODEL_WZ, opts: { dyspoWymagana: false } });
T('audyt z modelem: nadwyżka kierowników 22/27/31.10 18:00–02:00 (4 osoby MANAGER przy wymaganych 2) oraz mapa godzina × stanowisko', A1.problemy.filter((p) => p.kod === 'NADWYZKA_MGR').length === 3 && A1.mapa['2026-10-22'].stanowiska.MANAGER.obsada[wm.slotOd('20:00') / 2] === 4 && A1.mapa['2026-10-22'].stanowiska.MANAGER.wymagane[wm.slotOd('20:00') / 2] === 2);
// — audyt dyspozycji: pusty dzień = niedostępność; 23:59 vs do zamknięcia; nadpisanie —
const kDy = [{ id: 'd1', name: 'Dana Dyspo', grafikName: 'DYSPO', funkcja: 'CREW', umowa: 'UZ' }, { id: 'd2', name: 'Ewa Bez', grafikName: 'BEZ', funkcja: 'CREW', umowa: 'UZ' }];
const avDy = [{ accountId: 'd1', status: 'approved', type: 'available', date: '2026-11-03', recurrence: 'once' }, { accountId: 'd1', status: 'approved', type: 'until_time', endTime: '23:59', date: '2026-11-05', recurrence: 'once' }];
const zDy = [{ date: '2026-11-03', accountId: 'd1', name: 'DYSPO', station: 'KONTROLER', start: '08:00', end: '16:00' }, { date: '2026-11-04', accountId: 'd1', name: 'DYSPO', station: 'KONTROLER', start: '08:00', end: '16:00' }, { date: '2026-11-05', accountId: 'd1', name: 'DYSPO', station: 'KONTROLER', start: '18:00', end: '02:00' }, { date: '2026-11-06', accountId: 'd2', name: 'BEZ', station: 'KONTROLER', start: '08:00', end: '16:00' }, { date: '2026-11-07', accountId: 'd1', name: 'DYSPO', station: 'KONTROLER', start: '08:00', end: '16:00', mimoDyspozycji: { by: 'ASM', reason: 'potwierdziła telefonicznie' } }];
const A2 = sa.audytGrafiku(zDy, { accounts: kDy, avail: avDy, model: null, opts: {} });
T('dyspozycje: pusty dzień (4.11) = niedostępność krytyczna; 3.11 OK; osoba bez żadnej deklaracji = informacja, nie blokada; nadpisanie przez managera = informacja', A2.problemy.some((p) => p.kod === 'DYSPO_NIEDOSTEPNY' && p.date === '2026-11-04') && !A2.problemy.some((p) => p.date === '2026-11-03') && A2.problemy.some((p) => p.kod === 'DYSPO_BRAK_DEKLARACJI' && p.accountId === 'd2' && p.waga === 'info') && A2.problemy.some((p) => p.kod === 'DYSPO_NADPISANA' && p.date === '2026-11-07'));
T('„do 23:59” a zmiana do 02:00: przy odczycie „koniec dnia” ostrzeżenie DYSPO_2359, przy „do zamknięcia” brak problemu', A2.problemy.some((p) => p.kod === 'DYSPO_2359' && p.date === '2026-11-05') && !sa.audytGrafiku(zDy, { accounts: kDy, avail: avDy, model: null, opts: { interpretacja2359: 'do-zamkniecia' } }).problemy.some((p) => p.date === '2026-11-05'));
T('odcinki w zmianie: osoba liczona tylko na bieżącym stanowisku (12–17 KANAPKI, 17–20 PREP)', (() => { const p = wm.pokrycieDnia([{ date: '2026-11-03', name: 'X', station: 'KANAPKI / WRAPY', start: '12:00', end: '20:00', segmenty: [{ start: '12:00', end: '17:00', station: 'KANAPKI / WRAPY' }, { start: '17:00', end: '20:00', station: 'PREP' }] }]); return p['KANAPKI / WRAPY'][wm.slotOd('16:00')] === 1 && p['KANAPKI / WRAPY'][wm.slotOd('18:00')] === 0 && p.PREP[wm.slotOd('18:00')] === 1; })());
// — kwalifikacje oddzielone od historii —
const mtxP0 = { c1: { 'KANAPKI / WRAPY': { poziom: 2, zatwierdzone: true, zrodlo: 'manager' }, PREP: { poziom: 2, zatwierdzone: false, zrodlo: 'historia' } } };
T('kwalifikacja: zatwierdzony wpis = uprawnienie; propozycja z historii NIE jest uprawnieniem; brak wpisu = brak danych; stara lista konta = poziom 2', qm.kwalifikacja(mtxP0, { id: 'c1' }, 'KANAPKI / WRAPY').zatwierdzone && qm.kwalifikacja(mtxP0, { id: 'c1' }, 'PREP').zatwierdzone === false && qm.kwalifikacja(mtxP0, { id: 'c9' }, 'PREP').zrodlo === 'brak' && qm.kwalifikacja({}, { id: 'c2', stanowiska: ['FRYTKI'] }, 'FRYTKI').poziom === 2);
T('propozycje z historii: ≥ 3 zmiany → wpis niezatwierdzony, nie nadpisuje decyzji managera', (() => { const r = qm.propozycjeZHistorii(mtxP0, [{ id: 'c1' }], histAP); return r.matrix.c1['KANAPKI / WRAPY'].zrodlo === 'manager' && r.matrix.c1.FRYTKI === undefined && r.dodane === 0; })() && qm.propozycjeZHistorii({}, [{ id: 'c2' }], histAP).matrix.c2.FRYTKI.zatwierdzone === false);
T('stan danych: tryb „brak” bez macierzy, pula samodzielnych per stanowisko', qm.stanDanychKwalifikacji({}, kontaAP, ['PREP']).tryb === 'brak' && qm.stanDanychKwalifikacji(mtxP0, kontaAP, ['KANAPKI / WRAPY', 'PREP']).pula.PREP.samodzielni === 0 && qm.stanDanychKwalifikacji(mtxP0, kontaAP, ['KANAPKI / WRAPY']).pula['KANAPKI / WRAPY'].samodzielni === 1);
// — cele godzin zamiast „tyg ÷ 7 × dni” i 15 % —
const cg = ap.celeGodzin(kontaAP, ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'], [{ accountId: 'c1', status: 'approved', from: '2026-10-09', to: '2026-10-09' }]);
T('UOP 40 h/tydz., tydzień z 1 dniem absencji → cel 32 h (4 dni robocze × 8), max = cel (bez automatycznych +15 %), źródło „etat”; UZ bez celu z limitem domyślnym', cg.c1.cel === 32 && cg.c1.max === 32 && cg.c1.zrodlo === 'etat' && cg.c2.cel === null && cg.c2.max > 0 && ap.celeGodzin([{ id: 'x', umowa: 'UZ', godzCel: 80, godzMax: 100 }], ['2026-10-05']).x.max === 100);
// — silnik na danych października: konta, macierz z pliku (do testu), model z pliku, historia VIII–IX, sprzedaż z POS —
const nazwyWZ = [...new Set(WZ.shifts.map((x) => x.name))];
const mgrWZ = new Set(WZ.shifts.filter((x) => x.station === 'MANAGER').map((x) => x.name)), mgrfWZ = new Set(WZ.shifts.filter((x) => x.station === 'MGR FUNKCYJNE').map((x) => x.name));
// kierownicy: w grafiku wzorcowym planowani do 205 h — jawny limit godzMax 200 (bez tego domyślne 165 h i luki MGR FUNKCYJNE z powodem „limit godzin osoby”)
const kontaWZ = nazwyWZ.map((n, i) => ({ id: 'w' + i, name: n, grafikName: n, funkcja: mgrWZ.has(n) ? 'SM' : mgrfWZ.has(n) ? 'JSM' : 'CREW', umowa: 'UZ', ...(mgrWZ.has(n) || mgrfWZ.has(n) ? { godzMax: 200 } : {}) }));
const idWZ = Object.fromEntries(kontaWZ.map((a) => [a.name, a.id]));
const mtxWZ = {}; WZ.shifts.forEach((x) => { (mtxWZ[idWZ[x.name]] = mtxWZ[idWZ[x.name]] || {})[x.station] = { poziom: 2, zatwierdzone: true, zrodlo: 'manager' }; if (x.stacjaDocelowa) mtxWZ[idWZ[x.name]][x.stacjaDocelowa] = { poziom: 2, zatwierdzone: true, zrodlo: 'manager' }; });
const histWZ = HIST89.map((x) => ({ ...x, accountId: idWZ[x.name] || null }));
const sdzWZ = (await import('../lib/sales.js')).profilSrodDzienny(posPayload.intraday);
const daneWZ = { accounts: kontaWZ, historia: histWZ, salesHist: posPayload.sales, hourlyProfile: sdzWZ ? sdzWZ.hourlyDow : null, absences: [], avail: [], istniejace: [], sasiednie: [], workModel: MODEL_WZ, matrix: mtxWZ, paramy: {} };
const t0P0 = Date.now();
const G = ap.ulozGrafik({ from: '2026-10-01', to: '2026-10-31', aop: { sales: 930304, transactions: 23552, totalHours: 4200 }, seed: 42, splh: 420 }, daneWZ);
const tG = Date.now() - t0P0;
console.log('   październik:', JSON.stringify({ podst: G.podsumowanie.podstawowych, pokr: G.podsumowanie.pokrycieWymagan, kryt: G.audyt.podsumowanie.krytyczne, perKod: G.audyt.podsumowanie.perKod, block: G.podsumowanie.naruszenia.block, razem: G.podsumowanie.godzinyRazem, luki: G.luki.map((l) => `${l.date} ${l.station} ${l.start}-${l.end}: ${Object.entries(l.powody).map(([k, v]) => k + ' ' + v).join(', ')}`) }));
T(`październik: ≥ 450 instancji podstawowych z modelu, ≥ 99 % obsadzonych, 0 luk krytycznych audytu, 0 twardych naruszeń KP, ≤ 4200 h razem (${G.podsumowanie.godzinyRazem} h, ${tG} ms)`, G.podsumowanie.podstawowych >= 450 && G.podsumowanie.pokrycieWymagan >= 99 && G.audyt.podsumowanie.krytyczne === 0 && G.podsumowanie.naruszenia.block === 0 && G.podsumowanie.godzinyRazem <= 4200 && tG < 5000);
T('październik: kierownicy w tym samym budżecie — MANAGER ≥ 900 h + MGR FUNKCYJNE w godzinach razem, podział operacyjne/administracyjne, MANAGER tylko kierownicy', G.podsumowanie.godzinyMgrOperacyjne >= 900 && G.podsumowanie.godzinyMgrAdministracyjne > 0 && Math.abs(G.podsumowanie.godzinyRazem - (G.podsumowanie.godzinyCrew + G.podsumowanie.godzinyMgr)) < 0.01 && G.przypisania.filter((p) => p.station === 'MANAGER' && p.accountId).every((p) => kontaWZ.find((k) => k.id === p.accountId).funkcja === 'SM'));
T('październik: żadna osoba > 12 h w bloku, odpoczynek ≥ 11 h, brak nakładania — bez „łatania” długimi zmianami', !G.audyt.problemy.some((p) => ['ZMIANA_PONAD_12H', 'ODPOCZYNEK_11H', 'NAKLADANIE'].includes(p.kod)) && G.przypisania.filter((p) => p.accountId).every((p) => p.hours <= 12));
T('październik: każda luka ma powody, listę prób naprawy i wyjaśnienie po polsku; status „niekompletny” gdy luka podstawowa', G.luki.every((l) => l.wyjasnienie && l.proby.length >= 3 && Object.keys(l.powody).length) && (G.luki.length === 0 ? G.statusy.kompletna === true : G.statusy.kompletna === false && G.statusy.obsada === 'czesciowa'));
T('październik: stanowisko krytyczne ciągłe co 15 min — PANIEROWANIE i KANAPKI bez przerw w żadnym dniu (błąd wzorca nie jest powielany)', !G.audyt.problemy.some((p) => p.kod === 'LUKA_STANOWISKA' && ['PANIEROWANIE', 'KANAPKI / WRAPY'].includes(p.station)));
T('październik: przypisania z macierzy — każda osoba na stanowisku z zatwierdzonym poziomem ≥ 2 albo jawnie oznaczona (bez historii / niepotwierdzona)', G.przypisania.filter((p) => p.accountId).every((p) => (mtxWZ[p.accountId] && mtxWZ[p.accountId][p.station] && mtxWZ[p.accountId][p.station].poziom >= 2) || p.bezHistoriiStanowiska || p.kwalifikacjaNiepotwierdzona || p.kwalifikacjaZrodlo === 'funkcja'));
T('październik: koszt = „brak danych” (null) bez stawek, MPT policzone z godzin razem, wykorzystanie limitu < 100 %', G.podsumowanie.kosztSzac === null && G.podsumowanie.mpt > 0 && G.podsumowanie.wykorzystanieLimituPct < 100);
T('determinizm: ten sam seed → identyczne przypisania', JSON.stringify(ap.ulozGrafik({ from: '2026-10-01', to: '2026-10-07', aop: { sales: 210000, totalHours: 950 }, seed: 3, splh: 420 }, daneWZ).przypisania.map((p) => [p.date, p.start, p.accountId])) === JSON.stringify(ap.ulozGrafik({ from: '2026-10-01', to: '2026-10-07', aop: { sales: 210000, totalHours: 950 }, seed: 3, splh: 420 }, daneWZ).przypisania.map((p) => [p.date, p.start, p.accountId])));
// — P0-1: brakującego stanowiska nie pokrywa nadmiar na innym —
const modelMini = { ...wm.MODEL_DOMYSLNY, status: 'zatwierdzony', version: 1, biblioteka: [{ id: 't1', station: 'KONTROLER', start: '12:00', end: '20:00', dni: [1], liczba: 1, typ: 'podstawowa', rola: 'srodek', flexMin: 60, minH: 4, maxH: 10 }, { id: 't2', station: 'KANAPKI / WRAPY', start: '12:00', end: '20:00', dni: [1], liczba: 1, typ: 'podstawowa', rola: 'srodek', flexMin: 60, minH: 4, maxH: 10 }, { id: 't3', station: 'MANAGER', start: '11:00', end: '21:00', dni: [1], liczba: 1, typ: 'podstawowa', rola: 'srodek', flexMin: 0, minH: 4, maxH: 10 }] };
const kontaK = [{ id: 'k1', name: 'K Jeden', funkcja: 'CREW', umowa: 'UZ' }, { id: 'k2', name: 'K Dwa', funkcja: 'CREW', umowa: 'UZ' }, { id: 'k3', name: 'K Trzy', funkcja: 'CREW', umowa: 'UZ' }, { id: 'mm', name: 'M Szef', funkcja: 'SM', umowa: 'UZ' }];
const mtxK = { k1: { KONTROLER: { poziom: 2, zatwierdzone: true } }, k2: { KONTROLER: { poziom: 2, zatwierdzone: true } }, k3: { KONTROLER: { poziom: 2, zatwierdzone: true } }, mm: {} };
const GK = ap.ulozGrafik({ from: '2026-10-05', to: '2026-10-05', aop: { totalHours: 40 }, seed: 1 }, { accounts: kontaK, historia: [], workModel: modelMini, matrix: mtxK, avail: [], absences: [], istniejace: [] });
T('P0-1: trzech kontrolerów nie „pokrywa” KANAPEK — KONTROLER obsadzony, KANAPKI luka z powodem „brak kwalifikacji: 3”, wykonalność zgłasza brak puli przed generowaniem, status niekompletny', GK.przypisania.find((p) => p.station === 'KONTROLER').accountId && GK.luki.some((l) => l.station === 'KANAPKI / WRAPY' && l.powody['brak kwalifikacji: KANAPKI / WRAPY'] === 3) && GK.wykonalnosc.problemy.some((p) => p.typ === 'pula' && p.station === 'KANAPKI / WRAPY' && p.waga === 'krytyczna') && GK.statusy.kompletna === false && GK.statusy.wykonalnosc === 'problemy');
T('P0-1: MANAGER obsadzony kierownikiem, nie crew; audyt wyniku ma lukę krytyczną KANAPKI 12–20', GK.przypisania.find((p) => p.station === 'MANAGER').accountId === 'mm' && GK.audyt.problemy.some((p) => ['LUKA_STANOWISKA', 'BRAK_STANOWISKA_W_DNIU'].includes(p.kod) && p.waga === 'krytyczna' && p.station === 'KANAPKI / WRAPY' && p.od === '12:00' && p.do === '20:00'));
// — P0-3: zaimportowany grafik kierowników pokrywa instancje MANAGER i liczy się do budżetu —
const GI = ap.ulozGrafik({ from: '2026-10-05', to: '2026-10-05', aop: { totalHours: 40 }, seed: 1 }, { accounts: kontaK, historia: [], workModel: modelMini, matrix: { ...mtxK, k3: { 'KANAPKI / WRAPY': { poziom: 2, zatwierdzone: true } } }, avail: [], absences: [], istniejace: [{ sid: 's1', date: '2026-10-05', accountId: 'mm', name: 'M SZEF', station: 'MANAGER', start: '11:00', end: '21:00', hours: 10 }] });
T('P0-3: istniejąca zmiana MANAGER 11–21 pokrywa szablon (nie dubluje), 10 h w godzinach razem; KANAPKI obsadzone po dodaniu kwalifikacji → kompletny', GI.podsumowanie.pokryteIstniejacymi === 1 && !GI.przypisania.some((p) => p.station === 'MANAGER') && GI.podsumowanie.godzinyIstniejace === 10 && GI.podsumowanie.godzinyRazem === 26 && GI.statusy.kompletna === true);
// — P0-5/P1-8: naprawa — przesunięcie w granicach elastyczności, gdy jedyny kandydat ma 11 h odpoczynku po nocce —
const GN = ap.ulozGrafik({ from: '2026-10-05', to: '2026-10-05', aop: { totalHours: 40 }, seed: 1 }, { accounts: kontaK, historia: [], workModel: { ...modelMini, biblioteka: [{ id: 't1', station: 'KONTROLER', start: '12:00', end: '20:00', dni: [1], liczba: 1, typ: 'podstawowa', rola: 'srodek', flexMin: 60, minH: 4, maxH: 10 }] }, matrix: { k1: { KONTROLER: { poziom: 2, zatwierdzone: true } }, k2: { KONTROLER: { poziom: 0, zatwierdzone: true } }, k3: { KONTROLER: { poziom: 0, zatwierdzone: true } } }, avail: [], absences: [], istniejace: [], sasiednie: [{ date: '2026-10-04', accountId: 'k1', name: 'K JEDEN', station: 'KONTROLER', start: '16:00', end: '02:00' }] });
T('naprawa: start 12:00 narusza 11 h po nocce do 02:00 → silnik przesuwa zmianę na 13:00–21:00 (+60 min) i zapisuje naprawę', GN.przypisania[0].accountId === 'k1' && GN.przypisania[0].start === '13:00' && /przesunięcie \+60/.test(GN.przypisania[0].naprawa) && !GN.audyt.problemy.some((p) => p.kod === 'ODPOCZYNEK_11H'));
// — P0-6: te same reguły dyspozycji w generatorze i w zapisie (pusty dzień = niedostępny; okno przez północ) —
const avK = [{ accountId: 'k1', status: 'approved', type: 'available', date: '2026-10-06', recurrence: 'once' }];
const GD = ap.ulozGrafik({ from: '2026-10-05', to: '2026-10-05', aop: { totalHours: 40 }, seed: 1 }, { accounts: kontaK.slice(0, 1), historia: [], workModel: { ...modelMini, biblioteka: [modelMini.biblioteka[0]] }, matrix: { k1: { KONTROLER: { poziom: 2, zatwierdzone: true } } }, avail: avK, absences: [], istniejace: [] });
T('P0-6: osoba z dyspozycją tylko na 6.10 nie dostaje zmiany 5.10 (pusty dzień = niedostępność) — powód „brak dyspozycji na ten dzień”', GD.luki.length === 1 && GD.luki[0].powody['brak dyspozycji na ten dzień'] === 1);
T('P0-6: „do 23:59” — zmiana do 02:00 odrzucona przy odczycie „koniec dnia”, przyjęta przy „do zamknięcia”', (() => { const av = [{ accountId: 'k1', status: 'approved', type: 'until_time', endTime: '23:59', date: '2026-10-05', recurrence: 'once' }]; const mdl = { ...modelMini, biblioteka: [{ id: 'tz', station: 'KONTROLER', start: '18:00', end: '02:00', dni: [1], liczba: 1, typ: 'podstawowa', rola: 'zamkniecie', flexMin: 0, minH: 4, maxH: 10 }] }; const d = { accounts: kontaK.slice(0, 1), historia: [], workModel: mdl, matrix: { k1: { KONTROLER: { poziom: 2, zatwierdzone: true } } }, avail: av, absences: [], istniejace: [] }; const a = ap.ulozGrafik({ from: '2026-10-05', to: '2026-10-05', aop: { totalHours: 40 }, seed: 1 }, d); const b = ap.ulozGrafik({ from: '2026-10-05', to: '2026-10-05', aop: { totalHours: 40 }, seed: 1, opts: { interpretacja2359: 'do-zamkniecia' } }, d); return a.luki.length === 1 && a.luki[0].powody['dostępny do 23:59'] === 1 && b.luki.length === 0 && !b.audyt.problemy.some((p) => p.kod.startsWith('DYSPO')); })());
// — API: model pracy, kwalifikacje, audyt, bramka publikacji —
const wmH = wm.default, qmH = qm.default, saH = sa.default;
await kv.set('accounts:list', kontaWZ);
let rwP0 = await call(wmH, { method: 'POST', headers: asm, query: { action: 'derive' }, body: { shifts: WZ.shifts, plik: 'plan_2026-10 (wzorzec)' } });
T('POST /work-model?action=derive → propozycja (status „propozycja”, ≥ 30 szablonów podstawowych, uwagi)', rwP0.code === 200 && rwP0.body.model.status === 'propozycja' && rwP0.body.model.biblioteka.filter((t) => t.typ === 'podstawowa').length >= 30 && rwP0.body.model.uwagi.length >= 2);
T('autoplan bez zatwierdzonego modelu nie używa propozycji (wymagania z formularza)', (await call(ap.default, { method: 'POST', headers: asm, query: { action: 'feasibility' }, body: { from: '2026-10-05', to: '2026-10-05', aop: { totalHours: 100 }, wymagania: [] } })).body.modelPracy === null);
rwP0 = await call(wmH, { method: 'POST', headers: asm, query: { action: 'approve' }, body: {} });
T('zatwierdzenie modelu (ASM) → status „zatwierdzony” z osobą i datą', rwP0.code === 200 && rwP0.body.model.status === 'zatwierdzony' && rwP0.body.model.approvedBy === 'ASM');
T('kierownik nie zatwierdzi modelu → 403', (await call(wmH, { method: 'POST', headers: { authorization: 'Bearer ' + await signSession({ role: 'kierownik', name: 'K', login: 'K' }) }, query: { action: 'approve' }, body: {} })).code === 403);
await kv.set('quals:matrix', mtxWZ);
let rqP0 = await call(qmH, { method: 'GET', headers: asm, query: { stations: 'KANAPKI / WRAPY,PANIEROWANIE' } });
T('GET /qualifications: stan danych (tryb macierz, pula samodzielnych per stanowisko)', rqP0.code === 200 && rqP0.body.stan.tryb === 'macierz' && rqP0.body.stan.pula['PANIEROWANIE'].samodzielni >= 5);
rqP0 = await call(qmH, { method: 'PUT', headers: asm, query: {}, body: { accountId: 'w0', station: 'FRYTKI', poziom: 1 } });
T('PUT /qualifications zapisuje wpis managera (poziom 1 = w szkoleniu, zatwierdzone)', rqP0.code === 200 && rqP0.body.matrix.w0.FRYTKI.poziom === 1 && rqP0.body.matrix.w0.FRYTKI.zatwierdzone === true && rqP0.body.matrix.w0.FRYTKI.by === 'ASM');
await kv.set('sales:data', { sales: posPayload.sales, intraday: posPayload.intraday, meta: { basis: 'net' } });
const rf = await call(ap.default, { method: 'POST', headers: asm, query: { action: 'feasibility' }, body: { from: '2026-10-01', to: '2026-10-31', aop: { sales: 930304, transactions: 23552, totalHours: 4200 } } });
T('POST /autoplan?action=feasibility: wykonalność przed generowaniem (pule stanowisk, instancje bez kandydata) z zatwierdzonym modelem', rf.code === 200 && rf.body.modelPracy && rf.body.modelPracy.status === 'zatwierdzony' && rf.body.wykonalnosc && rf.body.wykonalnosc.puleStanowisk.MANAGER && rf.body.podstawowych >= 450);
const rgen = await call(ap.default, { method: 'POST', headers: asm, query: { action: 'generate' }, body: { from: '2026-10-01', to: '2026-10-31', aop: { sales: 930304, transactions: 23552, totalHours: 4200 } } });
T('POST /autoplan?action=generate (październik, model + macierz z bazy): propozycja z audytem, mapą godzina × stanowisko, lukami i statusami', rgen.code === 200 && rgen.body.proposal.audyt && rgen.body.proposal.mapa && rgen.body.proposal.mapa['2026-10-16'] && rgen.body.proposal.luki && rgen.body.proposal.statusy.operacyjnie);
// bramka publikacji: miesiąc z grafikiem wzorcowym (ma zmiany > 12 h i przerwy stanowisk) → 409 z listą luk; z uzasadnieniem przechodzi
await kv.set('sched:2026-10', { shifts: WZ.shifts.map((x, i) => ({ ...x, sid: 'wz' + i, accountId: idWZ[x.name] })), roster: nazwyWZ, meta: { ym: '2026-10' }, version: 1 });
let rpP0 = await call(schedule, { method: 'POST', headers: asm, query: { action: 'publish' }, body: { month: '2026-10' } });
T('publikacja grafiku z lukami krytycznymi (zmiany > 12 h, przerwy stanowisk wg modelu) → 409 „niekompletny” z listą problemów', rpP0.code === 409 && (rpP0.body.compliance || rpP0.body.audyt) && (rpP0.body.violations || rpP0.body.problemy).length > 0);
rpP0 = await call(saH, { method: 'GET', headers: asm, query: { month: '2026-10', date: '2026-10-15' } });
T('GET /schedule-audit?month&date: problemy dnia (15.10: KANAPKI 15–18) + mapa dnia', rpP0.code === 200 && rpP0.body.problemy.some((p) => p.kod === 'LUKA_STANOWISKA' && p.station === 'KANAPKI / WRAPY' && p.od === '15:00') && rpP0.body.mapa['2026-10-15']);
rpP0 = await call(schedule, { method: 'POST', headers: asm, query: { action: 'publish' }, body: { month: '2026-10', force: true, reason: 'wersja przejściowa — poprawki w toku' } });
T('publikacja wymuszona z uzasadnieniem przechodzi i jest audytowana', rpP0.code === 200 && ((await kv.get('audit:log')) || []).some((a) => a.action === 'schedule.publish-forced-audit' || a.action === 'schedule.publish-forced'));
// odcinki w zapisie
await kv.set('sched:2026-11', { shifts: [], roster: [], meta: {}, version: 1 });
rpP0 = await call(schedule, { method: 'POST', headers: asm, query: { action: 'add' }, body: { date: '2026-11-03', name: 'KAJA GRZYBEK', start: '12:00', end: '20:00', segmenty: [{ start: '12:00', end: '17:00', station: 'KANAPKI / WRAPY' }, { start: '17:00', end: '20:00', station: 'PREP' }] } });
T('dodanie zmiany z odcinkami 12–17 KANAPKI / 17–20 PREP: zapisane segmenty, stanowisko główne z pierwszego odcinka', rpP0.code === 200 && rpP0.body.shift.segmenty.length === 2 && rpP0.body.shift.station === 'KANAPKI / WRAPY');
T('odcinki z dziurą (12–16, 17–20) → 400', (await call(schedule, { method: 'POST', headers: asm, query: { action: 'add' }, body: { date: '2026-11-04', name: 'KAJA GRZYBEK', start: '12:00', end: '20:00', segmenty: [{ start: '12:00', end: '16:00', station: 'KANAPKI / WRAPY' }, { start: '17:00', end: '20:00', station: 'PREP' }] } })).code === 400);
await kv.set('accounts:list', [{ id: 'uA', name: 'Jan Kowal', grafikName: 'KOWAL', aliasy: [], login: 'JANKOW001', funkcja: 'CREW', umowa: 'UZ', stawka: 30 }]);

console.log('— P4-03: regresja syntetycznego Actual —');
try {
  const app = readFileSync(new URL('../../rex-cloud-admin/src/App.jsx', import.meta.url), 'utf-8');
  T('brak generowania Actual z planu (±%)', !/planDaily\.map\([^)]*%\s*11/.test(app) && !app.includes('Wbicia zasymulowane'));
  T('brak Math.random w danych wykonania', !/actual[A-Za-z]*\s*=[^;]*Math\.random/.test(app));
} catch { T('App.jsx dostępny do kontroli regresji', false); }

console.log(`\nWynik: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
