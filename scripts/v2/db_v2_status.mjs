import { appliedMigrations, ensureMigrationsTable, migrationFiles } from './db_v2_lib.mjs';

await ensureMigrationsTable();

const applied = new Set(appliedMigrations().map((m) => m.name));
const files = migrationFiles();

for (const file of files) {
  console.log(`${applied.has(file) ? 'APPLIED' : 'PENDING'} ${file}`);
}
