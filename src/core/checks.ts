import type { MandateTerms } from './mandate.js';
import type { Finding, InvoiceDraft, InvoiceRecord, RiskStatus, Vendor } from './types.js';
import { fmtMoney, levenshtein, periodLabel } from './util.js';

/**
 * The policy engine. Pure functions, no I/O, no LLM: the same invoice always
 * gets the same verdict, so the agent cannot argue its way past a hold.
 */

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com',
  'proton.me', 'protonmail.com', 'aol.com', 'gmx.com', 'mail.com', 'zoho.com',
]);

/** Collapse visually confusable characters so "studlo"/"studio" and "le0"/"leo" compare equal. */
export function skeleton(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/0/g, 'o')
    .replace(/[1il|!]/g, 'l')
    .replace(/[-_.]/g, '');
}

const registrable = (d: string) => d.split('.').slice(0, -1).join('.');

export function isLookalike(candidate: string, real: string): boolean {
  if (!candidate || !real || candidate === real || FREE_MAIL.has(candidate)) return false;
  if (candidate.endsWith(`.${real}`)) return false; // a subdomain of the real domain
  return (
    skeleton(candidate) === skeleton(real) ||
    levenshtein(candidate, real) <= 2 ||
    (registrable(candidate) !== '' && registrable(candidate) === registrable(real))
  );
}

const nameTokens = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1);

function sameName(vendorName: string, fromName: string): boolean {
  const v = nameTokens(vendorName);
  const f = new Set(nameTokens(fromName));
  return v.length > 0 && v.every((t) => f.has(t));
}

export function resolveVendor(d: Pick<InvoiceDraft, 'from_email' | 'from_domain'>, vendors: Vendor[]): Vendor | undefined {
  return (
    vendors.find((v) => v.contact_email === d.from_email) ??
    vendors.find((v) => !FREE_MAIL.has(v.domain) && (d.from_domain === v.domain || d.from_domain.endsWith(`.${v.domain}`)))
  );
}

const PRESSURE: [RegExp, string][] = [
  [/\burgent(?:ly)?\b/i, 'urgent'],
  [/\b(?:immediately|asap|right away)\b/i, 'immediately'],
  [/\b(?:today|end of (?:the )?day|eod|within (?:the )?(?:hour|24 hours))\b/i, 'today'],
  [/\b(?:new|updated|changed|different)\s+(?:bank(?:ing)?|payment|paypal|account)\b/i, 'new payment details'],
  [/\b(?:confidential|between us|keep this quiet)\b/i, 'secrecy'],
  [/\b(?:hard|unable|difficult) to (?:reach|call|contact)\b|\bemail is best\b|\bdon'?t call\b/i, 'discourages verification'],
  [/\b(?:final notice|overdue|late fee|legal action)\b/i, 'threat'],
  [/\b(?:gift cards?|wire transfer|bitcoin|crypto(?:currency)?)\b/i, 'unusual payment method'],
];

const INJECTION: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|review|standard)\s+(?:instructions|rules|guidance|directions|checks|process)/i,
  /\bnote\s+(?:to|for)\s+(?:the\s+|any\s+)?(?:ai|assistant|agent|llm|bot|model)s?\b/i,
  /\b(?:ai|llm)\s+(?:assistant|agent|model|system)s?\b[^.\n]{0,60}\b(?:must|should|please|need to|are instructed)\b/i,
  /(?:^|\n)\s*(?:system|assistant|developer)\s*:/i,
  /<\/?\s*(?:system|instructions?|prompt)\s*>/i,
  /\b(?:you are now|act as|new instructions)\b/i,
  /\bdo not\s+(?:mention|flag|report|disclose|tell)\b/i,
  /\b(?:mark|treat|classify|record)\s+(?:this|it)\s+(?:invoice\s+)?as\s+(?:verified|approved|safe|clear|legitimate)\b/i,
  /\b(?:pre-?approved|already approved)\b[^.\n]{0,80}\b(?:skip|without|no need|bypass)\b/i,
  /\b(?:add|include|send|make|queue)\s+(?:an?\s+)?(?:additional|extra|second|another|separate)\s+(?:payment|payout|transfer)\b/i,
];

