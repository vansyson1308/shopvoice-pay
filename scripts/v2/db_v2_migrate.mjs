import {
  appliedMigrations,
  ensureMigrationsTable,
  migrationFiles,
  readMigration,
  runSql
} from './db_v2_lib.mjs';

await ensureMigrationsTable();

const applied = new Map(appliedMigrations().map((m) => [m.name, m.checksum]));

for (const file of migrationFiles()) {
  const migration = readMigration(file);

  if (applied.has(file)) {
    const checksum = applied.get(file);
    if (checksum !== migration.checksum) {
      throw new Error(`Checksum drift detected for applied migration ${file}`);
    }
    continue;
  }

  if (!migration.up) {
    throw new Error(`Migration ${file} has empty up section.`);
  }

  runSql(migration.up);
  runSql(`
    INSERT INTO schema_migrations_v2 (name, checksum)
    VALUES ('${migration.name}', '${migration.checksum}');
  `);
  console.log(`Applied ${migration.name}`);
}

console.log('V2 migrations up to date.');
