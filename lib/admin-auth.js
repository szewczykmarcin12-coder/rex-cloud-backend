import { kv, cors, kvConfigured } from './_helpers.js';
import { signSession, requireRole, hashSecret, verifySecret, rateLimit, rateClear, clientIp } from './auth.js';

// Dostęp do panelu admina. Dwa źródła tożsamości:
//  - konto ASM (asm:login + asm:pass) → rola 'asm'
//  - konto pracownicze z rolą panelu (admin:roles lub funkcja RGM/ASM/SM/JSM) → 'asm' / 'kierownik'
//  - PIN kierownika zmiany (admin:pin) → rola 'kierownik'
//
// P0/SEC-06: ŻADNYCH domyślnych haseł. Pierwsze poświadczenia ustawiane przez env:
//   ADMIN_BOOTSTRAP_PIN      — startowy PIN kierownika zmiany (6 cyfr)
//   ASM_BOOTSTRAP_LOGIN      — startowy login ASM
//   ASM_BOOTSTRAP_PASSWORD   — startowe hasło ASM (min. 8 znaków)
// Bootstrap działa tylko, gdy dany klucz jeszcze nie istnieje w bazie.
const rolaZFunkcji = (funkcja) => {
  const f = String(funkcja || '').toUpperCase();
  if (f === 'RGM' || f === 'ASM') return 'asm';
  if (f === 'SM' || f === 'JSM' || f === 'REST') return 'kierownik';
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

async function bootstrapFromEnv() {
  if (!(await kv.get('admin:pin')) && process.env.ADMIN_BOOTSTRAP_PIN) {
    if (/^\d{6}$/.test(process.env.ADMIN_BOOTSTRAP_PIN)) await kv.set('admin:pin', hashSecret(process.env.ADMIN_BOOTSTRAP_PIN));
  }
  if (!(await kv.get('asm:pass')) && process.env.ASM_BOOTSTRAP_PASSWORD) {
    if (String(process.env.ASM_BOOTSTRAP_PASSWORD).length >= 8) await kv.set('asm:pass', hashSecret(process.env.ASM_BOOTSTRAP_PASSWORD));
  }
  if (!(await kv.get('asm:login')) && process.env.ASM_BOOTSTRAP_LOGIN) {
    await kv.set('asm:login', String(process.env.ASM_BOOTSTRAP_LOGIN).trim());
  }
}

// Weryfikacja z automatyczną migracją starego hasha (sha256 → scrypt+sól)
async function checkStored(key, plain) {
  const stored = await kv.get(key);
  if (!stored) return false;
  const w = verifySecret(plain, stored);
  if (w.ok && w.upgrade) await kv.set(key, hashSecret(plain));
  return w.ok;
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona. W Vercel: projekt backendu → Storage → Redis (Upstash) → podłącz, a potem wdróż ponownie.' });

  try {
    await bootstrapFromEnv();

    // GET — konfiguracja panelu (tylko ASM)
    if (req.method === 'GET') {
      const s = await requireRole(req, res, ['asm']);
      if (!s) return;
      const asmLogin = await kv.get('asm:login');
      const roles = await getRoles();
      const linked = Object.entries(roles).map(([login, role]) => ({ login, role }));
      const resetReqs = (await kv.get('admin:resetReqs')) || [];
      return res.json({ success: true, asmLogin, linked, resetReqs });
    }

    if (req.method === 'POST') {
      const { pin, login, password } = req.body || {};
      const ip = clientIp(req);

      // zgłoszenie resetu hasła z ekranu logowania (publiczne, z limitem prób)
      if (req.body && req.body.action === 'reset-request') {
        if (!(await rateLimit(`reset:${ip}`, 5, 3600))) return res.status(429).json({ success: false, error: 'Za dużo zgłoszeń — spróbuj później.' });
        const cel = String(req.body.login || '').trim().toUpperCase();
        if (!cel) return res.status(400).json({ success: false, error: 'Podaj login' });
        const konta = (await kv.get('accounts:list')) || [];
        const konto = konta.find((a) => String(a.login || '').toUpperCase() === cel);
        // celowo bez ujawniania, czy konto istnieje
        if (konto) {
          const reqs = ((await kv.get('admin:resetReqs')) || []).filter((r2) => r2.login !== cel);
          reqs.push({ login: cel, name: konto.name || '', at: Date.now() });
          await kv.set('admin:resetReqs', reqs);
        }
        return res.json({ success: true, message: 'Jeśli konto istnieje, zgłoszenie trafiło do ASM.' });
      }

      // ASM zamyka zgłoszenie resetu
      if (req.body && req.body.action === 'reset-done') {
        const s = await requireRole(req, res, ['asm']);
        if (!s) return;
        const cel = String(req.body.login || '').trim().toUpperCase();
        const reqs = ((await kv.get('admin:resetReqs')) || []).filter((r2) => r2.login !== cel);
        await kv.set('admin:resetReqs', reqs);
        return res.json({ success: true, resetReqs: reqs });
      }

      // nadanie / odebranie roli panelu kontu pracowniczemu (tylko ASM, sesja zamiast hasła w body)
      if (req.body && (req.body.action === 'link' || req.body.action === 'unlink')) {
        const s = await requireRole(req, res, ['asm']);
        if (!s) return;
        const cel = String(req.body.accountLogin || '').trim().toUpperCase();
        const roles = await getRoles();
        if (req.body.action === 'link') {
          const konta = (await kv.get('accounts:list')) || [];
          const konto = konta.find((a) => String(a.login || '').toUpperCase() === cel);
          if (!konto) return res.status(404).json({ success: false, error: `Brak konta pracowniczego o loginie ${cel}` });
          roles[cel] = (req.body.role === 'kierownik') ? 'kierownik' : 'asm';
        } else delete roles[cel];
        await kv.set('admin:roles', roles);
        return res.json({ success: true, linked: Object.entries(roles).map(([l, r2]) => ({ login: l, role: r2 })) });
      }

      // ── logowanie login+hasło ──
      if (login != null && password != null) {
        const kandydat = String(login).trim();
        if (!(await rateLimit(`login:${kandydat.toUpperCase()}:${ip}`, 8, 900))) {
          return res.status(429).json({ success: false, error: 'Konto tymczasowo zablokowane po zbyt wielu próbach. Spróbuj za 15 minut.' });
        }

        const asmLogin = await kv.get('asm:login');
        const asmPass = await kv.get('asm:pass');
        if (!asmPass && !process.env.ASM_BOOTSTRAP_PASSWORD) {
          return res.status(503).json({ success: false, error: 'Panel nie jest skonfigurowany: ustaw ASM_BOOTSTRAP_LOGIN i ASM_BOOTSTRAP_PASSWORD w zmiennych środowiskowych backendu.' });
        }
        if (asmLogin && kandydat.toLowerCase() === String(asmLogin).toLowerCase() && (await checkStored('asm:pass', String(password)))) {
          await rateClear(`login:${kandydat.toUpperCase()}:${ip}`);
          const token = await signSession({ role: 'asm', name: kandydat });
          return res.json({ success: true, role: 'asm', userName: kandydat, token });
        }

        // konto pracownicze z rolą panelu
        const roles = await getRoles();
        const cel = kandydat.toUpperCase();
        const konta = (await kv.get('accounts:list')) || [];
        const konto = konta.find((a) => String(a.login || '').toUpperCase() === cel);
        const rola = roles[cel] || (konto ? rolaZFunkcji(konto.funkcja) : null);
        if (konto && rola) {
          const w = verifySecret(String(password), konto.hasloHash);
          if (w.ok) {
            if (konto.mustChange) return res.status(401).json({ success: false, error: 'Konto wymaga zmiany hasła — zaloguj się najpierw do aplikacji pracownika i ustaw nowe hasło.' });
            if (w.upgrade) { konto.hasloHash = hashSecret(String(password)); await kv.set('accounts:list', konta); }
            await rateClear(`login:${cel}:${ip}`);
            const token = await signSession({ role: rola, name: (konto.name || cel).trim(), accountId: konto.id, login: cel });
            return res.json({ success: true, role: rola, userName: (konto.name || cel).trim(), login: cel, token });
          }
          return res.status(401).json({ success: false, error: 'Nieprawidłowy login lub hasło' });
        }
        if (konto && !rola) return res.status(403).json({ success: false, error: 'To konto nie ma uprawnień do panelu (funkcja CREW). ASM może nadać rolę w Ustawieniach.' });
        return res.status(401).json({ success: false, error: 'Nieprawidłowy login lub hasło' });
      }

      // ── logowanie PIN kierownika zmiany ──
      if (pin != null) {
        if (!(await rateLimit(`pin:${ip}`, 8, 900))) return res.status(429).json({ success: false, error: 'Za dużo prób — spróbuj za 15 minut.' });
        const adminPin = await kv.get('admin:pin');
        if (!adminPin) return res.status(503).json({ success: false, error: 'PIN kierownika nie jest skonfigurowany: ustaw ADMIN_BOOTSTRAP_PIN w zmiennych środowiskowych backendu.' });
        if (await checkStored('admin:pin', String(pin).trim())) {
          await rateClear(`pin:${ip}`);
          const token = await signSession({ role: 'kierownik', name: 'Kierownik zmiany' });
          return res.json({ success: true, role: 'kierownik', token });
        }
        return res.status(401).json({ success: false, error: 'Nieprawidłowy PIN' });
      }

      return res.status(400).json({ success: false, error: 'Podaj PIN albo login i hasło' });
    }

    // PUT — zmiana poświadczeń (tylko zalogowany ASM + potwierdzenie obecnym hasłem)
    if (req.method === 'PUT') {
      const s = await requireRole(req, res, ['asm']);
      if (!s) return;
      const body = req.body || {};

      if (body.newPin != null) {
        if (!(await checkStored('asm:pass', String(body.asmPassword || '')))) return res.status(401).json({ success: false, error: 'Nieprawidłowe hasło ASM' });
        if (!/^\d{6}$/.test(String(body.newPin).trim())) return res.status(400).json({ success: false, error: 'PIN musi mieć dokładnie 6 cyfr' });
        await kv.set('admin:pin', hashSecret(String(body.newPin).trim()));
        return res.json({ success: true });
      }

      if (body.newPassword != null || body.newLogin != null) {
        if (!(await checkStored('asm:pass', String(body.currentPassword || '')))) return res.status(401).json({ success: false, error: 'Nieprawidłowe obecne hasło ASM' });
        if (body.newLogin != null && String(body.newLogin).trim()) await kv.set('asm:login', String(body.newLogin).trim());
        if (body.newPassword != null && String(body.newPassword)) {
          if (String(body.newPassword).length < 8) return res.status(400).json({ success: false, error: 'Hasło ASM musi mieć min. 8 znaków' });
          await kv.set('asm:pass', hashSecret(String(body.newPassword)));
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
