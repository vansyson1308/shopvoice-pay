import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countWords, fitSpeech, pluralize, formatQty, formatMoney, speakList, formatDaysLeft, percentChange, compareClause
} from '../../apps/mcp-server/dist/speech.js';
import {
  resolvePeriod, resolveComparison, describeDate, weekdayIndex, suggestedOrderQty, needsReorder, daysOfCover, roundUpToPack, addDays
} from '../../apps/mcp-server/dist/analytics.js';
import { invoiceMatches, hashConfirmationToken, generateConfirmationToken } from '../../apps/mcp-server/dist/tools.js';
import { similarity, wordSimilarity } from '../../apps/mcp-server/dist/memory-store.js';
import { loadMcpServerConfig } from '../../apps/mcp-server/dist/config.js';
import { safeErrorSpeech } from '../../apps/mcp-server/dist/mcp.js';

const USD = { currency: 'USD', vndPerUnit: 25000 };
const VND = { currency: 'VND', vndPerUnit: 1 };

test('fitSpeech picks the first candidate within budget, else truncates', () => {
  assert.equal(fitSpeech(['one two three', 'one'], 2), 'one');
  assert.equal(fitSpeech(['a b c d e f'], 3), 'a b c.');
  assert.equal(countWords('  Four items   are low. '), 4);
});

test('units are pluralised and quantities rounded', () => {
  assert.equal(pluralize('loaf', 2), 'loaves');
  assert.equal(pluralize('box', 3), 'boxes');
  assert.equal(pluralize('carton', 1), 'carton');
  assert.equal(formatQty(12.6, 'can'), '13 cans');
  assert.equal(formatQty(1, 'tray'), '1 tray');
  assert.equal(formatQty(1200, null), '1,200 units');
});

test('money is spoken in the display currency', () => {
  assert.equal(formatMoney(10_950_000, USD), '$438');
  assert.equal(formatMoney(100_000, USD), '$4.00');
  assert.equal(formatMoney(2_450_000, VND), '2.5 million dong');
  assert.equal(formatMoney(850_000, VND), '850 thousand dong');
  assert.equal(formatMoney(1_000_000, VND), '1 million dong');
});

test('lists are capped at 3 items with "and N more"', () => {
  assert.equal(speakList(['a', 'b']), 'a and b');
  assert.equal(speakList(['a', 'b', 'c']), 'a; b; and c');
  assert.equal(speakList(['a', 'b', 'c', 'd', 'e']), 'a; b; c; and 2 more');
});

test('days left and change phrasing', () => {
  assert.equal(formatDaysLeft(null), 'no recent sales');
  assert.equal(formatDaysLeft(0.4), 'under a day left');
  assert.equal(formatDaysLeft(1.9), '1 day left');
  assert.equal(percentChange(110, 100), 10);
  assert.equal(percentChange(5, 0), null);
  assert.equal(compareClause(-12, 'last Friday', '$420'), "down 12% on last Friday's $420");
  assert.equal(compareClause(0, 'the week before', '$3,046'), "level with the week before's $3,046");
});

test('periods resolve relative to the shop date', () => {
  const friday = '2026-09-25';
  assert.equal(weekdayIndex(friday), 4);
  assert.deepEqual(resolvePeriod('this_week', friday), { start: '2026-09-21', end: friday, label: 'this week', partial: true });
  assert.deepEqual(resolvePeriod('last_week', friday), { start: '2026-09-14', end: '2026-09-20', label: 'last week', partial: false });
  assert.equal(resolvePeriod('last_7_days', friday).start, '2026-09-18');
  assert.throws(() => resolvePeriod('custom', friday, { start: '2026-09-30' }), /future/);
  assert.throws(() => resolvePeriod('custom', friday, { start: '2026-02-30' }), /invalid_date/);
  assert.throws(() => resolvePeriod('custom', friday, {}), /requires_start/);
});

