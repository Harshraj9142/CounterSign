import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AppContext } from '../src/core/context.js';
import { approveBatch, proposeBatch } from '../src/core/payments.js';
import * as repo from '../src/core/repo.js';
import { createMcpServer } from '../src/mcp/server.js';
import { testContext, waitFor } from './helpers.js';

async function connect(ctx: AppContext, elicit?: (msg: string) => { action: 'accept' | 'decline'; content?: Record<string, unknown> }) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createMcpServer(ctx).connect(serverT);
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: elicit ? { elicitation: {} } : {} });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, async (req) => elicit(req.params.message));
  await client.connect(clientT);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { structuredContent?: any; isError?: boolean; content: { text: string }[] };
  return r;
};

const CLEAR = ['oct-priya', 'oct-leo', 'oct-sam', 'oct-ana'];

test('the agent has no tool that can approve payments or change the mandate or vendors', async () => {
  const client = await connect(testContext());
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('propose_payment_batch'));
  for (const n of names) assert.doesNotMatch(n, /approve|sign|mandate_update|add_vendor|update_vendor|set_payout/);
});

test('full flow: scan → propose (held invoices excluded) → human approves → paid → reconciled', async () => {
  const ctx = testContext();
  const client = await connect(ctx);

  const scan = await call(client, 'scan_invoices', { period: '2026-10' });
  assert.equal(scan.structuredContent.summary.clear, 4);
  assert.equal(scan.structuredContent.summary.hold, 2);
  assert.equal(scan.structuredContent.summary.payable_cents, 907000);

  // A naive or manipulated agent asks to pay everything, including the scams.
  const prop = await call(client, 'propose_payment_batch', { invoice_ids: [...CLEAR, 'oct-jake', 'oct-dev'] });
  const batch = prop.structuredContent.batch;
  assert.equal(batch.status, 'PENDING_APPROVAL');
  assert.equal(batch.total_cents, 907000);
  assert.deepEqual(prop.structuredContent.excluded.map((e: any) => e.invoice_id).sort(), ['oct-dev', 'oct-jake']);
  // Payees come from the registry.
  for (const item of batch.items) assert.equal(item.payout_email, repo.getVendor(ctx.db, item.vendor_id)!.payout_email);
  assert.ok(batch.checks.every((c: any) => c.ok));

  // Nothing has been sent to PayPal yet.
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM mock_payouts').get()!.n, 0);

  // The human approves (dashboard path).
  const approved = await approveBatch(ctx, batch.id, 'Maya Chen (dashboard)', 'dashboard');
  assert.equal(approved.status, 'SUBMITTED');
  await waitFor(() => repo.getBatch(ctx.db, batch.id)!.status === 'PAID');

  // Approving twice must not pay twice.
  await assert.rejects(approveBatch(ctx, batch.id, 'Maya Chen (dashboard)', 'dashboard'));
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM mock_payouts').get()!.n, 1);

  const rec = await call(client, 'reconcile_payments');
  assert.equal(rec.structuredContent.paid.length, 4);
  assert.equal(rec.structuredContent.receipts_written.length, 4);
  assert.equal(rec.structuredContent.budget_remaining_cents, 2000000 - 907000);

  // Already-paid invoices can't be proposed again.
  const again = await call(client, 'propose_payment_batch', { invoice_ids: ['oct-priya'] });
  assert.equal(again.structuredContent.batch, null);

  const audit = await call(client, 'verify_audit_log');
  assert.equal(audit.structuredContent.ok, true);
});

test('in-chat approval via MCP elicitation pays; declining leaves it pending', async () => {
  const ctx = testContext();
  const yes = await connect(ctx, () => ({ action: 'accept', content: { approve: true } }));
  const r1 = await call(yes, 'propose_payment_batch', { invoice_ids: ['oct-priya', 'oct-ana'] });
  assert.equal(r1.structuredContent.approval.channel, 'in-chat');
  assert.equal(r1.structuredContent.batch.status, 'SUBMITTED');
  assert.equal(r1.structuredContent.batch.approval_channel, 'mcp-elicitation');

  const no = await connect(ctx, () => ({ action: 'decline' }));
  const r2 = await call(no, 'propose_payment_batch', { invoice_ids: ['oct-leo'] });
  assert.equal(r2.structuredContent.batch.status, 'PENDING_APPROVAL');
});

test('mandate limits: batch over the limit is refused; tampered mandate blocks everything', async () => {
  const ctx = testContext();
  ctx.db.prepare("UPDATE mandates SET terms_json = json_set(terms_json, '$.max_per_batch_cents', 100000)").run();
  const r = proposeBatch(ctx, CLEAR, 'agent');
  // Signature no longer matches the edited terms, so nothing can be proposed.
  assert.equal(r.batch, undefined);
  assert.match(r.problem!, /no valid signed mandate/i);
});

test('vendor payout account changed after proposal blocks approval', async () => {
  const ctx = testContext();
  const { batch } = proposeBatch(ctx, ['oct-priya'], 'agent');
  ctx.db.prepare("UPDATE vendors SET payout_email = 'attacker@evil.example' WHERE id = 'priya-raman'").run();
  await assert.rejects(approveBatch(ctx, batch!.id, 'Maya', 'dashboard'), /verified vendor account/);
});
