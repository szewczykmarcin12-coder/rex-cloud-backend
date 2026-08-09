import { kv, cors, kvConfigured } from './_helpers.js';
import crypto from 'crypto';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Dwie role:
//  - kierownik zmiany: PIN (admin:pin, domyślnie 123456) -> dostęp tylko do wydruku
//  - ASM: login (asm:login, domyślnie "asm") + hasło (asm:pass, domyślnie "asm12345") -> pełny dostęp
async function ensureDefaults() {
  if (!(await kv.get('admin:pin'))) await kv.set('admin:pin', sha('123456'));
  if (!(await kv.get('asm:pass'))) await kv.set('asm:pass', sha('asm12345'));
  if (!(await kv.get('asm:login'))) await kv.set('asm:login', 'asm');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona. W Vercel: projekt backendu → Storage → Redis (Upstash) → podłącz, a potem wdróż ponownie.' });

  try {
    await ensureDefaults();

    // GET — podaj aktualny login ASM (bez hasła), do podpowiedzi w ustawieniach
    if (req.method === 'GET') {
      const asmLogin = await kv.get('asm:login');
      return res.json({ success: true, asmLogin });
    }

    // POST — logowanie
    if (req.method === 'POST') {
      const { pin, login, password } = req.body || {};

      // logowanie ASM (login + hasło) → pełny dostęp
      if (login != null && password != null) {
        const asmLogin = await kv.get('asm:login');
        const asmPass = await kv.get('asm:pass');
        if (String(login).trim().toLowerCase() === String(asmLogin).toLowerCase() && sha(String(password)) === asmPass) {
          return res.json({ success: true, role: 'asm' });
        }
        return res.status(401).json({ success: false, error: 'Nieprawidłowy login lub hasło ASM' });
      }

      // logowanie PIN (kierownik zmiany) → tylko wydruk
      if (pin != null) {
        const adminPin = await kv.get('admin:pin');
        if (sha(String(pin).trim()) === adminPin) return res.json({ success: true, role: 'kierownik' });
        return res.status(401).json({ success: false, error: 'Nieprawidłowy PIN' });
      }

      return res.status(400).json({ success: false, error: 'Podaj PIN albo login i hasło' });
    }

    // PUT — zmiana poświadczeń
    if (req.method === 'PUT') {
      const body = req.body || {};

      // zmiana PIN kierownika — wymaga hasła ASM
      if (body.newPin != null) {
        const asmPass = await kv.get('asm:pass');
        if (sha(body.asmPassword || '') !== asmPass) return res.status(401).json({ success: false, error: 'Nieprawidłowe hasło ASM' });
        if (!/^\d{6}$/.test(String(body.newPin).trim())) return res.status(400).json({ success: false, error: 'PIN musi mieć dokładnie 6 cyfr' });
        await kv.set('admin:pin', sha(String(body.newPin).trim()));
        return res.json({ success: true });
      }

      // zmiana loginu/hasła ASM — wymaga OBECNEGO hasła ASM (tylko ASM może zmienić)
      if (body.newPassword != null || body.newLogin != null) {
        const asmPass = await kv.get('asm:pass');
        if (sha(body.currentPassword || '') !== asmPass) return res.status(401).json({ success: false, error: 'Nieprawidłowe obecne hasło ASM' });
        if (body.newLogin != null && String(body.newLogin).trim()) await kv.set('asm:login', String(body.newLogin).trim());
        if (body.newPassword != null && String(body.newPassword)) {
          if (String(body.newPassword).length < 6) return res.status(400).json({ success: false, error: 'Hasło ASM musi mieć min. 6 znaków' });
          await kv.set('asm:pass', sha(String(body.newPassword)));
        }
        return res.json({ success: true });
      }

      return res.status(400).json({ success: false, error: 'Brak danych do zmiany' });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
