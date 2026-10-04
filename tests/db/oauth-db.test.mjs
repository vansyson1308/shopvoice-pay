// Postgres tests for migration 018 (OAuth + web accounts + sandbox shops),
// run through PgOAuthStore as the RLS-bound runtime role.
// Requires DATABASE_URL pointing at a migrated database with a superuser role.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createPgPool, closePool, query } from '../../packages/common/dist/index.js';
import { PgOAuthStore } from '../../apps/mcp-server/dist/oauth/pg-store.js';
import { AccountExistsError } from '../../apps/mcp-server/dist/oauth/store.js';
import { buildSandboxCatalogue } from '../../scripts/gen_demo_seed.mjs';

const dbUrl = process.env.DATABASE_URL;
const skip = !dbUrl;
const sha = (v) => createHash('sha256').update(v).digest('hex');
const RESOURCE = 'https://shop.test/mcp';
const run = randomUUID().slice(0, 8);

let admin;
let runtimePool;
let store;

// A pool whose connections run as groceryclaw_app_runtime (no BYPASSRLS),
// the role the MCP server uses in production.
function runtimeRolePool(pool) {
  return {
    async query(text, params) {
      const client = await pool.connect();
      try {
        await client.query('SET ROLE groceryclaw_app_runtime');
        return await client.query(text, params);
      } finally {
        await client.query('RESET ROLE').catch(() => {});
        client.release();
      }
    },
    async connect() {
      const client = await pool.connect();
      await client.query('SET ROLE groceryclaw_app_runtime');
      return {
        query: (t, p) => client.query(t, p),
        release: () => {
          client.query('RESET ROLE').catch(() => {}).finally(() => client.release());
        }
      };
    },
    end: () => pool.end()
  };
}

test.before(async () => {
  if (skip) return;
  admin = await createPgPool({ connectionString: dbUrl, applicationName: 'oauth-db-test' });
  runtimePool = runtimeRolePool(await createPgPool({ connectionString: dbUrl, applicationName: 'oauth-db-test-runtime' }));
  store = new PgOAuthStore(runtimePool, { catalogue: buildSandboxCatalogue(), invitePepperB64: Buffer.from('test-pepper-0123456789').toString('base64') });
});

test.after(async () => {
  if (skip) return;
  await runtimePool.end();
  await closePool(admin);
});

async function newClient(id = `svc_${run}_${randomUUID().slice(0, 8)}`) {
  await store.registerClient({ clientId: id, clientName: 'Test client', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], tokenEndpointAuthMethod: 'none', clientSecretHash: null, registrationType: 'dcr' });
  return id;
}

