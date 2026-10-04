// Browser e2e (Playwright, headless Chromium) for the ShopVoice Pay hero story
// in the console, against an in-process stack: visitor mode ("Try the demo"),
// the MCP server with mock PayPal and the owner API, the rules brain.
//
//   Try the demo -> what's running low -> reorder milk and eggs -> confirm
//   -> milk held, eggs wait -> "yes, approve it" (voice, host-matched)
//   -> only 8 crates of milk came -> ledger: $56 charged, $28 released,
//   $56 paid to the supplier -> refund $7 -> tighten a rule -> next order
//   waits -> approve on the simulated PayPal page -> reset demo.
//
// Fails on any browser console error or CSP violation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { MemoryShopStore } from '../../apps/mcp-server/dist/memory-store.js';
import { MemoryDemoShops } from '../../apps/mcp-server/dist/demo-shops.js';
import { createSimHandler, loadSimConfig } from '../../apps/console/dist/server.js';
import { RulesBrain } from '../../apps/console/dist/brain.js';
import { McpToolbox } from '../../apps/console/dist/toolbox.js';
import { BrowserSpeech } from '../../apps/console/dist/speech.js';
import { buildSandboxTenantData } from '../../scripts/gen_demo_seed.mjs';
import { startMcpServer, twoTenantDataset, mockPayments, silentLogger, DEMO_TENANT_ID, ANCHOR } from '../unit/mcp-harness.mjs';

const SECRET = 'e2e-provision-secret-0123456789abcdef';

async function stack() {
  // The console's port must be known before PayPal links are built, so reserve it first.
  let consoleHandler = null;
  const consoleServer = createServer((req, res) => void consoleHandler?.handle(req, res));
  await new Promise((r) => consoleServer.listen(0, '127.0.0.1', r));
  const consoleUrl = `http://127.0.0.1:${consoleServer.address().port}`;
  const payments = mockPayments(Date.now, { CONSOLE_PUBLIC_URL: consoleUrl });
  const store = new MemoryShopStore(twoTenantDataset());
  const demoShops = new MemoryDemoShops(store, () => buildSandboxTenantData('en', ANCHOR), payments, new Set([DEMO_TENANT_ID]));
  const mcp = await startMcpServer({ store, payments, demoShops, resetDemo: (t) => demoShops.reset(t), env: { DEMO_PROVISION_SECRET: SECRET } });
  const config = loadSimConfig({ SIM_MCP_URL: `${mcp.url}/mcp`, DEMO_PROVISION_SECRET: SECRET, DEMO_ANCHOR_DATE: ANCHOR });
  consoleHandler = createSimHandler({
    config, logger: silentLogger, toolbox: new McpToolbox(config.mcpUrl, 'unused-in-visitor-mode-0000'), brain: new RulesBrain(), fallbackBrain: new RulesBrain(),
    speech: new BrowserSpeech(), staticDir: fileURLToPath(new URL('../../apps/console/static/', import.meta.url))
  });
  return { url: consoleUrl, async close() { await new Promise((r) => consoleServer.close(r)); await mcp.close(); } };
}

function launchOptions() {
  // Prefer the preinstalled Chromium in sandboxes; CI installs Playwright's own.
  const local = '/opt/pw-browsers/chromium';
  return process.env.PLAYWRIGHT_BROWSERS_PATH || !existsSync(local) ? {} : { executablePath: local };
}

