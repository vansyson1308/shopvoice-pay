// Public listing pages (/docs, /privacy, /terms, /support) and the icon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startOAuthServer } from './oauth-harness.mjs';
import { ALL_TOOLS } from '../../apps/mcp-server/dist/tool-catalog.js';

const SUPPORT = 'help@shop.test';

test('every public page renders in English and Vietnamese with config filled in', async () => {
  const srv = await startOAuthServer({ env: { SUPPORT_EMAIL: SUPPORT } });
  try {
    for (const page of ['docs', 'privacy', 'terms', 'support']) {
      for (const q of ['', '?lang=vi']) {
        const res = await fetch(`${srv.url}/${page}${q}`);
        assert.equal(res.status, 200, `${page}${q}`);
        assert.match(res.headers.get('content-type'), /text\/html/);
        assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
        const html = await res.text();
        assert.doesNotMatch(html, /\{\{/, `${page}${q}: placeholders filled`);
        assert.ok(html.includes(SUPPORT), `${page}${q}: support email`);
        assert.match(html, q ? /lang="vi"/ : /lang="en"/);
      }
    }
    const root = await fetch(`${srv.url}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/docs');
  } finally {
    await srv.close();
  }
});

test('docs list every tool and the connection URL; privacy covers the required topics', async () => {
  const srv = await startOAuthServer({ env: { SUPPORT_EMAIL: SUPPORT } });
  try {
    const docs = await (await fetch(`${srv.url}/docs`)).text();
    for (const t of ALL_TOOLS) assert.ok(docs.includes(`<code>${t.name}</code>`), `docs mention ${t.name}`);
    assert.ok(docs.includes('https://shop.test/mcp'));
    const privacy = await (await fetch(`${srv.url}/privacy`)).text();
    for (const topic of [/What we collect/, /never receives or stores your conversations/, /90 days/, /14 days/, /us-east-1/,
      /do not sell/, /train AI models/, /Amazon Web Services/, /KiotViet/, /Delete your account/, /under 18/, /Contact/]) {
      assert.match(privacy, topic);
    }
  } finally {
    await srv.close();
  }
});

test('icon: square SVG and a 512x512 PNG are served and committed', async () => {
  const srv = await startOAuthServer();
  try {
    const svg = await fetch(`${srv.url}/icon.svg`);
    assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
    assert.match(await svg.text(), /viewBox="0 0 512 512"/);
    const png = Buffer.from(await (await fetch(`${srv.url}/icon-512.png`)).arrayBuffer());
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 512);
    assert.equal(png.readUInt32BE(20), 512);
    const file = readFileSync(new URL('../../apps/mcp-server/public/icon-512.png', import.meta.url));
    assert.ok(file.length < 256 * 1024);
  } finally {
    await srv.close();
  }
});
