import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptPayload, encryptPayload } from '../../packages/common/dist/index.js';

const mekB64 = Buffer.alloc(32, 7).toString('base64');

test('envelope encryption roundtrip works', () => {
  const encrypted = encryptPayload(JSON.stringify({ token: 'abc123' }), mekB64);
  const plaintext = decryptPayload(encrypted, mekB64);
  assert.equal(JSON.parse(plaintext).token, 'abc123');
});

test('envelope decryption fails on tampered ciphertext/tag', () => {
  const encrypted = encryptPayload(JSON.stringify({ token: 'abc123' }), mekB64);
  encrypted.encryptedValue[0] = encrypted.encryptedValue[0] ^ 0xff;
  assert.throws(() => decryptPayload(encrypted, mekB64));
});
