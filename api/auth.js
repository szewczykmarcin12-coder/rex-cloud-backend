import { kv, cors } from './_helpers.js';
import crypto from 'crypto';

function hashPin(pin) {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // POST /api/auth - login
  if (req.method === 'POST') {
    const { login, pin, role } = req.body;
    if (!login || !pin) return res.status(400).json({ success: false, error: 'Login i PIN wymagane' });

    try {
      // Admin login
      if (role === 'admin') {
        const admin = await kv.get('admin:credentials');
        if (!admin) {
          // First-time setup: create default admin
          const defaultAdmin = { login: 'admin', pinHash: hashPin('1234'), name: 'Administrator' };
          await kv.set('admin:credentials', defaultAdmin);
          if (login === 'admin' && pin === '1234') {
            return res.json({ success: true, user: { name: 'Administrator', role: 'admin' } });
          }
          return res.status(401).json({ success: false, error: 'Nieprawidłowy login lub PIN' });
        }
        if (admin.login === login && admin.pinHash === hashPin(pin)) {
          return res.json({ success: true, user: { name: admin.name || 'Administrator', role: 'admin' } });
        }
        return res.status(401).json({ success: false, error: 'Nieprawidłowy login lub PIN' });
      }

      // Employee login
      const userId = await kv.get(`user:login:${login.toLowerCase().trim()}`);
      if (!userId) return res.status(401).json({ success: false, error: 'Nieprawidłowy login lub PIN' });

      const user = await kv.get(`user:${userId}`);
      if (!user) return res.status(401).json({ success: false, error: 'Użytkownik nie istnieje' });

      if (user.pinHash !== hashPin(pin.trim())) {
        return res.status(401).json({ success: false, error: 'Nieprawidłowy login lub PIN' });
      }

      return res.json({
        success: true,
        user: {
          id: userId,
          name: user.name,
          email: user.email,
          position: user.position,
          initials: user.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase(),
          hourlyRate: user.hourlyRate || 0,
          phone: user.phone || '',
          address: user.address || '',
          role: 'employee'
        }
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
}
