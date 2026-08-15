import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import crypto from 'crypto';
import { audit, aktor } from './audit.js';

// ── P4-02: serwerowa maszyna stanów tygodnia ──
const wtMonday = (ds) => { const d = new Date(ds + 'T00:00:00Z'); const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); return d.toISOString().slice(0, 10); };
// mapa sid → data (do ustalenia tygodnia wpisu wykonania kluczowanego po sid)
async function mapaSidData() {
  const idx = (await kv.get('sched:index')) || [];
  const m = {};
  for (const ym of idx) { const b = await kv.get(`sched:${ym}`); ((b && b.shifts) || []).forEach((x) => { if (x.sid) m[`sid:${x.sid}`] = x.date; }); }
  return m;
}
const dataKlucza = (key, sidMap) => key.startsWith('sid:') ? (sidMap[key] || null) : (String(key).split('|')[1] || null);

// Czas pracy (Working Time) — jeden klucz ts:data:
//   { actuals: { [shiftKey]: { start, end, breaks:[{type,platna,start,end}] } },
//     completed: { [YYYY-MM-DD]: true },
//     weekStatus: { [YYYY-MM-DD(monday)]: { reviewed, closed } } }
const KEY = 'ts:data';
const EMPTY = { actuals: {}, completed: {}, weekStatus: {} };

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona. W Vercel: projekt backendu → Storage → Redis (Upstash) → podłącz, a potem wdróż ponownie.' });

  try {
    // WFM-10: payroll — JEDNA funkcja płatnych minut (identyczna z ekranem Actual):
    // netto = czas Actual − przerwy niepłatne; liczone wyłącznie ze zmian z realnym wykonaniem.
    if (req.method === 'GET' && req.query && req.query.action === 'payroll') {
      // P0-1 (audyt P4): payroll poza sandboksem wyłączony do czasu zamknięcia fundamentów.
      if (process.env.PAYROLL_ENABLED !== 'true') {
        return res.status(403).json({ success: false, error: 'Eksport payroll jest wyłączony (tryb sandbox). Właściciel może go włączyć zmienną PAYROLL_ENABLED=true po przejściu bram jakości G1-G6.' });
      }
      const s = await requireRole(req, res, ['asm']);
      if (!s) return;
      const week = String(req.query.week || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return res.status(400).json({ success: false, error: 'Podaj poniedziałek tygodnia (YYYY-MM-DD).' });
      const d0 = (await kv.get(KEY)) || EMPTY;
      const st = (d0.weekStatus || {})[week] || {};
      if (!st.closed) return res.status(409).json({ success: false, error: 'Tydzień nie jest zamknięty (CLOSED) — payroll eksportuje wyłącznie zamknięte okresy.' });

      const dni = Array.from({ length: 7 }, (_, i) => { const d = new Date(week); d.setDate(d.getDate() + i); return d.toISOString().slice(0, 10); });
      const yms = [...new Set(dni.map((x) => x.slice(0, 7)))];
      let zmiany = [];
      for (const ym of yms) { const m = await kv.get(`sched:${ym}`); if (m) zmiany = zmiany.concat((m.shifts || []).filter((x) => dni.includes(x.date))); }
      zmiany = zmiany.filter((x) => x.rola !== 'instruktor' && String(x.station || '').toUpperCase() !== 'INSTRUKTOR');

      const toMin = (t) => { const [h, mm] = String(t || '0:0').split(':').map(Number); return h * 60 + (mm || 0); };
      const dur = (a, b) => { let x = toMin(b) - toMin(a); if (x <= 0) x += 1440; return x; };
      const klucz = (x) => x.sid ? `sid:${x.sid}` : `${x.name}|${x.date}|${x.station}|${x.start}|${x.end}`;
      const kluczLegacy = (x) => `${x.name}|${x.date}|${x.station}|${x.start}|${x.end}`;
      const actuals = d0.actuals || {};
      const netMin = (a) => dur(a.start, a.end) - (a.breaks || []).filter((b) => b.platna === false).reduce((x, b) => x + dur(b.start != null ? b.start : b.od, b.end != null ? b.end : b.do), 0);

      const konta = (await kv.get('accounts:list')) || [];
      const wiersze = {};
      for (const z of zmiany) {
        const rec = actuals[klucz(z)] || actuals[kluczLegacy(z)];
        const kid = z.accountId || `n:${String(z.name || '').toUpperCase()}`;
        const konto = z.accountId ? konta.find((k) => k.id === z.accountId) : null;
        const w = wiersze[kid] || (wiersze[kid] = { login: konto ? konto.login : '', name: konto ? konto.name : z.name, umowa: konto ? konto.umowa : null, stawka: konto ? Number(konto.stawka) || 0 : 0, zmian: 0, zmianBezOdbic: 0, minPlan: 0, minPaid: 0 });
        w.zmian++;
        w.minPlan += dur(z.start, z.end);
        if (rec) w.minPaid += Math.max(netMin(rec), 0); else w.zmianBezOdbic++;   // R-04: bez wykonania nie ma płatnych minut
      }
      const rows = Object.values(wiersze).map((w) => ({ ...w, hPaid: Math.round(w.minPaid / 60 * 100) / 100, koszt: w.umowa === 'UZ' ? Math.round(w.minPaid / 60 * w.stawka * 100) / 100 : null })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const suma = { minPaid: rows.reduce((a, w) => a + w.minPaid, 0), zmian: rows.reduce((a, w) => a + w.zmian, 0), bezOdbic: rows.reduce((a, w) => a + w.zmianBezOdbic, 0) };

      // Kontrakt eksportu (audyt P4): stabilny UUID, wersja, suma kontrolna; te same dane → ten sam hash.
      const kanonicznie = JSON.stringify({ week, rows });
      const hash = crypto.createHash('sha256').update(kanonicznie).digest('hex');
      const historiaKey = 'payroll:exports';
      const historia = (await kv.get(historiaKey)) || [];
      const wersjaEksportu = historia.filter((h) => h.week === week).length + 1;
      const exportId = crypto.randomUUID();
      historia.unshift({ exportId, week, wersja: wersjaEksportu, hash, at: new Date().toISOString(), by: s.name, osob: rows.length, minPaid: suma.minPaid, format: req.query.format || 'json' });
      if (historia.length > 500) historia.length = 500;
      await kv.set(historiaKey, historia);
      await audit({ ...aktor(s), action: 'payroll.export', target: `${week} v${wersjaEksportu}`, after: { exportId, hash, osob: rows.length, minPaid: suma.minPaid, format: req.query.format || 'json' } });

      if (req.query.format === 'csv') {
        // P4-09: neutralizacja CSV injection — komórki zaczynające się od = + - @ TAB CR
        const esc = (v) => { let x = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(x)) x = "'" + x; return `"${x.replace(/"/g, '""')}"`; };
        const csv = '\uFEFF' + [
          [`# payroll ${week} · wersja ${wersjaEksportu} · export ${exportId} · sha256 ${hash}`].join(';'),
          ['Login', 'Pracownik', 'Umowa', 'Stawka', 'Zmiany', 'Bez odbić', 'Minuty płatne', 'Godziny płatne', 'Koszt (UZ)'].join(';'),
          ...rows.map((w) => [w.login, w.name, w.umowa || '', w.stawka || '', w.zmian, w.zmianBezOdbic, w.minPaid, String(w.hPaid).replace('.', ','), w.koszt != null ? String(w.koszt).replace('.', ',') : ''].map(esc).join(';')),
          ['', 'RAZEM', '', '', suma.zmian, suma.bezOdbic, suma.minPaid, String(Math.round(suma.minPaid / 60 * 100) / 100).replace('.', ','), ''].map(esc).join(';'),
        ].join('\r\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="payroll_${week}_v${wersjaEksportu}.csv"`);
        return res.status(200).send(csv);
      }
      return res.json({ success: true, week, exportId, wersja: wersjaEksportu, hash, closedBy: st.closedBy || null, rows, suma });
    }

    if (req.method === 'GET') {
      if (!(await requireRole(req, res, ['asm', 'kierownik']))) return;
      const d = (await kv.get(KEY)) || EMPTY;
      return res.json({ success: true, actuals: d.actuals || {}, completed: d.completed || {}, weekStatus: d.weekStatus || {} });
    }

    // P4-02/TNA-06: zamknięcie i otwarcie tygodnia to JAWNE akcje serwera (nie flaga od klienta)
    if (req.method === 'POST' && req.query && req.query.action === 'close-week') {
      const s = await requireRole(req, res, ['asm', 'kierownik']);
      if (!s) return;
      const week = String((req.body || {}).week || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return res.status(400).json({ success: false, error: 'Podaj poniedziałek tygodnia.' });
      const d = (await kv.get(KEY)) || EMPTY;
      const st = (d.weekStatus || {})[week] || {};
      if (st.closed) return res.status(409).json({ success: false, error: 'Tydzień jest już zamknięty.' });
      d.weekStatus = { ...(d.weekStatus || {}), [week]: { reviewed: true, closed: true, closedBy: s.name, closedAt: new Date().toISOString() } };
      await kv.set(KEY, d);
      await audit({ ...aktor(s), action: 'timesheet.close', target: week, reason: 'blokada okresu (akcja serwera)' });
      return res.json({ success: true, week, weekStatus: d.weekStatus[week] });
    }
    if (req.method === 'POST' && req.query && req.query.action === 'reopen-week') {
      const s = await requireRole(req, res, ['asm']);                     // ponowne otwarcie: wyłącznie ASM
      if (!s) return;
      const week = String((req.body || {}).week || '');
      const powod = String((req.body || {}).reason || '').trim();
      if (!powod) return res.status(400).json({ success: false, error: 'Ponowne otwarcie zamkniętego tygodnia wymaga powodu.' });
      const d = (await kv.get(KEY)) || EMPTY;
      const st = (d.weekStatus || {})[week];
      if (!st || !st.closed) return res.status(409).json({ success: false, error: 'Ten tydzień nie jest zamknięty.' });
      d.weekStatus = { ...(d.weekStatus || {}), [week]: { ...st, closed: false, reopenedBy: s.name, reopenedAt: new Date().toISOString() } };
      await kv.set(KEY, d);
      await audit({ ...aktor(s), action: 'timesheet.reopen', target: week, reason: powod });
      return res.json({ success: true, week, weekStatus: d.weekStatus[week] });
    }

    if (req.method === 'PUT') {
      const s = await requireRole(req, res, ['asm', 'kierownik']);
      if (!s) return;
      const { data } = req.body || {};
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return res.status(400).json({ success: false, error: 'Nieprawidłowe dane czasu pracy' });
      }
      const next = {
        actuals: data.actuals && typeof data.actuals === 'object' ? data.actuals : {},
        completed: data.completed && typeof data.completed === 'object' ? data.completed : {},
        weekStatus: data.weekStatus && typeof data.weekStatus === 'object' ? data.weekStatus : {},
      };

      // ── P4-02: serwer ODRZUCA modyfikacje zamkniętych tygodni i zmiany flagi closed przez PUT ──
      const staryStan = (await kv.get(KEY)) || EMPTY;
      const zamkniete = Object.entries(staryStan.weekStatus || {}).filter(([, v]) => v && v.closed).map(([k]) => k);
      for (const ws of new Set([...Object.keys(staryStan.weekStatus || {}), ...Object.keys(next.weekStatus)])) {
        const przedC = !!(((staryStan.weekStatus || {})[ws]) || {}).closed;
        const poC = !!((next.weekStatus[ws]) || {}).closed;
        if (przedC !== poC) return res.status(409).json({ success: false, error: `Stan CLOSED tygodnia ${ws} zmienia wyłącznie serwer — użyj akcji close-week / reopen-week.` });
      }
      if (zamkniete.length) {
        const sidMap = await mapaSidData();
        const wZamknietym = (klucz) => { const dt = dataKlucza(klucz, sidMap); return dt ? zamkniete.includes(wtMonday(dt)) : false; };
        const sA = staryStan.actuals || {};
        for (const k of new Set([...Object.keys(sA), ...Object.keys(next.actuals)])) {
          if (JSON.stringify(sA[k]) !== JSON.stringify(next.actuals[k]) && wZamknietym(k)) {
            return res.status(409).json({ success: false, error: `Tydzień ${wtMonday(dataKlucza(k, sidMap))} jest zamknięty (CLOSED) — korekta wymaga ponownego otwarcia przez ASM z podaniem powodu.` });
          }
        }
        const sC = staryStan.completed || {};
        for (const dt of new Set([...Object.keys(sC), ...Object.keys(next.completed)])) {
          if (!!sC[dt] !== !!next.completed[dt] && zamkniete.includes(wtMonday(dt))) {
            return res.status(409).json({ success: false, error: `Dzień ${dt} należy do zamkniętego tygodnia — najpierw otwórz tydzień (ASM).` });
          }
        }
      }
      // audyt: porównanie z poprzednim stanem (ile wpisów wykonania przybyło/zmieniono/ubyło)
      const stary = staryStan;
      const sA = stary.actuals || {}, nA = next.actuals;
      const dodane = Object.keys(nA).filter((k) => !(k in sA)).length;
      const zmienione = Object.keys(nA).filter((k) => k in sA && JSON.stringify(nA[k]) !== JSON.stringify(sA[k])).length;
      const usuniete = Object.keys(sA).filter((k) => !(k in nA)).length;
      // TNA-06: zamknięcie/otwarcie tygodnia z podpisem aktora w audycie
      for (const ws of Object.keys(next.weekStatus || {})) {
        const n = next.weekStatus[ws] || {}, o = (stary.weekStatus || {})[ws] || {};
        if (n.closed && !o.closed) await audit({ ...aktor(s), action: 'timesheet.close', target: ws, reason: 'blokada okresu' });
        if (!n.closed && o.closed) await audit({ ...aktor(s), action: 'timesheet.reopen', target: ws });
        if (n.reviewed && !o.reviewed) await audit({ ...aktor(s), action: 'timesheet.review', target: ws });
      }
      await kv.set(KEY, next);
      if (dodane || zmienione || usuniete) await audit({ ...aktor(s), action: 'timesheet.write', target: 'ts:data', after: { dodane, zmienione, usuniete } });
      return res.json({ success: true });
    }

    if (req.method === 'DELETE') {
      if (!(await requireRole(req, res, ['asm']))) return;
      await kv.set(KEY, EMPTY);
      return res.json({ success: true });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
