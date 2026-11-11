import type { DB } from './db.js';
import type { Batch, BatchItem, InvoiceRecord, ItemStatus, PaymentStatus, Vendor } from './types.js';
import { nowIso } from './util.js';

type Row = Record<string, any>;

// ---------- vendors ----------

export function listVendors(db: DB): Vendor[] {
  return db.prepare('SELECT * FROM vendors ORDER BY name').all() as unknown as Vendor[];
}

export function getVendor(db: DB, id: string): Vendor | undefined {
  return db.prepare('SELECT * FROM vendors WHERE id = ?').get(id) as unknown as Vendor | undefined;
}

export function upsertVendor(db: DB, v: Vendor): void {
  db.prepare(
    `INSERT INTO vendors (id, name, contact_email, domain, payout_email, rate_type, rate_cents, fixed_fee_cents,
       monthly_cap_cents, category, verified_via, verified_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, contact_email = excluded.contact_email, domain = excluded.domain,
       payout_email = excluded.payout_email, rate_type = excluded.rate_type, rate_cents = excluded.rate_cents,
       fixed_fee_cents = excluded.fixed_fee_cents, monthly_cap_cents = excluded.monthly_cap_cents,
       category = excluded.category, verified_via = excluded.verified_via, verified_at = excluded.verified_at`,
  ).run(
    v.id, v.name, v.contact_email.toLowerCase(), v.domain.toLowerCase(), v.payout_email.toLowerCase(), v.rate_type,
    v.rate_cents, v.fixed_fee_cents, v.monthly_cap_cents, v.category, v.verified_via, v.verified_at, v.created_at,
  );
}

// ---------- timesheets ----------

export function setTimesheet(db: DB, vendorId: string, period: string, hours: number): void {
  db.prepare('INSERT INTO timesheets (vendor_id, period, hours) VALUES (?, ?, ?) ON CONFLICT(vendor_id, period) DO UPDATE SET hours = excluded.hours').run(vendorId, period, hours);
}

/** Map of "vendorId|YYYY-MM" -> hours. */
export function timesheetMap(db: DB): Map<string, number> {
  const rows = db.prepare('SELECT vendor_id, period, hours FROM timesheets').all() as Row[];
  return new Map(rows.map((r) => [`${r.vendor_id}|${r.period}`, Number(r.hours)]));
}

// ---------- invoices ----------

function rowToInvoice(r: Row): InvoiceRecord {
  const { findings_json, hidden_json, ...rest } = r;
  return { ...rest, findings: JSON.parse(findings_json ?? '[]'), hidden_text: JSON.parse(hidden_json ?? '[]') } as InvoiceRecord;
}

export function listInvoices(db: DB): InvoiceRecord[] {
  return (db.prepare('SELECT * FROM invoices ORDER BY received_at DESC, id').all() as Row[]).map(rowToInvoice);
}

export function getInvoice(db: DB, id: string): InvoiceRecord | undefined {
  const r = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as Row | undefined;
  return r ? rowToInvoice(r) : undefined;
}

export function saveInvoice(db: DB, inv: InvoiceRecord): void {
  db.prepare(
    `INSERT INTO invoices (id, file, received_at, from_name, from_email, from_domain, subject, invoice_number, vendor_id,
       claimed_vendor_id, period, hours, rate_cents, amount_cents, currency, pay_to, risk_status, risk_score, findings_json,
       payment_status, raw, visible_text, hidden_json, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET file = excluded.file, received_at = excluded.received_at, from_name = excluded.from_name,
       from_email = excluded.from_email, from_domain = excluded.from_domain, subject = excluded.subject,
       invoice_number = excluded.invoice_number, vendor_id = excluded.vendor_id, claimed_vendor_id = excluded.claimed_vendor_id,
       period = excluded.period, hours = excluded.hours, rate_cents = excluded.rate_cents, amount_cents = excluded.amount_cents,
       currency = excluded.currency, pay_to = excluded.pay_to, risk_status = excluded.risk_status,
       risk_score = excluded.risk_score, findings_json = excluded.findings_json, payment_status = excluded.payment_status,
       raw = excluded.raw, visible_text = excluded.visible_text, hidden_json = excluded.hidden_json,
       scanned_at = excluded.scanned_at`,
  ).run(
    inv.id, inv.file, inv.received_at, inv.from_name, inv.from_email, inv.from_domain, inv.subject, inv.invoice_number,
    inv.vendor_id, inv.claimed_vendor_id, inv.period, inv.hours, inv.rate_cents, inv.amount_cents, inv.currency, inv.pay_to,
    inv.risk_status, inv.risk_score, JSON.stringify(inv.findings), inv.payment_status, inv.raw, inv.visible_text,
    JSON.stringify(inv.hidden_text), inv.scanned_at,
  );
}

