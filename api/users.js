import { kv, cors } from './_helpers.js';
import crypto from 'crypto';

function hashPin(pin) {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET - list all users
    if (req.method === 'GET') {
      const userIds = await kv.smembers('users:ids') || [];
      const users = [];
      for (const id of userIds) {
        const u = await kv.get(`user:${id}`);
        if (u) users.push({ id, name: u.name, login: u.login, email: u.email, position: u.position, hourlyRate: u.hourlyRate || 0, phone: u.phone || '', address: u.address || '', createdAt: u.createdAt });
      }
      return res.json({ success: true, users });
    }

    // POST - create user
    if (req.method === 'POST') {
      const { name, login, pin, email, position, hourlyRate } = req.body;
      if (!name || !login || !pin) return res.status(400).json({ success: false, error: 'Imię, login i PIN wymagane' });

      const loginKey = login.toLowerCase().trim();
      const existing = await kv.get(`user:login:${loginKey}`);
      if (existing) return res.status(400).json({ success: false, error: 'Login już istnieje' });

      const id = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const user = {
        name, login: loginKey, pinHash: hashPin(pin.trim()),
        email: email || '', position: position || 'crew',
        hourlyRate: hourlyRate || 0, phone: '', address: '',
        createdAt: new Date().toISOString()
      };

      await kv.set(`user:${id}`, user);
      await kv.set(`user:login:${loginKey}`, id);
      await kv.sadd('users:ids', id);

      return res.json({ success: true, user: { id, name, login: loginKey, email: user.email, position: user.position, hourlyRate: user.hourlyRate } });
    }

    // PUT - update user
    if (req.method === 'PUT') {
      const { id, name, pin, email, position, hourlyRate, phone, address } = req.body;
      if (!id) return res.status(400).json({ success: false, error: 'ID wymagane' });

      const user = await kv.get(`user:${id}`);
      if (!user) return res.status(404).json({ success: false, error: 'Użytkownik nie znaleziony' });

      if (name) user.name = name;
      if (email !== undefined) user.email = email;
      if (position) user.position = position;
      if (hourlyRate !== undefined) user.hourlyRate = hourlyRate;
      if (phone !== undefined) user.phone = phone;
      if (address !== undefined) user.address = address;
      if (pin) user.pinHash = hashPin(pin.trim());

      await kv.set(`user:${id}`, user);
      return res.json({ success: true, user: { id, name: user.name, login: user.login, email: user.email, position: user.position, hourlyRate: user.hourlyRate } });
    }

    // DELETE - remove user
    if (req.method === 'DELETE') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ success: false, error: 'ID wymagane' });

      const user = await kv.get(`user:${id}`);
      if (!user) return res.status(404).json({ success: false, error: 'Użytkownik nie znaleziony' });

      await kv.del(`user:${id}`);
      await kv.del(`user:login:${user.login}`);
      await kv.srem('users:ids', id);

      return res.json({ success: true });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
