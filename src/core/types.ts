export type RateType = 'hourly' | 'fixed';

export interface Vendor {
  id: string;
  name: string;
  contact_email: string;
  domain: string;
  /** The only address money is ever sent to. Changed by a human, never by an invoice. */
  payout_email: string;
  rate_type: RateType;
  rate_cents: number | null;
  fixed_fee_cents: number | null;
  monthly_cap_cents: number;
  category: string;
  verified_via: string;
  verified_at: string;
  created_at: string;
}

export type RiskStatus = 'CLEAR' | 'REVIEW' | 'HOLD';
export type PaymentStatus = 'UNPAID' | 'PROPOSED' | 'PROCESSING' | 'PAID' | 'FAILED';
export type Severity = 'hold' | 'warn';

export interface Finding {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
}

/** What we can read out of an invoice email, before any judgement. */
export interface InvoiceDraft {
  id: string;
  file: string | null;
  received_at: string | null;
  from_name: string;
  from_email: string;
  from_domain: string;
  subject: string;
  invoice_number: string | null;
  period: string | null;
  hours: number | null;
  rate_cents: number | null;
  amount_cents: number | null;
  currency: string;
  pay_to: string | null;
  raw: string;
  visible_text: string;
  hidden_text: string[];
}

export interface InvoiceRecord extends InvoiceDraft {
  vendor_id: string | null;
  claimed_vendor_id: string | null;
  risk_status: RiskStatus;
  risk_score: number;
  findings: Finding[];
  payment_status: PaymentStatus;
  scanned_at: string;
}

export type BatchStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SUBMITTED'
  | 'PAID'
  | 'PARTIAL'
  | 'FAILED'
  | 'REJECTED'
  | 'EXPIRED';

export interface Batch {
  id: string;
  status: BatchStatus;
  mandate_id: string;
  total_cents: number;
  currency: string;
  created_by: string;
  created_at: string;
  note: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_channel: string | null;
  paypal_batch_id: string | null;
  paypal_status: string | null;
  error: string | null;
  updated_at: string;
}

export type ItemStatus =
  | 'QUEUED'
  | 'PENDING'
  | 'SUCCESS'
  | 'UNCLAIMED'
  | 'ONHOLD'
  | 'FAILED'
  | 'RETURNED'
  | 'BLOCKED'
  | 'REFUNDED'
  | 'REVERSED'
  | 'DENIED'
  | 'CANCELED';

export const FAILED_ITEM_STATUSES: ItemStatus[] = ['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'DENIED', 'CANCELED'];

export interface BatchItem {
  id: string;
  batch_id: string;
  invoice_id: string;
  vendor_id: string;
  payout_email: string;
  amount_cents: number;
  currency: string;
  status: ItemStatus;
  paypal_item_id: string | null;
  transaction_id: string | null;
  receipt_path: string | null;
  updated_at: string;
}
