# Devpost submission draft: Countersign

Copy each section into the matching Devpost field. Replace everything in [brackets].

**Tagline (short description):**
Let an AI agent pay your contractors through PayPal, inside a mandate you signed. It catches fake invoices and prompt injection, and a human approves every payout.

**Video:** [YouTube link, under 3 minutes]
**Repo:** [GitHub link]
**Try it:** [https://your-app.onrender.com, plus the dashboard and MCP tokens in "Testing instructions"]

---

## Inspiration

Fake invoices and swapped payment details ("business email compromise") were the second-largest category of reported losses in the FBI's 2025 Internet Crime Report, at about $3 billion. Small businesses are the easiest targets: one person pays a dozen freelancers at month-end, from email, in a hurry.

AI agents are about to take over exactly that chore, which adds a new risk: an agent that reads invoices can be talked into things by the invoice itself. We wanted to show what agentic payments look like when they're built to be trusted. The agent does the work, but the money only moves inside rules a human signed, to accounts a human verified, after a human approves.

## What it does

Countersign is an MCP server, so it works with Claude and any other MCP client, plus a small approval dashboard. It pays contractors through **PayPal Payouts**.

- **Scans invoices** against the vendor registry, contract rates, approved timesheets, payment history and a **signed spending mandate**. The verdicts (clear, review, held) come from deterministic code, not from the model.
- **Catches fraud**: lookalike domains (`morrison-studlo.com`), payee-account changes, display-name impersonation, unknown vendors, duplicates and already-paid invoices, inflated hours or rates, padded totals, and invoices split to dodge the approval limit.
- **Catches prompt injection**: separates what a human sees from hidden HTML (white or 1px text, `display:none`, comments) and holds invoices that address the AI.
- **Proposes, never pays**: the agent can only propose a batch. A human approves it in the dashboard or in an in-chat MCP elicitation form, and only then does Countersign send one PayPal Payouts batch.
- **Pays only verified accounts**: the payout address always comes from the vendor registry, never from the invoice, so even a fooled model can't redirect money.
- **Never pays twice**: idempotent `sender_batch_id` plus `PayPal-Request-Id`, and atomic approval.
- **Closes the loop**: PayPal webhooks stream status live, `reconcile_payments` confirms with PayPal and writes receipts, and every action lands in a hash-chained audit log.

## How we built it

- **TypeScript** MCP server (`@modelcontextprotocol/sdk`) over stdio and Streamable HTTP, with 15 tools, a prompt, tool annotations and **MCP elicitation** for in-chat human approval.
- **PayPal REST APIs**: OAuth client credentials, **Payouts** (create and track batches), **Reporting** (balances, Transaction Search), **Webhooks** (registration and signature verification), plus a mock PayPal with identical shapes for offline development.
- **Policy engine**: pure functions with confusable-character "skeletons" and edit distance for lookalike domains, contract and timesheet math, duplicate and split detection, and prompt-injection and pressure-language patterns.
- **Signed mandate** (HMAC over canonical JSON), inspired by the mandate concept in AP2, which PayPal supports.
- **SQLite** (`node:sqlite`) ledger and an append-only **hash-chained audit log**.
- **Dashboard** with **AG Grid**; live updates over server-sent events.
- **Deployed on Render** with a one-click Blueprint.
- **Evaluation harness**: 40 synthetic invoices and a "rubber-stamp" end-to-end test.
- **Demo video pipeline**: a real Claude session is captured through the Claude Code CLI, then replayed with live tool calls and rendered with Playwright, macOS speech and ffmpeg.

## Challenges we ran into

- **Making safety structural, not a prompt.** Instructions like "please don't pay suspicious invoices" don't hold up against a hostile invoice. We moved every guarantee into code the model can't bypass: no approval tool, payees only from the registry, mandate verification at proposal *and* at approval.
- **Hidden text.** HTML emails can show a human one thing and an AI another. We extract amounts and payees from visible text only and treat hidden text purely as evidence.
- **Race conditions around money.** Double-clicks, two approval channels and retries after timeouts all had to resolve to exactly one payout.
- **Payouts' asynchronous lifecycle** (pending, unclaimed, returned), reflected live through webhooks with polling as a fallback.

## Accomplishments that we're proud of

- On our 40-invoice synthetic set: **18/18** fraud and policy cases held, **22/22** legitimate invoices payable, **0** false holds.
- In the **rubber-stamp test**, where a naive agent proposes every invoice and a careless human approves every batch: **0 wrong payments** and **0 payouts to unregistered accounts**.
- The agent literally has no tool that can approve a payment, change the mandate or change a vendor's payout account.

## What we learned

The most useful thing an AI can do with money is the tedious part: reading, matching, batching, reconciling and explaining. The most important thing is to make the dangerous part impossible without a human. MCP's split between tools (what the model may do) and elicitation (what only the user may answer) maps neatly onto that.

## What's next

- Owner-held keys or verifiable-credential mandates (AP2-style) instead of a server-held HMAC key
- "Log in with PayPal" for multi-business use
- Recurring payouts (retainers) under the same mandate, and multi-currency
- More invoice formats (PDF) with the same visible-text-only rule

## Built with

typescript · node.js · model-context-protocol · claude · paypal-payouts-api · paypal-reporting-api · paypal-webhooks · sqlite · express · ag-grid · render · playwright

## Testing instructions (for judges)

**Fastest (offline, no PayPal account needed):**

```bash
npm install && npm run build && npm run seed && npm start
# open http://localhost:3000 and connect Claude:
claude mcp add --transport http countersign http://localhost:3000/mcp
```

Ask Claude: "It's month-end. Can you pay October's freelancer invoices?" Then approve the batch in the dashboard.

**Hosted (PayPal sandbox):** [https://your-app.onrender.com]. Dashboard token: [DASHBOARD_TOKEN]. MCP endpoint: [https://your-app.onrender.com/mcp?token=MCP_TOKEN]. "Reset demo" in the dashboard restores the story.

**Reproduce the numbers:** `npm test` and `npm run eval`.
