import crypto from 'node:crypto';
import type { AppContext } from './context.js';
import type { DB } from './db.js';
import { canonicalJson, monthOf, nowIso, randomHex, sha256 } from './util.js';

/**
 * A spending mandate: the owner's signed statement of what the agent may pay.
 * Inspired by the "mandate" idea in Google's Agent Payments Protocol (AP2),
 * which PayPal supports. The agent can read it but no MCP tool can change it.
 */
export interface MandateTerms {
  id: string;
  issuer: string;
  business: string;
  purpose: string;
  currency: string;
  max_per_payment_cents: number;
  max_per_batch_cents: number;
  monthly_budget_cents: number;
  allowed_categories: string[];
  registered_vendors_only: true;
  human_approval_required: true;
  valid_from: string;
  valid_until: string;
  signed_at: string;
}

export interface SignedMandate {
  terms: MandateTerms;
  signature: string;
  algorithm: 'HMAC-SHA256';
}

export function signTerms(terms: MandateTerms, key: string): string {
  return crypto.createHmac('sha256', key).update(canonicalJson(terms)).digest('base64url');
}

export function verifyMandate(m: SignedMandate, key: string): boolean {
  const expected = Buffer.from(signTerms(m.terms, key));
  const got = Buffer.from(m.signature);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

export function getActiveMandate(db: DB): SignedMandate | null {
  const row = db.prepare('SELECT terms_json, signature FROM mandates WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get() as
    | { terms_json: string; signature: string }
    | undefined;
  return row ? { terms: JSON.parse(row.terms_json), signature: row.signature, algorithm: 'HMAC-SHA256' } : null;
}

/** Only called from the human-facing dashboard and the seed script. */
export function signAndStoreMandate(ctx: AppContext, terms: Omit<MandateTerms, 'id' | 'signed_at'>, actor: string): SignedMandate {
  const full: MandateTerms = { ...terms, id: `MD-${randomHex(3)}`, signed_at: nowIso() };
  const signature = signTerms(full, ctx.mandateKey);
  ctx.db.exec('UPDATE mandates SET active = 0');
  ctx.db.prepare('INSERT INTO mandates (id, terms_json, signature, active, created_at) VALUES (?, ?, ?, 1, ?)').run(
    full.id, JSON.stringify(full), signature, full.signed_at,
  );
  ctx.audit.append(actor, 'mandate.signed', {
    mandate_id: full.id,
    terms_sha256: sha256(canonicalJson(full)),
    max_per_payment_cents: full.max_per_payment_cents,
    max_per_batch_cents: full.max_per_batch_cents,
    monthly_budget_cents: full.monthly_budget_cents,
  });
  return { terms: full, signature, algorithm: 'HMAC-SHA256' };
}

/** Money committed this month: items in approved batches that have not failed. */
export function committedForMonth(db: DB, month: string): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(bi.amount_cents), 0) AS total
       FROM batch_items bi JOIN batches b ON b.id = bi.batch_id
      WHERE substr(b.approved_at, 1, 7) = ?
        AND b.status IN ('APPROVED', 'SUBMITTED', 'PAID', 'PARTIAL')
        AND bi.status NOT IN ('FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'DENIED', 'CANCELED')`,
  ).get(month) as { total: number };
  return Number(row.total);
}

export interface MandateStatus {
  mandate: SignedMandate | null;
  signature_valid: boolean;
  in_effect: boolean;
  month: string;
  committed_cents: number;
  remaining_cents: number;
}

export function mandateStatus(ctx: AppContext, now = new Date()): MandateStatus {
  const mandate = getActiveMandate(ctx.db);
  const month = monthOf(now);
  const committed = committedForMonth(ctx.db, month);
  if (!mandate) return { mandate, signature_valid: false, in_effect: false, month, committed_cents: committed, remaining_cents: 0 };
  const iso = now.toISOString();
  return {
    mandate,
    signature_valid: verifyMandate(mandate, ctx.mandateKey),
    in_effect: iso >= mandate.terms.valid_from && iso <= mandate.terms.valid_until,
    month,
    committed_cents: committed,
    remaining_cents: Math.max(0, mandate.terms.monthly_budget_cents - committed),
  };
}
