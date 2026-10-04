import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, loadBaseConfig } from '../../packages/common/dist/index.js';

test('loadBaseConfig reads defaults and validates env', () => {
  const cfg = loadBaseConfig({
    serviceName: 'gateway',
    defaultHost: '0.0.0.0',
    defaultPort: 3000,
    env: { NODE_ENV: 'test', LOG_LEVEL: 'debug' }
  });

  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.logLevel, 'debug');
  assert.equal(cfg.nodeEnv, 'test');
});



test('logger scrubs secrets and authorization patterns', () => {
  const oldLog = console.log;
  const oldErr = console.error;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  console.error = (line) => lines.push(String(line));

  try {
    const logger = createLogger({ service: 'test', level: 'debug' });
    logger.info('Authorization: Bearer abc.def.ghi token=shhh', {
      token: 'abc123',
      nested: { ADMIN_MEK_B64: 'secret-mek', note: 'invite_pepper=pepper-value' }
    });
  } finally {
    console.log = oldLog;
    console.error = oldErr;
  }

  const output = lines.join('\\n');
  assert.doesNotMatch(output, /abc\.def\.ghi/);
  assert.doesNotMatch(output, /token=shhh/);
  assert.doesNotMatch(output, /secret-mek/);
  assert.match(output, /\[REDACTED\]/);
});
