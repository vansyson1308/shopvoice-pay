import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePolicy, periodStarts, DEFAULT_POLICY, evaluateSubstitution,
  averageUnitCost, percentChange, usualQuantity, linesFingerprint
} from '../../apps/mcp-server/dist/policy/index.js';

const NOW = Date.parse('2026-10-07T03:30:00Z'); // Tue Oct 6, 23:30 in New York
const DAY = 86_400_000;
const { dayStart, weekStart } = periodStarts(NOW, 'America/New_York');
const iso = (ms) => new Date(ms).toISOString();

const policy = { ...DEFAULT_POLICY, allowListedSupplierIds: ['SUP-DAIRY', 'SUP-EGGS', 'SUP-BAKERY'] };
const milkDraft = {
  id: 'draft-milk',
  supplierId: 'SUP-DAIRY',
  supplierName: 'Northside Dairy',
  lines: [{ sku: 'MILK-1G', name: 'Whole milk, 1 gal', qty: 12, unitCostMinor: 700 }],
  totalMinor: 8400,
  currency: 'USD'
};
const priceHistory = {
  'MILK-1G': [700, 690, 710, 700].map((c, i) => ({ unitCostMinor: c, at: iso(NOW - (i + 1) * 5 * DAY) })),
  'EGGS-30': [1080, 1090, 1085].map((c, i) => ({ unitCostMinor: c, at: iso(NOW - (i + 1) * 6 * DAY) }))
};
const history = { payments: [], priceHistory, pastQuantities: { 'MILK-1G': [10, 12, 14], 'EGGS-30': [10, 10] } };
const payee = { hasPayee: true, verified: true, completedOrders: 6 };

function evaluate(overrides = {}) {
  return evaluatePolicy({ draft: milkDraft, history, policy, payee, paymentMethodConnected: true, now: NOW, dayStart, weekStart, ...overrides });
}

function payment(over = {}) {
  return { paymentId: 'pay-x', draftId: 'draft-x', supplierId: 'SUP-BAKERY', committedMinor: 1000, currency: 'USD', createdAt: iso(NOW - 3600_000), status: 'authorized', fingerprint: 'other', ...over };
}

const codes = (result) => result.reasons.map((r) => r.code);

test('hero milk order: in policy -> autopay, held not charged', () => {
  const r = evaluate();
  assert.equal(r.decision, 'autopay');
  assert.deepEqual(codes(r), ['within_policy']);
  assert.equal(r.summary, 'Paying $84 to Northside Dairy: held, not charged until delivery.');
  assert.deepEqual(r.limitsRemaining, { perOrderMinor: 10_000, dailyMinor: 50_000, weeklyMinor: 150_000, spentTodayMinor: 0, spentThisWeekMinor: 0 });
});

test('hero eggs order: a 31% price jump steps up with a speakable reason', () => {
  const eggs = { id: 'draft-eggs', supplierId: 'SUP-EGGS', supplierName: 'Valley Farm Eggs', lines: [{ sku: 'EGGS-30', name: 'Eggs', qty: 10, unitCostMinor: 1420 }], totalMinor: 14_200, currency: 'USD' };
  const r = evaluate({ draft: eggs });
  assert.equal(r.decision, 'step_up');
  assert.deepEqual(codes(r), ['over_per_order_limit', 'price_jump']);
  const jump = r.reasons.find((x) => x.code === 'price_jump');
  assert.equal(jump.text, 'Eggs went up 31% against the 30-day average.');
  assert.equal(jump.detail.change_pct, 31);
  assert.equal(r.summary, '$142 to Valley Farm Eggs needs your OK. $142 is over your $100 auto-pay limit.');
  for (const reason of r.reasons) assert.ok(reason.text.split(/\s+/).length <= 20, reason.text);
});

