import { createServer } from 'node:http';
import { createLogger, createPgPool } from '../../../packages/common/dist/index.js';
import type { LogLevel } from '../../../packages/common/dist/index.js';
import { loadMcpServerConfig } from './config.js';
import { createMcpHttpHandler } from './http.js';
import type { McpHttpDeps } from './http.js';
import { PgShopStore } from './pg-store.js';
import { MemoryShopStore } from './memory-store.js';
import type { MemoryDataset, MemoryTenantData } from './memory-store.js';
import type { ShopStore } from './store.js';
import { MemoryOAuthStore } from './oauth/store.js';
import type { Locale, OAuthStore } from './oauth/store.js';
import { PgOAuthStore } from './oauth/pg-store.js';
import { connectMockPayPal, loadPaymentsSetup } from './payments-setup.js';
import type { PaymentsSetup } from './payments-setup.js';

const logger = createLogger({ service: 'mcp-server', level: (process.env.LOG_LEVEL ?? 'info') as LogLevel });

interface DemoSeedModule {
  buildDemoDataset(opts: { anchorDate?: string; tokens: Record<string, string>; env?: Record<string, string | undefined> }): MemoryDataset;
  buildSandboxCatalogue(env?: Record<string, string | undefined>): unknown;
  buildSandboxTenantData(locale: Locale, anchorDate?: string, env?: Record<string, string | undefined>): MemoryTenantData;
  SANDBOX_PROFILES: { en: { shop_name: string } };
  DEMO_TENANT_ID: string;
}

async function loadSeed(): Promise<DemoSeedModule> {
  const seedUrl = new URL('../../../scripts/gen_demo_seed.mjs', import.meta.url);
  return (await import(seedUrl.href)) as DemoSeedModule;
}

async function createStores(payments: PaymentsSetup): Promise<{ store: ShopStore; oauthStore: OAuthStore | null }> {
  const config = loadMcpServerConfig(process.env);
  const oauthEnabled = !!config.publicBaseUrl;
  if (config.dataBackend === 'memory') {
    const token = process.env.MCP_DEMO_TOKEN ?? '';
    if (token.length < 32) throw new Error('MCP_DEMO_TOKEN (>= 32 chars) is required when MCP_DATA_BACKEND=memory');
    const seed = await loadSeed();
    logger.warn('mcp_memory_backend', { message: 'Serving the in-memory demo dataset (no Postgres). OAuth accounts vanish on restart.' });
    const store = new MemoryShopStore(seed.buildDemoDataset({
      ...(process.env.DEMO_ANCHOR_DATE ? { anchorDate: process.env.DEMO_ANCHOR_DATE } : {}),
      tokens: { [token]: seed.DEMO_TENANT_ID }
    }));
    const oauthStore = oauthEnabled
      ? new MemoryOAuthStore({
        provision: async (tenantId, locale) => {
          store.addTenant(tenantId, seed.buildSandboxTenantData(locale, process.env.DEMO_ANCHOR_DATE || undefined));
          await connectMockPayPal(payments, store, tenantId).catch((error: unknown) => logger.warn('mock_paypal_connect_failed', { error: error instanceof Error ? error.message : 'unknown' }));
          return seed.SANDBOX_PROFILES.en.shop_name;
        },
        remove: (tenantId) => store.removeTenant(tenantId)
      })
      : null;
    if (await connectMockPayPal(payments, store, seed.DEMO_TENANT_ID)) logger.info('mock_paypal_connected', { tenant_id: seed.DEMO_TENANT_ID });
    return { store, oauthStore };
  }
  const pool = await createPgPool({
    connectionString: config.databaseUrl,
    applicationName: 'mcp-server',
    statementTimeoutMs: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? '5000')
  });
  const oauthStore = oauthEnabled
    ? new PgOAuthStore(pool, { catalogue: (await loadSeed()).buildSandboxCatalogue(process.env), invitePepperB64: config.invitePepperB64 })
    : null;
  const store = new PgShopStore(pool);
  const seed = await loadSeed();
  if (await connectMockPayPal(payments, store, seed.DEMO_TENANT_ID).catch(() => false)) logger.info('mock_paypal_connected', { tenant_id: seed.DEMO_TENANT_ID });
  return { store, oauthStore };
}

async function main(): Promise<void> {
  const config = loadMcpServerConfig(process.env);
  const payments = loadPaymentsSetup(process.env, logger);
  const { store, oauthStore } = await createStores(payments);
  const deps: McpHttpDeps = { store, config, logger, payments: payments.service, ...(oauthStore ? { oauth: { store: oauthStore } } : {}) };
  const handler = createMcpHttpHandler(deps);
  const server = createServer((req, res) => {
    void handler.handle(req, res);
  });
  const sweep = setInterval(() => {
    void handler.sweepIdleSessions();
  }, 60_000);
  sweep.unref();
  const housekeeping = setInterval(() => {
    handler.oauthCleanup()
      .then((removed) => { if (removed > 0) logger.info('oauth_cleanup', { removed_clients: removed }); })
      .catch((error: unknown) => logger.warn('oauth_cleanup_failed', { error: error instanceof Error ? error.message : 'unknown' }));
  }, 6 * 3600_000);
  housekeeping.unref();

  server.listen(config.port, config.host, () => {
    logger.info('mcp_server_listening', {
      host: config.host,
      port: config.port,
      path: config.mcpPath,
      backend: config.dataBackend,
      allowed_origins: config.allowedOrigins.length,
      oauth: oauthStore ? config.publicBaseUrl : 'disabled'
    });
  });

  const shutdown = async (signal: string) => {
    logger.info('mcp_server_shutdown', { signal });
    server.close();
    await handler.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.error('mcp_server_start_failed', { error: error instanceof Error ? error.message : 'unknown' });
  process.exit(1);
});
