// REX Cloud — sesje, role i ochrona poświadczeń (SEC-01 / SEC-03).
// Sesja = podpisany HMAC token { sub, role, exp } w nagłówku Authorization: Bearer.
// Role: 'asm' (pełny dostęp), 'kierownik' (operacje zmianowe), 'pracownik' (własne dane).
// Hasła/PIN-y: scrypt z unikalną solą (format s2:sól:hash); stare hashe SHA-256
// są akceptowane i automatycznie migrowane przy udanym logowaniu.
import crypto from 'crypto';
import { kv } from './_helpers.js';

const b64u = (s) => Buffer.from(s).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url').toString('utf8');
const hmac = (data, secret) => crypto.createHmac('sha256', String(secret)).update(data).digest('base64url');

// ── Sekret sesji: env SESSION_SECRET albo wygenerowany raz i trzymany w bazie ──
let cachedSecret = null;
export async function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (cachedSecret) return cachedSecret;
  let s = await kv.get('auth:secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); await kv.set('auth:secret', s); }
  cachedSecret = s;
  return s;
}

const DEFAULT_TTL = 12 * 60 * 60 * 1000;   // 12 h

export async function signSession(payload, ttlMs = DEFAULT_TTL) {
  const secret = await sessionSecret();
  const body = b64u(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + ttlMs }));
  return `${body}.${hmac(body, secret)}`;
}

export async function readSession(req) {
  try {
    const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    if (!h.startsWith('Bearer ')) return null;
    const token = h.slice(7).trim();
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const body = token.slice(0, dot), sig = token.slice(dot + 1);
    const secret = await sessionSecret();
    const expect = hmac(body, secret);
    if (expect.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null;
    const p = JSON.parse(unb64u(body));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

// Wymaga zalogowania (i opcjonalnie jednej z ról). Wysyła 401/403 i zwraca null przy braku.
export async function requireRole(req, res, roles = null) {
  const s = await readSession(req);
  if (!s) { res.status(401).json({ success: false, error: 'Wymagane zalogowanie — sesja wygasła lub jej brak.' }); return null; }
  if (roles && roles.length && !roles.includes(s.role)) { res.status(403).json({ success: false, error: 'Brak uprawnień do tej operacji.' }); return null; }
  return s;
}

// ── Hasła / PIN-y ──
export const shaLegacy = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function hashSecret(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return `s2:${salt}:${h}`;
}

// Zwraca { ok, upgrade } — upgrade=true gdy hash jest w starym formacie i po
// udanej weryfikacji należy zapisać nowy (hashSecret).
export function verifySecret(plain, stored) {
  if (!stored) return { ok: false, upgrade: false };
  const s = String(stored);
  if (s.startsWith('s2:')) {
    const [, salt, h] = s.split(':');
    if (!salt || !h) return { ok: false, upgrade: false };
    const calc = crypto.scryptSync(String(plain), salt, 32).toString('hex');
    const ok = h.length === calc.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(calc));
    return { ok, upgrade: false };
  }
  const ok = shaLegacy(plain) === s;                    // stary format (sha256 bez soli)
  return { ok, upgrade: ok };
}

// ── Blokada brute-force: licznik prób w oknie czasowym (Redis INCR+EXPIRE) ──
export async function rateLimit(bucket, max = 8, windowSec = 900) {
  try {
    const key = `rl:${bucket}`;
    const n = await kv.incr(key);
    if (n === 1) await kv.expire(key, windowSec);
    return n <= max;
  } catch { return true; }                              // awaria bazy nie blokuje logowania
}
export async function rateClear(bucket) { try { await kv.del(`rl:${bucket}`); } catch {} }

export const clientIp = (req) => String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || 'unknown').split(',')[0].trim();
