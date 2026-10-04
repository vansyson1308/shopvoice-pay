import test from 'node:test';
import assert from 'node:assert/strict';
import { findViolations } from '../../tools/sql-guard-lib.mjs';

test('sql guard: parameters and UPPER_CASE column constants pass', () => {
  assert.deepEqual(findViolations('q(`SELECT ${PAYMENT_COLUMNS} FROM supplier_payments WHERE id = $1`, [id]);'), []);
  assert.deepEqual(findViolations('const msg = `hello ${name}`;'), []);
});

test('sql guard: any variable or expression interpolated into SQL fails', () => {
  assert.deepEqual(findViolations('q(`SELECT * FROM t WHERE id = ${id}`)'), [1]);
  assert.deepEqual(findViolations('\nq(`DELETE FROM t WHERE x = ${input.value}`)'), [2]);
  assert.deepEqual(findViolations('q(`SELECT ${COLS} FROM t WHERE a = ${a}`)'), [1]);
  assert.deepEqual(findViolations('q(`UPDATE t SET s = ${camelCase}`)'), [1]);
});
