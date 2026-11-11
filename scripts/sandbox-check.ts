/**
 * Checks your PayPal sandbox setup before you demo.
 *   npm run sandbox:check                 # credentials, balance, reporting, webhooks, recipients
 *   npm run sandbox:check -- --payout     # also sends a $1.00 sandbox payout to the first recipient
 */
import { loadConfig } from '../src/config.js';
import { RestPayPal } from '../src/paypal/rest.js';
import { PayPalError } from '../src/paypal/types.js';

const ok = (s: string) => console.log(`  ✓ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);
const info = (s: string) => console.log(`    ${s}`);
let failures = 0;

const cfg = (() => {
  try {
    return loadConfig();
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }
})();
if (cfg.mode === 'mock') {
  console.log('PAYPAL_MODE is mock (no PAYPAL_CLIENT_ID set). Add sandbox credentials to .env first; see README → "Connect PayPal sandbox".');
  process.exit(1);
}
console.log(`Checking PayPal ${cfg.mode}…\n`);
const pp = new RestPayPal(cfg);

// 1. Credentials + balance
try {
  const balances = await pp.getBalances('USD');
  ok(`Credentials work. Business account balance: ${balances.map((b) => `${b.available} ${b.currency}`).join(', ') || 'no USD balance returned'}`);
  const usd = Number(balances.find((b) => b.currency === 'USD')?.available ?? 0);
  if (usd < 10000) info('Tip: give the sandbox business account a large USD balance (e.g. 50,000) so demo payouts never fail for funds.');
} catch (err) {
  const e = err as PayPalError;
  if (e.status === 401) {
    bad('PayPal rejected the client ID/secret. Check you copied the SANDBOX credentials of the right app.');
    failures++;
  } else if (e.status === 403) {
    ok('Credentials work (OAuth succeeded).');
    bad('Balance API not permitted yet. Enable "Transaction search" for the app; it can take a few hours to activate.');
  } else {
    bad(String(e));
    failures++;
  }
}

// 2. Transaction search
try {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86400_000);
  const tx = await pp.searchTransactions(start, end);
  ok(`Transaction Search works (${tx.length} transactions in the last 7 days; new ones can take ~3h to appear).`);
} catch (err) {
  bad(`Transaction Search: ${String(err)}`);
  info('Enable "Transaction search" under the app\'s Features in the developer dashboard. Activation can take hours. Countersign still works without it.');
}

// 3. Webhooks
try {
  const { webhooks } = await pp.listWebhooks();
  const mine = webhooks.find((w) => w.url === `${cfg.publicUrl}/webhooks/paypal`);
  if (mine && cfg.paypalWebhookId === mine.id) ok(`Webhook registered for ${mine.url} and PAYPAL_WEBHOOK_ID matches.`);
  else if (mine) bad(`Webhook exists (${mine.id}) but PAYPAL_WEBHOOK_ID is ${cfg.paypalWebhookId ? 'different' : 'not set'}. Set PAYPAL_WEBHOOK_ID=${mine.id}`);
  else {
    bad(`No webhook for ${cfg.publicUrl}/webhooks/paypal.`);
    info('Optional: deploy (e.g. Render) or use a tunnel, set PUBLIC_URL, then run `npm run sandbox:webhook`. Without webhooks Countersign polls PayPal every 20s.');
  }
} catch (err) {
  bad(`Webhooks: ${String(err)}`);
}

// 4. Recipients
const recipients = cfg.sandboxRecipients;
if (!recipients.length) {
  bad('SANDBOX_RECIPIENTS is empty: demo payouts would go to fictional emails and end UNCLAIMED.');
  info('Create 2–4 sandbox PERSONAL accounts and list their emails, comma-separated, in SANDBOX_RECIPIENTS.');
  failures++;
} else {
  ok(`${recipients.length} sandbox recipient(s): ${recipients.join(', ')}`);
  info('Run `npm run seed` after changing them so vendor payout accounts and invoices use these emails.');
}

// 5. Optional real payout
if (process.argv.includes('--payout')) {
  if (!recipients.length) {
    bad('Cannot test a payout without SANDBOX_RECIPIENTS.');
  } else {
    const id = `CS-CHECK-${Date.now()}`;
    try {
      const r = await pp.createPayout({
        senderBatchId: id,
        emailSubject: 'Countersign sandbox check',
        emailMessage: 'Test payout from npm run sandbox:check',
        items: [{ senderItemId: `${id}-1`, receiver: recipients[0], amountCents: 100, currency: 'USD', note: 'Countersign sandbox check' }],
      });
      ok(`Payouts works: batch ${r.payout_batch_id} (${r.batch_status}). $1.00 sent to ${recipients[0]}.`);
      await new Promise((res) => setTimeout(res, 5000));
      const snap = await pp.getPayout(r.payout_batch_id);
      info(`After 5s: batch ${snap.batch_header.batch_status}, item ${snap.items[0]?.transaction_status}`);
    } catch (err) {
      bad(`Payouts: ${String(err)}`);
      info('If this is AUTHORIZATION_ERROR / 403, enable "Payouts" under the app\'s Features in the developer dashboard.');
      failures++;
    }
  }
} else {
  info('\nRun with -- --payout to send a real $1.00 sandbox payout and confirm Payouts is enabled.');
}

console.log(failures ? `\n${failures} blocking problem(s).` : '\nSandbox looks ready.');
process.exit(failures ? 1 : 0);
