import fs from 'node:fs';
import path from 'node:path';
import { parseAddress, parseEmail } from './email.js';
import type { InvoiceDraft } from './types.js';
import { parseMoney } from './util.js';

/** Reads every .eml file in the inbox folder. The file name (without extension) is the invoice id. */
export function readInbox(dir: string): { id: string; file: string; raw: string }[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.eml'))
    .sort()
    .map((f) => ({ id: f.replace(/\.eml$/, ''), file: f, raw: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

const num = (s: string | null): number | null => {
  if (s == null) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Deterministically extracts invoice fields from the *visible* text only.
 * Hidden text never influences amounts or payees.
 */
export function extractInvoice(id: string, file: string | null, raw: string): InvoiceDraft {
  const p = parseEmail(raw);
  const from = parseAddress(p.headers['from'] ?? '');
  const date = p.headers['date'] ? new Date(p.headers['date']) : null;
  const text = p.visibleText;
  const grab = (re: RegExp): string | null => text.match(re)?.[1]?.trim() ?? null;

  const amount = text.match(/^\s*(?:Amount due|Total due|Total)\s*:\s*\$?\s*([\d.,]+)\s*([A-Z]{3})?/im);
  const rate = grab(/^\s*Rate\s*:\s*\$?\s*([\d.,]+)/im);

  return {
    id,
    file,
    received_at: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    from_name: from.name,
    from_email: from.email,
    from_domain: from.domain,
    subject: p.headers['subject'] ?? '',
    invoice_number: grab(/^\s*Invoice(?:\s*(?:number|no\.?|#))?\s*[:#]\s*([A-Za-z0-9][\w\-/.]*)/im),
    period: grab(/^\s*Period\s*:\s*(\d{4}-\d{2})\b/im),
    hours: num(grab(/^\s*Hours\s*:\s*([\d.,]+)/im)),
    rate_cents: rate ? parseMoney(rate) : null,
    amount_cents: amount ? parseMoney(amount[1]) : null,
    currency: amount?.[2] ?? 'USD',
    pay_to: grab(/^\s*Pay(?:ment)?\s+to(?:\s*\(PayPal\))?\s*:\s*<?([^\s<>]+@[^\s<>]+?)>?\s*$/im)?.toLowerCase() ?? null,
    raw,
    visible_text: text,
    hidden_text: p.hiddenText,
  };
}
