import { kv, cors, kvConfigured } from './_helpers.js';

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

// Przeniesienie zmiany na grafiku: ten sam dzień/stanowisko/godziny, nowy właściciel
async function reassign(sw, kto) {
  const ym = (sw.date || '').slice(0, 7);
  const bucket = await kv.get(monthKey(ym));
  if (!bucket || !Array.isArray(bucket.shifts)) return false;
  let znaleziono = false;
  bucket.shifts = bucket.shifts.map((s) => {
    if (!znaleziono && normalizeName(s.name) === normalizeName(sw.requester) && s.date === sw.date &&
        s.station === sw.shift.station && s.start === sw.shift.start && s.end === sw.shift.end) {
      znaleziono = true;
      return { ...s, name: kto };
    }
    return s;
  });
  if (!Array.isArray(bucket.roster)) bucket.roster = [];
  if (!bucket.roster.some((n) => normalizeName(n) === normalizeName(kto))) bucket.roster.push(kto);
  await kv.set(monthKey(ym), bucket);
  return znaleziono;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona. W Vercel: projekt backendu → Storage → Redis (Upstash) → podłącz, a potem wdróż ponownie.' });

  try {
    if (req.method === 'GET') {
      return res.json({ success: true, swaps: await readSwaps() });
    }

    if (req.method === 'POST') {
      const { requester, shift, note } = req.body || {};
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
      const { id, action, name, volunteer } = req.body || {};
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
        if (sw.status === 'open') sw.status = 'cancelled';
      } else if (action === 'reject') {
        sw.status = 'rejected';
      } else if (action === 'approve') {
        const kto = volunteer || sw.volunteers[0];
        if (!kto) return res.status(400).json({ success: false, error: 'Brak osoby zgłoszonej' });
        const ok = await reassign(sw, kto);
        if (!ok) return res.status(409).json({ success: false, error: 'Nie znaleziono tej zmiany na grafiku (mogła się zmienić). Odśwież grafik.' });
        sw.status = 'approved';
        sw.approvedVolunteer = kto;
      } else {
        return res.status(400).json({ success: false, error: 'Nieznana akcja' });
      }

      await writeSwaps(swaps);
      return res.json({ success: true, swap: sw });
    }

    if (req.method === 'DELETE') {
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
