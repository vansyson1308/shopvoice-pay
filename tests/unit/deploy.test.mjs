// Hosted deploy (render.yaml): proxy-aware client addresses, database settings from
// separate parts, the console reaching the MCP server by host:port, and a drift
// check that every variable the blueprint sets is one the code reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { clientIpFrom, trustedProxyHops } from '../../packages/common/dist/index.js';
import { databaseUrlFromParts, loadMcpServerConfig } from '../../apps/mcp-server/dist/config.js';
import { loadSimConfig } from '../../apps/console/dist/server.js';
import { adminUrlFrom, checkAppRole } from '../../scripts/deploy/db_prepare.mjs';

const req = (xff, remote = '10.0.0.5') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } });

test('clientIpFrom: with 2 trusted hops the viewer is second from the right; forged entries on the left are ignored', () => {
  assert.equal(clientIpFrom(req('6.6.6.6, 203.0.113.9, 10.1.2.3'), 2), '203.0.113.9');
  assert.equal(clientIpFrom(req('203.0.113.9, 10.1.2.3'), 2), '203.0.113.9');
  assert.equal(clientIpFrom(req('203.0.113.9'), 2), '10.0.0.5', 'shorter chain than expected: header ignored');
  assert.equal(clientIpFrom(req('1.2.3.4, 203.0.113.9'), 1), '203.0.113.9');
  assert.equal(clientIpFrom(req('1.2.3.4, 203.0.113.9'), 0), '10.0.0.5');
});

test('trustedProxyHops parses true/false/counts and caps them', () => {
  assert.equal(trustedProxyHops(undefined), 0);
  assert.equal(trustedProxyHops(''), 0);
  assert.equal(trustedProxyHops('false'), 0);
  assert.equal(trustedProxyHops('true'), 1);
  assert.equal(trustedProxyHops('2'), 2);
  assert.equal(trustedProxyHops('99'), 5);
  assert.equal(trustedProxyHops('nope'), 0);
});

test('MCP database URL can be assembled from parts; the password is URL-encoded', () => {
  // Random per run, with every character that must be escaped in a URL.
  const generated = `${randomBytes(9).toString('hex')}/+=:@`;
  const env = { MCP_DB_HOST: 'shopvoice-db', MCP_DB_PORT: '5432', MCP_DB_NAME: 'shopvoice', MCP_DB_USER: 'shopvoice_app', MCP_DB_PASSWORD: generated };
  const url = databaseUrlFromParts(env);
  assert.equal(url, `postgresql://shopvoice_app:${encodeURIComponent(generated)}@shopvoice-db:5432/shopvoice`);
  assert.equal(decodeURIComponent(new URL(url).password), generated);
  assert.equal(new URL(url).hostname, 'shopvoice-db');
  assert.equal(loadMcpServerConfig({ ...env, MCP_DATA_BACKEND: 'postgres' }).databaseUrl, url);
  assert.equal(loadMcpServerConfig({ ...env, MCP_DB_URL: 'postgresql://x@y/z' }).databaseUrl, 'postgresql://x@y/z', 'an explicit URL wins');
  assert.equal(databaseUrlFromParts({ MCP_DB_HOST: 'h' }), '', 'no user: no URL');
  assert.throws(() => loadMcpServerConfig({ MCP_DATA_BACKEND: 'postgres' }), /MCP_DB_HOST/);
  assert.equal(loadMcpServerConfig({ MCP_DATA_BACKEND: 'memory', MCP_TRUST_PROXY: '2' }).trustProxy, 2);
});

test('console reaches the MCP server by private host:port; owner API and demo provisioning follow it', () => {
  const c = loadSimConfig({ SIM_MCP_HOSTPORT: 'shopvoice-mcp-abc:10000', SIM_TRUST_PROXY: '2' });
  assert.equal(c.mcpUrl, 'http://shopvoice-mcp-abc:10000/mcp');
  assert.equal(c.ownerApiUrl, 'http://shopvoice-mcp-abc:10000/owner/api');
  assert.equal(c.demoProvisionUrl, 'http://shopvoice-mcp-abc:10000/owner/demo-shops');
  assert.equal(c.trustProxy, 2);
  assert.equal(loadSimConfig({ SIM_MCP_URL: 'http://a:1/mcp', SIM_MCP_HOSTPORT: 'b:2' }).mcpUrl, 'http://a:1/mcp');
  assert.equal(loadSimConfig({}).mcpUrl, 'http://127.0.0.1:8090/mcp');
  assert.equal(loadSimConfig({}).trustProxy, 0);
});

test('db_prepare: admin URL from parts, and the app login must be a dedicated role with a real password', () => {
  const generated = `${randomBytes(9).toString('hex')}/`;
  const admin = new URL(adminUrlFrom({ MCP_DB_HOST: 'db', POSTGRES_PASSWORD: generated }));
  assert.equal(admin.username, 'postgres');
  assert.equal(decodeURIComponent(admin.password), generated);
  assert.equal(admin.host, 'db:5432');
  assert.equal(admin.pathname, '/shopvoice');
  assert.equal(adminUrlFrom({ DB_ADMIN_URL: 'postgresql://a@b/c' }), 'postgresql://a@b/c');
  assert.throws(() => adminUrlFrom({ MCP_DB_HOST: 'db' }), /DB_ADMIN_PASSWORD/);
  assert.doesNotThrow(() => checkAppRole('shopvoice_app', generated.repeat(2)));
  for (const bad of ['postgres', 'groceryclaw_app_runtime', 'app_user', 'pg_monitor', 'Robert"; DROP', '']) {
    assert.throws(() => checkAppRole(bad, 'x'.repeat(16)), /MCP_DB_USER/, bad);
  }
  assert.throws(() => checkAppRole('shopvoice_app', 'short'), /MCP_DB_PASSWORD/);
});

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

test('render.yaml: services, Dockerfiles and the pre-deploy script exist, and every variable it sets is read by the code', () => {
  const yaml = readFileSync('render.yaml', 'utf8');
  const services = [...yaml.matchAll(/^ {4}name: (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(services.sort(), ['shopvoice-console', 'shopvoice-db', 'shopvoice-mcp']);
  for (const ref of yaml.matchAll(/fromService:\n\s+type: \w+\n\s+name: (\S+)/g)) assert.ok(services.includes(ref[1]), ref[1]);
  for (const m of yaml.matchAll(/dockerfilePath: (\S+)/g)) assert.ok(existsSync(m[1]), m[1]);
  const preDeploy = yaml.match(/preDeployCommand: node (\S+)/)[1];
  assert.ok(existsSync(preDeploy));
  assert.doesNotMatch(yaml, /PAYPAL_MODE\n\s+value: (?!sandbox)/, 'sandbox only');
  assert.doesNotMatch(yaml, /api-m\.paypal\.com/);

  const groups = [...yaml.matchAll(/^ {2}- name: (\S+)$/gm)].map((m) => m[1]);
  for (const ref of yaml.matchAll(/fromGroup: (\S+)/g)) assert.ok(groups.includes(ref[1]), ref[1]);

  const code = ['apps', 'packages', 'scripts'].flatMap((d) => sourceFiles(d)).map((f) => readFileSync(f, 'utf8')).join('\n');
  const forPostgresImage = new Set(['POSTGRES_DB', 'PGDATA']);
  const keys = [...yaml.matchAll(/- key: (\w+)/g)].map((m) => m[1]).filter((k) => !forPostgresImage.has(k));
  assert.ok(keys.length > 20);
  for (const key of keys) assert.ok(new RegExp(`\\b${key}\\b`).test(code), `render.yaml sets ${key}, which no code reads`);
});
