// End-to-end tests of the ShopVoice OAuth 2.1 authorization server and the
// OAuth-protected /mcp endpoint, over real HTTP with in-memory stores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  BASE, RESOURCE, CLAUDE_CALLBACK, CC_CIMD, INVITE_CODE, PASSWORD, TENANT_B, Jar,
  startOAuthServer, pkcePair, authorizeParams, getAuthorize, postAuthorize, registerClient, tokenRequest,
  authorize, fullGrant, dcrClient, mcpPost, mcpSession, callTool, INIT, hidden
} from './oauth-harness.mjs';
import { TOKEN_A } from './mcp-harness.mjs';
import { isAnthropicEgress } from '../../apps/mcp-server/dist/oauth/server.js';
import { clientIpFrom } from '../../apps/mcp-server/dist/client-ip.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');
let n = 0;
const email = () => `owner${++n}-${Date.now()}@example.com`;

test('discovery: PRM at both well-known paths, AS metadata, CORS for browser clients', async () => {
  const srv = await startOAuthServer();
  try {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await fetch(`${srv.url}${path}`);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      const prm = await res.json();
      assert.equal(prm.resource, RESOURCE);
      assert.deepEqual(prm.authorization_servers, [BASE]);
    }
    const as = await (await fetch(`${srv.url}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.issuer, BASE);
    assert.equal(as.client_id_metadata_document_supported, true);
    const pre = await fetch(`${srv.url}/oauth/token`, { method: 'OPTIONS', headers: { origin: 'http://localhost:6274', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  } finally {
    await srv.close();
  }
});

test('401 handshake: unauthenticated /mcp gets resource_metadata + scope, never a 200', async () => {
  const srv = await startOAuthServer();
  try {
    for (const token of [null, 'svat_notarealtoken0000000000000000000000000000']) {
      const res = await mcpPost(srv, INIT, token ? { token } : {});
      assert.equal(res.status, 401);
      const h = res.headers.get('www-authenticate') ?? '';
      assert.match(h, /^Bearer realm="shopvoice"/);
      assert.match(h, /resource_metadata="https:\/\/shop\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
      assert.match(h, /scope="shop\.read shop\.write"/);
      if (token) assert.match(h, /error="invalid_token"/);
    }
    // GET (SSE) and DELETE without a token are also 401.
    const get = await fetch(`${srv.url}/mcp`, { headers: { accept: 'text/event-stream' } });
    assert.equal(get.status, 401);
  } finally {
    await srv.close();
  }
});

test('DCR: public client registered, confidential client gets a secret, bad metadata rejected', async () => {
  const srv = await startOAuthServer();
  try {
    const pub = await registerClient(srv, { client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none' });
    assert.equal(pub.res.status, 201);
    assert.match(pub.json.client_id, /^svc_/);
    assert.equal(pub.json.client_secret, undefined);
    assert.deepEqual(pub.json.redirect_uris, [CLAUDE_CALLBACK]);
    assert.equal(pub.json.token_endpoint_auth_method, 'none');
    const conf = await registerClient(srv, { redirect_uris: ['https://app.example/cb'], token_endpoint_auth_method: 'client_secret_post' });
    assert.equal(conf.res.status, 201);
    assert.match(conf.json.client_secret, /^svcs_/);
    assert.equal(conf.json.client_secret_expires_at, 0);
    const stored = await srv.oauthStore.getClient(conf.json.client_id);
    assert.equal(stored.clientSecretHash, sha(conf.json.client_secret), 'secret stored hashed only');

    for (const bad of [
      {},
      { redirect_uris: [] },
      { redirect_uris: ['http://evil.example/cb'] },
      { redirect_uris: ['https://app.example/cb#x'] },
      { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'private_key_jwt' },
      { redirect_uris: [CLAUDE_CALLBACK], grant_types: ['client_credentials'] },
      { redirect_uris: [CLAUDE_CALLBACK], response_types: ['token'] }
    ]) {
      const r = await registerClient(srv, bad);
      assert.equal(r.res.status, 400, JSON.stringify(bad));
      assert.match(r.json.error, /^invalid_(redirect_uri|client_metadata)$/);
    }
    const notJson = await fetch(`${srv.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'redirect_uris=x' });
    assert.equal(notJson.status, 400);
  } finally {
    await srv.close();
  }
});

