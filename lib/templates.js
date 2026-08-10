// Szablony tygodniowe grafiku (wzór: GIR "Plantillas de Turnos Semanales").
// Szablon = zestaw SLOTÓW (generycznych pracowników) ze zmianami wg dnia tygodnia.
// Zapis: odczytujemy realny tydzień z grafiku i anonimizujemy osoby do slotów
// (z podpowiedzią, kto pełnił slot ostatnio). Aplikacja: sloty → wskazane osoby,
// zmiany trafiają do właściwych miesięcy (tydzień może przechodzić przez granicę).
import { kv, cors, kvConfigured } from './_helpers.js';

const KEY = 'tpl:data';
const INDEX_KEY = 'sched:index';
const monthKey = (ym) => `sched:${ym}`;
const normalizeName = (n) => String(n || '').trim().toUpperCase()
  .replace(/Ą/g, 'A').replace(/Ć/g, 'C').replace(/Ę/g, 'E').replace(/Ł/g, 'L')
  .replace(/Ń/g, 'N').replace(/Ó/g, 'O').replace(/Ś/g, 'S').replace(/Ż/g, 'Z').replace(/Ź/g, 'Z')
  .replace(/\s+/g, ' ');
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const godziny = (start, end) => { const [h1, m1] = start.split(':').map(Number); const [h2, m2] = end.split(':').map(Number); let a = h1 * 60 + m1, b = h2 * 60 + m2; if (b <= a) b += 1440; return (b - a) / 60; };

