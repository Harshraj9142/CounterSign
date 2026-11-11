import fs from 'node:fs';
import path from 'node:path';
import type { PayoutBatchSnapshot, PayoutItemSnapshot, WebhookEvent } from '../paypal/types.js';
import { PayPalError } from '../paypal/types.js';
import type { AppContext } from './context.js';
import { committedForMonth, mandateStatus } from './mandate.js';
import * as repo from './repo.js';
import { scanInbox } from './scan.js';
import {
  type Batch,
  type BatchItem,
  type BatchStatus,
  FAILED_ITEM_STATUSES,
  type InvoiceRecord,
  type ItemStatus,
  type Vendor,
} from './types.js';
import { batchId, canonicalJson, centsToValue, fmtMoney, monthOf, nowIso, periodLabel, sha256 } from './util.js';

const APPROVAL_TTL_MS = 24 * 3600 * 1000;
const ITEM_STATUSES: ItemStatus[] = ['QUEUED', 'PENDING', 'SUCCESS', 'UNCLAIMED', 'ONHOLD', 'FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'DENIED', 'CANCELED'];

export interface BatchCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface BatchItemView extends BatchItem {
  vendor_name: string;
  invoice_number: string | null;
  period: string | null;
  warnings: string[];
}

export interface BatchView extends Batch {
  items: BatchItemView[];
  checks: BatchCheck[];
}

const emit = (ctx: AppContext, type: string) => ctx.bus.emit('change', { type });

// ---------- views & preflight ----------

function preflight(ctx: AppContext, b: Batch, items: BatchItem[]): { ok: boolean; checks: BatchCheck[] } {
  const st = mandateStatus(ctx);
  const m = st.mandate?.terms;
  const checks: BatchCheck[] = [
    {
      label: 'Signed mandate is valid and in effect',
      ok: !!m && st.signature_valid && st.in_effect && m.id === b.mandate_id,
      detail: m ? m.id : 'no mandate',
    },
    {
      label: 'Every payout goes to a verified vendor account',
      ok: items.every((i) => repo.getVendor(ctx.db, i.vendor_id)?.payout_email === i.payout_email),
    },
  ];
  const held = items.map((i) => repo.getInvoice(ctx.db, i.invoice_id)).filter((inv) => !inv || inv.risk_status === 'HOLD');
  checks.push({ label: 'No held invoices', ok: held.length === 0, detail: held.map((h) => h?.id ?? '?').join(', ') || undefined });
  if (m) {
    const largest = Math.max(...items.map((i) => i.amount_cents));
    checks.push({ label: `Each payment ≤ ${fmtMoney(m.max_per_payment_cents)}`, ok: largest <= m.max_per_payment_cents, detail: `largest ${fmtMoney(largest)}` });
    checks.push({ label: `Batch total ≤ ${fmtMoney(m.max_per_batch_cents)}`, ok: b.total_cents <= m.max_per_batch_cents, detail: fmtMoney(b.total_cents) });
    checks.push({
      label: 'Within this month\'s budget',
      ok: b.total_cents <= st.remaining_cents,
      detail: `${fmtMoney(st.remaining_cents - b.total_cents)} of ${fmtMoney(m.monthly_budget_cents)} left after this batch`,
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

export function batchView(ctx: AppContext, id: string): BatchView | undefined {
  const b = repo.getBatch(ctx.db, id);
  if (!b) return undefined;
  const raw = repo.itemsForBatch(ctx.db, id);
  const items: BatchItemView[] = raw.map((i) => {
    const inv = repo.getInvoice(ctx.db, i.invoice_id);
    return {
      ...i,
      vendor_name: repo.getVendor(ctx.db, i.vendor_id)?.name ?? i.vendor_id,
      invoice_number: inv?.invoice_number ?? null,
      period: inv?.period ?? null,
      warnings: (inv?.findings ?? []).filter((f) => f.severity === 'warn').map((f) => f.title),
    };
  });
  return { ...b, items, checks: b.status === 'PENDING_APPROVAL' ? preflight(ctx, b, raw).checks : [] };
}

export function expireStale(ctx: AppContext): void {
  const cutoff = new Date(Date.now() - APPROVAL_TTL_MS).toISOString();
  const stale = ctx.db.prepare("SELECT id FROM batches WHERE status = 'PENDING_APPROVAL' AND created_at < ?").all(cutoff) as { id: string }[];
  for (const { id } of stale) closeBatch(ctx, id, 'EXPIRED', 'countersign', 'not approved within 24 hours');
}

function closeBatch(ctx: AppContext, id: string, status: 'REJECTED' | 'EXPIRED', actor: string, reason: string): void {
  const r = ctx.db.prepare("UPDATE batches SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'").run(status, reason, nowIso(), id);
  if (!Number(r.changes)) return;
  for (const i of repo.itemsForBatch(ctx.db, id)) {
    repo.updateItem(ctx.db, i.id, { status: 'CANCELED' });
    repo.setInvoicePaymentStatus(ctx.db, i.invoice_id, 'UNPAID');
  }
  ctx.audit.append(actor, status === 'REJECTED' ? 'batch.rejected' : 'batch.expired', { batch_id: id, reason });
  emit(ctx, 'batches');
}

// ---------- propose ----------

export interface ProposeResult {
  batch?: BatchView;
  excluded: { invoice_id: string; reason: string }[];
  problem?: string;
}

/** Creates a batch awaiting human approval. Never moves money. */
export function proposeBatch(ctx: AppContext, invoiceIds: string[], actor: string, note?: string): ProposeResult {
  expireStale(ctx);
  scanInbox(ctx, { quiet: true });
  const st = mandateStatus(ctx);
  if (!st.mandate || !st.signature_valid) {
    return { excluded: [], problem: 'There is no valid signed mandate. The owner must sign one in the dashboard before any payment can be proposed.' };
  }
  const m = st.mandate.terms;
  if (!st.in_effect) return { excluded: [], problem: `Mandate ${m.id} is not in effect today (${m.valid_from} to ${m.valid_until}).` };

  const excluded: ProposeResult['excluded'] = [];
  const picks: { inv: InvoiceRecord; vendor: Vendor }[] = [];
  for (const id of [...new Set(invoiceIds)]) {
    const inv = repo.getInvoice(ctx.db, id);
    if (!inv) { excluded.push({ invoice_id: id, reason: 'invoice not found' }); continue; }
    if (inv.risk_status === 'HOLD') {
      excluded.push({ invoice_id: id, reason: `on hold: ${inv.findings.filter((f) => f.severity === 'hold').map((f) => f.title).join('; ')}` });
      continue;
    }
    if (inv.payment_status !== 'UNPAID') { excluded.push({ invoice_id: id, reason: `already ${inv.payment_status.toLowerCase()}` }); continue; }
    if (inv.currency !== m.currency) { excluded.push({ invoice_id: id, reason: `currency ${inv.currency} is not covered by the mandate` }); continue; }
    const vendor = inv.vendor_id ? repo.getVendor(ctx.db, inv.vendor_id) : undefined;
    if (!vendor || inv.amount_cents == null) { excluded.push({ invoice_id: id, reason: 'no verified vendor or amount' }); continue; }
    picks.push({ inv, vendor });
  }
  if (!picks.length) return { excluded, problem: 'Nothing in this request can be paid.' };

  const total = picks.reduce((s, p) => s + (p.inv.amount_cents ?? 0), 0);
  if (total > m.max_per_batch_cents) {
    return { excluded, problem: `Batch total ${fmtMoney(total)} exceeds the mandate's ${fmtMoney(m.max_per_batch_cents)} batch limit. Propose fewer invoices per batch.` };
  }
  if (total > st.remaining_cents) {
    return { excluded, problem: `Batch total ${fmtMoney(total)} exceeds the ${fmtMoney(st.remaining_cents)} left in this month's budget.` };
  }

  const id = batchId();
  const ts = nowIso();
  ctx.db.prepare(
    `INSERT INTO batches (id, status, mandate_id, total_cents, currency, created_by, created_at, note, updated_at)
     VALUES (?, 'PENDING_APPROVAL', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, m.id, total, m.currency, actor, ts, note ?? null, ts);
  picks.forEach(({ inv, vendor }, n) => {
    ctx.db.prepare(
      `INSERT INTO batch_items (id, batch_id, invoice_id, vendor_id, payout_email, amount_cents, currency, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?)`,
      // The payee comes from the verified vendor registry, never from the invoice text.
    ).run(`${id}-${String(n + 1).padStart(2, '0')}`, id, inv.id, vendor.id, vendor.payout_email, inv.amount_cents!, inv.currency, ts);
    repo.setInvoicePaymentStatus(ctx.db, inv.id, 'PROPOSED');
  });
  ctx.audit.append(actor, 'batch.proposed', {
    batch_id: id,
    mandate_id: m.id,
    total_cents: total,
    items: picks.map(({ inv, vendor }) => ({ invoice_id: inv.id, vendor_id: vendor.id, payout_email: vendor.payout_email, amount_cents: inv.amount_cents })),
    excluded: excluded.map((e) => e.invoice_id),
  });
  emit(ctx, 'batches');
  return { batch: batchView(ctx, id)!, excluded };
}

// ---------- approve / reject / retry ----------

async function submitToPayPal(ctx: AppContext, b: Batch): Promise<void> {
  const items = repo.itemsForBatch(ctx.db, b.id).filter((i) => i.status !== 'CANCELED');
  try {
    const res = await ctx.paypal.createPayout({
      senderBatchId: b.id,
      emailSubject: `You have a payment from ${ctx.config.businessName}`,
      emailMessage: `${ctx.config.businessName} sent you a payment. Reference ${b.id}.`,
      items: items.map((i) => {
        const inv = repo.getInvoice(ctx.db, i.invoice_id);
        return {
          senderItemId: i.id,
          receiver: i.payout_email,
          amountCents: i.amount_cents,
          currency: i.currency,
          note: `Invoice ${inv?.invoice_number ?? i.invoice_id} (${periodLabel(inv?.period)}), ${ctx.config.businessName}`,
        };
      }),
    });
    ctx.db.prepare("UPDATE batches SET status = 'SUBMITTED', paypal_batch_id = ?, paypal_status = ?, error = NULL, updated_at = ? WHERE id = ?").run(
      res.payout_batch_id, res.batch_status, nowIso(), b.id,
    );
    ctx.db.prepare("UPDATE batch_items SET status = 'PENDING', updated_at = ? WHERE batch_id = ? AND status != 'CANCELED'").run(nowIso(), b.id);
    ctx.audit.append('countersign', 'payout.submitted', {
      batch_id: b.id,
      sender_batch_id: b.id,
      paypal_batch_id: res.payout_batch_id,
      items: items.length,
      total_cents: b.total_cents,
      paypal_mode: ctx.paypal.mode,
    });
  } catch (err) {
    const msg = err instanceof PayPalError ? err.toString() : String(err);
    // Invoices stay out of circulation (FAILED) so they can't be re-proposed under a new
    // batch id; "Retry" re-sends with the SAME sender_batch_id, which PayPal de-duplicates.
    ctx.db.prepare("UPDATE batches SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?").run(msg, nowIso(), b.id);
    for (const i of items) repo.setInvoicePaymentStatus(ctx.db, i.invoice_id, 'FAILED');
    ctx.audit.append('countersign', 'payout.failed', { batch_id: b.id, error: msg });
  }
}

/** The only path that moves money. Called by a human: the dashboard button or an in-chat elicitation answer. */
export async function approveBatch(ctx: AppContext, id: string, approver: string, channel: 'dashboard' | 'mcp-elicitation'): Promise<BatchView> {
  expireStale(ctx);
  const b = repo.getBatch(ctx.db, id);
  if (!b) throw new Error(`Batch ${id} not found.`);
  if (b.status !== 'PENDING_APPROVAL') throw new Error(`Batch ${id} is ${b.status.toLowerCase().replace(/_/g, ' ')}, not awaiting approval.`);

  scanInbox(ctx, { quiet: true }); // re-check every invoice right before money moves
  const items = repo.itemsForBatch(ctx.db, id);
  const pf = preflight(ctx, b, items);
  if (!pf.ok) {
    const failed = pf.checks.filter((c) => !c.ok).map((c) => c.label);
    ctx.audit.append(approver, 'batch.approval_blocked', { batch_id: id, failed });
    throw new Error(`Approval blocked by policy: ${failed.join('; ')}.`);
  }

  const ts = nowIso();
  const claimed = ctx.db.prepare(
    "UPDATE batches SET status = 'APPROVED', approved_by = ?, approved_at = ?, approval_channel = ?, updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'",
  ).run(approver, ts, channel, ts, id);
  if (!Number(claimed.changes)) throw new Error(`Batch ${id} was just approved or changed elsewhere.`);
  ctx.audit.append(approver, 'batch.approved', { batch_id: id, channel, total_cents: b.total_cents, mandate_id: b.mandate_id });
  for (const i of items) repo.setInvoicePaymentStatus(ctx.db, i.invoice_id, 'PROCESSING');
  emit(ctx, 'batches');

  await submitToPayPal(ctx, repo.getBatch(ctx.db, id)!);
  emit(ctx, 'batches');
  return batchView(ctx, id)!;
}

export async function retryBatch(ctx: AppContext, id: string, actor: string): Promise<BatchView> {
  const b = repo.getBatch(ctx.db, id);
  if (!b || b.status !== 'FAILED' || !b.approved_at) throw new Error(`Batch ${id} is not a failed, approved batch.`);
  ctx.audit.append(actor, 'payout.retry', { batch_id: id, sender_batch_id: id });
  for (const i of repo.itemsForBatch(ctx.db, id)) repo.setInvoicePaymentStatus(ctx.db, i.invoice_id, 'PROCESSING');
  await submitToPayPal(ctx, b);
  emit(ctx, 'batches');
  return batchView(ctx, id)!;
}

export function rejectBatch(ctx: AppContext, id: string, actor: string, reason: string): BatchView {
  const b = repo.getBatch(ctx.db, id);
  if (!b) throw new Error(`Batch ${id} not found.`);
  if (b.status !== 'PENDING_APPROVAL') throw new Error(`Batch ${id} is ${b.status.toLowerCase()}, it can no longer be cancelled.`);
  closeBatch(ctx, id, 'REJECTED', actor, reason || 'rejected');
  return batchView(ctx, id)!;
}

// ---------- PayPal status updates (poll + webhooks) ----------

function normalizeStatus(s: string | undefined): ItemStatus {
  const up = (s ?? '').toUpperCase() as ItemStatus;
  return ITEM_STATUSES.includes(up) ? up : 'PENDING';
}

function applyItemSnapshot(ctx: AppContext, snap: PayoutItemSnapshot, actor: string): BatchItem | undefined {
  const ours = snap.payout_item?.sender_item_id;
  const item = (ours && repo.getItem(ctx.db, ours)) || (snap.payout_item_id && repo.getItemByPayPalId(ctx.db, snap.payout_item_id)) || undefined;
  if (!item) return undefined;
  const status = normalizeStatus(snap.transaction_status);
  const changed =
    status !== item.status ||
    (snap.payout_item_id && item.paypal_item_id !== snap.payout_item_id) ||
    (snap.transaction_id && item.transaction_id !== snap.transaction_id);
  if (!changed) return item;
  repo.updateItem(ctx.db, item.id, {
    status,
    paypal_item_id: snap.payout_item_id ?? item.paypal_item_id,
    transaction_id: snap.transaction_id ?? item.transaction_id,
  });
  if (status !== item.status) {
    ctx.audit.append(actor, 'payout.item_status', {
      item_id: item.id,
      batch_id: item.batch_id,
      vendor_id: item.vendor_id,
      from: item.status,
      to: status,
      transaction_id: snap.transaction_id ?? null,
    });
  }
  repo.setInvoicePaymentStatus(ctx.db, item.invoice_id, status === 'SUCCESS' ? 'PAID' : FAILED_ITEM_STATUSES.includes(status) ? 'FAILED' : 'PROCESSING');
  return item;
}

function recomputeBatch(ctx: AppContext, id: string): void {
  const b = repo.getBatch(ctx.db, id);
  if (!b || !b.paypal_batch_id) return;
  const items = repo.itemsForBatch(ctx.db, id).filter((i) => i.status !== 'CANCELED');
  let next: BatchStatus;
  if (items.every((i) => i.status === 'SUCCESS')) next = 'PAID';
  else if (items.some((i) => ['QUEUED', 'PENDING', 'ONHOLD'].includes(i.status))) next = 'SUBMITTED';
  else if (items.every((i) => FAILED_ITEM_STATUSES.includes(i.status))) next = 'FAILED';
  else next = 'PARTIAL';
  if (next !== b.status) {
    ctx.db.prepare('UPDATE batches SET status = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), id);
    ctx.audit.append('countersign', 'batch.status', { batch_id: id, from: b.status, to: next });
  }
}

export async function refreshBatch(ctx: AppContext, id: string): Promise<{ view: BatchView; snapshot?: PayoutBatchSnapshot }> {
  const b = repo.getBatch(ctx.db, id);
  if (!b) throw new Error(`Batch ${id} not found.`);
  if (!b.paypal_batch_id) return { view: batchView(ctx, id)! };
  const snapshot = await ctx.paypal.getPayout(b.paypal_batch_id);
  ctx.db.prepare('UPDATE batches SET paypal_status = ?, updated_at = ? WHERE id = ?').run(snapshot.batch_header.batch_status, nowIso(), id);
  for (const item of snapshot.items ?? []) applyItemSnapshot(ctx, item, 'paypal (status check)');
  recomputeBatch(ctx, id);
  emit(ctx, 'payments');
  return { view: batchView(ctx, id)!, snapshot };
}

export function applyWebhookEvent(ctx: AppContext, event: WebhookEvent, actor: string): { duplicate: boolean; batch_id?: string } {
  if (!event?.id || !event.event_type) throw new Error('Malformed webhook event.');
  if (repo.kvGet(ctx.db, `webhook:${event.id}`)) return { duplicate: true };
  repo.kvSet(ctx.db, `webhook:${event.id}`, event.event_type);

  let affected: string | undefined;
  if (event.event_type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
    affected = applyItemSnapshot(ctx, event.resource as PayoutItemSnapshot, actor)?.batch_id;
  } else if (event.event_type.startsWith('PAYMENT.PAYOUTSBATCH.')) {
    const header = event.resource?.batch_header;
    const b = header?.payout_batch_id ? repo.getBatchByPayPalId(ctx.db, header.payout_batch_id) : undefined;
    if (b) {
      ctx.db.prepare('UPDATE batches SET paypal_status = ?, updated_at = ? WHERE id = ?').run(header.batch_status ?? null, nowIso(), b.id);
      affected = b.id;
    }
  }
  ctx.audit.append(actor, 'webhook.received', { event_id: event.id, event_type: event.event_type, batch_id: affected ?? null });
  if (affected) recomputeBatch(ctx, affected);
  emit(ctx, 'payments');
  return { duplicate: false, batch_id: affected };
}

// ---------- reconciliation & receipts ----------

function writeReceipt(ctx: AppContext, item: BatchItem): string {
  const b = repo.getBatch(ctx.db, item.batch_id)!;
  const inv = repo.getInvoice(ctx.db, item.invoice_id);
  const v = repo.getVendor(ctx.db, item.vendor_id);
  const receipt = {
    receipt_id: `RCPT-${item.id}`,
    issued_at: nowIso(),
    business: ctx.config.businessName,
    payee: { vendor_id: item.vendor_id, name: v?.name ?? item.vendor_id, paypal_account: item.payout_email },
    invoice: { id: item.invoice_id, number: inv?.invoice_number ?? null, period: inv?.period ?? null },
    amount: { value: centsToValue(item.amount_cents), currency: item.currency },
    paypal: {
      mode: ctx.paypal.mode,
      payout_batch_id: b.paypal_batch_id,
      payout_item_id: item.paypal_item_id,
      transaction_id: item.transaction_id,
      status: item.status,
    },
    authorization: {
      mandate_id: b.mandate_id,
      proposed_by: b.created_by,
      approved_by: b.approved_by,
      approved_at: b.approved_at,
      channel: b.approval_channel,
    },
    audit_head_sha256: ctx.audit.head(),
  };
  const file = `${item.id}.json`;
  fs.writeFileSync(path.join(ctx.receiptsDir, file), JSON.stringify(receipt, null, 2));
  ctx.audit.append('countersign', 'receipt.issued', { receipt_id: receipt.receipt_id, item_id: item.id, file, receipt_sha256: sha256(canonicalJson(receipt)) });
  repo.updateItem(ctx.db, item.id, { receipt_path: file });
  return file;
}

export interface ReconItem {
  item_id: string;
  batch_id: string;
  vendor: string;
  invoice_number: string | null;
  amount_cents: number;
  status: string;
  transaction_id: string | null;
}

export interface ReconcileReport {
  month: string;
  checked_batches: string[];
  paid: ReconItem[];
  in_flight: ReconItem[];
  problems: ReconItem[];
  receipts_written: string[];
  paid_total_cents: number;
  budget_remaining_cents: number;
  mismatches: string[];
  errors: string[];
}

export async function reconcile(ctx: AppContext, actor: string): Promise<ReconcileReport> {
  const checked: string[] = [];
  const errors: string[] = [];
  const mismatches: string[] = [];
  const open = repo.listBatches(ctx.db, 500).filter((b) => b.paypal_batch_id && ['SUBMITTED', 'PARTIAL'].includes(b.status));
  for (const b of open) {
    try {
      const { snapshot } = await refreshBatch(ctx, b.id);
      checked.push(b.id);
      const ours = repo.itemsForBatch(ctx.db, b.id).filter((i) => i.status !== 'CANCELED').reduce((s, i) => s + i.amount_cents, 0);
      const theirs = snapshot?.batch_header.amount ? Math.round(Number(snapshot.batch_header.amount.value) * 100) : undefined;
      if (theirs !== undefined && theirs !== ours) mismatches.push(`${b.id}: ledger ${fmtMoney(ours)} vs PayPal ${fmtMoney(theirs)}`);
    } catch (err) {
      errors.push(`${b.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const receipts: string[] = [];
  const unreceipted = ctx.db.prepare("SELECT * FROM batch_items WHERE status = 'SUCCESS' AND receipt_path IS NULL").all() as unknown as BatchItem[];
  for (const item of unreceipted) receipts.push(writeReceipt(ctx, item));

  const month = monthOf(new Date());
  const rows = repo.ledger(ctx.db, { limit: 2000 }).filter((r) => r.approved_at && monthOf(r.approved_at) === month);
  const view = (r: repo.LedgerRow): ReconItem => ({
    item_id: r.id, batch_id: r.batch_id, vendor: r.vendor_name, invoice_number: r.invoice_number,
    amount_cents: r.amount_cents, status: r.status, transaction_id: r.transaction_id,
  });
  const paid = rows.filter((r) => r.status === 'SUCCESS').map(view);
  const inFlight = rows.filter((r) => ['QUEUED', 'PENDING', 'ONHOLD'].includes(r.status)).map(view);
  const problems = rows.filter((r) => r.status === 'UNCLAIMED' || FAILED_ITEM_STATUSES.includes(r.status)).filter((r) => r.status !== 'CANCELED').map(view);
  const report: ReconcileReport = {
    month,
    checked_batches: checked,
    paid,
    in_flight: inFlight,
    problems,
    receipts_written: receipts,
    paid_total_cents: paid.reduce((s, p) => s + p.amount_cents, 0),
    budget_remaining_cents: mandateStatus(ctx).remaining_cents,
    mismatches,
    errors,
  };
  ctx.audit.append(actor, 'payments.reconciled', {
    month,
    checked_batches: checked.length,
    paid: paid.length,
    in_flight: inFlight.length,
    problems: problems.length,
    receipts_written: receipts.length,
    mismatches: mismatches.length,
  });
  emit(ctx, 'payments');
  return report;
}

// ---------- reporting helpers ----------

export function spendingSummary(ctx: AppContext, month = monthOf(new Date())) {
  const rows = repo
    .ledger(ctx.db, { limit: 5000 })
    .filter((r) => r.approved_at && monthOf(r.approved_at) === month && !FAILED_ITEM_STATUSES.includes(r.status));
  const byVendor = new Map<string, { vendor_id: string; vendor: string; paid_cents: number; in_flight_cents: number; payments: number }>();
  for (const r of rows) {
    const e = byVendor.get(r.vendor_id) ?? { vendor_id: r.vendor_id, vendor: r.vendor_name, paid_cents: 0, in_flight_cents: 0, payments: 0 };
    if (r.status === 'SUCCESS') e.paid_cents += r.amount_cents;
    else e.in_flight_cents += r.amount_cents;
    e.payments++;
    byVendor.set(r.vendor_id, e);
  }
  const st = mandateStatus(ctx);
  const budget = st.mandate?.terms.monthly_budget_cents ?? 0;
  const committed = committedForMonth(ctx.db, month);
  return {
    month,
    vendors: [...byVendor.values()].sort((a, b) => b.paid_cents + b.in_flight_cents - (a.paid_cents + a.in_flight_cents)),
    paid_cents: rows.filter((r) => r.status === 'SUCCESS').reduce((s, r) => s + r.amount_cents, 0),
    in_flight_cents: rows.filter((r) => r.status !== 'SUCCESS').reduce((s, r) => s + r.amount_cents, 0),
    budget_cents: budget,
    remaining_cents: Math.max(0, budget - committed),
  };
}

export function draftVendorVerification(ctx: AppContext, invoiceId: string) {
  const inv = repo.getInvoice(ctx.db, invoiceId);
  if (!inv) throw new Error(`Invoice ${invoiceId} not found.`);
  const vendorId = inv.vendor_id ?? inv.claimed_vendor_id;
  const v = vendorId ? repo.getVendor(ctx.db, vendorId) : undefined;
  if (!v) {
    return { problem: 'This sender does not match any registered vendor, so there is nobody on file to verify with. Do not pay it.' };
  }
  const owner = (repo.kvGet(ctx.db, 'owner_name') ?? 'the accounts team').split(' (')[0];
  const first = v.name.split(' ')[0];
  const redirect = inv.pay_to && inv.pay_to !== v.payout_email ? `, asking us to send payment to a new PayPal account (${inv.pay_to})` : '';
  return {
    to: v.contact_email,
    subject: `Quick check before we pay invoice ${inv.invoice_number ?? ''}`.trim(),
    body:
      `Hi ${first},\n\n` +
      `We received an invoice in your name (${inv.invoice_number ?? 'no number'}, ${fmtMoney(inv.amount_cents ?? 0)} for ${periodLabel(inv.period)}) ` +
      `from ${inv.from_email}${redirect}.\n\n` +
      `Before we pay anything, could you confirm whether you sent it? A reply from this address or a quick call works. ` +
      `We never change payment details based on an email alone.\n\nThanks,\n${owner}`,
    guidance: `Send this to ${v.contact_email} (the address on file), not to ${inv.from_email}. Do not reply to the suspicious email.`,
  };
}