test('DCR is rate limited per IP', async () => {
  const srv = await startOAuthServer({ env: { OAUTH_DCR_PER_HOUR: '3' } });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await registerClient(srv, { redirect_uris: [CLAUDE_CALLBACK] })).res.status);
    assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
  } finally {
    await srv.close();
  }
});

test('DCR from Anthropic egress (160.79.104.0/21) shares a large bucket instead of the per-IP one', async () => {
  const srv = await startOAuthServer({ env: { OAUTH_DCR_PER_HOUR: '2', MCP_TRUST_PROXY: 'true' } });
  try {
    const reg = (ip) => fetch(`${srv.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK] }) });
    const claude = [];
    for (let i = 0; i < 6; i += 1) claude.push((await reg(`160.79.10${4 + (i % 4)}.${10 + i}`)).status);
    assert.deepEqual(claude, [201, 201, 201, 201, 201, 201]);
    const other = [];
    for (let i = 0; i < 3; i += 1) other.push((await reg('203.0.113.9')).status);
    assert.deepEqual(other, [201, 201, 429]);
    assert.equal(isAnthropicEgress('160.79.111.255'), true);
    assert.equal(isAnthropicEgress('160.79.112.1'), false);
    assert.equal(isAnthropicEgress('::ffff:160.79.104.1'), true);
  } finally {
    await srv.close();
  }
});

test('X-Forwarded-For: only the hop appended by the trusted proxy counts, so spoofed entries cannot pick the bucket', async () => {
  const srv = await startOAuthServer({ env: { OAUTH_DCR_PER_HOUR: '2', MCP_TRUST_PROXY: 'true' } });
  try {
    const reg = (xff) => fetch(`${srv.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK] }) });
    // CloudFront appends the real viewer address to whatever the viewer sent.
    const spoofAnthropic = [];
    for (let i = 0; i < 3; i += 1) spoofAnthropic.push((await reg(`160.79.104.${10 + i}, 203.0.113.7`)).status);
    assert.deepEqual(spoofAnthropic, [201, 201, 429], 'a spoofed Anthropic address does not reach the shared bucket');
    const rotating = [];
    for (let i = 0; i < 3; i += 1) rotating.push((await reg(`198.51.100.${10 + i}, 203.0.113.8`)).status);
    assert.deepEqual(rotating, [201, 201, 429], 'rotating a spoofed address does not reset the per-IP limit');
  } finally {
    await srv.close();
  }
});

test('clientIpFrom: rightmost X-Forwarded-For entry behind a trusted proxy, socket address otherwise', () => {
  const req = (xff, remote = '10.0.0.5') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } });
  assert.equal(clientIpFrom(req('1.2.3.4, 203.0.113.9'), true), '203.0.113.9');
  assert.equal(clientIpFrom(req('203.0.113.9'), true), '203.0.113.9');
  assert.equal(clientIpFrom(req(' 1.2.3.4 ,  203.0.113.9 '), true), '203.0.113.9');
  assert.equal(clientIpFrom(req(''), true), '10.0.0.5');
  assert.equal(clientIpFrom(req(undefined), true), '10.0.0.5');
  assert.equal(clientIpFrom(req('1.2.3.4, 203.0.113.9'), false), '10.0.0.5', 'untrusted: header ignored');
  assert.equal(clientIpFrom({ headers: {}, socket: {} }, false), 'unknown');
});

