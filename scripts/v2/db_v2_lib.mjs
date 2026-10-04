import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export const MIGRATIONS_DIR = 'db/v2/migrations';

function hasCommand(cmd) {
  const check = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(check, [cmd], {
    encoding: 'utf8',
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  return result.status === 0;
}

const FALLBACK_DB = 'groceryclaw_v2';

function targetDb() {
  if (process.env.DATABASE_URL) {
    const match = process.env.DATABASE_URL.match(/\/([^/?]+)(\?|$)/);
    if (match) return match[1];
  }
  return FALLBACK_DB;
}

function shell(dbName = targetDb()) {
  if (process.env.DB_V2_PSQL_CMD) {
    return process.env.DB_V2_PSQL_CMD;
  }

  if (hasCommand('psql')) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required when using psql directly.');
    }
    // Replace the database name in the connection URL when targeting a different DB.
    let url = process.env.DATABASE_URL;
    if (dbName !== targetDb()) {
      url = url.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    }
    return `psql "${url}" -v ON_ERROR_STOP=1 -q -t -A -f -`;
  }

  if (hasCommand('docker')) {
    const envFile = process.env.DB_V2_COMPOSE_ENV_FILE || 'infra/compose/v2/.env';
    return [
      'docker compose',
      `--env-file ${envFile}`,
      '-f infra/compose/v2/docker-compose.yml',
      'exec -T postgres',
      `psql -U postgres -d ${dbName} -v ON_ERROR_STOP=1 -q -t -A -f -`
    ].join(' ');
  }

  throw new Error('No SQL execution method found. Install psql or docker, or set DB_V2_PSQL_CMD.');
}

// Migrations 014-016 were authored without migrate markers. Rather than edit
// them (which would change checksums on databases that already applied them),
// accept the legacy "---- rollback" separator, or treat the whole file as up.
const LEGACY_ROLLBACK_MARKER = '---- rollback';

export function splitMigration(content, fileName) {
  const markerUp = '-- migrate:up';
  const markerDown = '-- migrate:down';

  const upPos = content.indexOf(markerUp);
  const downPos = content.indexOf(markerDown);
  if (upPos === -1 && downPos === -1) {
    const legacyPos = content.indexOf(LEGACY_ROLLBACK_MARKER);
    if (legacyPos === -1) {
      return { up: content.trim(), down: '' };
    }
    return {
      up: content.slice(0, legacyPos).trim(),
      down: content.slice(legacyPos + LEGACY_ROLLBACK_MARKER.length).trim()
    };
  }
  if (upPos === -1 || downPos === -1 || downPos <= upPos) {
    throw new Error(`Migration ${fileName} must contain -- migrate:up and -- migrate:down sections.`);
  }

  return {
    up: content.slice(upPos + markerUp.length, downPos).trim(),
    down: content.slice(downPos + markerDown.length).trim()
  };
}

export function migrationFiles() {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Missing migrations directory: ${MIGRATIONS_DIR}`);
  }

  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

export function migrationChecksum(content) {
  return createHash('sha256').update(content).digest('hex');
}

const TRANSIENT_PATTERNS = [
  'shutting down',
  'starting up',
  'connection refused',
  'Connection refused',
  'ECONNREFUSED',
  'No such file or directory',
  'the database system is not yet accepting connections',
  'server closed the connection unexpectedly',
  'could not connect to server',
  'timeout expired'
];

function isTransientError(stderr) {
  return TRANSIENT_PATTERNS.some((p) => stderr.includes(p));
}

export function runSql(sql, dbName) {
  const cmd = shell(dbName);
  const result = spawnSync(cmd, {
    input: sql,
    encoding: 'utf8',
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (result.status !== 0) {
    const msg = result.stderr || result.stdout || 'SQL execution failed';
    const err = new Error(msg);
    err.transient = isTransientError(msg);
    throw err;
  }

  return result.stdout.trim();
}

/**
 * Waits for Postgres to be fully ready by requiring CONSECUTIVE_REQUIRED
 * successful probes. This survives the Docker entrypoint init-restart cycle
 * where Postgres starts temporarily, runs initdb scripts, shuts down, then
 * restarts for real. A single SELECT 1 success can land in the temporary
 * phase; requiring consecutive successes ensures the final restart is stable.
 */
export async function waitForDatabase(maxRetries = 30, delayMs = 1000) {
  const CONSECUTIVE_REQUIRED = 2;
  let consecutive = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const cmd = shell('postgres');
    const result = spawnSync(cmd, {
      input: 'SELECT 1;',
      encoding: 'utf8',
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (result.status === 0) {
      consecutive++;
      if (consecutive >= CONSECUTIVE_REQUIRED) {
        return;
      }
      console.error(
        `Database responded (${consecutive}/${CONSECUTIVE_REQUIRED} consecutive checks)...`
      );
      await sleep(delayMs);
      continue;
    }

    // Reset consecutive counter on any failure.
    consecutive = 0;
    const msg = result.stderr || result.stdout || 'unknown error';

    if (attempt === maxRetries) {
      throw new Error(
        `Database not ready after ${maxRetries} attempts (${maxRetries * delayMs / 1000}s). ` +
        `Last error: ${msg}`
      );
    }

    console.error(
      `Waiting for database to be ready... (attempt ${attempt}/${maxRetries}: ${msg.split('\n')[0].trim()})`
    );
    await sleep(delayMs);
  }
}

export async function ensureDatabaseExists(dbName = targetDb(), maxRetries = 10, delayMs = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const check = runSql(
        `SELECT 1 FROM pg_database WHERE datname = '${dbName}';`,
        'postgres'
      );

      if (check) {
        return;
      }

      console.error(`Creating database "${dbName}"...`);
      runSql(`CREATE DATABASE "${dbName}";`, 'postgres');
      return;
    } catch (err) {
      if (!err.transient || attempt === maxRetries) {
        throw err;
      }
      console.error(
        `Transient error during ensureDatabaseExists (attempt ${attempt}/${maxRetries}): ${err.message.split('\n')[0].trim()}`
      );
      await sleep(delayMs);
    }
  }
}

export async function ensureMigrationsTable() {
  await waitForDatabase();
  await ensureDatabaseExists();
  runSql(`
    CREATE TABLE IF NOT EXISTS schema_migrations_v2 (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export function readMigration(name) {
  const filePath = join(MIGRATIONS_DIR, name);
  const content = readFileSync(filePath, 'utf8');
  return {
    name,
    filePath,
    content,
    checksum: migrationChecksum(content),
    ...splitMigration(content, name)
  };
}

export function appliedMigrations() {
  const out = runSql(`
    SELECT name || ',' || checksum
    FROM schema_migrations_v2
    ORDER BY id ASC;
  `);

  if (!out) {
    return [];
  }

  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, checksum] = line.split(',');
      return { name, checksum };
    });
}
