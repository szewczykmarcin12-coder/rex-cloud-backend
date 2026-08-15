import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit, aktor } from './audit.js';

// Giełda zamian — wszystkie prośby pod jednym kluczem swaps:data (tablica)
// swap = { id, requester, date, shift:{date,start,end,station,hours}, note,
//          status:'open'|'approved'|'rejected'|'cancelled', volunteers:[], approvedVolunteer, createdAt }
const KEY = 'swaps:data';
const monthKey = (ym) => `sched:${ym}`;

function normalizeName(name) {
  if (!name) return '';
  return name.toString().trim().toUpperCase().replace(/\s+/g, ' ')
    .replace(/Ą/g, 'A').replace(/Ć/g, 'C').replace(/Ę/g, 'E').replace(/Ł/g, 'L')
    .replace(/Ń/g, 'N').replace(/Ó/g, 'O').replace(/Ś/g, 'S').replace(/Ź/g, 'Z').replace(/Ż/g, 'Z');
}

const readSwaps = async () => (await kv.get(KEY)) || [];
const writeSwaps = (arr) => kv.set(KEY, arr);

// COR-01: przeniesienie zmiany zmienia właściciela RAZEM z accountId (assignment
// wskazuje nową osobę, poprzednia przestaje widzieć zmianę, historia w audycie).
async function reassign(sw, kto) {
  const ym = (sw.date || '').slice(0, 7);
  const bucket = await kv.get(monthKey(ym));
  if (!bucket || !Array.isArray(bucket.shifts)) return null;
  const konta = (await kv.get('accounts:list')) || [];
  const noweKonto = konta.find((a) => [a.grafikName, ...(a.aliasy || []), a.name].filter(Boolean).some((n) => normalizeName(n) === normalizeName(kto)));
  let przed = null, po = null;
  bucket.shifts = bucket.shifts.map((s) => {
    if (!przed && normalizeName(s.name) === normalizeName(sw.requester) && s.date === sw.date &&
        s.station === sw.shift.station && s.start === sw.shift.start && s.end === sw.shift.end) {
      przed = s;
      po = { ...s, name: kto };
      if (noweKonto) po.accountId = noweKonto.id; else delete po.accountId;   // bez konta = jawnie nieprzypisana
      return po;
    }
    return s;
  });
  if (!przed) return null;
  if (!Array.isArray(bucket.roster)) bucket.roster = [];
  if (!bucket.roster.some((n) => normalizeName(n) === normalizeName(kto))) bucket.roster.push(kto);
  bucket.version = (bucket.version || 0) + 1;                                  // DATA-03
  bucket.meta = { ...(bucket.meta || {}), version: bucket.version };
  await kv.set(monthKey(ym), bucket);
  return { przed, po, noweKontoId: (noweKonto && noweKonto.id) || null };
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona. W Vercel: projekt backendu → Storage → Redis (Upstash) → podłącz, a potem wdróż ponownie.' });

  try {
    if (req.method === 'GET') {
      if (!(await requireRole(req, res, ['asm', 'kierownik', 'pracownik']))) return;
      return res.json({ success: true, swaps: await readSwaps() });
    }

    if (req.method === 'POST') {
      const sesja = await requireRole(req, res, ['asm', 'kierownik', 'pracownik']);
      if (!sesja) return;
      let { requester, shift, note } = req.body || {};
      if (sesja.role === 'pracownik') requester = sesja.grafikName || sesja.name;   // tylko własna zmiana
      if (!requester || !shift || !shift.date || !shift.station) {
        return res.status(400).json({ success: false, error: 'Brak danych prośby (pracownik i zmiana)' });
      }
      const swaps = await readSwaps();
      // nie duplikuj otwartej prośby o tę samą zmianę
      const dup = swaps.find((s) => s.status === 'open' && normalizeName(s.requester) === normalizeName(requester) &&
        s.shift.date === shift.date && s.shift.station === shift.station && s.shift.start === shift.start && s.shift.end === shift.end);
      if (dup) return res.status(409).json({ success: false, error: 'Ta zmiana jest już wystawiona' });
      const swap = {
        id: 'sw' + Date.now() + Math.random().toString(36).slice(2, 6),
        requester, date: shift.date, shift, note: note || '',
        status: 'open', volunteers: [], approvedVolunteer: null, createdAt: Date.now(),
      };
      swaps.unshift(swap);
      await writeSwaps(swaps);
      return res.json({ success: true, swap });
    }

    if (req.method === 'PUT') {
      const sesja = await requireRole(req, res, ['asm', 'kierownik', 'pracownik']);
      if (!sesja) return;
      let { id, action, name, volunteer } = req.body || {};
      const wlasna = sesja.grafikName || sesja.name;
      if (sesja.role === 'pracownik') {
        if (action === 'volunteer' || action === 'unvolunteer') name = wlasna;      // zgłoszenie tylko we własnym imieniu
        else if (action === 'cancel') { /* dozwolone tylko dla własnej prośby — sprawdzane niżej */ }
        else return res.status(403).json({ success: false, error: 'Zatwierdzanie i odrzucanie zamian wymaga uprawnień kierownika.' });
      }
      if (!id || !action) return res.status(400).json({ success: false, error: 'Brak id lub akcji' });
      const swaps = await readSwaps();
      const sw = swaps.find((s) => s.id === id);
      if (!sw) return res.status(404).json({ success: false, error: 'Nie znaleziono prośby' });

      if (action === 'volunteer') {
        if (sw.status !== 'open') return res.status(409).json({ success: false, error: 'Prośba nie jest już otwarta' });
        if (normalizeName(sw.requester) === normalizeName(name)) return res.status(400).json({ success: false, error: 'Nie można zgłosić się do własnej zmiany' });
        if (!sw.volunteers.some((v) => normalizeName(v) === normalizeName(name))) sw.volunteers.push(name);
      } else if (action === 'unvolunteer') {
        sw.volunteers = sw.volunteers.filter((v) => normalizeName(v) !== normalizeName(name));
      } else if (action === 'cancel') {
        if (sesja.role === 'pracownik' && normalizeName(sw.requester) !== normalizeName(wlasna)) return res.status(403).json({ success: false, error: 'Można anulować tylko własną prośbę.' });
        if (sw.status === 'open') sw.status = 'cancelled';
      } else if (action === 'reject') {
        sw.status = 'rejected';
        audit({ ...aktor(sesja), action: 'swap.reject', target: sw.id, before: { requester: sw.requester, shift: sw.shift } });
      } else if (action === 'approve') {
        const kto = volunteer || sw.volunteers[0];
        if (!kto) return res.status(400).json({ success: false, error: 'Brak osoby zgłoszonej' });
        const wynik = await reassign(sw, kto);
        if (!wynik) return res.status(409).json({ success: false, error: 'Nie znaleziono tej zmiany na grafiku (mogła się zmienić). Odśwież grafik.' });
        sw.status = 'approved';
        sw.approvedVolunteer = kto;
        sw.approvedAccountId = wynik.noweKontoId;
        sw.approvedBy = (sesja && sesja.name) || null;
        sw.approvedAt = Date.now();
        audit({ ...aktor(sesja), action: 'swap.approve', target: sw.id, before: wynik.przed, after: wynik.po, reason: sw.note || null });
      } else {
        return res.status(400).json({ success: false, error: 'Nieznana akcja' });
      }

      await writeSwaps(swaps);
      return res.json({ success: true, swap: sw });
    }

    if (req.method === 'DELETE') {
      if (!(await requireRole(req, res, ['asm']))) return;
      const { id } = req.query;
      let swaps = await readSwaps();
      swaps = id ? swaps.filter((s) => s.id !== id) : [];
      await writeSwaps(swaps);
      return res.json({ success: true });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
