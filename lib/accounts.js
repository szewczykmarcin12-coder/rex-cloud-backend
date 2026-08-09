import crypto from 'crypto';
import { kv, cors, kvConfigured } from './_helpers.js';

// Konta pracowników. Klucz accounts:list = tablica:
//   { id, name, grafikName, funkcja, umowa, stawka, zus, login, hasloHash, mustChange }
const KEY = 'accounts:list';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const stripPl = (s) => (s || '').replace(/ł/g, 'l').replace(/Ł/g, 'L').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const loginBase = (name) => { const p = stripPl(name).trim().toUpperCase().split(/\s+/); const f = (p[0] || '').replace(/[^A-Z]/g, '').slice(0, 3).padEnd(3, 'X'); const l = (p[1] || '').replace(/[^A-Z]/g, '').slice(0, 3).padEnd(3, 'X'); return f + l; };
const nextLogin = (name, list) => { const base = loginBase(name); const used = new Set(list.map((e) => e.login)); let n = 1; while (used.has(base + String(n).padStart(3, '0'))) n++; return base + String(n).padStart(3, '0'); };
const genPass = () => String(Math.floor(Math.random() * 10000)).padStart(4, '0');
const grafikOf = (name) => (name.trim().split(/\s+/).pop() || name).toUpperCase();
const safe = (a) => ({ id: a.id, name: a.name, grafikName: a.grafikName, funkcja: a.funkcja, umowa: a.umowa, stawka: a.stawka, zus: a.zus, instruktor: !!a.instruktor, login: a.login, mustChange: a.mustChange });

async function read() { return (await kv.get(KEY)) || []; }
async function write(list) { await kv.set(KEY, list); }

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });

  try {
    const action = (req.query && req.query.action) || '';
    const id = req.query && req.query.id;

    // ── logowanie / zmiana hasła (POST z action) ──
    if (req.method === 'POST' && action === 'auth') {
      const { login, haslo } = req.body || {};
      const list = await read();
      const a = list.find((x) => x.login.toLowerCase() === String(login || '').trim().toLowerCase());
      if (!a || a.hasloHash !== sha(haslo)) return res.json({ success: false, error: 'Nieprawidłowy login lub hasło' });
      return res.json({ success: true, account: safe(a) });
    }
    if (req.method === 'POST' && action === 'setpass') {
      const { login, oldHaslo, newPass } = req.body || {};
      if (!/^\d{4}$/.test(String(newPass || ''))) return res.status(400).json({ success: false, error: 'PIN musi mieć 4 cyfry' });
      const list = await read();
      const a = list.find((x) => x.login.toLowerCase() === String(login || '').trim().toLowerCase());
      if (!a || a.hasloHash !== sha(oldHaslo)) return res.json({ success: false, error: 'Nieprawidłowe hasło bieżące' });
      a.hasloHash = sha(newPass); a.mustChange = false;
      await write(list);
      return res.json({ success: true });
    }
    if (req.method === 'POST' && action === 'reset') {
      const list = await read();
      const a = list.find((x) => x.id === id);
      if (!a) return res.status(404).json({ success: false, error: 'Nie ma konta' });
      const haslo = genPass(); a.hasloHash = sha(haslo); a.mustChange = true;
      await write(list);
      return res.json({ success: true, name: a.name, login: a.login, haslo });
    }

    if (req.method === 'GET') {
      const list = await read();
      return res.json({ success: true, accounts: list.map(safe) });
    }

    if (req.method === 'POST') { // create
      const { name, funkcja, umowa, stawka, zus, instruktor } = req.body || {};
      if (!name || name.trim().split(/\s+/).length < 2) return res.status(400).json({ success: false, error: 'Podaj imię i nazwisko' });
      const list = await read();
      const login = nextLogin(name, list);
      const haslo = genPass();
      const acc = { id: 'u' + Date.now(), name: name.trim(), grafikName: grafikOf(name), funkcja: funkcja || 'CREW', umowa: umowa || 'UZ', stawka: Number(stawka) || 0, zus: (umowa === 'UOP') ? true : !!zus, instruktor: !!instruktor, login, hasloHash: sha(haslo), mustChange: true };
      list.push(acc);
      await write(list);
      return res.json({ success: true, name: acc.name, login, haslo });
    }

    if (req.method === 'PUT') { // update fields (login/hasło bez zmian)
      const patch = req.body || {};
      const list = await read();
      const a = list.find((x) => x.id === id);
      if (!a) return res.status(404).json({ success: false, error: 'Nie ma konta' });
      if (patch.name != null) { a.name = patch.name.trim(); a.grafikName = grafikOf(a.name); }
      if (patch.funkcja != null) a.funkcja = patch.funkcja;
      if (patch.umowa != null) a.umowa = patch.umowa;
      if (patch.stawka != null) a.stawka = Number(patch.stawka) || 0;
      a.zus = a.umowa === 'UOP' ? true : (patch.zus != null ? !!patch.zus : a.zus);
      if (patch.instruktor != null) a.instruktor = !!patch.instruktor;
      await write(list);
      return res.json({ success: true, account: safe(a) });
    }

    if (req.method === 'DELETE') {
      const list = await read();
      await write(list.filter((x) => x.id !== id));
      return res.json({ success: true });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
