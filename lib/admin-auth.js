import { kv, cors, kvConfigured } from './_helpers.js';
import crypto from 'crypto';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Dwie role:
//  - kierownik zmiany: PIN (admin:pin, domyślnie 123456) -> dostęp tylko do wydruku
//  - ASM: login (asm:login, domyślnie "asm") + hasło (asm:pass, domyślnie "asm12345") -> pełny dostęp
// rola panelu z funkcji konta: RGM/ASM = pelny dostep, SM/JSM = kierownik zmiany, CREW = brak
const rolaZFunkcji = (funkcja) => {
  const f = String(funkcja || '').toUpperCase();
  if (f === 'RGM' || f === 'ASM') return 'asm';
  if (f === 'SM' || f === 'JSM') return 'kierownik';
  return null;
};

async function getRoles() {
  let roles = await kv.get('admin:roles');
  if (!roles) {
    const stare = (await kv.get('admin:linked')) || [];
    roles = {}; stare.forEach((l) => { roles[l] = 'asm'; });
    if (stare.length) await kv.set('admin:roles', roles);
  }
  return roles || {};
}

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
      const roles = await getRoles();
      const linked = Object.entries(roles).map(([login, role]) => ({ login, role }));
      const resetReqs = (await kv.get('admin:resetReqs')) || [];
      return res.json({ success: true, asmLogin, linked, resetReqs });
    }

    // POST — logowanie
    if (req.method === 'POST') {
      const { pin, login, password } = req.body || {};

      // zgloszenie resetu hasla z ekranu logowania -> powiadomienie u ASM
      if (req.body && req.body.action === 'reset-request') {
        const cel = String(req.body.login || '').trim().toUpperCase();
        if (!cel) return res.status(400).json({ success: false, error: 'Podaj login' });
        const konta = (await kv.get('accounts:list')) || [];
        const konto = konta.find((a) => String(a.login || '').toUpperCase() === cel);
        if (!konto) return res.status(404).json({ success: false, error: `Brak konta o loginie ${cel}` });
        const reqs = ((await kv.get('admin:resetReqs')) || []).filter((r2) => r2.login !== cel);
        reqs.push({ login: cel, name: konto.name || '', at: Date.now() });
        await kv.set('admin:resetReqs', reqs);
        return res.json({ success: true, message: 'Zgłoszenie wysłane — ASM zresetuje hasło i przekaże Ci tymczasowe.' });
      }
      // ASM zamyka zgloszenie (po resecie albo odrzuceniu)
      if (req.body && req.body.action === 'reset-done') {
        const cel = String(req.body.login || '').trim().toUpperCase();
        const reqs = ((await kv.get('admin:resetReqs')) || []).filter((r2) => r2.login !== cel);
        await kv.set('admin:resetReqs', reqs);
        return res.json({ success: true, resetReqs: reqs });
      }

      // powiazanie / odpiecie konta pracowniczego z rola ASM (wymaga hasla ASM)
      if (req.body && req.body.action === 'link') {
        const { accountLogin, asmPassword } = req.body;
        const asmPass = await kv.get('asm:pass');
        if (sha(String(asmPassword || '')) !== asmPass) return res.status(401).json({ success: false, error: 'Nieprawidłowe hasło ASM' });
        const konta = (await kv.get('accounts:list')) || [];
        const cel = String(accountLogin || '').trim().toUpperCase();
        const konto = konta.find((a) => String(a.login || '').toUpperCase() === cel);
        if (!konto) return res.status(404).json({ success: false, error: `Brak konta pracowniczego o loginie ${cel}` });
        const rola = (req.body.role === 'kierownik') ? 'kierownik' : 'asm';
        const roles = await getRoles();
        roles[cel] = rola;
        await kv.set('admin:roles', roles);
        return res.json({ success: true, linked: Object.entries(roles).map(([login, role]) => ({ login, role })) });
      }
      if (req.body && req.body.action === 'unlink') {
        const { accountLogin, asmPassword } = req.body;
        const asmPass = await kv.get('asm:pass');
        if (sha(String(asmPassword || '')) !== asmPass) return res.status(401).json({ success: false, error: 'Nieprawidłowe hasło ASM' });
        const cel = String(accountLogin || '').trim().toUpperCase();
        const roles = await getRoles();
        delete roles[cel];
        await kv.set('admin:roles', roles);
        return res.json({ success: true, linked: Object.entries(roles).map(([login, role]) => ({ login, role })) });
      }

      // logowanie ASM (login + hasło) → pełny dostęp
      if (login != null && password != null) {
        const asmLogin = await kv.get('asm:login');
        const asmPass = await kv.get('asm:pass');
        if (String(login).trim().toLowerCase() === String(asmLogin).toLowerCase() && sha(String(password)) === asmPass) {
          return res.json({ success: true, role: 'asm', userName: String(login).trim() });
        }
        // jeden profil: konto pracownicze z przypisana rola panelu (asm lub kierownik)
        // loguje sie tym samym loginem i haslem/PIN-em co do aplikacji pracownika
        const roles = await getRoles();
        const cel = String(login).trim().toUpperCase();
        const konta = (await kv.get('accounts:list')) || [];
        const konto = konta.find((a) => String(a.login || '').toUpperCase() === cel);
        const rola = roles[cel] || (konto ? rolaZFunkcji(konto.funkcja) : null);
        if (konto && rola) {
          if (konto.hasloHash === sha(String(password))) {
            if (konto.mustChange) return res.status(401).json({ success: false, error: 'Konto wymaga zmiany hasła — zaloguj się najpierw do aplikacji pracownika i ustaw nowe hasło.' });
            return res.json({ success: true, role: rola, userName: (konto.name || cel).trim(), login: cel });
          }
          return res.status(401).json({ success: false, error: 'Nieprawidłowy login lub hasło' });
        }
        if (konto && !rola) return res.status(403).json({ success: false, error: 'To konto nie ma uprawnień do panelu (funkcja CREW). ASM może nadać rolę w Ustawieniach.' });
        return res.status(401).json({ success: false, error: 'Nieprawidłowy login lub hasło' });
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
