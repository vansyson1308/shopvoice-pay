import { ensureMigrationsTable, readMigration, runSql } from './db_v2_lib.mjs';

await ensureMigrationsTable();

const latest = runSql(`
  SELECT name
  FROM schema_migrations_v2
  ORDER BY id DESC
  LIMIT 1;
`).trim();

if (!latest) {
  console.log('No applied V2 migrations to rollback.');
  process.exit(0);
}

const migration = readMigration(latest);

if (!migration.down) {
  throw new Error(`Migration ${latest} has empty down section.`);
}

runSql(migration.down);
runSql(`DELETE FROM schema_migrations_v2 WHERE name='${migration.name}';`);
console.log(`Rolled back ${migration.name}`);
