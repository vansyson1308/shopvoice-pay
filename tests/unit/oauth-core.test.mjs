// Unit tests for the ShopVoice OAuth building blocks (no network, no DB):
// PKCE, password hashing, signed cookies, redirect matching, metadata
// documents, WWW-Authenticate, scopes, CIMD validation and the SSRF guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  hashPassword, verifyPassword, pkceS256Challenge, verifyPkce, isValidCodeVerifier,
  signCookieValue, verifyCookieValue, randomToken, sha256Hex
} from '../../apps/mcp-server/dist/oauth/crypto.js';
import {
  CLAUDE_CALLBACK, isLoopbackRedirect, redirectUriMatches, validateRegisteredRedirectUri
} from '../../apps/mcp-server/dist/oauth/redirect.js';
import {
  oauthUrls, protectedResourceMetadata, authorizationServerMetadata, wwwAuthenticate, parseScopeParam
} from '../../apps/mcp-server/dist/oauth/metadata.js';
import { CimdResolver, isCimdClientId, validateCimdDocument } from '../../apps/mcp-server/dist/oauth/cimd.js';
import { isPublicIpAddress, validatePublicHttpsUrl } from '../../packages/common/dist/index.js';

const b64url = (buf) => buf.toString('base64url');

test('PKCE S256: RFC 7636 appendix B vector and failure cases', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(pkceS256Challenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(verifyPkce(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'), true);
  assert.equal(verifyPkce(`${verifier}x`, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'), false, 'wrong verifier');
  assert.equal(verifyPkce('short', pkceS256Challenge('short')), false, 'verifier under 43 chars is rejected');
  assert.equal(verifyPkce('a'.repeat(129), pkceS256Challenge('a'.repeat(129))), false, 'over 128 chars is rejected');
  assert.equal(isValidCodeVerifier(`${'a'.repeat(42)}!`), false, 'charset is unreserved only');
  assert.equal(isValidCodeVerifier('a'.repeat(43)), true);
  // The plain method is never accepted: a challenge equal to the verifier fails.
  assert.equal(verifyPkce('a'.repeat(43), 'a'.repeat(43)), false);
});

test('passwords: scrypt hash round-trips, never stores plaintext, rejects wrong password', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$/);
  assert.ok(!hash.includes('correct horse'));
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('correct horse batterx', hash), false);
  assert.equal(await verifyPassword('anything', 'scrypt$garbage'), false);
  assert.notEqual(await hashPassword('same'), await hashPassword('same'), 'salted');
});

test('signed cookie values: tamper, wrong secret and expiry are rejected', () => {
  const secret = 'k'.repeat(32);
  const v = signCookieValue('acct-1', secret, 10_000);
  assert.equal(verifyCookieValue(v, secret, 5_000), 'acct-1');
  assert.equal(verifyCookieValue(v, secret, 10_001), null, 'expired');
  assert.equal(verifyCookieValue(v, 'x'.repeat(32), 5_000), null, 'wrong secret');
  assert.equal(verifyCookieValue(v.replace(/^./, (c) => (c === 'Y' ? 'Z' : 'Y')), secret, 5_000), null, 'tampered payload');
  assert.equal(verifyCookieValue('garbage', secret, 5_000), null);
});

test('random tokens are prefixed, url-safe and hash to hex', () => {
  const t = randomToken('svat');
  assert.match(t, /^svat_[A-Za-z0-9_-]{43}$/);
  assert.equal(sha256Hex('abc'), createHash('sha256').update('abc').digest('hex'));
});

test('redirect matching: exact Claude callback, port-agnostic loopback, everything else exact', () => {
  const claudeCode = ['http://localhost/callback', 'http://127.0.0.1/callback'];
  assert.equal(redirectUriMatches(CLAUDE_CALLBACK, [CLAUDE_CALLBACK]), true);
  assert.equal(redirectUriMatches(`${CLAUDE_CALLBACK}/`, [CLAUDE_CALLBACK]), false, 'trailing slash differs');
  assert.equal(redirectUriMatches('https://claude.ai/api/mcp/auth_callback?x=1', [CLAUDE_CALLBACK]), false);
  assert.equal(redirectUriMatches('https://evil.example/api/mcp/auth_callback', [CLAUDE_CALLBACK]), false);
  assert.equal(redirectUriMatches('http://localhost:3118/callback', claudeCode), true, 'any port on localhost');
  assert.equal(redirectUriMatches('http://127.0.0.1:53682/callback', claudeCode), true, 'any port on 127.0.0.1');
  assert.equal(redirectUriMatches('http://localhost/callback', claudeCode), true, 'no port');
  assert.equal(redirectUriMatches('http://localhost:3118/other', claudeCode), false, 'path must match');
  assert.equal(redirectUriMatches('http://localhost:3118/callback?code=x', claudeCode), false, 'query must match');
  assert.equal(redirectUriMatches('https://localhost:3118/callback', claudeCode), false, 'scheme must match');
  assert.equal(redirectUriMatches('http://localhost.evil.com:3118/callback', claudeCode), false);
  assert.equal(redirectUriMatches('http://[::1]:9000/callback', ['http://[::1]/callback']), true, 'IPv6 loopback');
  assert.equal(redirectUriMatches('http://127.0.0.1:9000/callback', ['http://localhost/callback']), false, 'host must match');
  assert.equal(redirectUriMatches('not a url', claudeCode), false);
  assert.equal(redirectUriMatches('https://app.example/cb#frag', ['https://app.example/cb#frag']), false, 'fragments never allowed');
  assert.equal(isLoopbackRedirect('http://127.0.0.1:1/x'), true);
  assert.equal(isLoopbackRedirect(CLAUDE_CALLBACK), false);
});

test('registered redirect URIs: https or http loopback only, no fragments or userinfo', () => {
  assert.equal(validateRegisteredRedirectUri(CLAUDE_CALLBACK), true);
  assert.equal(validateRegisteredRedirectUri('http://localhost/callback'), true);
  assert.equal(validateRegisteredRedirectUri('http://127.0.0.1:8080/cb'), true);
  assert.equal(validateRegisteredRedirectUri('http://example.com/cb'), false, 'plain http on a public host');
  assert.equal(validateRegisteredRedirectUri('https://example.com/cb#x'), false);
  assert.equal(validateRegisteredRedirectUri('https://user:pw@example.com/cb'), false);
  assert.equal(validateRegisteredRedirectUri('javascript:alert(1)'), false);
  assert.equal(validateRegisteredRedirectUri('com.example.app:/cb'), false);
});

test('metadata documents: PRM and RFC 8414 carry what Claude checks', () => {
  const urls = oauthUrls('https://shop.example.com/');
  assert.equal(urls.issuer, 'https://shop.example.com', 'no trailing slash');
  assert.equal(urls.resource, 'https://shop.example.com/mcp');
  const prm = protectedResourceMetadata(urls);
  assert.equal(prm.resource, 'https://shop.example.com/mcp');
  assert.deepEqual(prm.authorization_servers, ['https://shop.example.com']);
  assert.deepEqual(prm.scopes_supported, ['shop.read', 'shop.write', 'offline_access']);
  assert.deepEqual(prm.bearer_methods_supported, ['header']);
  const as = authorizationServerMetadata(urls);
  assert.equal(as.issuer, 'https://shop.example.com');
  assert.equal(as.authorization_endpoint, 'https://shop.example.com/oauth/authorize');
  assert.equal(as.token_endpoint, 'https://shop.example.com/oauth/token');
  assert.equal(as.registration_endpoint, 'https://shop.example.com/oauth/register');
  assert.equal(as.revocation_endpoint, 'https://shop.example.com/oauth/revoke');
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.deepEqual(as.response_types_supported, ['code']);
  assert.ok(as.token_endpoint_auth_methods_supported.includes('none'), 'CIMD needs "none"');
  assert.ok(as.token_endpoint_auth_methods_supported.includes('client_secret_post'));
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.deepEqual(as.scopes_supported, ['shop.read', 'shop.write', 'offline_access']);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
});

test('WWW-Authenticate: resource_metadata + scope on 401, insufficient_scope on 403', () => {
  const urls = oauthUrls('https://shop.example.com');
  const h401 = wwwAuthenticate(urls, {});
  assert.match(h401, /^Bearer realm="shopvoice"/);
  assert.match(h401, /resource_metadata="https:\/\/shop\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(h401, /scope="shop\.read shop\.write"/);
  const bad = wwwAuthenticate(urls, { error: 'invalid_token' });
  assert.match(bad, /error="invalid_token"/);
  const h403 = wwwAuthenticate(urls, { error: 'insufficient_scope', scope: 'shop.read shop.write', description: 'Needs shop.write' });
  assert.match(h403, /error="insufficient_scope"/);
  assert.match(h403, /scope="shop\.read shop\.write"/);
  assert.match(h403, /error_description="Needs shop\.write"/);
});

test('scope parameter parsing: defaults, dedupe, unknown scopes rejected', () => {
  assert.deepEqual(parseScopeParam(undefined), ['shop.read', 'shop.write']);
  assert.deepEqual(parseScopeParam(''), ['shop.read', 'shop.write']);
  assert.deepEqual(parseScopeParam('shop.read  shop.read offline_access'), ['shop.read', 'offline_access']);
  assert.equal(parseScopeParam('shop.read admin'), null);
  assert.deepEqual(parseScopeParam('offline_access'), ['shop.read', 'offline_access'], 'shop.read is implied');
});

test('SSRF guard: only public https hosts on port 443', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.5', '192.168.1.1', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3']) {
    assert.equal(isPublicIpAddress(ip), false, ip);
  }
  for (const ip of ['1.1.1.1', '160.79.104.10', '2606:4700::1111']) assert.equal(isPublicIpAddress(ip), true, ip);
  assert.equal(validatePublicHttpsUrl('https://claude.ai/oauth/claude-code-client-metadata').ok, true);
  for (const bad of ['http://claude.ai/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x',
    'https://10.0.0.1/x', 'https://claude.ai:8443/x', 'https://user@claude.ai/x', 'https://metadata.internal/x',
    'https://printer.local/x', 'ftp://claude.ai/x', 'not-a-url']) {
    assert.equal(validatePublicHttpsUrl(bad).ok, false, bad);
  }
});

