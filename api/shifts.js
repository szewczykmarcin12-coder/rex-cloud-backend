import { kv, cors } from './_helpers.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET - get shifts, optionally filtered by userId or month
    if (req.method === 'GET') {
      const { userId, month, year } = req.query;
      const allShifts = await kv.get('shifts:all') || [];

      let filtered = allShifts;
      if (userId) filtered = filtered.filter(s => s.userId === userId);
      if (month && year) {
        const prefix = `${year}-${String(parseInt(month) + 1).padStart(2, '0')}`;
        filtered = filtered.filter(s => s.date.startsWith(prefix));
      }

      return res.json({ success: true, shifts: filtered });
    }

    // POST - add or replace shift
    if (req.method === 'POST') {
      const { shift } = req.body;
      if (!shift || !shift.date || !shift.userId) return res.status(400).json({ success: false, error: 'Dane zmiany wymagane' });

      const allShifts = await kv.get('shifts:all') || [];
      const id = shift.id || `shf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const newShift = { ...shift, id, createdAt: new Date().toISOString() };

      // Remove existing shift for same user+date if replacing
      const updated = allShifts.filter(s => !(s.date === shift.date && s.userId === shift.userId));
      updated.push(newShift);

      await kv.set('shifts:all', updated);
      return res.json({ success: true, shift: newShift });
    }

    // PUT - bulk save shifts (admin scheduler)
    if (req.method === 'PUT') {
      const { shifts } = req.body;
      if (!Array.isArray(shifts)) return res.status(400).json({ success: false, error: 'Tablica zmian wymagana' });

      await kv.set('shifts:all', shifts);
      return res.json({ success: true, count: shifts.length });
    }

    // DELETE - remove a shift
    if (req.method === 'DELETE') {
      const { shiftId } = req.body;
      if (!shiftId) return res.status(400).json({ success: false, error: 'ID zmiany wymagane' });

      const allShifts = await kv.get('shifts:all') || [];
      const filtered = allShifts.filter(s => s.id !== shiftId);
      await kv.set('shifts:all', filtered);

      return res.json({ success: true });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
