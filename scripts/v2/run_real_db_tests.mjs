import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const composeFile = 'infra/compose/v2/docker-compose.yml';
const envFile = 'infra/compose/v2/.env.real-db-test';
const useExistingDb = process.env.REAL_DB_TESTS_USE_EXISTING_DB === 'true';

function run(cmd, env = process.env) {
  const result = spawnSync(cmd, { stdio: 'inherit', env, shell: true });
  if (result.status !== 0) {
    throw new Error(`command failed: ${cmd}`);
  }
}

function compose(cmd, envPath = envFile) {
  run(`docker compose --env-file ${envPath} -f ${composeFile} ${cmd}`);
}

function makeEnv() {
  const pgPassword = randomBytes(12).toString('hex');
  const dbName = `groceryclaw_v2_real_test_${randomBytes(3).toString('hex')}`;
  const content = [
    'NODE_ENV=test',
    'LOG_LEVEL=info',
    `POSTGRES_DB=${dbName}`,
    'POSTGRES_SUPERUSER=postgres',
    `POSTGRES_SUPERUSER_PASSWORD=${pgPassword}`,
    'APP_DB_USER=app_user',
    `APP_DB_PASSWORD=${pgPassword}`,
    `REDIS_PASSWORD=${randomBytes(12).toString('hex')}`,
    `DB_APP_URL=postgresql://app_user:${pgPassword}@127.0.0.1:5432/${dbName}`,
    `DB_ADMIN_URL=postgresql://postgres:${pgPassword}@127.0.0.1:5432/${dbName}`,
    `DATABASE_URL=postgresql://postgres:${pgPassword}@127.0.0.1:5432/${dbName}`
  ].join('\n');
  writeFileSync(envFile, `${content}\n`);
  return { pgPassword, dbName };
}

async function main() {
  if (useExistingDb) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required when REAL_DB_TESTS_USE_EXISTING_DB=true');
    }
    run('npm run db:v2:migrate');
    run('npm run test:v2:db:real');
    return;
  }

  const generated = makeEnv();

  try {
    // Always tear down first to remove stale volumes. Postgres only applies
    // POSTGRES_PASSWORD during initdb (first run on an empty data directory).
    // If a previous run left v2_v2_postgres_data behind (e.g. Ctrl+C before
    // cleanup), the old password is baked into pg_authid and the new random
    // password would be silently ignored. Migrations still succeed (docker exec
    // uses local-socket trust auth) but TCP connections from tests fail with
    // 28P01 "password authentication failed". Removing volumes guarantees a
    // fresh initdb with the current password.
    compose('down -v --remove-orphans');
    compose('up -d --wait postgres');
    const testEnv = {
      ...process.env,
      DATABASE_URL: `postgresql://postgres:${generated.pgPassword}@127.0.0.1:5432/${generated.dbName}`,
      DB_V2_COMPOSE_ENV_FILE: envFile
    };
    run('npm run db:v2:migrate', testEnv);
    run('npm run test:v2:db:real', testEnv);
  } finally {
    try {
      compose('down -v --remove-orphans');
    } finally {
      try {
        unlinkSync(envFile);
      } catch {
        // no-op
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
