import type { Vendor } from './types.js';
import { centsToValue } from './util.js';

/** Fictional vendors used by the demo and the evaluation set. */
export type VendorSeed = Omit<Vendor, 'verified_via' | 'verified_at' | 'created_at'>;

export const DEMO_VENDORS: VendorSeed[] = [
  { id: 'priya-raman', name: 'Priya Raman', contact_email: 'priya@lumen-studio.com', domain: 'lumen-studio.com', payout_email: 'priya@lumen-studio.com', rate_type: 'hourly', rate_cents: 8500, fixed_fee_cents: null, monthly_cap_cents: 600000, category: 'illustration' },
  { id: 'leo-martins', name: 'Leo Martins', contact_email: 'leo@leomartins.dev', domain: 'leomartins.dev', payout_email: 'leo@leomartins.dev', rate_type: 'hourly', rate_cents: 9500, fixed_fee_cents: null, monthly_cap_cents: 700000, category: 'development' },
  { id: 'sam-okafor', name: 'Sam Okafor', contact_email: 'sam@okafor-copy.com', domain: 'okafor-copy.com', payout_email: 'sam@okafor-copy.com', rate_type: 'fixed', rate_cents: null, fixed_fee_cents: 120000, monthly_cap_cents: 200000, category: 'copywriting' },
  { id: 'ana-silva', name: 'Ana Silva', contact_email: 'ana@anasilva.photo', domain: 'anasilva.photo', payout_email: 'ana@anasilva.photo', rate_type: 'hourly', rate_cents: 7000, fixed_fee_cents: null, monthly_cap_cents: 300000, category: 'photography' },
  { id: 'jake-morrison', name: 'Jake Morrison', contact_email: 'jake@morrison-studio.com', domain: 'morrison-studio.com', payout_email: 'jake@morrison-studio.com', rate_type: 'hourly', rate_cents: 9000, fixed_fee_cents: null, monthly_cap_cents: 600000, category: 'motion' },
  { id: 'dev-kapoor', name: 'Dev Kapoor', contact_email: 'dev@kapoorsound.com', domain: 'kapoorsound.com', payout_email: 'dev@kapoorsound.com', rate_type: 'fixed', rate_cents: null, fixed_fee_cents: 95000, monthly_cap_cents: 200000, category: 'sound' },
];

export const EVAL_EXTRA_VENDORS: VendorSeed[] = [
  { id: 'mei-lin', name: 'Mei Lin', contact_email: 'mei@meilin3d.studio', domain: 'meilin3d.studio', payout_email: 'mei@meilin3d.studio', rate_type: 'hourly', rate_cents: 10000, fixed_fee_cents: null, monthly_cap_cents: 1000000, category: '3d' },
];

export const ALL_CATEGORIES = ['illustration', 'development', 'copywriting', 'photography', 'motion', 'sound', '3d'];

export const OWNER = { name: 'Maya Chen', email: 'maya@larkspur.studio' };

export interface InvoiceEmail {
  fromName: string;
  fromEmail: string;
  date: Date;
  subject: string;
  intro: string;
  fields: [string, string][];
  outro?: string;
  signoff: string;
  html?: boolean;
  /** Raw HTML appended to the body; used for preheaders and hidden-text attacks. */
  extraHtml?: string;
}

const money = (cents: number) => Number(centsToValue(cents)).toLocaleString('en-US', { minimumFractionDigits: 2 });

export function invoiceFields(o: { number: string; period: string; hours?: number; rateCents?: number; amountCents: number; payTo: string }): [string, string][] {
  const f: [string, string][] = [['Invoice', o.number], ['Period', o.period]];
  if (o.hours != null) f.push(['Hours', String(o.hours)]);
  if (o.rateCents != null) f.push(['Rate', `${money(o.rateCents)} USD/hour`]);
  f.push(['Amount due', `${money(o.amountCents)} USD`], ['Pay to (PayPal)', o.payTo]);
  return f;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderEmail(e: InvoiceEmail): string {
  const headers = [
    `From: ${e.fromName} <${e.fromEmail}>`,
    `To: ${OWNER.name} <${OWNER.email}>`,
    `Date: ${e.date.toUTCString()}`,
    `Subject: ${e.subject}`,
    `Content-Type: ${e.html ? 'text/html' : 'text/plain'}; charset=utf-8`,
  ].join('\n');
  if (!e.html) {
    const body = [`Hi Maya,`, '', e.intro, '', ...e.fields.map(([k, v]) => `${k}: ${v}`), '', ...(e.outro ? [e.outro, ''] : []), e.signoff].join('\n');
    return `${headers}\n\n${body}\n`;
  }
  const rows = e.fields.map(([k, v]) => `    <tr><td style="padding:2px 12px 2px 0;color:#555">${esc(k)}:</td><td>${esc(v)}</td></tr>`).join('\n');
  const body = `<html>
<body style="font-family:Arial,Helvetica,sans-serif;color:#222;font-size:14px">
  <p>Hi Maya,</p>
  <p>${esc(e.intro)}</p>
  <table>
${rows}
  </table>
${e.outro ? `  <p>${esc(e.outro)}</p>\n` : ''}  <p>${e.signoff.split('\n').map(esc).join('<br>')}</p>
${e.extraHtml ?? ''}
</body>
</html>`;
  return `${headers}\n\n${body}\n`;
}
