// Fails when a Postgres repository builds SQL by string interpolation.
// Every query in a *pg-store.ts / pg-*.ts / ledger/pg*.ts file must use
// $1-style parameters. The one allowed interpolation is an UPPER_CASE constant
// (a fixed column list such as ${PAYMENT_COLUMNS}); any other ${...} fails.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findViolations } from './sql-guard-lib.mjs';

const ROOTS = ['apps', 'packages'];
const SKIP = new Set(['node_modules', 'dist', '.git']);
const SQL_FILE = /(^|[-/])pg[-.].*\.ts$|pg-store\.ts$|ledger\/pg.*\.ts$/;

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SQL_FILE.test(full.replaceAll('\\', '/'))) out.push(full);
  }
  return out;
}

let failed = false;
const files = ROOTS.flatMap((root) => walk(root, []));
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (text.includes('sqlQuote(')) {
    console.error(`[sql-guard] ${file}: sqlQuote() is forbidden, use $n parameters`);
    failed = true;
  }
  for (const line of findViolations(text)) {
    console.error(`[sql-guard] ${file}:${line}: interpolated SQL template literal`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`SQL interpolation guard passed (${files.length} files).`);