async function wczytajKonta() { try { return (await kv.get('accounts:list')) || []; } catch (e) { return []; } }
function mapaNazw(konta) {
  const m = new Map();
  konta.forEach((a) => [a.grafikName, ...(a.aliasy || [])].filter(Boolean).forEach((n) => m.set(normalizeName(n), a.id)));
  konta.forEach((a) => { const k = normalizeName(a.name || ''); if (k && !m.has(k)) m.set(k, a.id); });
  return m;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });

  try {
    const db = (await kv.get(KEY)) || { list: [] };

    if (req.method === 'GET') return res.json({ success: true, templates: db.list.map((t) => ({ id: t.id, name: t.name, notes: t.notes, createdAt: t.createdAt, sloty: t.sloty.length, zmian: t.sloty.reduce((a, s) => a + s.shifts.length, 0), godzin: t.sloty.reduce((a, s) => a + s.shifts.reduce((x, y) => x + y.hours, 0), 0) })) });

    if (req.method === 'DELETE') {
      const { id } = req.query || {};
      const przed = db.list.length;
      db.list = db.list.filter((t) => t.id !== id);
      await kv.set(KEY, db);
      return res.json({ success: true, usuniete: przed - db.list.length });
    }

    // POST ?action=save {weekStart, name, notes} — zapisz tydzień z grafiku jako szablon
    if (req.method === 'POST' && req.query && req.query.action === 'save') {
      const { weekStart, name, notes } = req.body || {};
      if (!weekStart || !name) return res.status(400).json({ success: false, error: 'Wymagane: tydzień i nazwa szablonu' });
      const dni = Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(d.getDate() + i); return ymd(d); });
      const miesiace = [...new Set(dni.map((d) => d.slice(0, 7)))];
      let zmiany = [];
      for (const ym of miesiace) {
        const m = await kv.get(monthKey(ym));
        if (m) zmiany = zmiany.concat((m.shifts || []).filter((s) => dni.includes(s.date)));
      }
      if (!zmiany.length) return res.status(400).json({ success: false, error: 'Ten tydzień nie ma żadnych zmian w grafiku' });

      // grupowanie po osobie -> sloty generyczne (z podpowiedzią ostatniego wykonawcy)
      const wgOsoby = {};
      zmiany.forEach((s) => { const k = normalizeName(s.name); (wgOsoby[k] = wgOsoby[k] || []).push(s); });
      const sloty = Object.entries(wgOsoby).map(([k, arr], i) => {
        const stacje = [...new Set(arr.map((s) => s.station))];
        return {
          id: 's' + (i + 1),
          label: `SLOT ${String(i + 1).padStart(2, '0')} (${stacje.join('/') || '—'})`,
          hint: arr[0].name,
          hintAccountId: arr.find((s) => s.accountId)?.accountId || null,
          shifts: arr.map((s) => ({ dow: new Date(s.date).getDay(), station: s.station, start: s.start, end: s.end, hours: s.hours != null ? Number(s.hours) : godziny(s.start, s.end) })),
        };
      }).sort((a, b) => b.shifts.reduce((x, y) => x + y.hours, 0) - a.shifts.reduce((x, y) => x + y.hours, 0));

      const t = { id: 'tpl' + Date.now(), name: String(name).trim(), notes: String(notes || '').trim(), createdAt: new Date().toISOString(), zrodloTydzien: weekStart, sloty };
      db.list.push(t);
      await kv.set(KEY, db);
      return res.json({ success: true, template: { id: t.id, name: t.name, sloty: sloty.length, zmian: zmiany.length } });
    }

    // GET-like: POST ?action=detail {id} — pełny szablon (sloty do przypisania)
    if (req.method === 'POST' && req.query && req.query.action === 'detail') {
      const t = db.list.find((x) => x.id === (req.body || {}).id);
      if (!t) return res.status(404).json({ success: false, error: 'Nie znaleziono szablonu' });
      return res.json({ success: true, template: t });
    }

    // POST ?action=apply {id, weekStart, przypisania: {slotId: {name, accountId?}}}
    if (req.method === 'POST' && req.query && req.query.action === 'apply') {
      const { id, weekStart, przypisania } = req.body || {};
      const t = db.list.find((x) => x.id === id);
      if (!t) return res.status(404).json({ success: false, error: 'Nie znaleziono szablonu' });
      if (!weekStart) return res.status(400).json({ success: false, error: 'Wybierz tydzień docelowy' });
      const konta = await wczytajKonta();
      const mapa = mapaNazw(konta);

      const dodane = [];
      for (const slot of t.sloty) {
        const p = (przypisania || {})[slot.id];
        if (!p || !p.name) continue;                                  // slot pominięty
        const osoba = String(p.name).trim().toUpperCase();
        const idKonta = p.accountId || mapa.get(normalizeName(osoba)) || null;
        for (const sh of slot.shifts) {
          const d = new Date(weekStart); d.setDate(d.getDate() + ((sh.dow + 6) % 7));   // pon=+0 … nd=+6
          dodane.push({ date: ymd(d), name: osoba, station: sh.station, start: sh.start, end: sh.end, hours: sh.hours, dodana: true, tpl: t.id, ...(idKonta ? { accountId: idKonta } : {}) });
        }
      }
      if (!dodane.length) return res.status(400).json({ success: false, error: 'Żaden slot nie ma przypisanej osoby' });

      // zapis per miesiąc (tydzień może przechodzić przez granicę miesiąca)
      const wgYm = {};
      dodane.forEach((s) => { const ym = s.date.slice(0, 7); (wgYm[ym] = wgYm[ym] || []).push(s); });
      const idx = (await kv.get(INDEX_KEY)) || [];
      for (const [ym, arr] of Object.entries(wgYm)) {
        const m = (await kv.get(monthKey(ym))) || { shifts: [], roster: [], meta: { ym } };
        m.shifts = [...(m.shifts || []), ...arr];
        arr.forEach((s) => { if (!(m.roster || []).some((r) => normalizeName(r) === normalizeName(s.name))) m.roster = [...(m.roster || []), s.name]; });
        await kv.set(monthKey(ym), m);
        if (!idx.includes(ym)) idx.push(ym);
      }
      await kv.set(INDEX_KEY, idx.sort());
      return res.json({ success: true, dodane, tygodnie: Object.keys(wgYm) });
    }

    return res.status(405).json({ success: false, error: 'Nieobsługiwana metoda' });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Błąd serwera: ' + e.message });
  }
}
