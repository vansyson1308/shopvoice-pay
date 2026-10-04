import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTokenBucketRateLimiter } from '../../packages/common/dist/index.js';

test('rate limiter allows within capacity and blocks overflow', () => {
  const limiter = new InMemoryTokenBucketRateLimiter(2, 2);
  assert.equal(limiter.consume('k').allowed, true);
  assert.equal(limiter.consume('k').allowed, true);
  assert.equal(limiter.consume('k').allowed, false);
});
