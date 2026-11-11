/**
 * The demo video script. Each scene has narration (spoken + captioned) and on-screen actions
 * that run at the same time. Claude's replies come from demo/transcript.json (a real session
 * captured with `npm run demo:capture`); every tool call is re-run live during recording.
 */

type Target = { in: 'stage' | 'dash'; sel: string; text?: string; nth?: number; all?: boolean; count?: number; crop?: { top?: number; bottom?: number; left?: number; right?: number }; pad?: number; maxScale?: number; fx?: number; fy?: number };

export type Action =
  | { type: 'title'; logo?: boolean; kicker?: string; title: string; subtitle?: string; fact?: { value: string; label: string }; stats?: { value: string; label: string }[]; footer?: string }
  | { type: 'hideTitle' }
  | { type: 'chapter'; n?: number; text?: string }
  | { type: 'cursor'; show: boolean }
  | ({ type: 'camera'; target: 'full' | Target; ms?: number })
  | ({ type: 'click'; after?: number; scrollIntoView?: boolean } & Target)
  | ({ type: 'highlight'; label?: string; tone?: 'bad' | 'ok'; below?: boolean; hold?: number } & Target)
  | { type: 'clearHighlights' }
  | ({ type: 'scroll'; to: 'top' | 'bottom' | number; ms?: number } & Target)
  | { type: 'openRow'; text: string; id: string }
  | { type: 'type'; turn: number }
  | { type: 'claude'; turn: number }
  | { type: 'waitPaid' }
  | { type: 'wait'; ms: number };

export interface Scene {
  id: string;
  narration: string;
  actions: Action[];
  audioMs?: number;
}

export interface EvalSummary {
  cases: number;
  bad: number;
  badHeld: number;
  legit: number;
  legitPayable: number;
  wrongPayments: number;
  patterns: number;
}

const tab = (name: string): Action => ({ type: 'click', in: 'dash', sel: `#tabs a[data-tab="${name}"]`, after: 500 });
const CHAT: Target = { in: 'stage', sel: '.chat', crop: { top: 0.36 }, pad: 12, maxScale: 1.45 };

