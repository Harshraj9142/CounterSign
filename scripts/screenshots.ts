/**
 * Captures dashboard screenshots for the README / Devpost gallery into docs/screenshots.
 * Runs its own server in mock mode on a temporary data directory.
 *   npm run screenshots
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(out, { recursive: true });
const port = 4311;
const base = `http://localhost:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'countersign-shots-'));

const srv = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src/server.ts')], {
  cwd: root,
  env: { ...process.env, DATA_DIR: dataDir, PAYPAL_MODE: 'mock', PORT: String(port), HOST: '127.0.0.1', DEMO_MODE: 'true', SEED_ON_START: 'true', MOCK_SETTLE_MS: '1500', DASHBOARD_TOKEN: '', MCP_TOKEN: '', PUBLIC_URL: base },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', (d) => !String(d).includes('ExperimentalWarning') && process.stderr.write(d));
await new Promise((r) => srv.stdout.once('data', r));

try {
  await fetch(`${base}/api/demo/reset`, { method: 'POST', headers: { 'x-countersign': '1' } });
  // Propose a batch through MCP, as the agent would.
  let sid = '';
  const rpc = async (method: string, params: unknown, id?: number) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id ? { id } : {}) }),
    });
    sid = r.headers.get('mcp-session-id') ?? sid;
    return r.text();
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'screenshots', version: '1' } }, 1);
  await rpc('notifications/initialized', {});
  await rpc('tools/call', { name: 'propose_payment_batch', arguments: { invoice_ids: ['oct-priya', 'oct-leo', 'oct-sam', 'oct-ana'] } }, 2);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  const shot = async (name: string) => {
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    console.log(`  docs/screenshots/${name}.png`);
  };
  for (const tab of ['approvals', 'invoices', 'vendors', 'mandate']) {
    await page.goto(`${base}/#${tab}`);
    await page.waitForTimeout(1200);
    await shot(tab);
  }
  await page.goto(`${base}/#invoices`);
  await page.waitForTimeout(1000);
  await page.locator('.ag-row', { hasText: 'Claims to be Jake' }).first().click();
  await page.waitForTimeout(700);
  await shot('invoice-jake-payee-swap');
  await page.keyboard.press('Escape');
  await page.locator('.ag-row', { hasText: 'Dev Kapoor' }).first().click();
  await page.waitForTimeout(700);
  await page.locator('#drawer-body').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(300);
  await shot('invoice-dev-prompt-injection');
  await page.keyboard.press('Escape');

  await page.goto(`${base}/#approvals`);
  await page.waitForTimeout(800);
  await page.click('[data-approve]');
  await page.waitForTimeout(7000);
  await shot('payments');
  await page.goto(`${base}/#audit`);
  await page.waitForTimeout(800);
  await page.click('#verify-audit');
  await page.waitForTimeout(800);
  await shot('audit');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${base}/#payments`);
  await page.waitForTimeout(1200);
  await shot('payments-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${base}/#invoices`);
  await page.waitForTimeout(1200);
  await shot('mobile');
  await browser.close();
} finally {
  srv.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