test('console hero story in a real browser: approve by voice, pay only for what arrived, PayPal page, reset', { timeout: 180_000 }, async () => {
  const s = await stack();
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));
  const say = async (text) => page.evaluate((t) => window.shopvoice.say(t, { wordDelayMs: 0 }), text);
  const reply = () => page.textContent('#reply');
  try {
    await page.goto(s.url);
    await page.click('#btn-start');
    await page.waitForSelector('#chip-paypal:has-text("Simulated PayPal")');
    assert.match(await page.textContent('#honesty'), /simulated .* No money moves/);
    await page.evaluate(() => window.shopvoice.setMuted(true));

    await say("What's running low?");
    assert.match(await reply(), /^Four items are running low/);
    await say('Reorder milk and eggs');
    await page.waitForSelector('#confirm-card:not([hidden])');
    await page.click('#btn-confirm');
    await page.waitForSelector('#done-card:not([hidden]) .status');
    assert.match(await reply(), /Say "yes" to approve \$142 to Valley Farm Eggs/);
    assert.equal(await page.textContent('#approvals-count'), '1');
    const doneText = await page.textContent('#done-body');
    assert.match(doneText, /Northside Dairy\$84\.00Held/);
    assert.match(doneText, /Valley Farm Eggs\$142\.00Waiting for you/);

    await say('Yes, approve it');
    assert.match(await reply(), /^Approved\. \$142 to Valley Farm Eggs is held/);
    assert.match(await page.textContent('#calls'), /approve_payment.*host, not the model/s);

    await say('Only 8 crates of milk came');
    assert.match(await reply(), /Charged \$56 for what arrived from Northside Dairy and released \$28/);

    await page.click('#tab-ledger');
    const dairyRow = page.locator('#ledger-grid .ag-row', { hasText: 'Northside Dairy' }).filter({ hasText: 'Partly charged' }).first();
    await dairyRow.waitFor();
    const rowText = await dairyRow.innerText();
    for (const want of ['$84.00', '$56.00', '$28.00']) assert.ok(rowText.includes(want), `ledger row shows ${want}: ${rowText}`);
    const eggsRow = page.locator('#ledger-grid .ag-row', { hasText: 'Valley Farm Eggs' }).filter({ hasText: 'You (voice)' }).first();
    await eggsRow.waitFor();

    await dairyRow.click();
    await page.waitForSelector('#payment-dialog[open] form[aria-label="Refund"]');
    await page.fill('form[aria-label="Refund"] input[name="amount"]', '7');
    await page.fill('form[aria-label="Refund"] input[name="reason"]', 'one crate was spoiled');
    await page.click('form[aria-label="Refund"] button[type="submit"]');
    await page.waitForSelector('#toast:has-text("Refund of $7")');
    await page.click('#btn-close-payment');

    // Tighten the rule: the next milk order now needs the owner, who approves on the (simulated) PayPal page.
    await page.click('#tab-policy');
    await page.waitForSelector('#policy-suppliers input');
    await page.fill('input[name="per_order_autopay_max"]', '50');
    await page.click('#policy-form button[type="submit"]');
    await page.waitForSelector('#toast:has-text("Rules saved")');
    await page.click('#tab-talk');
    await say('Reorder bread');
    await say('Yes, confirm');
    assert.match(await reply(), /Hillside Bakery \$92 needs your OK/);
    await page.click('#tab-approvals');
    const card = page.locator('.approval', { hasText: 'Hillside Bakery' });
    await card.locator('button:has-text("Approve in PayPal")').click();
    await card.locator('.paypal-link a').click();
    await page.waitForSelector('text=This is not PayPal and no money moves');
    await page.click('button:has-text("Continue")');
    await page.waitForSelector('#toast:has-text("Approved in PayPal")');
    await page.waitForSelector('#approvals-empty:not([hidden])');

    page.once('dialog', (d) => void d.accept());
    await page.click('#btn-reset-demo');
    await page.waitForSelector('#toast:has-text("Demo shop reset")');
    await page.click('#tab-ledger');
    await page.waitForSelector('#ledger-grid .ag-row');
    assert.equal(await page.locator('#ledger-grid .ag-row', { hasText: 'Held' }).count(), 0, 'reset leaves only the seeded, settled history');

    assert.deepEqual(problems, [], 'no console errors or CSP violations');
  } finally {
    await browser.close();
    await s.close();
  }
});
