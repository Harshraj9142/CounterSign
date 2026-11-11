/**
 * Runs the synthetic evaluation set through the real pipeline.
 *  1. Detection: every case is scanned; fraud/policy cases must be HOLD, legit ones payable.
 *  2. Rubber-stamp test: a naive agent proposes EVERY invoice and a careless human approves
 *     EVERY batch. We count money that reached a fraudster or a wrong account.
 *   npm run eval
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/core/context.js';
import { signAndStoreMandate } from '../src/core/mandate.js';
import { approveBatch, proposeBatch } from '../src/core/payments.js';
import * as repo from '../src/core/repo.js';
import { scanInbox } from '../src/core/scan.js';
import { ALL_CATEGORIES, type VendorSeed } from '../src/core/fixtures.js';

const here = import.meta.dirname;
const manifest: { file: string; kind: 'legit' | 'fraud' | 'policy'; expected: 'PAYABLE' | 'HOLD'; pattern: string; description: string }[] =
  JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(path.join(here, 'fixtures.json'), 'utf8'));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'countersign-eval-'));
const ctx = createContext(loadConfig({ dataDir, mode: 'mock', mockSettleMs: 0, mandateSigningKey: 'eval-key', sandboxRecipients: [] }));

for (const v of fixtures.vendors as VendorSeed[]) {
  repo.upsertVendor(ctx.db, { ...v, verified_via: 'eval fixture', verified_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' });
}
for (const [v, p, h] of fixtures.timesheets as [string, string, number][]) repo.setTimesheet(ctx.db, v, p, h);
signAndStoreMandate(ctx, {
  issuer: 'Eval owner', business: 'Eval', purpose: 'Evaluation', currency: 'USD', ...fixtures.mandate,
  allowed_categories: ALL_CATEGORIES, registered_vendors_only: true, human_approval_required: true,
  valid_from: '2026-01-01T00:00:00.000Z', valid_until: '2099-01-01T00:00:00.000Z',
}, 'eval');
for (const h of fixtures.paid_history) {
  const v = repo.getVendor(ctx.db, h.vendor_id)!;
  repo.saveInvoice(ctx.db, {
    id: `history-${h.invoice_number}`, file: null, received_at: '2026-07-01T00:00:00Z', from_name: v.name, from_email: v.contact_email,
    from_domain: v.domain, subject: '', invoice_number: h.invoice_number, period: h.period, hours: null, rate_cents: null,
    amount_cents: h.amount_cents, currency: 'USD', pay_to: v.payout_email, raw: '', visible_text: '', hidden_text: [],
    vendor_id: v.id, claimed_vendor_id: null, risk_status: 'CLEAR', risk_score: 0, findings: [], payment_status: 'PAID', scanned_at: '2026-07-01T00:00:00Z',
  });
}
for (const c of manifest) fs.copyFileSync(path.join(here, 'cases', `${c.file}.eml`), path.join(ctx.inboxDir, `${c.file}.eml`));

// ---------- 1. detection ----------
const scanned = new Map(scanInbox(ctx, { actor: 'eval' }).map((r) => [r.id, r]));
const rows = manifest.map((c) => {
  const r = scanned.get(c.file)!;
  const predicted = r.risk_status === 'HOLD' ? 'HOLD' : 'PAYABLE';
  return { ...c, verdict: r.risk_status, predicted, correct: predicted === c.expected, codes: r.findings.map((f) => `${f.severity === 'hold' ? '' : '~'}${f.code}`) };
});

// ---------- 2. rubber-stamp end-to-end ----------
let approved = 0; const skipped: string[] = [];
for (const c of manifest) {
  const res = proposeBatch(ctx, [c.file], 'eval: naive agent');
  if (res.batch) {
    await approveBatch(ctx, res.batch.id, 'eval: careless human', 'dashboard');
    approved++;
  } else if (c.kind === 'legit') {
    skipped.push(`${c.file}: ${res.problem ?? ''} ${res.excluded.map((e) => e.reason).join('; ')}`);
  }
}
const kindOf = new Map(manifest.map((c) => [c.file, c.kind]));
const items = ctx.db.prepare("SELECT * FROM batch_items WHERE status != 'CANCELED'").all() as unknown as import('../src/core/types.js').BatchItem[];
const sent = items.filter((i) => i.status !== 'QUEUED');
const wrong = sent.filter((i) => kindOf.get(i.invoice_id) !== 'legit');
const payeeMismatch = sent.filter((i) => repo.getVendor(ctx.db, i.vendor_id)?.payout_email !== i.payout_email);
const mockPayouts = (ctx.db.prepare('SELECT json FROM mock_payouts').all() as { json: string }[]).flatMap((r) => JSON.parse(r.json).items);
const registryEmails = new Set(repo.listVendors(ctx.db).map((v) => v.payout_email));
const offRegistry = mockPayouts.filter((i: { receiver: string }) => !registryEmails.has(i.receiver));

// ---------- report ----------
const of = (k: string) => rows.filter((r) => r.kind === k);
const fraud = of('fraud');
const policy = of('policy');
const legit = of('legit');
const results = {
  generated_at: new Date().toISOString(),
  cases: rows.length,
  fraud: { total: fraud.length, held: fraud.filter((r) => r.predicted === 'HOLD').length },
  policy: { total: policy.length, held: policy.filter((r) => r.predicted === 'HOLD').length },
  legit: {
    total: legit.length,
    payable: legit.filter((r) => r.predicted === 'PAYABLE').length,
    false_holds: legit.filter((r) => r.predicted === 'HOLD').length,
    with_warnings: legit.filter((r) => r.verdict === 'REVIEW').length,
  },
  rubber_stamp: {
    batches_approved: approved,
    payouts_sent: sent.length,
    legit_paid: sent.length - wrong.length,
    wrong_payments: wrong.length,
    payee_mismatches: payeeMismatch.length,
    payouts_to_unregistered_accounts: offRegistry.length,
  },
  per_case: rows,
};
fs.writeFileSync(path.join(here, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);

const md = [
  '# Evaluation results',
  '',
  `Synthetic test set: ${rows.length} invoices (${legit.length} legitimate, ${fraud.length} fraud, ${policy.length} policy violation). Generated by \`eval/generate.ts\`; run with \`npm run eval\`.`,
  '',
  '| Metric | Result |',
  '|---|---|',
  `| Fraud invoices held | **${results.fraud.held} / ${results.fraud.total}** |`,
  `| Policy violations held | **${results.policy.held} / ${results.policy.total}** |`,
  `| Legitimate invoices payable | **${results.legit.payable} / ${results.legit.total}** (${results.legit.with_warnings} with warnings) |`,
  `| False holds | **${results.legit.false_holds}** |`,
  `| Rubber-stamp test: payouts sent | ${results.rubber_stamp.payouts_sent} |`,
  `| Rubber-stamp test: wrong payments | **${results.rubber_stamp.wrong_payments}** |`,
  `| Payouts to accounts not in the vendor registry | **${results.rubber_stamp.payouts_to_unregistered_accounts}** |`,
  '',
  'Rubber-stamp test: a naive agent proposes every invoice and a careless human approves every batch.',
  '',
  '| Case | Kind | Pattern | Expected | Verdict | Findings |',
  '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.file} | ${r.kind} | ${r.pattern} | ${r.expected} | ${r.correct ? '' : '❌ '}${r.verdict} | ${r.codes.join(', ')} |`),
  '',
  '_Findings prefixed with ~ are warnings (payable after review); the rest are holds._',
  '',
  '> This is a synthetic set we wrote to cover common invoice-fraud and AI-agent attack patterns. It shows the rules behave as designed; it is not a measure of real-world accuracy.',
  '',
].join('\n');
fs.writeFileSync(path.join(here, 'RESULTS.md'), md);

console.log(`Fraud held:          ${results.fraud.held}/${results.fraud.total}`);
console.log(`Policy held:         ${results.policy.held}/${results.policy.total}`);
console.log(`Legit payable:       ${results.legit.payable}/${results.legit.total} (${results.legit.with_warnings} with warnings, ${results.legit.false_holds} false holds)`);
console.log(`Rubber-stamp test:   ${results.rubber_stamp.payouts_sent} payouts sent, ${results.rubber_stamp.wrong_payments} wrong, ${results.rubber_stamp.payouts_to_unregistered_accounts} to unregistered accounts`);
for (const r of rows.filter((x) => !x.correct)) console.log(`  MISS ${r.file}: expected ${r.expected}, got ${r.verdict} [${r.codes.join(', ')}]`);
for (const s of skipped) console.log(`  legit not paid: ${s}`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(rows.every((r) => r.correct) && wrong.length === 0 && offRegistry.length === 0 ? 0 : 1);
