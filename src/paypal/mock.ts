import type { DB } from '../core/db.js';
import { centsToValue, parseMoney, randomToken } from '../core/util.js';
import {
  type Balance,
  type CreatePayoutInput,
  type PayoutBatchSnapshot,
  type PayoutItemSnapshot,
  type PayPalClient,
  PayPalError,
  type TransactionSummary,
  type WebhookEvent,
} from './types.js';

interface MockItem {
  payout_item_id: string;
  sender_item_id: string;
  receiver: string;
  value: string;
  currency: string;
  note: string;
  settle_at: number;
  final: 'SUCCESS' | 'UNCLAIMED';
  transaction_id: string;
}

interface MockBatch {
  payout_batch_id: string;
  sender_batch_id: string;
  created_at: number;
  items: MockItem[];
}

const STARTING_BALANCE_CENTS = 100_000_00;

/**
 * Offline stand-in for PayPal Payouts with the same response shapes.
 * State lives in SQLite and status is derived from timestamps, so the HTTP
 * server and a stdio MCP process see the same payouts. Receivers at
 * "@unclaimed.example" end UNCLAIMED, like an email with no PayPal account.
 */
export class MockPayPal implements PayPalClient {
  readonly mode = 'mock' as const;
  onEvent?: (event: WebhookEvent) => void;

  constructor(private readonly db: DB, private readonly settleMs: number) {}

  private all(): MockBatch[] {
    return (this.db.prepare('SELECT json FROM mock_payouts').all() as { json: string }[]).map((r) => JSON.parse(r.json));
  }

  private find(where: 'payout_batch_id' | 'sender_batch_id', id: string): MockBatch | undefined {
    const row = this.db.prepare(`SELECT json FROM mock_payouts WHERE ${where} = ?`).get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  private itemSnapshot(b: MockBatch, i: MockItem, now: number): PayoutItemSnapshot {
    const settled = now >= i.settle_at;
    return {
      payout_item_id: i.payout_item_id,
      transaction_id: settled && i.final === 'SUCCESS' ? i.transaction_id : undefined,
      transaction_status: settled ? i.final : 'PENDING',
      payout_batch_id: b.payout_batch_id,
      time_processed: settled ? new Date(i.settle_at).toISOString() : undefined,
      payout_item: {
        sender_item_id: i.sender_item_id,
        receiver: i.receiver,
        amount: { value: i.value, currency: i.currency },
        note: i.note,
        recipient_type: 'EMAIL',
      },
      errors: settled && i.final === 'UNCLAIMED' ? { name: 'RECEIVER_UNREGISTERED', message: 'Receiver is unregistered' } : undefined,
    };
  }

  private snapshot(b: MockBatch, now = Date.now()): PayoutBatchSnapshot {
    const allSettled = b.items.every((i) => now >= i.settle_at);
    const total = b.items.reduce((s, i) => s + parseMoney(i.value), 0);
    return {
      batch_header: {
        payout_batch_id: b.payout_batch_id,
        batch_status: allSettled ? 'SUCCESS' : now - b.created_at > 600 ? 'PROCESSING' : 'PENDING',
        sender_batch_header: { sender_batch_id: b.sender_batch_id },
        amount: { value: centsToValue(total), currency: b.items[0]?.currency ?? 'USD' },
        fees: { value: '0.00', currency: b.items[0]?.currency ?? 'USD' },
      },
      items: b.items.map((i) => this.itemSnapshot(b, i, now)),
    };
  }

  private balanceCents(): number {
    const spent = this.all().flatMap((b) => b.items).reduce((s, i) => s + parseMoney(i.value), 0);
    return STARTING_BALANCE_CENTS - spent;
  }

  async createPayout(input: CreatePayoutInput) {
    // Same idempotency contract as PayPal-Request-Id: a replay returns the original batch.
    const existing = this.find('sender_batch_id', input.senderBatchId);
    if (existing) return { payout_batch_id: existing.payout_batch_id, batch_status: this.snapshot(existing).batch_header.batch_status };

    if (!input.items.length) throw new PayPalError(400, 'VALIDATION_ERROR', 'Payout batch has no items.');
    for (const i of input.items) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(i.receiver)) throw new PayPalError(422, 'VALIDATION_ERROR', `Invalid receiver ${i.receiver}`);
      if (!(i.amountCents > 0)) throw new PayPalError(422, 'VALIDATION_ERROR', 'Amount must be positive.');
    }
    const total = input.items.reduce((s, i) => s + i.amountCents, 0);
    if (total > this.balanceCents()) throw new PayPalError(422, 'INSUFFICIENT_FUNDS', 'Sender does not have sufficient funds.');

