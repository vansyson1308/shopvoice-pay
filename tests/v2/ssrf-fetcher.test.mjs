import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchUrlSafely, validateSafeAttachmentUrl } from '../../packages/common/dist/index.js';

test('ssrf validator allows approved https domain', () => {
  const result = validateSafeAttachmentUrl('https://files.zalo.me/invoice.xml', ['zalo.me', 'zadn.vn']);
  assert.equal(result.ok, true);
});

test('ssrf validator blocks private ip and non-https and custom port', () => {
  assert.equal(validateSafeAttachmentUrl('http://files.zalo.me/a.xml', ['zalo.me']).ok, false);
  assert.equal(validateSafeAttachmentUrl('https://127.0.0.1/a.xml', ['zalo.me']).ok, false);
  assert.equal(validateSafeAttachmentUrl('https://files.zalo.me:444/a.xml', ['zalo.me']).ok, false);
});



test('ssrf validator allows explicit http stub domains only when configured', () => {
  assert.equal(validateSafeAttachmentUrl('http://xml-stub:18082/invoice.xml', ['xml-stub']).ok, false);
  assert.equal(validateSafeAttachmentUrl('http://xml-stub:18082/invoice.xml', ['xml-stub'], ['xml-stub']).ok, true);
});

test('ssrf validator blocks loopback hostname forms', () => {
  assert.equal(validateSafeAttachmentUrl('https://localhost/a.xml', ['zalo.me']).ok, false);
  assert.equal(validateSafeAttachmentUrl('https://api.local/a.xml', ['zalo.me']).ok, false);
});

test('safe fetch uses redirect:error and rejects redirect responses', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: false,
      status: 302,
      headers: { get: () => 'text/plain' },
      text: async () => ''
    };
  };

  await assert.rejects(() => fetchUrlSafely('https://files.zalo.me/invoice.xml', {
    allowedDomains: ['zalo.me'],
    maxBytes: 1024,
    timeoutMs: 100
  }, fakeFetch));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'error');
});
