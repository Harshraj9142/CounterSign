import type { Config } from '../config.js';
import { centsToValue } from '../core/util.js';
import {
  type Balance,
  type CreatePayoutInput,
  type PayoutBatchSnapshot,
  type PayPalClient,
  PayPalError,
  type TransactionSummary,
} from './types.js';

/** PayPal REST v1 client (sandbox or live) for Payouts, Reporting and Webhooks. */
export class RestPayPal implements PayPalClient {
  readonly mode: 'sandbox' | 'live';
  private readonly base: string;
  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly cfg: Pick<Config, 'mode' | 'paypalClientId' | 'paypalClientSecret' | 'paypalWebhookId'>,
    baseUrl?: string, // tests only
  ) {
    if (cfg.mode === 'mock') throw new Error('RestPayPal cannot run in mock mode');
    this.mode = cfg.mode;
    this.base = baseUrl ?? (cfg.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const basic = Buffer.from(`${this.cfg.paypalClientId}:${this.cfg.paypalClientSecret}`).toString('base64');
    const res = await fetch(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      throw new PayPalError(res.status, body.error ?? 'AUTH_FAILED', `OAuth failed: ${body.error_description ?? res.statusText}`);
    }
    this.token = { value: body.access_token, expiresAt: Date.now() + (Number(body.expires_in ?? 3600) - 120) * 1000 };
    return this.token.value;
  }

  async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(this.base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const detail = json?.details?.[0]?.issue ? ` [${json.details[0].issue}]` : '';
      throw new PayPalError(
        res.status,
        json?.name ?? `HTTP_${res.status}`,
        `${json?.message ?? (text.slice(0, 300) || res.statusText)}${detail}`,
        json?.debug_id ?? res.headers.get('paypal-debug-id') ?? undefined,
        json?.details,
      );
    }
    return json as T;
  }

  async createPayout(input: CreatePayoutInput) {
    const body = {
      sender_batch_header: {
        sender_batch_id: input.senderBatchId,
        email_subject: input.emailSubject,
        email_message: input.emailMessage,
      },
      items: input.items.map((i) => ({
        recipient_type: 'EMAIL',
        amount: { value: centsToValue(i.amountCents), currency: i.currency },
        note: i.note,
        sender_item_id: i.senderItemId,
        receiver: i.receiver,
      })),
    };
    // sender_batch_id is unique per batch, and PayPal-Request-Id makes a retried POST
    // return the original result instead of paying twice.
    const res = await this.request<any>('POST', '/v1/payments/payouts', body, { 'PayPal-Request-Id': input.senderBatchId });
    return { payout_batch_id: res.batch_header.payout_batch_id as string, batch_status: res.batch_header.batch_status as string };
  }

  getPayout(payoutBatchId: string): Promise<PayoutBatchSnapshot> {
    return this.request<PayoutBatchSnapshot>('GET', `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`);
  }

  async getBalances(currency = 'USD'): Promise<Balance[]> {
    const r = await this.request<any>('GET', `/v1/reporting/balances?currency_code=${encodeURIComponent(currency)}`);
    return (r.balances ?? []).map((b: any) => ({
      currency: b.currency,
      available: b.available_balance?.value ?? b.total_balance?.value ?? '0.00',
      total: b.total_balance?.value ?? '0.00',
    }));
  }

  async searchTransactions(start: Date, end: Date): Promise<TransactionSummary[]> {
    const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '-0000');
    const qs = new URLSearchParams({ start_date: fmt(start), end_date: fmt(end), fields: 'transaction_info,payer_info', page_size: '100' });
    const r = await this.request<any>('GET', `/v1/reporting/transactions?${qs}`);
    return (r.transaction_details ?? []).map((t: any) => ({
      id: t.transaction_info?.transaction_id,
      date: t.transaction_info?.transaction_initiation_date,
      event_code: t.transaction_info?.transaction_event_code,
      status: t.transaction_info?.transaction_status,
      amount: t.transaction_info?.transaction_amount?.value,
      currency: t.transaction_info?.transaction_amount?.currency_code,
      note: t.transaction_info?.transaction_note ?? t.transaction_info?.transaction_subject,
      counterparty: t.payer_info?.email_address,
    }));
  }

  async verifyWebhook(headers: Record<string, string | undefined>, event: unknown): Promise<boolean> {
    if (!this.cfg.paypalWebhookId) return false;
    const r = await this.request<any>('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: this.cfg.paypalWebhookId,
      webhook_event: event,
    });
    return r.verification_status === 'SUCCESS';
  }

  listWebhooks(): Promise<{ webhooks: { id: string; url: string; event_types: { name: string }[] }[] }> {
    return this.request('GET', '/v1/notifications/webhooks');
  }

  registerWebhook(url: string, eventTypes: string[]): Promise<{ id: string; url: string }> {
    return this.request('POST', '/v1/notifications/webhooks', { url, event_types: eventTypes.map((name) => ({ name })) });
  }
}
