// Shared helpers for the ShopVoice OAuth flow tests (not a test file itself).
// The server runs on 127.0.0.1 with PUBLIC_BASE_URL=https://shop.test: the
// issuer/resource strings are logical, requests go to the local port.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createMcpHttpHandler } from '../../apps/mcp-server/dist/http.js';
import { loadMcpServerConfig } from '../../apps/mcp-server/dist/config.js';
import { MemoryShopStore } from '../../apps/mcp-server/dist/memory-store.js';
import { MemoryOAuthStore } from '../../apps/mcp-server/dist/oauth/store.js';
import { CimdResolver } from '../../apps/mcp-server/dist/oauth/cimd.js';
import { buildSandboxTenantData, SANDBOX_PROFILES } from '../../scripts/v2/gen_demo_seed.mjs';
import { ANCHOR, TENANT_B, twoTenantDataset, silentLogger } from './mcp-harness.mjs';

export const BASE = 'https://shop.test';
export const RESOURCE = `${BASE}/mcp`;
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
export const CC_CIMD = 'https://claude.ai/oauth/claude-code-client-metadata';
export const INVITE_CODE = 'LINKSHOP42';
export const PASSWORD = 'correct horse battery staple';

export const CC_DOC = {
  client_id: CC_CIMD,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none'
};

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function startOAuthServer({ env = {}, cimdDocs = { [CC_CIMD]: CC_DOC }, clock } = {}) {
  const shopStore = new MemoryShopStore(twoTenantDataset(), clock);
  const cimdFetches = [];
  const cimd = new CimdResolver({
    fetcher: async (url) => {
      cimdFetches.push(url.href);
      const doc = cimdDocs[url.href];
      return doc
        ? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }
        : { status: 404, headers: {}, body: '' };
    }
  });
  const oauthStore = new MemoryOAuthStore({
    provision: (tenantId, locale) => {
      shopStore.addTenant(tenantId, buildSandboxTenantData(locale, ANCHOR));
      return SANDBOX_PROFILES[locale].shop_name;
    },
    remove: (tenantId) => shopStore.removeTenant(tenantId),
    redeemInvite: (code) => (code.replace(/[\s-]/g, '').toUpperCase() === INVITE_CODE ? { tenantId: TENANT_B, shopName: 'Other Shop' } : null)
  }, clock);
  const config = loadMcpServerConfig({
    MCP_DATA_BACKEND: 'memory',
    MCP_ALLOW_LOCALHOST_ORIGINS: 'false',
    MCP_ALLOWED_ORIGINS: 'https://sim.example',
    PUBLIC_BASE_URL: BASE,
    OAUTH_COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
    ...env
  });
  const handler = createMcpHttpHandler({ store: shopStore, config, logger: silentLogger, oauth: { store: oauthStore, cimd } });
  const server = createServer((req, res) => { void handler.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    shopStore,
    oauthStore,
    cimdFetches,
    handler,
    async close() {
      await handler.close();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

// ---- tiny cookie jar + HTML helpers ---------------------------------------
export class Jar {
  constructor() { this.cookies = new Map(); }
  absorb(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/max-age=0/i.test(line) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
}

export function hidden(html, name) {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null;
}

export function authorizeParams({ clientId, redirectUri = CLAUDE_CALLBACK, challenge, scope = 'shop.read shop.write offline_access', state = 'st-123', resource = RESOURCE, method = 'S256' } = {}) {
  const p = { response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state };
  if (challenge !== undefined) p.code_challenge = challenge;
  if (method !== undefined) p.code_challenge_method = method;
  if (scope !== undefined) p.scope = scope;
  if (resource !== undefined) p.resource = resource;
  return p;
}

export async function getAuthorize(srv, params, jar = new Jar()) {
  const res = jar.absorb(await fetch(`${srv.url}/oauth/authorize?${new URLSearchParams(params)}`, { headers: { cookie: jar.header() }, redirect: 'manual' }));
  return { res, html: res.status === 200 ? await res.text() : '', jar };
}

export async function postAuthorize(srv, jar, html, fields) {
  const body = new URLSearchParams();
  for (const name of ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource', 'csrf']) {
    const v = hidden(html, name);
    if (v !== null) body.set(name, v);
  }
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const res = jar.absorb(await fetch(`${srv.url}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
    body,
    redirect: 'manual'
  }));
  return { res, html: res.status >= 300 && res.status < 400 ? '' : await res.text() };
}

export async function registerClient(srv, body) {
  const res = await fetch(`${srv.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { res, json: await res.json().catch(() => null) };
}

export async function tokenRequest(srv, form, { json = false } = {}) {
  const res = await fetch(`${srv.url}/oauth/token`, json
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) }
    : { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  return { res, json: await res.json().catch(() => null) };
}

/** Sign up (or log in) and consent; returns the authorization code and the redirect URL. */
export async function authorize(srv, { clientId, redirectUri = CLAUDE_CALLBACK, scope, email, locale = 'en', login = false, jar = new Jar(), consent = {} }) {
  const { verifier, challenge } = pkcePair();
  const first = await getAuthorize(srv, authorizeParams({ clientId, redirectUri, challenge, scope }), jar);
  let page = first.html;
  if (!/name="action" value="allow"/.test(page)) {
    const step = await postAuthorize(srv, jar, page, login
      ? { action: 'login', email, password: PASSWORD }
      : { action: 'signup', email, password: PASSWORD, password_confirm: PASSWORD, locale, accept_terms: 'on' });
    if (step.res.status !== 200) throw new Error(`login/signup failed: ${step.res.status}`);
    page = step.html;
  }
  const allow = await postAuthorize(srv, jar, page, { action: 'allow', grant_write: '1', ...consent });
  const location = allow.res.headers.get('location') ?? '';
  const url = new URL(location);
  return { code: url.searchParams.get('code'), redirect: url, verifier, jar, consentHtml: page, status: allow.res.status };
}

export async function fullGrant(srv, opts) {
  const { code, verifier, redirect, jar } = await authorize(srv, opts);
  const { res, json } = await tokenRequest(srv, {
    grant_type: 'authorization_code', code, redirect_uri: opts.redirectUri ?? CLAUDE_CALLBACK, client_id: opts.clientId, code_verifier: verifier, resource: RESOURCE
  });
  if (res.status !== 200) throw new Error(`token exchange failed: ${res.status} ${JSON.stringify(json)}`);
  return { ...json, jar, redirect };
}

export async function dcrClient(srv, redirectUris = [CLAUDE_CALLBACK]) {
  const { json } = await registerClient(srv, { client_name: 'Claude', redirect_uris: redirectUris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  return json.client_id;
}

export const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'oauth-test', version: '1.0.0' } }
};

export async function mcpPost(srv, body, { token, session } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (session) {
    headers['mcp-session-id'] = session;
    headers['mcp-protocol-version'] = '2025-11-25';
  }
  return fetch(`${srv.url}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
}

export async function mcpSession(srv, token) {
  const res = await mcpPost(srv, INIT, { token });
  if (res.status !== 200) return { status: res.status, res };
  const session = res.headers.get('mcp-session-id');
  await res.text();
  await mcpPost(srv, { jsonrpc: '2.0', method: 'notifications/initialized' }, { token, session }).then((r) => r.text());
  return { status: 200, session };
}

export async function callTool(srv, token, session, name, args = {}, id = 7) {
  const res = await mcpPost(srv, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, { token, session });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE or error body */ }
  return { res, json };
}

export { ANCHOR, TENANT_B };
