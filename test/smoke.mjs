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

console.log('— DATA-04: audyt niezmienny —');
T('DELETE audytu → 405', (await call(audit, { method: 'DELETE', headers: asm, query: {} })).code === 405);

console.log('— P4-03: regresja syntetycznego Actual —');
try {
  const app = readFileSync(new URL('../../rex-cloud-admin/src/App.jsx', import.meta.url), 'utf-8');
  T('brak generowania Actual z planu (±%)', !/planDaily\.map\([^)]*%\s*11/.test(app) && !app.includes('Wbicia zasymulowane'));
  T('brak Math.random w danych wykonania', !/actual[A-Za-z]*\s*=[^;]*Math\.random/.test(app));
} catch { T('App.jsx dostępny do kontroli regresji', false); }

console.log(`\nWynik: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