export function buildScenes(e: EvalSummary, model: string, mode: string): Scene[] {
  return [
    {
      id: 'intro',
      narration:
        'Fake invoices and swapped payment details cost businesses about three billion dollars last year, according to the FBI. And AI agents are starting to move money. Countersign lets an agent pay your contractors through PayPal, inside rules you signed, and never without your approval.',
      actions: [
        {
          type: 'title', logo: true, kicker: 'PayPal AI Hackathon 2026', title: 'Countersign',
          subtitle: 'An AI agent that pays your contractors through PayPal, inside a mandate you signed.',
          fact: { value: '~$3B', label: 'reported losses to business email compromise\nin 2025 (FBI Internet Crime Report)' },
        },
      ],
    },
    {
      id: 'mandate',
      narration:
        'Maya runs a design studio with six freelancers. Her signed mandate allows verified vendors only, up to five thousand dollars per payment, and a human approves every batch. Claude can read the mandate, but has no tool to change it.',
      actions: [
        { type: 'hideTitle' },
        { type: 'chapter', n: 1, text: 'The signed mandate' },
        { type: 'cursor', show: true },
        tab('mandate'),
        { type: 'camera', target: { in: 'dash', sel: '.mandate-card', crop: { bottom: 0.4 }, pad: 24, maxScale: 1.6 } },
        { type: 'highlight', in: 'dash', sel: '.mandate-card .terms', label: 'Limits only Maya can change', pad: 10 },
        { type: 'wait', ms: 2400 },
        { type: 'clearHighlights' },
      ],
    },
    {
      id: 'scan',
      narration:
        "At month-end, Maya asks Claude to pay October's invoices. Claude calls Countersign, which checks each invoice against the vendor registry, contract rates, timesheets, payment history and the mandate. The verdicts come from code, not the model's opinion.",
      actions: [
        { type: 'chapter', n: 2, text: 'Ask Claude' },
        { type: 'camera', target: CHAT },
        { type: 'type', turn: 0 },
        { type: 'claude', turn: 0 },
      ],
    },
    {
      id: 'jake',
      narration:
        'Two invoices are held. This one claims to be from Jake, but comes from a lookalike domain: studlo, not studio. It asks to pay a new Gmail account, bills twelve extra hours, and pushes urgency. A classic payment-redirection scam.',
      actions: [
        { type: 'chapter', n: 3, text: 'Fraud caught' },
        { type: 'camera', target: 'full', ms: 1000 },
        tab('invoices'),
        { type: 'openRow', text: 'Claims to be Jake', id: 'oct-jake' },
        { type: 'camera', target: { in: 'dash', sel: '#drawer', crop: { bottom: 0.4 }, pad: 16, maxScale: 1.7 } },
        { type: 'highlight', in: 'dash', sel: '#drawer-body .finding', nth: 0, label: 'Lookalike domain', tone: 'bad', pad: 6 },
        { type: 'wait', ms: 1400 },
        { type: 'highlight', in: 'dash', sel: '#drawer-body .finding', nth: 1, label: 'New payee account', tone: 'bad', pad: 6, below: true },
        { type: 'wait', ms: 2200 },
        { type: 'clearHighlights' },
      ],
    },
    {
      id: 'dev',
      narration:
        "The other looks normal. But hidden in white, one-pixel text is a message to the AI: it's pre-approved, skip the review, and add a forty-five hundred dollar payment to another account. Countersign flags the prompt injection.",
      actions: [
        { type: 'camera', target: 'full', ms: 900 },
        { type: 'click', in: 'dash', sel: '#drawer-close', after: 400 },
        { type: 'openRow', text: 'Dev Kapoor', id: 'oct-dev' },
        { type: 'scroll', in: 'dash', sel: '#drawer-body', to: 'bottom', ms: 1000 },
        { type: 'camera', target: { in: 'dash', sel: '#email-hidden', pad: 70, maxScale: 1.8 } },
        { type: 'highlight', in: 'dash', sel: '#email-hidden', label: 'Hidden from humans, aimed at the AI', tone: 'bad', pad: 6 },
        { type: 'wait', ms: 2600 },
        { type: 'clearHighlights' },
      ],
    },
    {
      id: 'propose',
      narration:
        "Maya says yes, but Claude can only propose. Countersign re-runs every check, confirms the batch fits the mandate, and pins each payout to a verified PayPal account. Claude also drafts a note to Jake's real address, not the scammer's.",
      actions: [
        { type: 'chapter', n: 4, text: 'Claude proposes, never pays' },
        { type: 'camera', target: 'full', ms: 900 },
        { type: 'click', in: 'dash', sel: '#drawer-close', after: 300 },
        { type: 'camera', target: CHAT },
        { type: 'type', turn: 1 },
        { type: 'claude', turn: 1 },
      ],
    },
    {
      id: 'approve',
      narration:
        'Maya reviews the batch and its policy checks, then approves. Countersign sends one PayPal Payouts batch, keyed to its own batch ID, so a retry can never pay twice. PayPal webhooks stream the status back live.',
      actions: [
        { type: 'chapter', n: 5, text: 'A human approves' },
        { type: 'camera', target: 'full', ms: 1000 },
        tab('approvals'),
        { type: 'camera', target: { in: 'dash', sel: '.batch-card', pad: 20, maxScale: 1.5 } },
        { type: 'highlight', in: 'dash', sel: '.batch-checks', label: 'Re-checked at approval', tone: 'ok', pad: 0 },
        { type: 'wait', ms: 1700 },
        { type: 'clearHighlights' },
        { type: 'click', in: 'dash', sel: '[data-approve]', after: 900 },
        { type: 'camera', target: { in: 'dash', sel: '#view-payments', crop: { bottom: 0.38 }, pad: 16, maxScale: 1.55 } },
        { type: 'waitPaid' },
        { type: 'highlight', in: 'dash', sel: '#grid-payments .ag-row', all: true, count: 4, label: 'Paid through PayPal Payouts', tone: 'ok', pad: 4 },
        { type: 'wait', ms: 1300 },
        { type: 'clearHighlights' },
      ],
    },
    {
      id: 'confirm',
      narration:
        'When Maya checks in, Claude confirms with PayPal that all four payouts succeeded. And every action, by the agent, by Maya or by PayPal, lands in a hash-chained audit log, so tampering is detectable.',
      actions: [
        { type: 'chapter', n: 6, text: 'Paid and verified' },
        { type: 'camera', target: CHAT },
        { type: 'type', turn: 2 },
        { type: 'claude', turn: 2 },
        { type: 'camera', target: 'full', ms: 900 },
        tab('audit'),
        { type: 'click', in: 'dash', sel: '#verify-audit', after: 600 },
        { type: 'camera', target: { in: 'dash', sel: '#view-audit', crop: { bottom: 0.55 }, pad: 16, maxScale: 1.6 } },
        { type: 'highlight', in: 'dash', sel: '#audit-banner', label: 'Tamper-evident', tone: 'ok', pad: 4 },
        { type: 'wait', ms: 1600 },
        { type: 'clearHighlights' },
      ],
    },
    {
      id: 'eval',
      narration:
        `We tested it on ${e.cases} synthetic invoices covering ${e.patterns} attack patterns, from lookalike domains and padded hours to split invoices and prompt injection. It held ${e.badHeld === e.bad ? 'all ' : ''}${e.badHeld} bad ones, cleared ${e.legitPayable === e.legit ? 'all ' : ''}${e.legitPayable} good ones, and made ${e.wrongPayments === 0 ? 'zero' : e.wrongPayments} wrong payments, even with a careless approver.`,
      actions: [
        { type: 'chapter' },
        { type: 'cursor', show: false },
        { type: 'camera', target: 'full', ms: 600 },
        {
          type: 'title', kicker: 'Evaluation', title: `Tested on ${e.cases} invoices`,
          stats: [
            { value: `${e.badHeld}/${e.bad}`, label: 'fraud & policy cases held' },
            { value: `${e.legitPayable}/${e.legit}`, label: 'legitimate invoices cleared' },
            { value: String(e.wrongPayments), label: 'wrong payments, even with a careless approver' },
          ],
          footer: `Synthetic test set · ${e.patterns} patterns · reproduce with npm run eval`,
        },
      ],
    },
    {
      id: 'close',
      narration: 'The model proposes. The mandate decides. A human approves. Countersign: AI that can pay people, safely.',
      actions: [
        {
          type: 'title', logo: true, title: 'The model proposes.\nThe mandate decides.\nA human approves.',
          subtitle: 'Countersign · open-source MCP server for PayPal Payouts',
          footer: `Claude's replies recorded from a real session (${model}) · tool calls and payouts run live · PayPal ${mode} mode`,
        },
        { type: 'wait', ms: 2200 },
      ],
    },
  ];
}
