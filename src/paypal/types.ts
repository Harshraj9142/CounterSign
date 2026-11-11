export interface PayoutItemInput {
  senderItemId: string;
  receiver: string;
  amountCents: number;
  currency: string;
  note: string;
}

export interface CreatePayoutInput {
  senderBatchId: string;
  emailSubject: string;
  emailMessage: string;
  items: PayoutItemInput[];
}

export interface Money {
  value: string;
  currency: string;
}

/** Shape of an item as returned by GET /v1/payments/payouts/{id} and payout-item webhooks. */
export interface PayoutItemSnapshot {
  payout_item_id: string;
  transaction_id?: string;
  transaction_status: string;
  payout_batch_id?: string;
  time_processed?: string;
  payout_item: {
    sender_item_id?: string;
    receiver: string;
    amount: Money;
    note?: string;
    recipient_type?: string;
  };
  errors?: { name?: string; message?: string };
}

export interface PayoutBatchSnapshot {
  batch_header: {
    payout_batch_id: string;
    batch_status: string;
    sender_batch_header?: { sender_batch_id?: string };
    amount?: Money;
    fees?: Money;
  };
  items: PayoutItemSnapshot[];
}

export interface WebhookEvent {
  id: string;
  event_type: string;
  create_time?: string;
  summary?: string;
  resource: any;
}

export interface Balance {
  currency: string;
  available: string;
  total: string;
}

export interface TransactionSummary {
  id: string;
  date: string;
  event_code: string;
  status: string;
  amount: string;
  currency: string;
  note?: string;
  counterparty?: string;
}

export interface PayPalClient {
  readonly mode: 'mock' | 'sandbox' | 'live';
  createPayout(input: CreatePayoutInput): Promise<{ payout_batch_id: string; batch_status: string }>;
  getPayout(payoutBatchId: string): Promise<PayoutBatchSnapshot>;
  getBalances(currency?: string): Promise<Balance[]>;
  searchTransactions(start: Date, end: Date): Promise<TransactionSummary[]>;
  verifyWebhook(headers: Record<string, string | undefined>, event: unknown): Promise<boolean>;
}

export class PayPalError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public debugId?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'PayPalError';
  }

  toString(): string {
    return `PayPal ${this.status} ${this.code}: ${this.message}${this.debugId ? ` (debug_id ${this.debugId})` : ''}`;
  }
}
