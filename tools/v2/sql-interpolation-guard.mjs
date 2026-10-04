import { readFileSync } from 'node:fs';

const checks = [
  {
    file: 'apps/gateway/src/server.ts',
    deny: ['resolve_membership_by_platform_user_id(${', 'platform_user_id = ${sqlQuote(']
  },
  {
    file: 'apps/admin/src/server.ts',
    deny: ['${sqlQuote(tenantId)}::uuid', 'sqlQuote(principal.subject)', 'sqlQuote(requestId)']
  },
  {
    file: 'apps/worker/src/mapping-resolve.ts',
    deny: ['sqlQuote(']
  },
  {
    file: 'apps/worker/src/kiotviet-sync.ts',
    deny: ['sqlQuote(']
  }
];

let failed = false;
for (const check of checks) {
  const text = readFileSync(check.file, 'utf8');
  for (const token of check.deny) {
    if (text.includes(token)) {
      console.error(`[sql-guard] forbidden interpolation token in ${check.file}: ${token}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log('SQL interpolation guard passed.');
