/**
 * Registers PUBLIC_URL/webhooks/paypal with PayPal for all Payouts events and prints the webhook ID.
 *   PUBLIC_URL=https://your-app.onrender.com npm run sandbox:webhook
 */
import { loadConfig } from '../src/config.js';
import { RestPayPal } from '../src/paypal/rest.js';

const EVENTS = [
  'PAYMENT.PAYOUTSBATCH.DENIED',
  'PAYMENT.PAYOUTSBATCH.PROCESSING',
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
  'PAYMENT.PAYOUTS-ITEM.HELD',
  'PAYMENT.PAYOUTS-ITEM.REFUNDED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
];

const cfg = loadConfig();
if (cfg.mode === 'mock') {
  console.error('Set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox) in .env first.');
  process.exit(1);
}
if (!cfg.publicUrl.startsWith('https://')) {
  console.error(`PayPal needs a public HTTPS URL. PUBLIC_URL is ${cfg.publicUrl}. Deploy (e.g. Render) or use a tunnel, then set PUBLIC_URL.`);
  process.exit(1);
}
const url = `${cfg.publicUrl}/webhooks/paypal`;
const pp = new RestPayPal(cfg);
const { webhooks } = await pp.listWebhooks();
const existing = webhooks.find((w) => w.url === url);
const id = existing?.id ?? (await pp.registerWebhook(url, EVENTS)).id;
console.log(`${existing ? 'Already registered' : 'Registered'}: ${url}`);
console.log(`\nAdd this to your environment:\n  PAYPAL_WEBHOOK_ID=${id}`);