const CC_ID = 'https://claude.ai/oauth/claude-code-client-metadata';
const CC_DOC = {
  client_id: CC_ID,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none'
};

test('CIMD client ids and documents are validated', () => {
  assert.equal(isCimdClientId(CC_ID), true);
  assert.equal(isCimdClientId('https://claude.ai'), false, 'needs a path');
  assert.equal(isCimdClientId('https://claude.ai/'), false, 'needs a non-root path');
  assert.equal(isCimdClientId('http://claude.ai/x'), false);
  assert.equal(isCimdClientId('svc_abc123'), false);
  assert.equal(isCimdClientId('https://claude.ai/x#f'), false);
  const doc = validateCimdDocument(CC_ID, CC_DOC);
  assert.equal(doc.clientName, 'Claude Code');
  assert.deepEqual(doc.redirectUris, CC_DOC.redirect_uris);
  assert.throws(() => validateCimdDocument(CC_ID, { ...CC_DOC, client_id: 'https://evil.example/x' }), /client_id_mismatch/);
  assert.throws(() => validateCimdDocument(CC_ID, { ...CC_DOC, redirect_uris: [] }), /invalid_redirect_uris/);
  assert.throws(() => validateCimdDocument(CC_ID, { ...CC_DOC, redirect_uris: ['http://evil.example/cb'] }), /invalid_redirect_uris/);
  assert.throws(() => validateCimdDocument(CC_ID, { ...CC_DOC, token_endpoint_auth_method: 'private_key_jwt' }), /unsupported_auth_method/);
  assert.throws(() => validateCimdDocument(CC_ID, { ...CC_DOC, client_secret: 'x' }), /client_secret_not_allowed/);
  assert.throws(() => validateCimdDocument(CC_ID, 'nope'), /invalid_document/);
});

