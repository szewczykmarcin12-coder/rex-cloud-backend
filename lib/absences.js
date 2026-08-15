// WFM-03: absencje i urlopy z akceptacją.
// absences:list = [{ id, accountId, name, login, type, from, to, reason,
//                    status: 'open'|'approved'|'rejected'|'cancelled',
//                    createdAt, decidedBy, decidedAt }]
// Typy: 'urlop' (wypoczynkowy), 'uz' (urlop na żądanie), 'l4' (zwolnienie), 'inne'
import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit, aktor } from './audit.js';

const KEY = 'absences:list';
const TYPY = ['urlop', 'uz', 'l4', 'inne'];
const read = async () => (await kv.get(KEY)) || [];
const write = (l) => kv.set(KEY, l);
const dataOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

// WFM-05: czy konto ma zatwierdzoną absencję pokrywającą dzień (używane przez schedule)
export async function absencjaZatwierdzona(accountId, date) {
  if (!accountId || !date) return null;
  const list = await read();
  return list.find((a) => a.accountId === accountId && a.status === 'approved' && a.from <= date && date <= a.to) || null;
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });

  try {
    const sesja = await requireRole(req, res, ['asm', 'kierownik', 'pracownik']);
    if (!sesja) return;

    // ── lista: pracownik własne, panel wszystkie ──
    if (req.method === 'GET') {
      const list = await read();
      if (sesja.role === 'pracownik') return res.json({ success: true, absences: list.filter((a) => a.accountId === sesja.accountId) });
      return res.json({ success: true, absences: list });
    }

    // ── nowy wniosek ──
    if (req.method === 'POST') {
      const b = req.body || {};
      const type = TYPY.includes(b.type) ? b.type : 'urlop';
      if (!dataOk(b.from) || !dataOk(b.to) || b.to < b.from) return res.status(400).json({ success: false, error: 'Podaj poprawny zakres dat (od–do).' });
      // pracownik składa wyłącznie we własnym imieniu; panel może wpisać za pracownika
      const accountId = sesja.role === 'pracownik' ? sesja.accountId : (b.accountId || null);
      if (!accountId) return res.status(400).json({ success: false, error: 'Wskaż pracownika.' });
      const konta = (await kv.get('accounts:list')) || [];
      const konto = konta.find((k) => k.id === accountId);
      if (!konto) return res.status(404).json({ success: false, error: 'Nie znaleziono konta pracownika.' });
      const list = await read();
      if (list.some((a) => a.accountId === accountId && ['open', 'approved'].includes(a.status) && a.from <= b.to && b.from <= a.to)) {
        return res.status(409).json({ success: false, error: 'Ten zakres nakłada się na istniejący wniosek lub zatwierdzoną absencję.' });
      }
      const wn = {
        id: 'ab' + Date.now() + Math.random().toString(36).slice(2, 6),
        accountId, name: konto.name, login: konto.login,
        type, from: b.from, to: b.to, reason: String(b.reason || '').trim(),
        status: sesja.role === 'pracownik' ? 'open' : 'approved',            // wpis z panelu = od razu zatwierdzony
        createdAt: Date.now(),
        decidedBy: sesja.role === 'pracownik' ? null : sesja.name,
        decidedAt: sesja.role === 'pracownik' ? null : Date.now(),
      };
      list.unshift(wn);
      await write(list);
      await audit({ ...aktor(sesja), action: 'absence.create', target: `${konto.login} ${b.from}→${b.to}`, after: { type, status: wn.status } });
      return res.json({ success: true, absence: wn });
    }

    // ── decyzje ──
    if (req.method === 'PUT') {
      const { id, action } = req.body || {};
      const list = await read();
      const a = list.find((x) => x.id === id);
      if (!a) return res.status(404).json({ success: false, error: 'Nie znaleziono wniosku.' });

      if (action === 'cancel') {
        if (sesja.role === 'pracownik' && a.accountId !== sesja.accountId) return res.status(403).json({ success: false, error: 'Można wycofać tylko własny wniosek.' });
        if (a.status !== 'open') return res.status(409).json({ success: false, error: 'Wniosek nie jest już otwarty.' });
        a.status = 'cancelled';
      } else if (action === 'approve' || action === 'reject') {
        if (sesja.role === 'pracownik') return res.status(403).json({ success: false, error: 'Decyzja wymaga uprawnień kierownika.' });
        if (a.status !== 'open') return res.status(409).json({ success: false, error: 'Wniosek został już rozpatrzony.' });
        a.status = action === 'approve' ? 'approved' : 'rejected';
        a.decidedBy = sesja.name; a.decidedAt = Date.now();
        await audit({ ...aktor(sesja), action: `absence.${action}`, target: `${a.login} ${a.from}→${a.to}`, after: { type: a.type } });
      } else return res.status(400).json({ success: false, error: 'Nieznana akcja.' });

      await write(list);
      return res.json({ success: true, absence: a });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
