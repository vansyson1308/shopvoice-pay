// Crypto helpers for the OAuth authorization server. node:crypto only:
// scrypt for passwords, SHA-256 for tokens/codes at rest, HMAC for cookies.
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 } as const;

function scrypt(password: string, salt: Buffer, keyLen: number, opts: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keyLen, opts, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time string comparison (hashes both sides so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** `scrypt$N$r$p$<salt b64url>$<key b64url>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keyLen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (![N, R, P].every((v) => Number.isInteger(v) && v > 0) || N > 1 << 20 || R > 32 || P > 16) return false;
  const expected = Buffer.from(keyB64 ?? '', 'base64url');
  if (expected.length < 16) return false;
  try {
    const key = await scrypt(password, Buffer.from(saltB64 ?? '', 'base64url'), expected.length, { N, r: R, p: P, maxmem: SCRYPT.maxmem });
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** A dummy verification with the same cost, so unknown emails take as long as wrong passwords. */
export async function burnPasswordCheck(password: string): Promise<void> {
  await scrypt(password, randomBytes(16), SCRYPT.keyLen, SCRYPT);
}

export function isValidCodeVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(verifier);
}

export function pkceS256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function isValidCodeChallenge(challenge: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(challenge);
}

/** RFC 7636 S256 only; the plain method is never accepted. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) return false;
  return safeEqual(pkceS256Challenge(verifier), challenge);
}

function mac(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('base64url');
}

/** `<payload b64url>.<expires ms>.<hmac>` */
export function signCookieValue(payload: string, secret: string, expiresAtMs: number): string {
  const body = `${Buffer.from(payload, 'utf8').toString('base64url')}.${expiresAtMs}`;
  return `${body}.${mac(body, secret)}`;
}

export function verifyCookieValue(value: string, secret: string, nowMs: number): string | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [payload = '', exp = '', sig = ''] = parts;
  if (!safeEqual(mac(`${payload}.${exp}`, secret), sig)) return null;
  const expires = Number(exp);
  if (!Number.isFinite(expires) || expires < nowMs) return null;
  return Buffer.from(payload, 'base64url').toString('utf8');
}