    const now = Date.now();
    const batch: MockBatch = {
      payout_batch_id: `MOCK${randomToken(9)}`,
      sender_batch_id: input.senderBatchId,
      created_at: now,
      items: input.items.map((i, idx) => ({
        payout_item_id: `MOCKI${randomToken(8)}`,
        sender_item_id: i.senderItemId,
        receiver: i.receiver,
        value: centsToValue(i.amountCents),
        currency: i.currency,
        note: i.note,
        settle_at: now + Math.round(this.settleMs * (1 + idx * 0.45)),
        final: /@unclaimed\./i.test(i.receiver) ? 'UNCLAIMED' : 'SUCCESS',
        transaction_id: `MOCKT${randomToken(12)}`,
      })),
    };
    this.db.prepare('INSERT INTO mock_payouts (payout_batch_id, sender_batch_id, json) VALUES (?, ?, ?)').run(
      batch.payout_batch_id, batch.sender_batch_id, JSON.stringify(batch),
    );
    this.scheduleWebhooks(batch);
    return { payout_batch_id: batch.payout_batch_id, batch_status: 'PENDING' };
  }

  /** Emits the same webhook events PayPal would send, so the live-update path is exercised. */
  private scheduleWebhooks(b: MockBatch): void {
    const emit = (event: WebhookEvent) => this.onEvent?.(event);
    for (const i of b.items) {
      setTimeout(() => {
        const snap = this.itemSnapshot(b, i, Date.now() + 1);
        emit({
          id: `WH-MOCK-${randomToken(10)}`,
          event_type: i.final === 'SUCCESS' ? 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED' : 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
          create_time: new Date().toISOString(),
          resource: snap,
        });
      }, Math.max(0, i.settle_at - Date.now())).unref();
    }
    const last = Math.max(...b.items.map((i) => i.settle_at));
    setTimeout(() => {
      emit({
        id: `WH-MOCK-${randomToken(10)}`,
        event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS',
        create_time: new Date().toISOString(),
        resource: { batch_header: this.snapshot(b, Date.now() + 1).batch_header },
      });
    }, Math.max(0, last - Date.now() + 150)).unref();
  }

  async getPayout(payoutBatchId: string): Promise<PayoutBatchSnapshot> {
    const b = this.find('payout_batch_id', payoutBatchId);
    if (!b) throw new PayPalError(404, 'INVALID_RESOURCE_ID', `Payout batch ${payoutBatchId} not found.`);
    return this.snapshot(b);
  }

  async getBalances(currency = 'USD'): Promise<Balance[]> {
    const v = centsToValue(this.balanceCents());
    return [{ currency, available: v, total: v }];
  }

  async searchTransactions(start: Date, end: Date): Promise<TransactionSummary[]> {
    const now = Date.now();
    return this.all()
      .flatMap((b) => b.items.map((i) => ({ b, i })))
      .filter(({ i }) => now >= i.settle_at && i.settle_at >= start.getTime() && i.settle_at <= end.getTime())
      .map(({ i }) => ({
        id: i.transaction_id,
        date: new Date(i.settle_at).toISOString(),
        event_code: 'PAYOUT',
        status: i.final === 'SUCCESS' ? 'S' : 'P',
        amount: `-${i.value}`,
        currency: i.currency,
        note: i.note,
        counterparty: i.receiver,
      }));
  }

  async verifyWebhook(): Promise<boolean> {
    // Mock mode never accepts webhooks from the network; mock events are delivered in-process.
    return false;
  }
}