export function setInvoicePaymentStatus(db: DB, id: string, status: PaymentStatus): void {
  db.prepare('UPDATE invoices SET payment_status = ? WHERE id = ?').run(status, id);
}

// ---------- batches ----------

export function listBatches(db: DB, limit = 100): Batch[] {
  return db.prepare('SELECT * FROM batches ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as Batch[];
}

export function getBatch(db: DB, id: string): Batch | undefined {
  return db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as unknown as Batch | undefined;
}

export function getBatchByPayPalId(db: DB, paypalBatchId: string): Batch | undefined {
  return db.prepare('SELECT * FROM batches WHERE paypal_batch_id = ?').get(paypalBatchId) as unknown as Batch | undefined;
}

export function itemsForBatch(db: DB, batchId: string): BatchItem[] {
  return db.prepare('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY id').all(batchId) as unknown as BatchItem[];
}

export function getItem(db: DB, id: string): BatchItem | undefined {
  return db.prepare('SELECT * FROM batch_items WHERE id = ?').get(id) as unknown as BatchItem | undefined;
}

export function getItemByPayPalId(db: DB, paypalItemId: string): BatchItem | undefined {
  return db.prepare('SELECT * FROM batch_items WHERE paypal_item_id = ?').get(paypalItemId) as unknown as BatchItem | undefined;
}

export function updateItem(db: DB, id: string, patch: Partial<Pick<BatchItem, 'status' | 'paypal_item_id' | 'transaction_id' | 'receipt_path'>>): void {
  const sets = Object.keys(patch).map((k) => `${k} = ?`);
  db.prepare(`UPDATE batch_items SET ${[...sets, 'updated_at = ?'].join(', ')} WHERE id = ?`).run(
    ...(Object.values(patch) as (string | null)[]), nowIso(), id,
  );
}

export interface LedgerRow extends BatchItem {
  batch_status: string;
  approved_at: string | null;
  approved_by: string | null;
  paypal_batch_id: string | null;
  vendor_name: string;
  invoice_number: string | null;
  period: string | null;
}

export function ledger(db: DB, opts: { vendorId?: string; period?: string; limit?: number } = {}): LedgerRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.vendorId) { where.push('bi.vendor_id = ?'); args.push(opts.vendorId); }
  if (opts.period) { where.push('i.period = ?'); args.push(opts.period); }
  args.push(opts.limit ?? 200);
  return db.prepare(
    `SELECT bi.*, b.status AS batch_status, b.approved_at, b.approved_by, b.paypal_batch_id,
            COALESCE(v.name, bi.vendor_id) AS vendor_name, i.invoice_number, i.period
       FROM batch_items bi
       JOIN batches b ON b.id = bi.batch_id
       LEFT JOIN vendors v ON v.id = bi.vendor_id
       LEFT JOIN invoices i ON i.id = bi.invoice_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(b.approved_at, b.created_at) DESC, bi.id
      LIMIT ?`,
  ).all(...args) as unknown as LedgerRow[];
}

export function itemStatusCounts(items: { status: ItemStatus }[]): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, i) => ((acc[i.status] = (acc[i.status] ?? 0) + 1), acc), {});
}

// ---------- kv ----------

export function kvGet(db: DB, k: string): string | undefined {
  return (db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as Row | undefined)?.v;
}

export function kvSet(db: DB, k: string, v: string): void {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}