test('full flow (DCR + Claude callback): signup provisions a sandbox shop, code -> tokens -> MCP tools', async () => {
  const srv = await startOAuthServer();
  try {
    const clientId = await dcrClient(srv);
    const { code, redirect, verifier, consentHtml } = await authorize(srv, { clientId, email: email() });
    assert.equal(redirect.origin + redirect.pathname, CLAUDE_CALLBACK);
    assert.equal(redirect.searchParams.get('state'), 'st-123', 'state echoed');
    assert.equal(redirect.searchParams.get('iss'), BASE, 'RFC 9207 iss');
    assert.match(code, /^svac_/);
    assert.match(consentHtml, /claude\.ai/, 'consent shows the redirect host');
    assert.match(consentHtml, /Your demo shop \(sample data\)/);

    const { res, json } = await tokenRequest(srv, { grant_type: 'authorization_code', code, redirect_uri: CLAUDE_CALLBACK, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(json.token_type, 'Bearer');
    assert.equal(json.expires_in, 3600);
    assert.match(json.access_token, /^svat_/);
    assert.match(json.refresh_token, /^svrt_/);
    assert.equal(json.scope, 'shop.read shop.write offline_access');

    const s = await mcpSession(srv, json.access_token);
    assert.equal(s.status, 200);
    const low = await callTool(srv, json.access_token, s.session, 'get_low_stock', {});
    assert.equal(low.res.status, 200);
    assert.equal(low.json.result.isError, undefined);
    assert.ok(low.json.result.structuredContent.total_low > 0, 'sandbox shop is populated');
    const profile = await mcpPost(srv, { jsonrpc: '2.0', id: 9, method: 'resources/read', params: { uri: 'shop://profile' } }, { token: json.access_token, session: s.session });
    assert.match(JSON.parse((await profile.json()).result.contents[0].text).shop_name, /Your demo shop \(sample data\)/);
  } finally {
    await srv.close();
  }
});

test('CIMD (Claude Code): client_id URL fetched once, loopback redirect on any port, consent shows client host', async () => {
  const srv = await startOAuthServer();
  try {
    const redirectUri = 'http://127.0.0.1:53682/callback';
    const tokens = await fullGrant(srv, { clientId: CC_CIMD, redirectUri, email: email() });
    assert.match(tokens.access_token, /^svat_/);
    assert.equal(srv.cimdFetches.length, 1);
    const again = await authorize(srv, { clientId: CC_CIMD, redirectUri: 'http://localhost:3118/callback', email: email() });
    assert.match(again.consentHtml, /claude\.ai/, 'client_id host shown');
    assert.match(again.consentHtml, /only loopback|chỉ loopback|local application/i, 'loopback-only warning');
    assert.equal(again.redirect.host, 'localhost:3118');

    // A redirect the document does not list is an error page, never a redirect.
    const { challenge } = pkcePair();
    const bad = await getAuthorize(srv, authorizeParams({ clientId: CC_CIMD, redirectUri: 'https://evil.example/cb', challenge }));
    assert.equal(bad.res.status, 400);
    assert.equal(bad.res.headers.get('location'), null);
    const unknownDoc = await getAuthorize(srv, authorizeParams({ clientId: 'https://app.example/missing.json', challenge }));
    assert.equal(unknownDoc.res.status, 400);
    const ssrf = await getAuthorize(srv, authorizeParams({ clientId: 'https://169.254.169.254/latest/meta-data', challenge }));
    assert.equal(ssrf.res.status, 400);
    assert.ok(!srv.cimdFetches.some((u) => u.includes('169.254')), 'SSRF target never fetched');
  } finally {
    await srv.close();
  }
});

test('authorize validation: unknown client and bad redirect show an error page; other errors redirect with state', async () => {
  const srv = await startOAuthServer();
  try {
    const clientId = await dcrClient(srv);
    const { challenge } = pkcePair();
    const unknown = await getAuthorize(srv, authorizeParams({ clientId: 'svc_unknown_client_000000', challenge }));
    assert.equal(unknown.res.status, 400);
    const badRedirect = await getAuthorize(srv, authorizeParams({ clientId, redirectUri: 'https://claude.ai/api/mcp/other', challenge }));
    assert.equal(badRedirect.res.status, 400);
    assert.equal(badRedirect.res.headers.get('location'), null);

    const cases = [
      [{ challenge: undefined }, 'invalid_request'],
      [{ challenge, method: 'plain' }, 'invalid_request'],
      [{ challenge, method: undefined }, 'invalid_request'],
      [{ challenge: 'tooshort' }, 'invalid_request'],
      [{ challenge, scope: 'shop.read admin' }, 'invalid_scope'],
      [{ challenge, resource: 'https://other.example/mcp' }, 'invalid_target']
    ];
    for (const [over, error] of cases) {
      const r = await getAuthorize(srv, build(clientId, challenge, over));
      assert.equal(r.res.status, 302, JSON.stringify(over));
      const loc = new URL(r.res.headers.get('location'));
      assert.equal(loc.searchParams.get('error'), error, JSON.stringify(over));
      assert.equal(loc.searchParams.get('state'), 'st-123');
    }
    const rt = await getAuthorize(srv, { ...authorizeParams({ clientId, challenge }), response_type: 'token' });
    assert.equal(new URL(rt.res.headers.get('location')).searchParams.get('error'), 'unsupported_response_type');
  } finally {
    await srv.close();
  }
});

// authorizeParams() drops undefined values, except that a default fills an
// undefined method; delete it explicitly when a case wants it missing.
function build(clientId, challenge, over) {
  const p = authorizeParams({ clientId, challenge, ...over });
  if ('method' in over && over.method === undefined) delete p.code_challenge_method;
  return p;
}

test('deny returns access_denied to the client; login failures are generic and lock the account', async () => {
  const srv = await startOAuthServer();
  try {
    const clientId = await dcrClient(srv);
    const who = email();
    await fullGrant(srv, { clientId, email: who });
    const { challenge } = pkcePair();
    const jar = new Jar();
    const page = await getAuthorize(srv, authorizeParams({ clientId, challenge }), jar);
    const wrongPw = await postAuthorize(srv, jar, page.html, { action: 'login', email: who, password: 'wrong password!!' });
    const noUser = await postAuthorize(srv, jar, page.html, { action: 'login', email: 'nobody@example.com', password: 'wrong password!!' });
    assert.equal(wrongPw.res.status, 401);
    assert.equal(noUser.res.status, 401);
    assert.equal(/Email or password is incorrect/.test(wrongPw.html) && /Email or password is incorrect/.test(noUser.html), true, 'same generic message');
    for (let i = 0; i < 4; i += 1) await postAuthorize(srv, jar, page.html, { action: 'login', email: who, password: 'wrong password!!' });
    const locked = await postAuthorize(srv, jar, page.html, { action: 'login', email: who, password: PASSWORD });
    assert.equal(locked.res.status, 401, 'locked after 5 failures even with the right password');

    const other = email();
    const jar2 = new Jar();
    const p2 = await getAuthorize(srv, authorizeParams({ clientId, challenge }), jar2);
    const signed = await postAuthorize(srv, jar2, p2.html, { action: 'signup', email: other, password: PASSWORD, password_confirm: PASSWORD, locale: 'en', accept_terms: 'on' });
    const deny = await postAuthorize(srv, jar2, signed.html, { action: 'deny' });
    assert.equal(deny.res.status, 302);
    const loc = new URL(deny.res.headers.get('location'));
    assert.equal(loc.searchParams.get('error'), 'access_denied');
    assert.equal(loc.searchParams.get('state'), 'st-123');
  } finally {
    await srv.close();
  }
});

test('CSRF: consent without the matching csrf cookie/field is refused', async () => {
  const srv = await startOAuthServer();
  try {
    const clientId = await dcrClient(srv);
    const { challenge } = pkcePair();
    const jar = new Jar();
    const page = await getAuthorize(srv, authorizeParams({ clientId, challenge }), jar);
    const signed = await postAuthorize(srv, jar, page.html, { action: 'signup', email: email(), password: PASSWORD, password_confirm: PASSWORD, locale: 'en', accept_terms: 'on' });
    const forged = await postAuthorize(srv, jar, signed.html, { action: 'allow', csrf: 'forged-value' });
    assert.equal(forged.res.status, 403);
    assert.equal(forged.res.headers.get('location'), null);
  } finally {
    await srv.close();
  }
});

test('token endpoint: PKCE, redirect, client and resource binding; form-urlencoded only', async () => {
  const srv = await startOAuthServer();
  try {
    const clientId = await dcrClient(srv);
    const otherClient = await dcrClient(srv);
    const grant = async () => authorize(srv, { clientId, email: email() });

    let g = await grant();
    let r = await tokenRequest(srv, { grant_type: 'authorization_code', code: g.code, redirect_uri: CLAUDE_CALLBACK, client_id: clientId, code_verifier: pkcePair().verifier });
    assert.equal(r.res.status, 400);
    assert.equal(r.json.error, 'invalid_grant', 'wrong verifier');

    g = await grant();
    r = await tokenRequest(srv, { grant_type: 'authorization_code', code: g.code, redirect_uri: CLAUDE_CALLBACK, client_id: clientId });
    assert.equal(r.json.error, 'invalid_request', 'missing verifier');

    g = await grant();
    r = await tokenRequest(srv, { grant_type: 'authorization_code', code: g.code, redirect_uri: 'http://localhost/callback', client_id: clientId, code_verifier: g.verifier });
    assert.equal(r.json.error, 'invalid_grant', 'redirect_uri mismatch');

    g = await grant();
    r = await tokenRequest(srv, { grant_type: 'authorization_code', code: g.code, redirect_uri: CLAUDE_CALLBACK, client_id: otherClient, code_verifier: g.verifier });
    assert.equal(r.json.error, 'invalid_grant', 'code bound to its client');

    g = await grant();
    r = await tokenRequest(srv, { grant_type: 'authorization_code', code: g.code, redirect_uri: CLAUDE_CALLBACK, client_id: clientId, code_verifier: g.verifier, resource: 'https://other.example/mcp' });
    assert.equal(r.json.error, 'invalid_target');

    g = await grant();
    r = await tokenRequest(srv, { grant_type: 'authorization_code', code: g.code, redirect_uri: CLAUDE_CALLBACK, client_id: clientId, code_verifier: g.verifier }, { json: true });
    assert.equal(r.res.status, 400);
    assert.equal(r.json.error, 'invalid_request', 'JSON body refused');

    r = await tokenRequest(srv, { grant_type: 'client_credentials', client_id: clientId });
    assert.equal(r.json.error, 'unsupported_grant_type');
    r = await tokenRequest(srv, { grant_type: 'authorization_code', code: 'svac_nope', redirect_uri: CLAUDE_CALLBACK, client_id: clientId, code_verifier: pkcePair().verifier });
    assert.equal(r.json.error, 'invalid_grant');
  } finally {
    await srv.close();
  }
});

test('authorization codes expire after 60 s', async () => {
  let now = Date.now();
  const srv = await startOAuthServer({ clock: () => now });
  try {
    const clientId = await dcrClient(srv);
    const g = await authorize(srv, { clientId, email: email() });
    now += 61_000;
    const r = await tokenRequest(srv, { grant_type: 'authorization_code', code: g.code, redirect_uri: CLAUDE_CALLBACK, client_id: clientId, code_verifier: g.verifier });
    assert.equal(r.json.error, 'invalid_grant');
  } finally {
    await srv.close();
  }
});

test('code reuse: the second redemption fails and revokes the tokens from the first', async () => {
  const srv = await startOAuthServer();
  try {
    const clientId = await dcrClient(srv);
    const g = await authorize(srv, { clientId, email: email() });
    const form = { grant_type: 'authorization_code', code: g.code, redirect_uri: CLAUDE_CALLBACK, client_id: clientId, code_verifier: g.verifier };
    const first = await tokenRequest(srv, form);
    assert.equal(first.res.status, 200);
    const second = await tokenRequest(srv, form);
    assert.equal(second.json.error, 'invalid_grant');
    assert.equal((await mcpPost(srv, INIT, { token: first.json.access_token })).status, 401, 'access token revoked');
    const refresh = await tokenRequest(srv, { grant_type: 'refresh_token', refresh_token: first.json.refresh_token, client_id: clientId });
    assert.equal(refresh.json.error, 'invalid_grant', 'refresh token revoked');
  } finally {
    await srv.close();
  }
});

test('refresh: rotation returns a new pair; reusing an old refresh token revokes the family', async () => {
  const srv = await startOAuthServer();
  try {
    const clientId = await dcrClient(srv);
    const t1 = await fullGrant(srv, { clientId, email: email() });
    const r2 = await tokenRequest(srv, { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: clientId });
    assert.equal(r2.res.status, 200);
    assert.notEqual(r2.json.refresh_token, t1.refresh_token);
    assert.notEqual(r2.json.access_token, t1.access_token);
    assert.equal(r2.json.scope, 'shop.read shop.write offline_access');
    assert.equal((await mcpPost(srv, INIT, { token: r2.json.access_token })).status, 200);

    const wrongClient = await tokenRequest(srv, { grant_type: 'refresh_token', refresh_token: r2.json.refresh_token, client_id: await dcrClient(srv) });
    assert.equal(wrongClient.json.error, 'invalid_grant', 'refresh token bound to its client');

    const replay = await tokenRequest(srv, { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: clientId });
    assert.equal(replay.json.error, 'invalid_grant');
    assert.equal((await mcpPost(srv, INIT, { token: r2.json.access_token })).status, 401, 'family revoked on reuse');
    const after = await tokenRequest(srv, { grant_type: 'refresh_token', refresh_token: r2.json.refresh_token, client_id: clientId });
    assert.equal(after.json.error, 'invalid_grant');
  } finally {
    await srv.close();
  }
});

test('no offline_access -> no refresh token', async () => {
  const srv = await startOAuthServer();
  try {
    const clientId = await dcrClient(srv);
    const t = await fullGrant(srv, { clientId, email: email(), scope: 'shop.read shop.write' });
    assert.equal(t.refresh_token, undefined);
    assert.equal(t.scope, 'shop.read shop.write');
  } finally {
    await srv.close();
  }
});

test('confidential DCR client must authenticate with client_secret_post', async () => {
  const srv = await startOAuthServer();
  try {
    const { json: reg } = await registerClient(srv, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'client_secret_post' });
    const g = await authorize(srv, { clientId: reg.client_id, email: email() });
    const base = { grant_type: 'authorization_code', code: g.code, redirect_uri: CLAUDE_CALLBACK, client_id: reg.client_id, code_verifier: g.verifier };
    const noSecret = await tokenRequest(srv, base);
    assert.equal(noSecret.res.status, 401);
    assert.equal(noSecret.json.error, 'invalid_client');
    const ok = await tokenRequest(srv, { ...base, client_secret: reg.client_secret });
    assert.equal(ok.res.status, 200, 'code still usable after a failed client auth');
  } finally {
    await srv.close();
  }
});

test('scopes: a read-only token can read but write tools get 403 insufficient_scope (step-up)', async () => {
  const srv = await startOAuthServer();
  try {
    const clientId = await dcrClient(srv);
    const t = await fullGrant(srv, { clientId, email: email(), scope: 'shop.read' });
    assert.equal(t.scope, 'shop.read');
    const s = await mcpSession(srv, t.access_token);
    const read = await callTool(srv, t.access_token, s.session, 'suggest_reorder', {});
    assert.equal(read.res.status, 200);
    for (const tool of ['create_reorder_draft', 'confirm_reorder']) {
      const w = await callTool(srv, t.access_token, s.session, tool, tool === 'confirm_reorder' ? { confirmation_token: 'abcdefgh12' } : {});
      assert.equal(w.res.status, 403, tool);
      const h = w.res.headers.get('www-authenticate') ?? '';
      assert.match(h, /error="insufficient_scope"/);
      assert.match(h, /scope="shop\.read shop\.write"/);
      assert.match(h, /resource_metadata=/);
    }
    // Batched JSON-RPC cannot smuggle a write call past the gate.
    const batch = await mcpPost(srv, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_reorder_draft', arguments: {} } }], { token: t.access_token, session: s.session });
    assert.equal(batch.status, 403);

    // Consent can drop write access even when the client asked for it.
    const t2 = await fullGrant(srv, { clientId, email: email(), consent: { grant_write: '' } });
    assert.equal(t2.scope, 'shop.read offline_access');
  } finally {
    await srv.close();
  }
});

test('tenant isolation: each account reaches only its own shop; a draft token does not cross accounts', async () => {
  const srv = await startOAuthServer();
  try {
    const clientId = await dcrClient(srv);
    const a = await fullGrant(srv, { clientId, email: email() });
    const b = await fullGrant(srv, { clientId, email: email() });
    const ga = await srv.oauthStore.resolveAccessToken(sha(a.access_token));
    const gb = await srv.oauthStore.resolveAccessToken(sha(b.access_token));
    assert.notEqual(ga.tenantId, gb.tenantId);
    assert.equal(ga.isSandbox, true);

    const sa = await mcpSession(srv, a.access_token);
    const draft = await callTool(srv, a.access_token, sa.session, 'create_reorder_draft', {});
    const token = draft.json.result.structuredContent.confirmation_token;
    assert.ok(token);
    const sb = await mcpSession(srv, b.access_token);
    const cross = await callTool(srv, b.access_token, sb.session, 'confirm_reorder', { confirmation_token: token });
    assert.equal(cross.json.result.structuredContent.status, 'not_found');
    // B's token cannot ride A's session either.
    const hijack = await callTool(srv, b.access_token, sa.session, 'get_low_stock', {});
    assert.equal(hijack.res.status, 404);
    const own = await callTool(srv, a.access_token, sa.session, 'confirm_reorder', { confirmation_token: token });
    assert.equal(own.json.result.structuredContent.status, 'confirmed');
  } finally {
    await srv.close();
  }
});

test('audience: a token issued for another resource is rejected at /mcp', async () => {
  const srv = await startOAuthServer();
  try {
    const clientId = await dcrClient(srv);
    const t = await fullGrant(srv, { clientId, email: email() });
    const g = await srv.oauthStore.resolveAccessToken(sha(t.access_token));
    await srv.oauthStore.issueTokens('fam-x', { clientId, accountId: g.accountId, scopes: ['shop.read'], resource: 'https://other.example/mcp' }, { accessHash: sha('svat_foreign_audience_token_000000000000000000'), accessTtlSeconds: 3600, refreshHash: null, refreshTtlSeconds: 0 });
    const res = await mcpPost(srv, INIT, { token: 'svat_foreign_audience_token_000000000000000000' });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test('revocation (RFC 7009): revoking the refresh token kills the grant; unknown tokens still 200', async () => {
  const srv = await startOAuthServer();
  try {
    const clientId = await dcrClient(srv);
    const t = await fullGrant(srv, { clientId, email: email() });
    const rv = await fetch(`${srv.url}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.refresh_token, token_type_hint: 'refresh_token', client_id: clientId }) });
    assert.equal(rv.status, 200);
    assert.equal((await mcpPost(srv, INIT, { token: t.access_token })).status, 401);
    const unknown = await fetch(`${srv.url}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: 'svrt_unknown', client_id: clientId }) });
    assert.equal(unknown.status, 200);
  } finally {
    await srv.close();
  }
});

test('account page: lists connected apps, revokes one, links a real shop with an invite code', async () => {
  const srv = await startOAuthServer({ env: { INVITE_PEPPER_B64: 'dGVzdC1wZXBwZXItMTIzNDU2' } });
  try {
    const clientId = await dcrClient(srv);
    const who = email();
    const t = await fullGrant(srv, { clientId, email: who });
    const jar = t.jar;
    const page = jar.absorb(await fetch(`${srv.url}/account`, { headers: { cookie: jar.header() } }));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Claude/);
    assert.match(html, /claude\.ai/);
    assert.match(html, /Your demo shop \(sample data\)/);

    const post = async (fields) => jar.absorb(await fetch(`${srv.url}/account`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
      body: new URLSearchParams({ csrf: hidden(html, 'csrf'), ...fields }), redirect: 'manual'
    }));
    const bad = await post({ action: 'link', invite_code: 'WRONGCODE1' });
    assert.equal(bad.status, 400);
    const revoked = await post({ action: 'revoke', client_id: clientId });
    assert.equal(revoked.status, 303);
    assert.equal((await mcpPost(srv, INIT, { token: t.access_token })).status, 401, 'revoked from the account page');

    const t2 = await fullGrant(srv, { clientId, email: who, login: true });
    const linked = await post({ action: 'link', invite_code: INVITE_CODE });
    assert.equal(linked.status, 303);
    assert.equal((await mcpPost(srv, INIT, { token: t2.access_token })).status, 401, 'linking revokes old tokens');
    const t3 = await fullGrant(srv, { clientId, email: who, login: true });
    const g = await srv.oauthStore.resolveAccessToken(sha(t3.access_token));
    assert.equal(g.tenantId, TENANT_B);
    assert.equal(g.isSandbox, false);

    const loggedOut = await fetch(`${srv.url}/account`);
    assert.equal(loggedOut.status, 200);
    assert.match(await loggedOut.text(), /name="action" value="login"/);
  } finally {
    await srv.close();
  }
});

