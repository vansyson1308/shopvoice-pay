// Fails when a Postgres repository builds SQL by string interpolation.
// Every query in a *pg-store.ts / pg-*.ts file must use $1-style parameters.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['apps', 'packages'];
const SKIP = new Set(['node_modules', 'dist', '.git']);
const SQL_FILE = /(^|[-/])pg[-.].*\.ts$|pg-store\.ts$|ledger\/pg.*\.ts$/;
const SQL_KEYWORD = /\b(SELECT|INSERT|UPDATE|DELETE|WITH|SET LOCAL)\b/;

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
  for (const match of text.matchAll(/`([^`]*)`/g)) {
    const body = match[1] ?? '';
    if (body.includes('${') && SQL_KEYWORD.test(body)) {
      const line = text.slice(0, match.index).split('\n').length;
      console.error(`[sql-guard] ${file}:${line}: interpolated SQL template literal`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log(`SQL interpolation guard passed (${files.length} files).`);
