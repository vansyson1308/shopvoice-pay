import { createHash } from 'node:crypto';

export function normalizeInviteCode(code: string): string {
  return code.trim().replace(/[\s-]/g, '').toUpperCase();
}

export function validateInviteCodeNormalized(normalized: string): boolean {
  return /^[A-Z0-9]{6,32}$/.test(normalized);
}

export function computeInviteCodeHashHex(normalizedCode: string, pepperB64: string): string {
  if (!validateInviteCodeNormalized(normalizedCode)) {
    throw new Error('invite_code_invalid');
  }

  const pepper = Buffer.from(pepperB64, 'base64');
  if (pepper.length < 8) {
    throw new Error('invite_pepper_invalid');
  }

  return createHash('sha256')
    .update(Buffer.concat([pepper, Buffer.from(normalizedCode, 'utf8')]))
    .digest('hex');
}