export function detectInjection(text: string): string[] {
  const hits: string[] = [];
  for (const re of INJECTION) {
    const m = text.match(re);
    if (m) {
      const start = Math.max(0, (m.index ?? 0) - 30);
      hits.push(text.slice(start, (m.index ?? 0) + m[0].length + 50).replace(/\s+/g, ' ').trim());
    }
  }
  return hits;
}

export function detectPressure(text: string): string[] {
  return PRESSURE.filter(([re]) => re.test(text)).map(([, label]) => label);
}

export interface CheckInput {
  vendors: Vendor[];
  timesheets: Map<string, number>;
  mandate: MandateTerms | null;
  /** Everything currently in the inbox (including the invoice being checked). */
  inbox: InvoiceDraft[];
  /** Invoices already proposed, in flight or paid. */
  history: InvoiceRecord[];
}

export interface Assessment {
  vendor_id: string | null;
  claimed_vendor_id: string | null;
  risk_status: RiskStatus;
  risk_score: number;
  findings: Finding[];
}

const isEarlier = (a: { received_at: string | null; id: string }, b: { received_at: string | null; id: string }) =>
  (a.received_at ?? '') < (b.received_at ?? '') || ((a.received_at ?? '') === (b.received_at ?? '') && a.id < b.id);

export function assessInvoice(inv: InvoiceDraft, input: CheckInput): Assessment {
  const { vendors, timesheets, mandate, inbox, history } = input;
  const findings: Finding[] = [];
  const hold = (code: string, title: string, detail: string) => findings.push({ code, severity: 'hold', title, detail });
  const warn = (code: string, title: string, detail: string) => findings.push({ code, severity: 'warn', title, detail });

  // 1. Can we even read it?
  if (inv.amount_cents == null || Number.isNaN(inv.amount_cents) || inv.amount_cents <= 0) {
    hold('UNREADABLE_AMOUNT', 'No readable amount', 'Could not find a valid "Amount due" line in the visible invoice text.');
  }
  if (!inv.invoice_number) warn('NO_INVOICE_NUMBER', 'No invoice number', 'Duplicate detection is weaker without an invoice number.');

  // 2. Who sent it?
  const vendor = resolveVendor(inv, vendors);
  let claimed: Vendor | undefined;
  if (!vendor) {
    claimed = vendors.find((v) => isLookalike(inv.from_domain, v.domain));
    if (claimed) {
      hold('LOOKALIKE_DOMAIN', `Sender domain imitates ${claimed.name}`,
        `Sent from ${inv.from_domain}, which is visually close to ${claimed.name}'s real domain ${claimed.domain}. This is a common invoice-fraud tactic.`);
    } else {
      claimed = vendors.find((v) => sameName(v.name, inv.from_name));
      if (claimed) {
        hold('IMPERSONATION', `Uses ${claimed.name}'s name from an unregistered address`,
          `${inv.from_email} is not ${claimed.name}'s registered address (${claimed.contact_email}).`);
      } else {
        hold('UNKNOWN_VENDOR', 'Sender is not a registered vendor',
          `${inv.from_email || 'Unknown sender'} is not in the vendor registry. New vendors must be added and verified by a human in the dashboard.`);
      }
    }
  }
  const v = vendor ?? claimed;

  // 3. Where does it want the money to go?
  if (v && inv.pay_to && inv.pay_to !== v.payout_email) {
    hold('PAYEE_CHANGED', 'Asks to pay a different PayPal account',
      `Invoice says pay ${inv.pay_to}; ${v.name}'s verified payout account is ${v.payout_email}. Payee changes must be confirmed with the vendor out-of-band (by phone).`);
  }

  // 4. Does it match the contract and the timesheet?
  if (v && inv.amount_cents != null && inv.amount_cents > 0) {
    if (v.rate_type === 'hourly' && v.rate_cents != null) {
      if (inv.rate_cents != null && inv.rate_cents > v.rate_cents) {
        hold('RATE_ABOVE_CONTRACT', 'Hourly rate above contract',
          `Billed ${fmtMoney(inv.rate_cents)}/h; contract rate is ${fmtMoney(v.rate_cents)}/h.`);
      }
      if (inv.hours != null) {
        const effectiveRate = inv.rate_cents ?? v.rate_cents;
        const expected = Math.round(inv.hours * effectiveRate);
        if (Math.abs(expected - inv.amount_cents) > 1) {
          hold('MATH_MISMATCH', 'Amount does not match hours × rate',
            `${inv.hours}h × ${fmtMoney(effectiveRate)} = ${fmtMoney(expected)}, but the invoice asks for ${fmtMoney(inv.amount_cents)}.`);
        }
        const ts = inv.period ? timesheets.get(`${v.id}|${inv.period}`) : undefined;
        if (ts == null) {
          warn('NO_TIMESHEET', 'No timesheet on file', `No approved timesheet for ${v.name} in ${periodLabel(inv.period)}.`);
        } else if (inv.hours > ts + 0.01) {
          hold('HOURS_EXCEED_TIMESHEET', 'Billed hours exceed the timesheet',
            `Billed ${inv.hours}h for ${periodLabel(inv.period)}; the approved timesheet shows ${ts}h.`);
        }
      } else {
        warn('NO_HOURS', 'No hours listed', 'Hourly vendor invoice without an hours line.');
      }
    } else if (v.rate_type === 'fixed' && v.fixed_fee_cents != null) {
      if (inv.amount_cents > v.fixed_fee_cents) {
        hold('AMOUNT_ABOVE_CONTRACT', 'Amount above the fixed fee',
          `Invoice asks for ${fmtMoney(inv.amount_cents)}; ${v.name}'s fixed monthly fee is ${fmtMoney(v.fixed_fee_cents)}.`);
      } else if (inv.amount_cents < v.fixed_fee_cents) {
        warn('AMOUNT_BELOW_CONTRACT', 'Amount below the fixed fee', `Invoice is for ${fmtMoney(inv.amount_cents)} vs. the usual ${fmtMoney(v.fixed_fee_cents)}.`);
      }
    }
  }

  // 5. Have we seen (or paid) this before?
  if (v) {
    const vendorOf = (d: InvoiceDraft) => resolveVendor(d, vendors)?.id;
    if (inv.invoice_number) {
      const paid = history.find((h) => h.id !== inv.id && h.vendor_id === v.id && h.invoice_number === inv.invoice_number);
      if (paid) {
        hold('ALREADY_PAID', 'Invoice number already paid',
          `${v.name} invoice ${inv.invoice_number} is already ${paid.payment_status.toLowerCase()} (record ${paid.id}).`);
      }
      const dupe = inbox.find((o) => o.id !== inv.id && vendorOf(o) === v.id && o.invoice_number === inv.invoice_number && isEarlier(o, inv));
      if (dupe) {
        hold('DUPLICATE_INVOICE', 'Duplicate invoice', `Same invoice number (${inv.invoice_number}) as ${dupe.id}, received earlier.`);
      }
    }
    if (inv.period && inv.amount_cents) {
      const twin = [...inbox, ...history].find(
        (o) => o.id !== inv.id && (('vendor_id' in o ? (o as InvoiceRecord).vendor_id : vendorOf(o)) === v.id) &&
          o.period === inv.period && o.amount_cents === inv.amount_cents && o.invoice_number !== inv.invoice_number && isEarlier(o, inv),
      );
      if (twin) {
        hold('POSSIBLE_DUPLICATE', 'Same vendor, period and amount as another invoice',
          `${twin.id} bills ${fmtMoney(inv.amount_cents)} for ${periodLabel(inv.period)} under a different invoice number.`);
      }
    }

    // 6. Split invoicing to stay under the approval limit.
    if (inv.period && mandate) {
      const seen = new Set<string>();
      const siblings = inbox.filter((o) => {
        if (vendorOf(o) !== v.id || o.period !== inv.period) return false;
        const key = o.invoice_number ?? o.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (siblings.length > 1) {
        const sum = siblings.reduce((s, o) => s + (o.amount_cents ?? 0), 0);
        if (sum > mandate.max_per_payment_cents && siblings.every((o) => (o.amount_cents ?? 0) <= mandate.max_per_payment_cents)) {
          hold('SPLIT_INVOICES', 'Looks split to stay under the payment limit',
            `${siblings.length} invoices from ${v.name} for ${periodLabel(inv.period)} total ${fmtMoney(sum)}, above the ${fmtMoney(mandate.max_per_payment_cents)} per-payment limit, though each is below it.`);
        } else {
          warn('MULTIPLE_INVOICES', 'More than one invoice this period', `${siblings.length} invoices from ${v.name} for ${periodLabel(inv.period)}.`);
        }
        if (v.rate_type === 'hourly') {
          const ts = timesheets.get(`${v.id}|${inv.period}`);
          const hours = siblings.reduce((s, o) => s + (o.hours ?? 0), 0);
          if (ts != null && hours > ts + 0.01 && !findings.some((f) => f.code === 'HOURS_EXCEED_TIMESHEET')) {
            hold('HOURS_EXCEED_TIMESHEET', 'Combined hours exceed the timesheet',
              `${siblings.length} invoices bill ${hours}h in total for ${periodLabel(inv.period)}; the timesheet shows ${ts}h.`);
          }
        }
      }
    }

    // 7. Vendor monthly cap.
    if (inv.amount_cents && inv.period) {
      const alreadyThisPeriod = history
        .filter((h) => h.id !== inv.id && h.vendor_id === v.id && h.period === inv.period && h.payment_status !== 'FAILED')
        .reduce((s, h) => s + (h.amount_cents ?? 0), 0);
      if (alreadyThisPeriod + inv.amount_cents > v.monthly_cap_cents) {
        hold('VENDOR_CAP_EXCEEDED', 'Over this vendor\'s monthly cap',
          `${fmtMoney(alreadyThisPeriod + inv.amount_cents)} for ${periodLabel(inv.period)} exceeds ${v.name}'s cap of ${fmtMoney(v.monthly_cap_cents)}.`);
      }
    }
  }

  // 8. Mandate limits.
  if (mandate && inv.amount_cents && inv.amount_cents > mandate.max_per_payment_cents) {
    hold('OVER_MANDATE_LIMIT', 'Above the per-payment limit in the signed mandate',
      `${fmtMoney(inv.amount_cents)} exceeds the ${fmtMoney(mandate.max_per_payment_cents)} limit. Only the owner can raise it by re-signing the mandate.`);
  }
  if (mandate && vendor && !mandate.allowed_categories.includes(vendor.category)) {
    hold('CATEGORY_NOT_ALLOWED', 'Vendor category not covered by the mandate', `Category "${vendor.category}" is not in the mandate.`);
  }

  // 9. Social-engineering language.
  const pressure = detectPressure(`${inv.subject}\n${inv.visible_text}`);
  if (pressure.length) {
    warn('PRESSURE_LANGUAGE', 'Urgency or secrecy cues', `Contains: ${pressure.join(', ')}. Typical of payment-redirection scams.`);
  }

  // 10. Instructions aimed at an AI agent (visible or hidden).
  const injection = detectInjection([inv.subject, inv.visible_text, ...inv.hidden_text].join('\n'));
  if (injection.length) {
    const where = inv.hidden_text.some((h) => detectInjection(h).length) ? 'hidden from human readers' : 'in the visible text';
    hold('PROMPT_INJECTION', 'Contains instructions aimed at an AI agent',
      `Text ${where}: "${injection[0]}". Invoice content is treated as data and never followed; the vendor's mailbox may be compromised.`);
  } else if (inv.hidden_text.length) {
    warn('HIDDEN_TEXT', 'Contains hidden text', `${inv.hidden_text.length} hidden block(s) not visible to a human reader.`);
  }

  const holds = findings.filter((f) => f.severity === 'hold').length;
  const warns = findings.length - holds;
  return {
    vendor_id: vendor?.id ?? null,
    claimed_vendor_id: claimed?.id ?? null,
    risk_status: holds ? 'HOLD' : warns ? 'REVIEW' : 'CLEAR',
    risk_score: Math.min(100, holds * 35 + warns * 10),
    findings,
  };
}