test('Vietnamese UI sign-up still gets the USD sample shop (the demo is US-only)', async () => {
  const srv = await startOAuthServer();
  try {
    const clientId = await dcrClient(srv);
    const { challenge } = pkcePair();
    const vi = await getAuthorize(srv, { ...authorizeParams({ clientId, challenge }), ui_locales: 'vi' });
    assert.match(vi.html, /Đăng nhập|Tạo tài khoản/);
    const t = await fullGrant(srv, { clientId, email: email(), locale: 'vi' });
    const s = await mcpSession(srv, t.access_token);
    const res = await mcpPost(srv, { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'shop://profile' } }, { token: t.access_token, session: s.session });
    const profile = JSON.parse((await res.json()).result.contents[0].text);
    assert.equal(profile.display_currency, 'USD');
    assert.equal(profile.timezone, 'America/New_York');
    assert.match(profile.shop_name, /Your demo shop \(sample data\)/);
  } finally {
    await srv.close();
  }
});

test('static bearer tokens keep working next to OAuth (Alexa simulator, Devpost scripts)', async () => {
  const srv = await startOAuthServer();
  try {
    const s = await mcpSession(srv, TOKEN_A);
    assert.equal(s.status, 200);
    const draft = await callTool(srv, TOKEN_A, s.session, 'create_reorder_draft', {});
    assert.equal(draft.res.status, 200, 'static tokens keep full read/write access');
  } finally {
    await srv.close();
  }
});

