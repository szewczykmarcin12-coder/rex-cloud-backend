import { kv, cors } from './_helpers.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET
    if (req.method === 'GET') {
      const { userId } = req.query;
      const requests = await kv.get('requests:all') || [];
      const filtered = userId ? requests.filter(r => r.employeeId === userId) : requests;
      return res.json({ success: true, requests: filtered });
    }

    // POST - add request
    if (req.method === 'POST') {
      const { request: newReq } = req.body;
      if (!newReq) return res.status(400).json({ success: false, error: 'Dane wniosku wymagane' });

      const requests = await kv.get('requests:all') || [];
      const reqToAdd = {
        ...newReq,
        id: newReq.id || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        status: 'pending'
      };
      requests.push(reqToAdd);
      await kv.set('requests:all', requests);

      return res.json({ success: true, request: reqToAdd });
    }

    // PUT - update request status
    if (req.method === 'PUT') {
      const { requestId, updates } = req.body;
      if (!requestId) return res.status(400).json({ success: false, error: 'ID wniosku wymagane' });

      const requests = await kv.get('requests:all') || [];
      const idx = requests.findIndex(r => r.id === requestId);
      if (idx === -1) return res.status(404).json({ success: false, error: 'Wniosek nie znaleziony' });

      requests[idx] = { ...requests[idx], ...updates, updatedAt: new Date().toISOString() };
      await kv.set('requests:all', requests);

      return res.json({ success: true, request: requests[idx] });
    }

    // DELETE
    if (req.method === 'DELETE') {
      const { requestId } = req.body;
      if (!requestId) return res.status(400).json({ success: false, error: 'ID wniosku wymagane' });

      const requests = await kv.get('requests:all') || [];
      const filtered = requests.filter(r => r.id !== requestId);
      await kv.set('requests:all', filtered);

      return res.json({ success: true });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
