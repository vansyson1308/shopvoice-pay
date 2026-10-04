import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAction, newPaymentState, checkInvariants, heldMinor, chargedMinor, committedMinor, LedgerError
} from '../../apps/mcp-server/dist/ledger/state-machine.js';

const run = (state, ...actions) => actions.reduce((s, a) => applyAction(s, a), state);
const rejects = (state, action, code) => assert.throws(() => applyAction(state, action), (e) => e instanceof LedgerError && e.code === code);

test('hero milk: authorize $84, full delivery -> captured, then partial refund for spoiled yogurt', () => {
  const s = run(newPaymentState(8400, 'pending_approval'), { kind: 'authorize', amountMinor: 8400 });
  assert.equal(s.status, 'authorized');
  assert.equal(heldMinor(s), 8400);
  assert.equal(chargedMinor(s), 0);
  const captured = applyAction(s, { kind: 'capture', amountMinor: 8400, final: true });
  assert.equal(captured.status, 'captured');
  assert.equal(heldMinor(captured), 0);
  const refunded = applyAction(captured, { kind: 'refund', amountMinor: 1200 });
  assert.equal(refunded.status, 'captured');
  assert.equal(chargedMinor(refunded), 7200);
  assert.equal(applyAction(refunded, { kind: 'refund', amountMinor: 7200 }).status, 'refunded');
});

test('hero eggs: 10 of 12 crates -> partial capture, void the rest, charged only for what arrived', () => {
  const s = run(newPaymentState(14_400, 'pending_approval'), { kind: 'authorize', amountMinor: 14_400 }, { kind: 'capture', amountMinor: 12_000, final: false });
  assert.equal(s.status, 'partially_captured');
  assert.equal(heldMinor(s), 2400);
  const closed = applyAction(s, { kind: 'void' });
  assert.equal(closed.status, 'partially_captured');
  assert.equal(closed.voidedMinor, 2400);
  assert.equal(heldMinor(closed), 0);
  assert.equal(committedMinor(closed), 12_000);
});

test('final_capture on a partial capture releases the remainder (sandbox S2.5)', () => {
  const s = run(newPaymentState(12_000, 'pending_approval'), { kind: 'authorize', amountMinor: 12_000 }, { kind: 'capture', amountMinor: 7000, final: true });
  assert.equal(s.status, 'partially_captured');
  assert.equal(s.voidedMinor, 5000);
  assert.equal(heldMinor(s), 0);
  rejects(s, { kind: 'capture', amountMinor: 1, final: true }, 'nothing_held');
  rejects(s, { kind: 'void' }, 'nothing_held');
});

test('nothing delivered -> void; step-up declined -> voided; failure before money moves', () => {
  const voided = run(newPaymentState(5000, 'pending_approval'), { kind: 'authorize', amountMinor: 5000 }, { kind: 'void' });
  assert.equal(voided.status, 'voided');
  assert.equal(committedMinor(voided), 0);
  assert.equal(applyAction(newPaymentState(5000, 'pending_approval'), { kind: 'decline' }).status, 'voided');
  assert.equal(applyAction(newPaymentState(5000, 'pending_approval'), { kind: 'fail' }).status, 'failed');
  rejects(voided, { kind: 'fail' }, 'invalid_transition');
});