test('comparisons: same weekday last week, previous period, named weekday', () => {
  const today = '2026-09-25';
  const t = resolvePeriod('today', today);
  assert.equal(resolveComparison(t, today, 'auto').start, '2026-09-18');
  assert.equal(resolveComparison(t, today, 'auto', 'friday').start, '2026-09-18', 'on a Friday, last Friday is a week ago');
  assert.equal(resolveComparison(t, today, 'auto', 'monday').start, '2026-09-21');
  assert.equal(resolveComparison(t, today, 'none'), null);
  const week = resolvePeriod('last_7_days', today);
  const prev = resolveComparison(week, today, 'auto');
  assert.deepEqual([prev.start, prev.end], ['2026-09-11', '2026-09-17']);
  assert.equal(describeDate('2026-09-18', today), 'last Friday');
  assert.equal(describeDate('2026-09-23', today), 'Wednesday');
  assert.equal(describeDate('2026-09-01', today), 'September 1');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('reorder math: cover target (lead + 7) x forecast - on hand, pack rounding', () => {
  const row = { onHand: 13, minQty: 28, reorderQty: 108, packSize: 12, leadTimeDays: 1, avgDaily14d: 15, sku: 'M', name: 'Milk', unit: 'carton', barcode: null, unitCostVnd: 1, supplierCode: 'S' };
  assert.equal(daysOfCover(row), 0.9);
  assert.equal(suggestedOrderQty(row), 108, '(1+7)*15-13 = 107 -> 108');
  assert.equal(needsReorder(row), true);
  const healthy = { ...row, onHand: 200 };
  assert.equal(suggestedOrderQty(healthy), 0);
  assert.equal(needsReorder(healthy), false);
  const noSales = { ...row, avgDaily14d: 0 };
  assert.equal(daysOfCover(noSales), null);
  assert.equal(suggestedOrderQty(noSales), 108, 'falls back to reorder_qty when low with no sales');
  assert.equal(roundUpToPack(24, 24), 24);
  assert.equal(roundUpToPack(25, 24), 48);
});

test('invoice matching uses supplier, product words and simple synonyms', () => {
  const inv = { supplierName: 'Sunrise Beverages', supplierCode: 'SUP-BEV', invoiceNumber: 'SRB-1', productNames: ['Green Tea 450ml', 'Lager Beer 330ml Can'] };
  assert.equal(invoiceMatches(inv, 'Sunrise'), true);
  assert.equal(invoiceMatches(inv, 'the drinks invoice'), true);
  assert.equal(invoiceMatches(inv, 'beer'), true);
  assert.equal(invoiceMatches(inv, 'snacks'), false);
});

test('confirmation tokens are random and only their hash is stored', () => {
  const a = generateConfirmationToken();
  assert.notEqual(a, generateConfirmationToken());
  assert.match(hashConfirmationToken(a), /^[0-9a-f]{64}$/);
});

test('in-memory trigram similarity mirrors pg_trgm on demo queries', () => {
  assert.equal(wordSimilarity('milk', 'Fresh Milk 1L'), 1);
  assert.equal(wordSimilarity('egg', 'Chicken Eggs 10-pack'), 0.75);
  assert.equal(wordSimilarity('pepsi', 'Ground Pepper 50g'), 0.5);
  assert.ok(similarity('cola', 'Cola 330ml Can') > 0.3);
});

test('config defaults and production hardening', () => {
  const dev = loadMcpServerConfig({ MCP_DATA_BACKEND: 'memory' });
  assert.equal(dev.port, 8090);
  assert.equal(dev.allowLocalhostOrigins, true);
  assert.equal(dev.confirmTtlSeconds, 300);
  const prod = loadMcpServerConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', MCP_ALLOWED_ORIGINS: 'https://a.example, https://b.example' });
  assert.equal(prod.allowLocalhostOrigins, false);
  assert.deepEqual(prod.allowedOrigins, ['https://a.example', 'https://b.example']);
  assert.throws(() => loadMcpServerConfig({}), /MCP_DB_URL/);
});

test('errors are turned into short speakable sentences without internals', () => {
  const s = safeErrorSpeech(new Error('connect ECONNREFUSED 10.0.0.5:5432 postgres://user:pw@host'));
  assert.doesNotMatch(s, /ECONNREFUSED|postgres|5432/);
  assert.ok(countWords(s) <= 35);
});