test('CIMD resolver: fetches once, caches by max-age, enforces size and SSRF rules', async () => {
  const calls = [];
  let now = 1_000_000;
  const fetcher = async (url) => {
    calls.push(url.href);
    return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=120' }, body: JSON.stringify(CC_DOC) };
  };
  const resolver = new CimdResolver({ fetcher, now: () => now });
  const doc = await resolver.resolve(CC_ID);
  assert.equal(doc.clientId, CC_ID);
  await resolver.resolve(CC_ID);
  assert.equal(calls.length, 1, 'cached');
  now += 121_000;
  await resolver.resolve(CC_ID);
  assert.equal(calls.length, 2, 'refetched after max-age');

  await assert.rejects(resolver.resolve('https://10.0.0.5/client.json'), /unsafe_url/);
  await assert.rejects(resolver.resolve('https://localhost/client.json'), /unsafe_url/);

  const big = new CimdResolver({ fetcher: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: 'x'.repeat(10_000) }), now: () => now });
  await assert.rejects(big.resolve('https://app.example/c.json'), /document_too_large/);
  const html = new CimdResolver({ fetcher: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '{}' }), now: () => now });
  await assert.rejects(html.resolve('https://app.example/c.json'), /invalid_content_type/);
  const notFound = new CimdResolver({ fetcher: async () => ({ status: 404, headers: {}, body: '' }), now: () => now });
  await assert.rejects(notFound.resolve('https://app.example/c.json'), /fetch_failed/);
});
