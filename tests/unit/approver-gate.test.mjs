// Proves the headless sandbox approver is test-only: it refuses to run without
// the explicit test flag, in production, or on a hosting platform, and no
// product code (apps/, packages/) or deploy image can reach it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { approveInSandbox, assertHeadlessApprovalAllowed, TEST_FLAG } from '../../scripts/paypal/sandbox-approver.mjs';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test('approver refuses without the explicit test flag', async () => {
  assert.equal(TEST_FLAG, 'SHOPVOICE_TEST_ONLY_HEADLESS_APPROVAL');
  assert.throws(() => assertHeadlessApprovalAllowed({}), /headless_approval_test_only/);
  assert.throws(() => assertHeadlessApprovalAllowed({ [TEST_FLAG]: 'true' }), /headless_approval_test_only/, 'only the exact value 1 enables it');
  const saved = process.env[TEST_FLAG];
  delete process.env[TEST_FLAG];
  try {
    await assert.rejects(
      approveInSandbox('https://www.sandbox.paypal.com/checkoutnow?token=X', { email: 'a@b.example', password: 'x' }),
      /headless_approval_test_only/
    );
  } finally {
    if (saved !== undefined) process.env[TEST_FLAG] = saved;
  }
});

test('approver refuses in production and on hosting platforms even with the flag', () => {
  assert.throws(() => assertHeadlessApprovalAllowed({ [TEST_FLAG]: '1', NODE_ENV: 'production' }), /production/);
  assert.throws(() => assertHeadlessApprovalAllowed({ [TEST_FLAG]: '1', RENDER: 'true' }), /hosting platform/);
  assert.throws(() => assertHeadlessApprovalAllowed({ [TEST_FLAG]: '1', RENDER_SERVICE_ID: 'srv-x' }), /hosting platform/);
  assert.doesNotThrow(() => assertHeadlessApprovalAllowed({ [TEST_FLAG]: '1', NODE_ENV: 'test' }));
});

test('no product code (apps/, packages/, source or build output) references the approver or Playwright', () => {
  const files = [...walk('apps'), ...walk('packages')].filter((f) => /\.(ts|js|mjs|json|html)$/.test(f));
  assert.ok(files.length > 20);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/sandbox-approver|approveInSandbox|SHOPVOICE_TEST_ONLY_HEADLESS_APPROVAL/.test(text), `${file} references the test-only approver`);
    assert.ok(!/from ['"]playwright|import\(['"]playwright/.test(text), `${file} imports Playwright`);
  }
});

test('deploy images and runtime dependencies cannot carry it', () => {
  for (const dockerfile of walk('apps').filter((f) => f.endsWith('Dockerfile'))) {
    const text = readFileSync(dockerfile, 'utf8');
    assert.ok(!/scripts\/paypal|COPY scripts\s/.test(text), `${dockerfile} copies scripts/paypal`);
  }
  const root = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.ok(root.devDependencies.playwright, 'playwright is a dev dependency');
  assert.ok(!root.dependencies?.playwright, 'playwright is not a runtime dependency');
  for (const app of ['apps/mcp-server', 'apps/console']) {
    const pkg = JSON.parse(readFileSync(`${app}/package.json`, 'utf8'));
    assert.ok(!pkg.dependencies?.playwright, `${app} must not depend on playwright`);
  }
  assert.match(root.scripts.spike, /SHOPVOICE_TEST_ONLY_HEADLESS_APPROVAL=1/, 'only the spike script opts in');
});
