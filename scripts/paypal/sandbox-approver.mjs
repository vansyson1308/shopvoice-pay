// Approves a PayPal *sandbox* approval link (order payer-action or vault
// setup-token approve) as the sandbox buyer, in headless Chromium. Used only
// by the spike and the sandbox test suite so the money flow can run
// unattended; the real product sends the owner to PayPal instead.
//
// Credentials come from env (SPIKE_BUYER_EMAIL / SPIKE_BUYER_PASSWORD) and are
// typed into PayPal's own sandbox login page, nowhere else. Refuses any URL
// that is not on sandbox.paypal.com.
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const APPROVE_TEXT = /^(continue|agree (and|&) continue|agree & continue|save and continue|continue to review order|pay now|complete purchase|agree|accept)$/i;

/**
 * Behind a TLS-intercepting egress proxy, Chromium must trust the proxy's CA.
 * We pin exactly that CA's public key instead of disabling verification.
 */
function proxyCaSpki() {
  const file = process.env.SPIKE_PROXY_CA_FILE || '/root/.ccr/agent-proxy-ca.crt';
  if (!existsSync(file)) return null;
  const der = new X509Certificate(readFileSync(file)).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}

export async function approveInSandbox(url, { email, password, returnHost, log = () => {}, screenshotDir = null, timeoutMs = 120_000 }) {
  const target = new URL(url);
  if (!/(^|\.)sandbox\.paypal\.com$/.test(target.hostname)) throw new Error(`approver_refuses_non_sandbox_url:${target.hostname}`);
  if (!email || !password) throw new Error('approver_needs_SPIKE_BUYER_EMAIL_and_SPIKE_BUYER_PASSWORD');
  const { chromium } = await import('playwright');
  const spki = proxyCaSpki();
  const browser = await chromium.launch({
    ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}),
    args: spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : []
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const deadline = Date.now() + timeoutMs;
  const shot = async (name) => {
    if (!screenshotDir) return;
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: `${screenshotDir}/${Date.now()}-${name}.png`, fullPage: true }).catch(() => {});
  };
  const done = () => returnHost && new URL(page.url()).hostname.endsWith(returnHost);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    let loggedIn = false;
    let clicks = 0;
    while (Date.now() < deadline && !done()) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      const emailBox = page.locator('#email');
      const passwordBox = page.locator('#password');
      if (!loggedIn && await emailBox.isVisible().catch(() => false)) {
        log('login: email');
        await emailBox.fill(email);
        const next = page.locator('#btnNext');
        if (await next.isVisible().catch(() => false)) {
          await next.click();
          await passwordBox.waitFor({ state: 'visible', timeout: 20_000 });
        }
      }
      if (!loggedIn && await passwordBox.isVisible().catch(() => false)) {
        log('login: password');
        await passwordBox.fill(password);
        await page.locator('#btnLogin').click();
        loggedIn = true;
        await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
        continue;
      }
      const buttons = page.locator('button:visible, input[type=submit]:visible, [role=button]:visible');
      const count = await buttons.count();
      let clicked = false;
      for (let i = 0; i < count; i += 1) {
        const button = buttons.nth(i);
        const text = ((await button.innerText().catch(() => '')) || (await button.getAttribute('value').catch(() => '')) || '').trim();
        const testId = (await button.getAttribute('data-testid').catch(() => '')) || '';
        if (APPROVE_TEXT.test(text) || /submit-button|consentButton|payment-submit/i.test(testId) || (await button.getAttribute('id').catch(() => '')) === 'payment-submit-btn') {
          log(`click: "${text || testId}"`);
          await button.click({ timeout: 10_000 }).catch(() => {});
          clicks += 1;
          clicked = true;
          await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
          break;
        }
      }
      if (!clicked) await sleep(1500);
      if (clicks > 6) break;
    }
    await shot('final');
    return { finalHost: new URL(page.url()).hostname, loggedIn, clicks };
  } catch (error) {
    await shot('error');
    throw error;
  } finally {
    await browser.close();
  }
}
