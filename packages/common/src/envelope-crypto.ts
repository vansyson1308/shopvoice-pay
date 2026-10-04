import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EnvelopeEncrypted {
  readonly encryptedDek: Buffer;
  readonly dekNonce: Buffer;
  readonly encryptedValue: Buffer;
  readonly valueNonce: Buffer;
}

function decodeMek(mekB64: string): Buffer {
  const mek = Buffer.from(mekB64, 'base64');
  if (mek.length !== 32) {
    throw new Error('invalid_mek');
  }
  return mek;
}

function encryptAesGcm(plaintext: Buffer, key: Buffer): { ciphertextWithTag: Buffer; nonce: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertextWithTag: Buffer.concat([ciphertext, tag]), nonce };
}

function decryptAesGcm(ciphertextWithTag: Buffer, key: Buffer, nonce: Buffer): Buffer {
  if (ciphertextWithTag.length < 16) {
    throw new Error('invalid_ciphertext');
  }
  const ciphertext = Buffer.from(ciphertextWithTag.toString('hex').slice(0, (ciphertextWithTag.length - 16) * 2), 'hex');
  const tag = Buffer.from(ciphertextWithTag.toString('hex').slice((ciphertextWithTag.length - 16) * 2), 'hex');

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptPayload(plaintextJson: string, mekB64: string): EnvelopeEncrypted {
  const mek = decodeMek(mekB64);
  const dek = randomBytes(32);

  const value = encryptAesGcm(Buffer.from(plaintextJson, 'utf8'), dek);
  const wrappedDek = encryptAesGcm(dek, mek);

  return {
    encryptedDek: wrappedDek.ciphertextWithTag,
    dekNonce: wrappedDek.nonce,
    encryptedValue: value.ciphertextWithTag,
    valueNonce: value.nonce
  };
}

export function decryptPayload(input: EnvelopeEncrypted, mekB64: string): string {
  const mek = decodeMek(mekB64);
  const dek = decryptAesGcm(input.encryptedDek, mek, input.dekNonce);
  if (dek.length !== 32) {
    throw new Error('invalid_dek');
  }

  const plaintext = decryptAesGcm(input.encryptedValue, dek, input.valueNonce);
  return plaintext.toString('utf8');
}
