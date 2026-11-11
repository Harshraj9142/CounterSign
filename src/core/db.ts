import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  domain TEXT NOT NULL,
  payout_email TEXT NOT NULL,
  rate_type TEXT NOT NULL,
  rate_cents INTEGER,
  fixed_fee_cents INTEGER,
  monthly_cap_cents INTEGER NOT NULL,
  category TEXT NOT NULL,
  verified_via TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timesheets (
  vendor_id TEXT NOT NULL,
  period TEXT NOT NULL,
  hours REAL NOT NULL,
  PRIMARY KEY (vendor_id, period)
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  file TEXT,
  received_at TEXT,
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL DEFAULT '',
  from_domain TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  invoice_number TEXT,
  vendor_id TEXT,
  claimed_vendor_id TEXT,
  period TEXT,
  hours REAL,
  rate_cents INTEGER,
  amount_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  pay_to TEXT,
  risk_status TEXT NOT NULL,
  risk_score INTEGER NOT NULL DEFAULT 0,
  findings_json TEXT NOT NULL DEFAULT '[]',
  payment_status TEXT NOT NULL DEFAULT 'UNPAID',
  raw TEXT NOT NULL DEFAULT '',
  visible_text TEXT NOT NULL DEFAULT '',
  hidden_json TEXT NOT NULL DEFAULT '[]',
  scanned_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  terms_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  active INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  mandate_id TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note TEXT,
  approved_by TEXT,
  approved_at TEXT,
  approval_channel TEXT,
  paypal_batch_id TEXT,
  paypal_status TEXT,
  error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batch_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  invoice_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  payout_email TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  paypal_item_id TEXT,
  transaction_id TEXT,
  receipt_path TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  data TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- Only used by the mock PayPal client (PAYPAL_MODE=mock).
CREATE TABLE IF NOT EXISTS mock_payouts (
  payout_batch_id TEXT PRIMARY KEY,
  sender_batch_id TEXT NOT NULL UNIQUE,
  json TEXT NOT NULL
);
`;

export function openDb(file: string): DB {
  const db = new DatabaseSync(file);
  // WAL + busy timeout let the HTTP server and a stdio MCP process share one database.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Wipes all business data (used by demo seeding and tests). */
export function wipe(db: DB): void {
  db.exec(`
    DELETE FROM batch_items; DELETE FROM batches; DELETE FROM invoices; DELETE FROM timesheets;
    DELETE FROM vendors; DELETE FROM mandates; DELETE FROM audit; DELETE FROM kv; DELETE FROM mock_payouts;
  `);
}
