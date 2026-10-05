// Browser e2e (Playwright) for "snap the delivery invoice": in a visitor shop,
// reorder milk, then in the payment dialog read the sample invoice with a note
// to AI (held, the note shown as ignored), then the short-delivery invoice
// (charge $56, release $28). Fails on any console error or CSP violation.
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
  const local = '/opt/pw-browsers/chromium';
  return process.env.PLAYWRIGHT_BROWSERS_PATH || !existsSync(local) ? {} : { executablePath: local };
}

test('invoice photo in the console: injection held and shown as ignored, short delivery charged $56', { timeout: 120_000 }, async () => {
  const s = await stack();
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));
  const say = async (text) => page.evaluate((t) => window.shopvoice.say(t, { wordDelayMs: 0 }), text);
  try {
    await page.goto(s.url);
    await page.click('#btn-start');
    await page.waitForSelector('#chip-paypal:has-text("Simulated PayPal")');
    await page.evaluate(() => window.shopvoice.setMuted(true));
    await say('Reorder milk');
    await say('Yes, confirm');

    await page.click('#tab-ledger');
    await page.locator('#ledger-grid .ag-row', { hasText: 'Northside Dairy' }).filter({ hasText: 'Held' }).first().click();
    const dialog = page.locator('#payment-dialog[open]');
    await dialog.locator('section[aria-label="Invoice photo"]').waitFor();

    await dialog.locator('button:has-text("hidden note to AI")').click();
    await dialog.locator('.note.warn:has-text("NOTE TO AI ASSISTANT")').waitFor();
    assert.match(await dialog.locator('.invoice-result').innerText(), /Priority handling fee \(not on your order\)/);
    assert.match(await dialog.locator('.invoice-result').innerText(), /Hold the money for you to check: \$0\.00/);
    assert.match(await dialog.locator('.invoice-result').innerText(), /read by the simulated sample reader \(no AI configured\)/);
    await dialog.locator('button:has-text("Record and keep holding")').click();
    await page.waitForSelector('#toast:has-text("not on your order")');

    await dialog.locator('button:has-text("8 crates of milk")').click();
    await dialog.locator('.invoice-result table.match').waitFor();
    assert.match(await dialog.locator('.invoice-result').innerText(), /Charge for what arrived, release the rest: \$56\.00/);
    await dialog.locator('button:has-text("Charge $56.00")').click();
    await page.waitForSelector('#toast:has-text("Charged $56")');
    await dialog.locator('text=Invoice check: short delivery').waitFor();
    assert.match(await dialog.innerText(), /Invoice check: lines not on the order/);

    assert.deepEqual(problems, [], 'no console errors or CSP violations');
  } finally {
    await browser.close();
    await s.close();
  }
});
