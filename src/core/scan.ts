import { assessInvoice } from './checks.js';
import type { AppContext } from './context.js';
import { readInbox, extractInvoice } from './invoices.js';
import { getActiveMandate } from './mandate.js';
import { listInvoices, listVendors, saveInvoice, timesheetMap } from './repo.js';
import type { InvoiceRecord } from './types.js';
import { nowIso } from './util.js';

/**
 * Parses every invoice in the inbox, runs the policy engine and stores the
 * verdicts. Payment status is preserved across re-scans.
 */
export function scanInbox(ctx: AppContext, opts: { actor?: string; quiet?: boolean } = {}): InvoiceRecord[] {
  const drafts = readInbox(ctx.inboxDir).map((f) => extractInvoice(f.id, f.file, f.raw));
  const existing = new Map(listInvoices(ctx.db).map((i) => [i.id, i]));
  const input = {
    vendors: listVendors(ctx.db),
    timesheets: timesheetMap(ctx.db),
    mandate: getActiveMandate(ctx.db)?.terms ?? null,
    inbox: drafts,
    history: [...existing.values()].filter((i) => i.payment_status !== 'UNPAID' && i.payment_status !== 'FAILED'),
  };
  const scannedAt = nowIso();
  const records = drafts.map((d) => {
    const rec: InvoiceRecord = {
      ...d,
      ...assessInvoice(d, input),
      payment_status: existing.get(d.id)?.payment_status ?? 'UNPAID',
      scanned_at: scannedAt,
    };
    saveInvoice(ctx.db, rec);
    return rec;
  });

  if (!opts.quiet) {
    const count = (s: string) => records.filter((r) => r.risk_status === s).length;
    ctx.audit.append(opts.actor ?? 'system', 'invoices.scanned', {
      files: records.length,
      clear: count('CLEAR'),
      review: count('REVIEW'),
      hold: count('HOLD'),
    });
  }
  ctx.bus.emit('change', { type: 'invoices' });
  return records;
}
