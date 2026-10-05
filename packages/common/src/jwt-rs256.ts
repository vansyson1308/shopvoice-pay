// Minimal RS256 JWTs for agent-to-agent calls (node:crypto only). The PayPal
// Cart API authenticates its callers to merchants this way: a short-lived JWT
// signed with RS256 and checked against the caller's published JWKS.
import { createPrivateKey, createPublicKey, createSign, createVerify, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';

export interface JwtClaims {
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
  readonly [claim: string]: unknown;
}

export type PublicJwk = JsonWebKey & { readonly kid: string; readonly alg: 'RS256'; readonly use: 'sig' };

export class JwtError extends Error {}

const b64url = (data: Buffer | string) => (typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64url');

export function generateSigningKey(kid: string = randomUUID()): { privateKey: KeyObject; publicJwk: PublicJwk } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, publicJwk: { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid, alg: 'RS256', use: 'sig' } };
}

/** A PKCS#8 PEM private key (from env) and the kid it is published under. */
export function signingKeyFromPem(pem: string, kid: string): { privateKey: KeyObject; publicJwk: PublicJwk } {
  const privateKey = createPrivateKey(pem);
  return { privateKey, publicJwk: { ...(createPublicKey(privateKey).export({ format: 'jwk' }) as JsonWebKey), kid, alg: 'RS256', use: 'sig' } };
}

export function signJwt(privateKey: KeyObject, kid: string, claims: Omit<JwtClaims, 'iat' | 'exp' | 'jti'> & { ttlSeconds?: number }, nowMs: number = Date.now()): string {
  const { ttlSeconds = 300, ...rest } = claims;
  const iat = Math.floor(nowMs / 1000);
  const body: JwtClaims = { ...rest, iat, exp: iat + ttlSeconds, jti: randomUUID() } as JwtClaims;
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const payload = b64url(JSON.stringify(body));
  const signature = createSign('RSA-SHA256').update(`${head}.${payload}`).sign(privateKey);
  return `${head}.${payload}.${b64url(signature)}`;
}

/** Verifies signature (RS256 only, key chosen by kid), audience and time. Throws JwtError. */
export function verifyJwt(token: string, keys: readonly PublicJwk[], opts: { audience: string; issuer?: string; nowMs?: number; maxAgeSeconds?: number }): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed token');
  const [head, payload, signature] = parts as [string, string, string];
  let header: { alg?: unknown; kid?: unknown };
  let claims: JwtClaims;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { alg?: unknown; kid?: unknown };
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims;
  } catch {
    throw new JwtError('malformed token');
  }
  if (header.alg !== 'RS256') throw new JwtError('unsupported alg');
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new JwtError('unknown key');
  const ok = createVerify('RSA-SHA256').update(`${head}.${payload}`).verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'));
  if (!ok) throw new JwtError('bad signature');
  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new JwtError('expired');
  if (typeof claims.iat !== 'number' || claims.iat > now + 60 || now - claims.iat > (opts.maxAgeSeconds ?? 600)) throw new JwtError('bad issued-at');
  if (claims.aud !== opts.audience) throw new JwtError('wrong audience');
  if (opts.issuer && claims.iss !== opts.issuer) throw new JwtError('wrong issuer');
  return claims;
}
