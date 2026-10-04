import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadDatabaseConfig,
  redactDbErrorMessage,
  sanitizeDbError,
  dbPing
} from '../../packages/common/dist/index.js';

test('loadDatabaseConfig validates required URLs', () => {
  const cfg = loadDatabaseConfig({
    DB_APP_URL: 'postgresql://app_user:secret@db:5432/appdb',
    DB_ADMIN_URL: 'postgres://admin_reader:secret@db:5432/appdb',
    DB_STATEMENT_TIMEOUT_MS: '2500'
  });

  assert.equal(cfg.dbAppUrl, 'postgresql://app_user:secret@db:5432/appdb');
  assert.equal(cfg.dbAdminUrl, 'postgres://admin_reader:secret@db:5432/appdb');
  assert.equal(cfg.dbStatementTimeoutMs, 2500);

  assert.throws(() => loadDatabaseConfig({ DB_ADMIN_URL: 'postgresql://a:b@db:5432/db' }), /DB_APP_URL/);
  assert.throws(() => loadDatabaseConfig({ DB_APP_URL: 'mysql://db', DB_ADMIN_URL: 'postgresql://a:b@db:5432/db' }), /DB_APP_URL must use/);
});

test('db error redaction removes connection-string credentials', () => {
  const message = 'failed to connect postgresql://user:super-secret@db.internal:5432/appdb timeout';
  const redacted = redactDbErrorMessage(message);
  assert.doesNotMatch(redacted, /super-secret/);
  assert.match(redacted, /\[REDACTED\]/);

  const safeError = sanitizeDbError(new Error(message));
  assert.doesNotMatch(safeError.message, /super-secret/);
  assert.match(safeError.message, /\[REDACTED\]/);
});


test('dbPing returns true on successful SELECT and false on timeout/failure', async () => {
  const okPool = {
    async query() {
      return { rows: [{ ok: 1 }] };
    }
  };
  const badPool = {
    async query() {
      throw new Error('down');
    }
  };
  const slowPool = {
    async query() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { rows: [{ ok: 1 }] };
    }
  };

  assert.equal(await dbPing(okPool, 50), true);
  assert.equal(await dbPing(badPool, 50), false);
  assert.equal(await dbPing(slowPool, 1), false);
});

test('runTenantScopedTransaction keeps application errors (codes intact) and redacts driver errors', async () => {
  const { runTenantScopedTransaction, isApplicationError } = await import('../../packages/common/dist/index.js');
  class LedgerLikeError extends Error {
    constructor() {
      super('cannot capture more than is held');
      this.code = 'over_capture';
    }
  }
  const statements = [];
  const client = { query: async (sql) => { statements.push(String(sql)); return { rows: [] }; }, release() {} };
  const pool = { connect: async () => client, query: client.query, end: async () => {} };
  await assert.rejects(
    runTenantScopedTransaction({ pool, tenantId: 't', work: async () => { throw new LedgerLikeError(); } }),
    (e) => e instanceof LedgerLikeError && e.code === 'over_capture'
  );
  assert.ok(statements.includes('ROLLBACK'));
  const driverError = Object.assign(new Error('connect failed postgres://app:secret@db/x'), { severity: 'FATAL' });
  await assert.rejects(
    runTenantScopedTransaction({ pool, tenantId: 't', work: async () => { throw driverError; } }),
    (e) => !(e.message.includes('secret')) && !('severity' in e)
  );
  assert.equal(isApplicationError(new Error('plain')), false);
  assert.equal(isApplicationError('nope'), false);
  assert.equal(isApplicationError(new LedgerLikeError()), true);
});
