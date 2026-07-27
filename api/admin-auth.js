import { kv, cors, kvConfigured } from './_helpers.js';
import crypto from 'crypto';

function hashPin(pin) {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona. W Vercel: projekt backendu → Storage → Redis (Upstash) → podłącz, a potem wdróż ponownie (vercel --prod).' });

  if (req.method === 'POST') {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ success: false, error: 'PIN wymagany' });

    try {
      let admin = await kv.get('admin:pin');
      if (!admin) {
        // First run: set default admin PIN = 1234
        admin = hashPin('1234');
        await kv.set('admin:pin', admin);
      }
      if (hashPin(pin.trim()) === admin) {
        return res.json({ success: true });
      }
      return res.status(401).json({ success: false, error: 'Nieprawidłowy PIN' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // PUT - change admin PIN (must supply current + new)
  if (req.method === 'PUT') {
    const { currentPin, newPin } = req.body;
    if (!currentPin || !newPin) return res.status(400).json({ success: false, error: 'Podaj obecny i nowy PIN' });
    try {
      const admin = await kv.get('admin:pin') || hashPin('1234');
      if (hashPin(currentPin.trim()) !== admin) return res.status(401).json({ success: false, error: 'Nieprawidłowy obecny PIN' });
      await kv.set('admin:pin', hashPin(newPin.trim()));
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
}