async function grant(account, clientId, scopes = ['shop.read', 'shop.write', 'offline_access']) {
  const code = `svac_${randomUUID()}`;
  await store.createCode(sha(code), { clientId, accountId: account.accountId, redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', scopes, resource: RESOURCE }, 60);
  const consumed = await store.consumeCode(sha(code));
  assert.equal(consumed.outcome, 'ok');
  const access = `svat_${randomUUID()}`;
  const refresh = `svrt_${randomUUID()}`;
  await store.issueTokens(consumed.code.familyId, { clientId, accountId: account.accountId, scopes, resource: RESOURCE }, { accessHash: sha(access), accessTtlSeconds: 3600, refreshHash: sha(refresh), refreshTtlSeconds: 86400 });
  return { access, refresh, code };
}

test('runtime role cannot read OAuth tables directly (RLS forced, no grants)', { skip }, async () => {
  for (const table of ['web_accounts', 'oauth_clients', 'oauth_codes', 'oauth_tokens', 'sandbox_shops']) {
    await assert.rejects(runtimePool.query(`SELECT 1 FROM ${table} LIMIT 1`), /permission denied/, table);
  }
});

test('sign-up creates an account and a populated sandbox shop; duplicate email is refused', { skip }, async () => {
  const email = `Owner-${run}@Example.com`;
  const account = await store.createAccount({ email, passwordHash: 'scrypt$1$1$1$c2FsdA$a2V5a2V5a2V5a2V5a2V5', locale: 'en' });
  assert.equal(account.email, email.toLowerCase());
  assert.equal(account.isSandbox, true);
  assert.equal(account.shopName, 'Demo shop (sample data)');
  const counts = await admin.query(`SELECT (SELECT count(*) FROM product_cache WHERE tenant_id = $1)::int AS products,
      (SELECT count(*) FROM sales_daily WHERE tenant_id = $1)::int AS sales,
      (SELECT count(*) FROM canonical_invoices WHERE tenant_id = $1)::int AS invoices,
      (SELECT count(*) FROM stock_levels s JOIN reorder_rules r USING (tenant_id, sku) WHERE s.tenant_id = $1 AND s.on_hand_qty <= r.min_qty)::int AS low`, [account.tenantId]);
  assert.deepEqual(counts.rows[0], { products: 60, sales: 5460, invoices: 3, low: 4 });
  await assert.rejects(store.createAccount({ email: email.toUpperCase(), passwordHash: 'scrypt$x', locale: 'en' }), AccountExistsError);
  const creds = await store.findCredentials(email);
  assert.equal(creds.accountId, account.accountId);
});

test('Vietnamese sandbox uses VND; sandbox_refresh is a no-op on the same day', { skip }, async () => {
  const account = await store.createAccount({ email: `vi-${run}@example.com`, passwordHash: 'scrypt$x', locale: 'vi' });
  const profile = await admin.query('SELECT display_currency, locale FROM shop_profiles WHERE tenant_id = $1', [account.tenantId]);
  assert.deepEqual(profile.rows[0], { display_currency: 'VND', locale: 'vi-VN' });
  assert.equal(await store.refreshSandbox(account.tenantId), false);
  await admin.query("UPDATE sandbox_shops SET seeded_on = seeded_on - 3 WHERE tenant_id = $1", [account.tenantId]);
  await admin.query('DELETE FROM sales_daily WHERE tenant_id = $1', [account.tenantId]);
  assert.equal(await store.refreshSandbox(account.tenantId), true);
  const sales = await admin.query('SELECT count(*)::int AS n FROM sales_daily WHERE tenant_id = $1', [account.tenantId]);
  assert.equal(sales.rows[0].n, 5460, 're-seeded');
  const again = await admin.query('SELECT display_currency FROM shop_profiles WHERE tenant_id = $1', [account.tenantId]);
  assert.equal(again.rows[0].display_currency, 'VND', 'locale kept on re-seed');
});

test('codes are single-use; reuse revokes the issued tokens', { skip }, async () => {
  const account = await store.createAccount({ email: `code-${run}@example.com`, passwordHash: 'scrypt$x', locale: 'en' });
  const clientId = await newClient();
  const t = await grant(account, clientId);
  assert.ok(await store.resolveAccessToken(sha(t.access)));
  assert.equal((await store.consumeCode(sha(t.code))).outcome, 'reused');
  assert.equal(await store.resolveAccessToken(sha(t.access)), null);
  assert.equal((await store.consumeCode(sha('svac_unknown'))).outcome, 'invalid');
});

test('access tokens resolve to the account tenant; refresh rotation and reuse detection', { skip }, async () => {
  const account = await store.createAccount({ email: `rot-${run}@example.com`, passwordHash: 'scrypt$x', locale: 'en' });
  const clientId = await newClient();
  const t = await grant(account, clientId);
  const g = await store.resolveAccessToken(sha(t.access));
  assert.equal(g.tenantId, account.tenantId);
  assert.equal(g.resource, RESOURCE);
  assert.deepEqual([...g.scopes].sort(), ['offline_access', 'shop.read', 'shop.write']);
  const next = { accessHash: sha(`a2-${run}`), accessTtlSeconds: 3600, refreshHash: sha(`r2-${run}`), refreshTtlSeconds: 86400 };
  assert.equal((await store.rotateRefreshToken(sha(t.refresh), 'svc_other', next)).outcome, 'invalid', 'bound to client');
  const ok = await store.rotateRefreshToken(sha(t.refresh), clientId, next);
  assert.equal(ok.outcome, 'ok');
  assert.ok(await store.resolveAccessToken(next.accessHash));
  const replay = await store.rotateRefreshToken(sha(t.refresh), clientId, { accessHash: sha(`a3-${run}`), accessTtlSeconds: 3600, refreshHash: sha(`r3-${run}`), refreshTtlSeconds: 86400 });
  assert.equal(replay.outcome, 'reuse');
  assert.equal(await store.resolveAccessToken(next.accessHash), null, 'family revoked');
});

test('grants list and revoke; revoke_token kills the family', { skip }, async () => {
  const account = await store.createAccount({ email: `grants-${run}@example.com`, passwordHash: 'scrypt$x', locale: 'en' });
  const c1 = await newClient();
  const c2 = await newClient();
  const t1 = await grant(account, c1);
  await grant(account, c2, ['shop.read']);
  const grants = await store.listGrants(account.accountId);
  assert.equal(grants.length, 2);
  assert.deepEqual(grants.find((x) => x.clientId === c2).scopes, ['shop.read']);
  assert.ok((await store.revokeGrant(account.accountId, c2)) >= 1);
  assert.equal((await store.listGrants(account.accountId)).length, 1);
  assert.equal(await store.revokeToken(sha(t1.refresh), c2), false, 'other client cannot revoke');
  assert.equal(await store.revokeToken(sha(t1.refresh), c1), true);
  assert.equal(await store.resolveAccessToken(sha(t1.access)), null);
});

test('CIMD clients upsert; idle DCR clients are cleaned up', { skip }, async () => {
  const cimdId = `https://client-${run}.example/metadata.json`;
  const base = { clientId: cimdId, clientName: 'A', redirectUris: ['http://localhost/callback'], tokenEndpointAuthMethod: 'none', clientSecretHash: null, registrationType: 'cimd' };
  await store.registerClient(base);
  await store.registerClient({ ...base, clientName: 'B' });
  assert.equal((await store.getClient(cimdId)).clientName, 'B');
  const idle = await newClient();
  await admin.query("UPDATE oauth_clients SET created_at = now() - interval '40 days' WHERE client_id = $1", [idle]);
  assert.ok((await store.cleanup(30)) >= 1);
  assert.equal(await store.getClient(idle), null);
});

test('login lockout after 5 failures', { skip }, async () => {
  const account = await store.createAccount({ email: `lock-${run}@example.com`, passwordHash: 'scrypt$x', locale: 'en' });
  for (let i = 0; i < 5; i += 1) await store.recordLogin(account.accountId, false);
  const creds = await store.findCredentials(`lock-${run}@example.com`);
  assert.ok(creds.lockedUntilMs > Date.now());
  await store.recordLogin(account.accountId, true);
  assert.equal((await store.findCredentials(`lock-${run}@example.com`)).lockedUntilMs, null);
});

test('invite link switches the account to the real tenant and revokes its tokens', { skip }, async () => {
  const account = await store.createAccount({ email: `link-${run}@example.com`, passwordHash: 'scrypt$x', locale: 'en' });
  const clientId = await newClient();
  const t = await grant(account, clientId);
  const real = randomUUID();
  await admin.query("INSERT INTO tenants (id, name, status, processing_mode) VALUES ($1, 'Real Shop', 'active', 'v2')", [real]);
  const code = `REAL${run.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
  const pepper = Buffer.from('test-pepper-0123456789');
  const codeHash = createHash('sha256').update(Buffer.concat([pepper, Buffer.from(code)])).digest();
  await admin.query("INSERT INTO invite_codes (tenant_id, code_hash, code_hint, target_role, expires_at) VALUES ($1, $2, 'RE..', 'staff', now() + interval '1 day')", [real, codeHash]);
  assert.deepEqual(await store.linkInvite(account.accountId, 'WRONGCODE9'), { ok: false, tenantId: null });
  const linked = await store.linkInvite(account.accountId, code);
  assert.deepEqual(linked, { ok: true, tenantId: real });
  assert.equal(await store.resolveAccessToken(sha(t.access)), null, 'old tokens revoked');
  const after = await store.getAccount(account.accountId);
  assert.equal(after.tenantId, real);
  assert.equal(after.isSandbox, false);
});

test('account deletion erases the sandbox shop and tokens; audit purge keeps 90 days', { skip }, async () => {
  const account = await store.createAccount({ email: `del-${run}@example.com`, passwordHash: 'scrypt$x', locale: 'en' });
  const clientId = await newClient();
  const t = await grant(account, clientId);
  await admin.query("INSERT INTO voice_audit_log (tenant_id, tool_name, created_at) VALUES ($1, 'old', now() - interval '91 days'), ($1, 'new', now())", [account.tenantId]);
  const removed = await store.purgeAuditLog(90);
  assert.ok(removed >= 1);
  const left = await admin.query('SELECT tool_name FROM voice_audit_log WHERE tenant_id = $1', [account.tenantId]);
  assert.deepEqual(left.rows.map((r) => r.tool_name), ['new']);
  assert.equal(await store.deleteAccount(account.accountId), true);
  assert.equal(await store.findCredentials(`del-${run}@example.com`), null);
  assert.equal(await store.resolveAccessToken(sha(t.access)), null);
  const rest = await admin.query(`SELECT (SELECT count(*) FROM sales_daily WHERE tenant_id = $1)::int AS sales,
      (SELECT count(*) FROM voice_audit_log WHERE tenant_id = $1)::int AS audit,
      (SELECT status FROM tenants WHERE id = $1) AS status,
      (SELECT count(*) FROM platform_users WHERE platform_user_id = $2)::int AS users`, [account.tenantId, `web:${account.accountId}`]);
  assert.deepEqual(rest.rows[0], { sales: 0, audit: 0, status: 'suspended', users: 0 });
  assert.equal(await store.deleteAccount(account.accountId), false);
});

test('migration 018 installs its functions', { skip }, async () => {
  const fns = await query(admin, "SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'oauth\\_%' OR proname LIKE 'web\\_account\\_%'");
  assert.ok(fns.rows[0].n >= 15);
});