test('DCR clients idle for 30 days with no live token are cleaned up; recently used ones stay', async () => {
  let now = Date.now();
  const srv = await startOAuthServer({ clock: () => now });
  try {
    const idle = await dcrClient(srv);
    const used = await dcrClient(srv);
    const t = await fullGrant(srv, { clientId: used, email: email() });
    now += 20 * 86_400_000;
    const refreshed = await tokenRequest(srv, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: used });
    assert.equal(refreshed.res.status, 200);
    now += 11 * 86_400_000;
    const removed = await srv.oauthStore.cleanup(30);
    assert.equal(removed, 1);
    assert.equal(await srv.oauthStore.getClient(idle), null);
    assert.ok(await srv.oauthStore.getClient(used), 'client used 11 days ago is kept');
  } finally {
    await srv.close();
  }
});

test('account deletion needs the typed email, then removes the account and its access', async () => {
  const srv = await startOAuthServer();
  try {
    const clientId = await dcrClient(srv);
    const who = email();
    const t = await fullGrant(srv, { clientId, email: who });
    const jar = t.jar;
    const page = await (await fetch(`${srv.url}/account`, { headers: { cookie: jar.header() } })).text();
    assert.match(page, /name="action" value="delete"/);
    const post = async (fields) => jar.absorb(await fetch(`${srv.url}/account`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
      body: new URLSearchParams({ csrf: hidden(page, 'csrf'), ...fields }), redirect: 'manual'
    }));
    const wrong = await post({ action: 'delete', confirm_email: 'someone-else@example.com' });
    assert.equal(wrong.status, 400);
    assert.equal((await mcpPost(srv, INIT, { token: t.access_token })).status, 200, 'nothing deleted');
    const del = await post({ action: 'delete', confirm_email: who.toUpperCase() });
    assert.equal(del.status, 303);
    assert.equal((await mcpPost(srv, INIT, { token: t.access_token })).status, 401);
    assert.equal(await srv.oauthStore.findCredentials(who), null);
    const after = await fetch(`${srv.url}/account?done=deleted`, { headers: { cookie: jar.header() } });
    assert.match(await after.text(), /Your account was deleted/);
  } finally {
    await srv.close();
  }
});