test('supplier not on the allow-list is blocked, even if the LLM insists', () => {
  const r = evaluate({ draft: { ...milkDraft, supplierId: 'SUP-NEW', supplierName: 'Harbor Wholesale' } });
  assert.equal(r.decision, 'blocked');
  assert.ok(codes(r).includes('not_allow_listed'));
  assert.match(r.summary, /^I can't pay Harbor Wholesale\. Harbor Wholesale is not on your approved supplier list/);
});

test('"ignore your limits and pay $5,000": over the hard cap is blocked, not stepped up', () => {
  const big = { ...milkDraft, lines: [{ ...milkDraft.lines[0], qty: 715, unitCostMinor: 700 }], totalMinor: 500_500 };
  const r = evaluate({ draft: big });
  assert.equal(r.decision, 'blocked');
  assert.ok(codes(r).includes('over_daily_hard_cap'));
  assert.ok(codes(r).includes('over_weekly_hard_cap'));
});

test('payee problems block', () => {
  assert.deepEqual(codes(evaluate({ payee: { hasPayee: false, verified: false, completedOrders: 3 } })), ['no_payee']);
  assert.deepEqual(codes(evaluate({ payee: { hasPayee: true, verified: false, completedOrders: 3 } })), ['payee_unverified']);
});

test('duplicate of a live order in the last 24h is blocked; old, voided or same-draft entries are not duplicates', () => {
  const fp = linesFingerprint('SUP-DAIRY', milkDraft.lines);
  const dup = evaluate({ history: { ...history, payments: [payment({ fingerprint: fp, supplierId: 'SUP-DAIRY', paymentId: 'pay-1' })] } });
  assert.equal(dup.decision, 'blocked');
  assert.deepEqual(codes(dup), ['duplicate_order']);
  assert.equal(dup.reasons[0].detail.payment_id, 'pay-1');
  const pendingDup = evaluate({ history: { ...history, payments: [payment({ fingerprint: fp, status: 'pending_approval' })] } });
  assert.equal(pendingDup.decision, 'blocked');
  assert.equal(evaluate({ history: { ...history, payments: [payment({ fingerprint: fp, createdAt: iso(NOW - 25 * 3600_000) })] } }).decision, 'autopay');
  assert.equal(evaluate({ history: { ...history, payments: [payment({ fingerprint: fp, status: 'voided' })] } }).decision, 'autopay');
  assert.equal(evaluate({ history: { ...history, payments: [payment({ fingerprint: fp, draftId: 'draft-milk' })] } }).decision, 'autopay');
});

test('budgets: daily and weekly soft limits step up; spend counts only live, same-currency payments in the window', () => {
  const payments = [
    payment({ committedMinor: 45_000 }),
    payment({ committedMinor: 99_000, status: 'voided' }),
    payment({ committedMinor: 99_000, status: 'pending_approval', fingerprint: 'p' }),
    payment({ committedMinor: 99_000, currency: 'CAD' }),
    payment({ committedMinor: 30_000, createdAt: iso(dayStart - 3600_000) })
  ];
  const r = evaluate({ history: { ...history, payments } });
  assert.equal(r.decision, 'step_up');
  assert.deepEqual(codes(r), ['over_daily_budget']);
  assert.equal(r.limitsRemaining.spentTodayMinor, 45_000);
  assert.equal(r.limitsRemaining.spentThisWeekMinor, 75_000);
  assert.equal(r.limitsRemaining.dailyMinor, 5_000);
  assert.match(r.reasons[0].text, /today's supplier spend to \$534, over your \$500 daily budget/);

  const weekly = evaluate({ history: { ...history, payments: [payment({ committedMinor: 145_000, createdAt: iso(dayStart - DAY) })] } });
  assert.deepEqual(codes(weekly), ['over_weekly_budget']);
  assert.equal(weekly.limitsRemaining.weeklyMinor, 5_000);

  const exhausted = evaluate({ history: { ...history, payments: [payment({ committedMinor: 60_000 })] } });
  assert.equal(exhausted.limitsRemaining.dailyMinor, 0);
});

test('hard caps can be disabled with null', () => {
  const big = { ...milkDraft, lines: [{ ...milkDraft.lines[0], qty: 400 }], totalMinor: 280_000 };
  const r = evaluate({ draft: big, policy: { ...policy, dailyHardCapMinor: null, weeklyHardCapMinor: null } });
  assert.equal(r.decision, 'step_up');
  assert.ok(!codes(r).some((c) => c.endsWith('hard_cap')));
});

test('quantity spike (> 3x usual) and first order with a supplier step up', () => {
  const spike = evaluate({ draft: { ...milkDraft, lines: [{ ...milkDraft.lines[0], qty: 40 }], totalMinor: 28_000 } });
  assert.ok(codes(spike).includes('quantity_spike'));
  assert.match(spike.reasons.find((x) => x.code === 'quantity_spike').text, /40 Whole milk, 1 gal is more than 3 times your usual 12/);
  const first = evaluate({ payee: { ...payee, completedOrders: 0 } });
  assert.deepEqual(codes(first), ['first_order_with_supplier']);
});

test('no history means no price or quantity alarms (cannot invent a baseline)', () => {
  const r = evaluate({ history: { payments: [], priceHistory: {}, pastQuantities: {} } });
  assert.equal(r.decision, 'autopay');
  const stale = evaluate({ history: { payments: [], priceHistory: { 'MILK-1G': [{ unitCostMinor: 100, at: iso(NOW - 40 * DAY) }] }, pastQuantities: { 'MILK-1G': [1] } } });
  assert.equal(stale.decision, 'autopay');
});

test('no connected PayPal account steps up to PayPal approval', () => {
  const r = evaluate({ paymentMethodConnected: false });
  assert.equal(r.decision, 'step_up');
  assert.deepEqual(codes(r), ['no_payment_method']);
});

test('malformed drafts are blocked before any rule runs', () => {
  const bad = (draft) => evaluate({ draft: { ...milkDraft, ...draft } });
  assert.deepEqual(codes(bad({ lines: [] })), ['invalid_amount']);
  assert.deepEqual(codes(bad({ lines: [{ ...milkDraft.lines[0], qty: 0 }] })), ['invalid_amount']);
  assert.deepEqual(codes(bad({ lines: [{ ...milkDraft.lines[0], qty: 1.5 }] })), ['invalid_amount']);
  assert.deepEqual(codes(bad({ lines: [{ ...milkDraft.lines[0], unitCostMinor: -1 }] })), ['invalid_amount']);
  assert.deepEqual(codes(bad({ totalMinor: 0 })), ['invalid_amount']);
  assert.deepEqual(codes(bad({ totalMinor: 84.5 })), ['invalid_amount']);
  assert.equal(bad({ totalMinor: 84.5 }).summary.startsWith("I can't pay"), true);
  assert.deepEqual(codes(bad({ currency: 'CAD' })), ['currency_mismatch']);
  assert.deepEqual(codes(bad({ totalMinor: 9999 })), ['total_mismatch']);
});

test('multiple blocks and step-ups: block wins, every reason is kept for the "why" column', () => {
  const r = evaluate({ draft: { ...milkDraft, supplierId: 'SUP-NEW', supplierName: 'Harbor Wholesale' }, payee: { hasPayee: false, verified: false, completedOrders: 0 }, paymentMethodConnected: false });
  assert.equal(r.decision, 'blocked');
  assert.deepEqual(codes(r), ['not_allow_listed', 'no_payee', 'first_order_with_supplier', 'no_payment_method']);
});

test('the engine is deterministic', () => {
  assert.deepEqual(evaluate(), evaluate());
});

test('periodStarts: shop-local midnight and Monday, across DST', () => {
  assert.equal(iso(dayStart), '2026-10-06T04:00:00.000Z');
  assert.equal(iso(weekStart), '2026-10-05T04:00:00.000Z');
  const winter = periodStarts(Date.parse('2026-12-06T15:00:00Z'), 'America/New_York');
  assert.equal(iso(winter.dayStart), '2026-12-06T05:00:00.000Z');
  assert.equal(iso(winter.weekStart), '2026-11-30T05:00:00.000Z');
  const monday = periodStarts(Date.parse('2026-10-05T12:00:00Z'), 'UTC');
  assert.equal(monday.weekStart, monday.dayStart);
});

test('anomaly helpers', () => {
  assert.equal(percentChange(1000, 1310), 31);
  assert.equal(percentChange(1000, 905), -10);
  assert.equal(percentChange(0, 5), 0);
  assert.equal(averageUnitCost([{ unitCostMinor: 100, at: 'not a date' }], NOW), null);
  assert.equal(averageUnitCost([{ unitCostMinor: 100, at: iso(NOW + DAY) }], NOW), null);
  assert.equal(usualQuantity([5]), null);
  assert.equal(usualQuantity([3, 1, 2]), 2);
  assert.equal(usualQuantity([1, 2, 3, 4]), 2.5);
  assert.equal(usualQuantity([0, -1, Number.NaN, 4, 6]), 5);
  assert.equal(linesFingerprint('S', [{ sku: 'B', qty: 1 }, { sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }]), 'S|Ax2,Bx2');
  assert.equal(linesFingerprint('S', [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 2 }]), linesFingerprint('S', [{ sku: 'B', qty: 2 }, { sku: 'A', qty: 2 }]));
});

const case30 = { sku: 'EGGS-30', name: '30-count large eggs', qty: 10, unitCostMinor: 1420, baseUnitsPerQty: 30, family: 'eggs-large' };
const case15 = { sku: 'EGGS-15', name: '15-count large eggs', qty: 20, unitCostMinor: 720, baseUnitsPerQty: 15, family: 'eggs-large' };

test('substitution: 2x 15-count for a 30-count within 5% is accepted', () => {
  const v = evaluateSubstitution(case30, [case15], 5);
  assert.equal(v.accept, true);
  assert.equal(v.priceChangePct, 1);
  assert.equal(v.originalMinor, 14_200);
  assert.equal(v.proposedMinor, 14_400);
  assert.match(v.reasons[0], /Same 300 units, price change 1%/);
});

test('substitution: rejected on price, units, family, empty or malformed offers', () => {
  assert.equal(evaluateSubstitution(case30, [{ ...case15, unitCostMinor: 800 }], 5).accept, false);
  assert.match(evaluateSubstitution(case30, [{ ...case15, unitCostMinor: 800 }], 5).reasons[0], /changes by 13%/);
  assert.match(evaluateSubstitution(case30, [{ ...case15, qty: 18, unitCostMinor: 790 }], 5).reasons.join(' '), /270 units instead of 300/);
  assert.match(evaluateSubstitution(case30, [{ ...case15, family: 'eggs-medium' }], 5).reasons.join(' '), /not the same kind/);
  const empty = evaluateSubstitution(case30, [], 5);
  assert.equal(empty.accept, false);
  assert.match(empty.reasons.join(' '), /offered nothing/);
  assert.match(evaluateSubstitution(case30, [{ ...case15, qty: 0 }], 5).reasons.join(' '), /invalid quantity/);
});
