import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { type AppContext, createContext } from '../src/core/context.js';
import { seedDemo } from '../src/core/seed.js';

export function testContext(opts: { seed?: boolean; settleMs?: number } = {}): AppContext {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'countersign-test-'));
  const ctx = createContext(
    loadConfig({
      dataDir,
      mode: 'mock',
      mockSettleMs: opts.settleMs ?? 30,
      sandboxRecipients: [],
      mandateSigningKey: 'test-signing-key',
      dashboardToken: undefined,
      mcpToken: undefined,
      demoMode: true,
      port: 0,
      host: '127.0.0.1',
    }),
  );
  if (opts.seed !== false) seedDemo(ctx, []);
  return ctx;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error('waitFor timed out');
}
