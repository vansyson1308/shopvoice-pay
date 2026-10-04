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
