// WFM-02: dostępność i preferencje pracowników.
// avail:list = { [accountId]: {
//   wzor: { '0'..'6': { tryb: 'pelna'|'brak'|'okno', od: 'HH:MM', do: 'HH:MM', pref: ''|'rano'|'wieczor' } },
//   pending: { wzor, requestedAt } | null,        // propozycja pracownika czeka na akceptację
//   updatedAt, decidedBy
// } }
// Wzorzec zatwierdzony egzekwuje WFM-05 w schedule: 'brak' = blokada, poza oknem = ostrzeżenie.
import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit, aktor } from './audit.js';

const KEY = 'avail:list';
const TRYBY = ['pelna', 'brak', 'okno'];
const read = async () => (await kv.get(KEY)) || {};
const write = (o) => kv.set(KEY, o);

const czysc = (wzor) => {
  const out = {};
  for (let d = 0; d <= 6; d++) {
    const w = (wzor || {})[d] || (wzor || {})[String(d)] || {};
    const tryb = TRYBY.includes(w.tryb) ? w.tryb : 'pelna';
    out[d] = { tryb, od: tryb === 'okno' ? (w.od || '06:00') : null, do: tryb === 'okno' ? (w.do || '23:00') : null, pref: ['rano', 'wieczor'].includes(w.pref) ? w.pref : '' };
  }
  return out;
};

// pomocnicze dla schedule (WFM-05): zatwierdzona dostępność konta na dany dzień
export async function dostepnoscDnia(accountId, date) {
  if (!accountId || !date) return null;
  const all = await read();
  const rec = all[accountId];
  if (!rec || !rec.wzor) return null;
  return rec.wzor[new Date(date).getDay()] || null;
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });

  try {
    const sesja = await requireRole(req, res, ['asm', 'kierownik', 'pracownik']);
    if (!sesja) return;

    if (req.method === 'GET') {
      const all = await read();
      if (sesja.role === 'pracownik') return res.json({ success: true, availability: all[sesja.accountId] || null });
      const konta = (await kv.get('accounts:list')) || [];
      const lista = Object.entries(all).map(([aid, rec]) => ({ accountId: aid, name: (konta.find((k) => k.id === aid) || {}).name || aid, ...rec }));
      return res.json({ success: true, list: lista, pending: lista.filter((x) => x.pending).length });
    }

    // ── zapis wzorca ──
    if (req.method === 'PUT') {
      const b = req.body || {};
      const wzor = czysc(b.wzor);
      const all = await read();
      if (sesja.role === 'pracownik') {
        // workflow akceptacji: propozycja czeka na decyzję kierownika
        const rec = all[sesja.accountId] || { wzor: null };
        rec.pending = { wzor, requestedAt: Date.now() };
        all[sesja.accountId] = rec;
        await write(all);
        await audit({ ...aktor(sesja), action: 'availability.request', target: sesja.login });
        return res.json({ success: true, availability: rec, message: 'Propozycja dostępności czeka na akceptację kierownika.' });
      }
      // panel: ustawienie wprost (zatwierdzone)
      const accountId = b.accountId;
      if (!accountId) return res.status(400).json({ success: false, error: 'Wskaż pracownika.' });
      all[accountId] = { wzor, pending: null, updatedAt: Date.now(), decidedBy: sesja.name };
      await write(all);
      await audit({ ...aktor(sesja), action: 'availability.set', target: accountId });
      return res.json({ success: true, availability: all[accountId] });
    }

    // ── decyzja o propozycji pracownika ──
    if (req.method === 'POST') {
      if (sesja.role === 'pracownik') return res.status(403).json({ success: false, error: 'Decyzja wymaga uprawnień kierownika.' });
      const { accountId, action } = req.body || {};
      const all = await read();
      const rec = all[accountId];
      if (!rec || !rec.pending) return res.status(404).json({ success: false, error: 'Brak oczekującej propozycji.' });
      if (action === 'approve') {
        rec.wzor = rec.pending.wzor;
        rec.updatedAt = Date.now(); rec.decidedBy = sesja.name; rec.pending = null;
        await audit({ ...aktor(sesja), action: 'availability.approve', target: accountId });
      } else if (action === 'reject') {
        rec.pending = null; rec.decidedBy = sesja.name;
        await audit({ ...aktor(sesja), action: 'availability.reject', target: accountId });
      } else return res.status(400).json({ success: false, error: 'Nieznana akcja.' });
      await write(all);
      return res.json({ success: true, availability: rec });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
