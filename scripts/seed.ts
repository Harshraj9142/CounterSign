/** Resets ./data to the demo story. Usage: npm run seed */
import { createContext } from '../src/core/context.js';
import { listInvoices } from '../src/core/repo.js';
import { seedDemo } from '../src/core/seed.js';
import { fmtMoney } from '../src/core/util.js';

const ctx = createContext();
seedDemo(ctx);
console.log(`Seeded ${ctx.config.dataDir} (PayPal mode: ${ctx.paypal.mode})`);
for (const inv of listInvoices(ctx.db).filter((i) => i.file)) {
  const holds = inv.findings.filter((f) => f.severity === 'hold').map((f) => f.code);
  const warns = inv.findings.filter((f) => f.severity === 'warn').map((f) => f.code);
  console.log(
    `  ${inv.risk_status.padEnd(6)} ${inv.id.padEnd(10)} ${fmtMoney(inv.amount_cents ?? 0).padStart(10)}  ${[...holds, ...warns.map((w) => `(${w})`)].join(' ')}`,
  );
}
if (ctx.config.mode !== 'mock' && !ctx.config.sandboxRecipients.length) {
  console.warn('\nWarning: SANDBOX_RECIPIENTS is empty, so payouts will go to fictional emails and end UNCLAIMED.');
}
