// SECURITY.md is a threat model with linked tests; this keeps the links honest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkSecurityDoc, testTitles } from '../../tools/security-links.mjs';

const doc = readFileSync(new URL('../../SECURITY.md', import.meta.url), 'utf8');

test('SECURITY.md: every threat links real tests, and the brief\'s threats are all covered', () => {
  const { problems, links } = checkSecurityDoc(doc);
  assert.deepEqual(problems, []);
  assert.ok(links.length >= 50, `${links.length} links`);
  for (const threat of ['Prompt injection', 'Duplicate payment', 'Replay', 'Over-limit', 'Wrong payee', 'leakage', 'Webhook spoofing']) {
    assert.match(doc, new RegExp(`^### T\\d+\\. .*${threat}`, 'mi'), threat);
  }
});

test('the checker catches a missing file, a renamed test, a missing eval and a threat without tests', () => {
  const bad = [
    '### T1. Example',
    '- [`tests/unit/nope.test.mjs`](tests/unit/nope.test.mjs) — `anything`',
    '- [`tests/unit/policy-engine.test.mjs`](tests/unit/policy-engine.test.mjs) — `a title that does not exist`',
    '- Eval S99 covers it.',
    '### T2. No tests here',
    'Just words.'
  ].join('\n');
  const { problems } = checkSecurityDoc(bad);
  assert.equal(problems.length, 4, problems.join('\n'));
  assert.match(problems.join('\n'), /does not exist/);
  assert.match(problems.join('\n'), /has no test titled/);
  assert.match(problems.join('\n'), /eval S99/);
  assert.match(problems.join('\n'), /links no tests/);
  assert.deepEqual([...testTitles("test('it\\'s fine', () => {}); t(\"double\", () => {});")], ["it's fine", 'double']);
});