test('illegal moves are rejected with a code and leave no trace', () => {
  const pending = newPaymentState(8400, 'pending_approval');
  rejects(pending, { kind: 'capture', amountMinor: 100, final: true }, 'invalid_transition');
  rejects(pending, { kind: 'authorize', amountMinor: 8401 }, 'over_requested');
  rejects(pending, { kind: 'authorize', amountMinor: 0 }, 'invalid_amount');
  rejects(pending, { kind: 'authorize', amountMinor: 1.5 }, 'invalid_amount');
  const auth = applyAction(pending, { kind: 'authorize', amountMinor: 8400 });
  rejects(auth, { kind: 'authorize', amountMinor: 1 }, 'invalid_transition');
  rejects(auth, { kind: 'capture', amountMinor: 8401, final: false }, 'over_capture');
  rejects(auth, { kind: 'refund', amountMinor: 1 }, 'invalid_transition');
  rejects(auth, { kind: 'settle', amountMinor: 1 }, 'invalid_transition');
  rejects(auth, { kind: 'decline' }, 'invalid_transition');
  const captured = applyAction(auth, { kind: 'capture', amountMinor: 8400, final: true });
  rejects(captured, { kind: 'refund', amountMinor: 8401 }, 'over_refund');
  rejects(captured, { kind: 'settle', amountMinor: 8401 }, 'over_settle');
  const open = applyAction(auth, { kind: 'capture', amountMinor: 100, final: false });
  rejects(open, { kind: 'settle', amountMinor: 100 }, 'still_held');
  rejects(open, { kind: 'refund', amountMinor: 100 }, 'invalid_transition');
  assert.throws(() => newPaymentState(0, 'pending_approval'), /requested amount/);
  assert.equal(newPaymentState(10, 'blocked').status, 'blocked');
  rejects(newPaymentState(10, 'blocked'), { kind: 'authorize', amountMinor: 10 }, 'invalid_transition');
});

test('settlement pays the supplier at most what the shop was charged, net of refunds', () => {
  const s = run(newPaymentState(8400, 'pending_approval'), { kind: 'authorize', amountMinor: 8400 }, { kind: 'capture', amountMinor: 8400, final: true }, { kind: 'refund', amountMinor: 1200 });
  rejects(s, { kind: 'settle', amountMinor: 7201 }, 'over_settle');
  const settled = applyAction(s, { kind: 'settle', amountMinor: 7200 });
  assert.equal(settled.settledMinor, 7200);
  rejects(settled, { kind: 'settle', amountMinor: 1 }, 'over_settle');
});

// --- property-based: random action sequences never break the invariants ---

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomAction(rand, s) {
  const pick = (n) => Math.floor(rand() * n);
  // Amounts deliberately include zero, negatives, fractions, exact limits and overshoots.
  const amount = () => {
    const base = [0, -5, 1.5, 1, heldMinor(s), heldMinor(s) + 1, chargedMinor(s), chargedMinor(s) + 1, s.requestedMinor, s.requestedMinor + 1][pick(10)];
    return rand() < 0.5 ? base : pick(Math.max(1, s.requestedMinor + 50));
  };
  switch (pick(7)) {
    case 0: return { kind: 'authorize', amountMinor: amount() };
    case 1: return { kind: 'capture', amountMinor: amount(), final: rand() < 0.5 };
    case 2: return { kind: 'void' };
    case 3: return { kind: 'refund', amountMinor: amount() };
    case 4: return { kind: 'settle', amountMinor: amount() };
    case 5: return { kind: 'decline' };
    default: return { kind: 'fail' };
  }
}

test('property: 5,000 random sequences never yield captured + voided > authorized or refunded > captured', () => {
  const stats = { applied: 0, rejected: 0, statuses: new Set() };
  for (let seed = 1; seed <= 5000; seed += 1) {
    const rand = prng(seed);
    let s = newPaymentState(1 + Math.floor(rand() * 50_000), 'pending_approval');
    for (let step = 0; step < 25; step += 1) {
      const action = randomAction(rand, s);
      const before = s;
      try {
        s = applyAction(s, action);
        stats.applied += 1;
      } catch (error) {
        assert.ok(error instanceof LedgerError, `seed ${seed}: unexpected ${error}`);
        assert.deepEqual(s, before, `seed ${seed}: rejected action changed state`);
        stats.rejected += 1;
      }
      const broken = checkInvariants(s);
      assert.deepEqual(broken, [], `seed ${seed} step ${step} ${JSON.stringify(action)} -> ${JSON.stringify(s)}`);
      assert.ok(committedMinor(s) >= 0 && committedMinor(s) <= s.authorizedMinor, `seed ${seed}: committed out of range`);
      stats.statuses.add(s.status);
    }
  }
  // The generator must actually reach every state, or the property proves little.
  for (const status of ['pending_approval', 'authorized', 'partially_captured', 'captured', 'voided', 'refunded', 'failed']) {
    assert.ok(stats.statuses.has(status), `never reached ${status}`);
  }
  assert.ok(stats.applied > 5000, `too few applied actions: ${stats.applied}`);
});
