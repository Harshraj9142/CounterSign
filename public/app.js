/* Countersign approval dashboard. Invoice content is attacker-controlled: always escape. */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const money = (c, cur = 'USD') =>
    (cur === 'USD' ? '$' : '') + ((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (cur !== 'USD' ? ` ${cur}` : '');
  const period = (p) => {
    if (!p || !/^\d{4}-\d{2}$/.test(p)) return '—';
    const [y, m] = p.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return when(iso);
  };

  const CHIP = {
    CLEAR: ['ok', 'Clear'], REVIEW: ['warn', 'Review'], HOLD: ['bad', 'Held'],
    PENDING_APPROVAL: ['accent', 'Awaiting approval'], APPROVED: ['info', 'Approved'], SUBMITTED: ['info live', 'Sent to PayPal'],
    PAID: ['ok', 'Paid'], PARTIAL: ['warn', 'Partly paid'], FAILED: ['bad', 'Failed'], REJECTED: ['', 'Rejected'], EXPIRED: ['', 'Expired'],
    QUEUED: ['', 'Queued'], PENDING: ['info live', 'Pending'], SUCCESS: ['ok', 'Paid'], UNCLAIMED: ['warn', 'Unclaimed'], ONHOLD: ['warn', 'On hold'],
    RETURNED: ['bad', 'Returned'], BLOCKED: ['bad', 'Blocked'], REFUNDED: ['bad', 'Refunded'], REVERSED: ['bad', 'Reversed'], DENIED: ['bad', 'Denied'],
    CANCELED: ['', 'Canceled'], UNPAID: ['', 'Unpaid'], PROPOSED: ['accent', 'Proposed'], PROCESSING: ['info live', 'Processing'],
  };
  const chip = (s) => {
    const [cls, label] = CHIP[s] || ['', s];
    return `<span class="chip ${cls}">${esc(label)}</span>`;
  };

  let state = null;
  let tab = 'approvals';
  let loadedOnce = false;
  let knownPending = new Set();
  const grids = {};

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-countersign': '1', ...(opts.headers || {}) } });
    if (res.status === 401) {
      location.href = '/login';
      throw new Error('Sign in required');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  }
  const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body || {}) });

  function toast(msg, bad = false) {
    const el = document.createElement('div');
    el.className = `toast${bad ? ' bad' : ''}`;
    el.textContent = msg;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), 4500);
  }

  /** Replace a region's HTML only when it changed, so live reloads don't wipe forms or detach buttons. */
  function setHtml(el, html) {
    if (el._html === html) return false;
    el._html = html;
    el.innerHTML = html;
    return true;
  }

  const vendorName = (id) => state.vendors.find((v) => v.id === id)?.name;

  function grid(key, el, options, rows) {
    if (grids[key]) {
      grids[key].setGridOption('rowData', rows);
      return grids[key];
    }
    grids[key] = agGrid.createGrid(el, {
      rowData: rows,
      defaultColDef: { resizable: true, sortable: true, suppressMovable: true },
      animateRows: true,
      suppressCellFocus: true,
      ...options,
    });
    return grids[key];
  }

  // ---------- data ----------

  async function load() {
    state = await api('/api/state');
    renderChrome();
    renderTab();
    loadedOnce = true;
  }

  function setBadge(sel, n) {
    const el = $(sel);
    el.hidden = !n;
    el.textContent = n;
  }

  function renderChrome() {
    $('#business').textContent = `${state.business} · ${state.owner}`;
    const mp = $('#mode-pill');
    mp.textContent = { mock: 'PayPal · mock mode', sandbox: 'PayPal · sandbox', live: 'PayPal · LIVE' }[state.mode] || state.mode;
    mp.className = `pill ${state.mode === 'live' ? 'bad' : 'info'}`;
    const m = state.mandate;
    const pill = $('#mandate-pill');
    if (m.mandate && m.signature_valid && m.in_effect) {
      pill.className = 'pill ok';
      pill.textContent = `✓ Mandate ${m.mandate.terms.id} signed`;
    } else {
      pill.className = 'pill bad';
      pill.textContent = m.mandate ? '✗ Mandate signature invalid' : 'No mandate signed';
    }
    const budget = m.mandate?.terms.monthly_budget_cents || 0;
    $('#budget-text').textContent = budget ? `${money(m.committed_cents)} of ${money(budget)} used this month` : 'No budget';
    $('#budget-fill').style.width = budget ? `${Math.min(100, (m.committed_cents / budget) * 100)}%` : '0';
    const pending = state.batches.filter((b) => b.status === 'PENDING_APPROVAL');
    setBadge('#badge-approvals', pending.length);
    setBadge('#badge-held', state.invoices.filter((i) => i.risk_status === 'HOLD' && i.payment_status === 'UNPAID').length);
    $('#reset-demo').hidden = !state.demo_mode;
    for (const b of pending) if (loadedOnce && !knownPending.has(b.id)) toast(`New payout batch ${b.id} is waiting for your approval`);
    knownPending = new Set(pending.map((b) => b.id));
  }

  function setTab(t) {
    if (!document.getElementById(`view-${t}`)) t = 'approvals';
    tab = t;
    for (const a of $$('#tabs a')) a.classList.toggle('active', a.dataset.tab === t);
    for (const v of $$('.view')) v.hidden = v.id !== `view-${t}`;
    if (state) renderTab();
  }

  function renderTab() {
    ({ approvals: renderApprovals, invoices: renderInvoices, payments: renderPayments, vendors: renderVendors, mandate: renderMandate, audit: renderAudit })[tab]?.();
  }

  // ---------- approvals ----------

  function batchCard(b) {
    const allOk = b.checks.every((c) => c.ok);
    const rows = b.items
      .map(
        (i) => `<tr>
          <td><strong>${esc(i.vendor_name)}</strong>${i.warnings.length ? `<div class="warn-text">⚠ ${esc(i.warnings.join('; '))}</div>` : ''}</td>
          <td>${esc(i.invoice_number || i.invoice_id)}<span class="cell-sub">${esc(period(i.period))}</span></td>
          <td class="num">${money(i.amount_cents, i.currency)}</td>
          <td><span class="mono">${esc(i.payout_email)}</span><span class="verified">✓ verified</span></td>
        </tr>`,
      )
      .join('');
    const checks = b.checks
      .map((c) => `<div class="check"><span class="mark ${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'}</span><div>${esc(c.label)}${c.detail ? `<div class="detail">${esc(c.detail)}</div>` : ''}</div></div>`)
      .join('');
    return `<div class="card batch-card" data-batch="${esc(b.id)}">
      <div class="batch-head">
        <div>
          <div class="batch-title">Batch ${esc(b.id)} ${chip(b.status)}</div>
          <div class="batch-meta">Proposed by ${esc(b.created_by)} · ${esc(ago(b.created_at))}${b.note ? ` · “${esc(b.note)}”` : ''}</div>
        </div>
        <div class="batch-amount"><div class="big">${money(b.total_cents)}</div><div class="small">${b.items.length} payout${b.items.length === 1 ? '' : 's'} via PayPal Payouts</div></div>
      </div>
      <div class="batch-body">
        <div class="batch-items"><table class="simple"><thead><tr><th>Vendor</th><th>Invoice</th><th class="num">Amount</th><th>Pays to</th></tr></thead><tbody>${rows}</tbody></table></div>
        <div class="batch-checks"><h3>Policy checks</h3>${checks}</div>
      </div>
      <div class="batch-foot">
        <span class="note">One PayPal Payouts batch, sender_batch_id <span class="mono">${esc(b.id)}</span>: it can never be paid twice.</span>
        <div style="display:flex;gap:8px">
          <button class="btn ghost danger" data-reject="${esc(b.id)}">Reject</button>
          <button class="btn primary big" data-approve="${esc(b.id)}" ${allOk ? '' : 'disabled title="Blocked by policy"'}>Approve &amp; pay ${money(b.total_cents)}</button>
        </div>
      </div>
    </div>`;
  }

  function renderApprovals() {
    const pending = state.batches.filter((b) => b.status === 'PENDING_APPROVAL');
    const recent = state.batches.filter((b) => b.status !== 'PENDING_APPROVAL').slice(0, 8);
    setHtml($('#view-approvals'), `
      <div class="view-head"><div><h1>Approvals</h1>
        <p class="sub">The agent can only propose payouts. Nothing moves until you approve, and only within your signed mandate.</p></div></div>
      ${pending.length ? pending.map(batchCard).join('') : '<div class="card empty"><strong>Nothing waiting for approval</strong>When the agent proposes a payout batch, it shows up here.</div>'}
      <div class="section-title">Recent batches</div>
      ${recent.length ? `<div class="card" style="padding:4px 20px 8px"><table class="simple"><thead><tr><th>Batch</th><th>Status</th><th class="num">Amount</th><th>Payouts</th><th>Approved by</th><th>When</th></tr></thead><tbody>
        ${recent.map((b) => `<tr><td class="mono">${esc(b.id)}</td><td>${chip(b.status)}</td><td class="num">${money(b.total_cents)}</td><td>${b.items.length}</td><td>${esc(b.approved_by || '—')}</td><td>${esc(when(b.approved_at || b.created_at))}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="card empty">No batches yet.</div>'}`);
  }

  async function approve(id, btn) {
    btn.disabled = true;
    btn.textContent = 'Sending to PayPal…';
    try {
      const b = await post(`/api/batches/${encodeURIComponent(id)}/approve`);
      if (b.status === 'FAILED') toast(`PayPal rejected the batch: ${b.error}`, true);
      else toast(`Approved. ${b.items.length} payouts sent to PayPal.`);
      knownPending.delete(id);
      await load();
      location.hash = '#payments';
    } catch (err) {
      toast(err.message, true);
      await load();
    }
  }

  $('#view-approvals').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-approve]');
    if (a) return approve(a.dataset.approve, a);
    const r = e.target.closest('[data-reject]');
    if (r) {
      const reason = prompt('Why are you rejecting this batch?', 'Not approved');
      if (reason == null) return;
      try {
        await post(`/api/batches/${encodeURIComponent(r.dataset.reject)}/reject`, { reason });
        toast('Batch rejected. Invoices returned to unpaid.');
        await load();
      } catch (err) {
        toast(err.message, true);
      }
    }
  });

  // ---------- invoices ----------

  function renderInvoices() {
    const rows = state.invoices;
    const n = (s) => rows.filter((r) => r.risk_status === s).length;
    $('#invoice-counts').innerHTML = `<span class="chip ok">${n('CLEAR')} clear</span><span class="chip warn">${n('REVIEW')} review</span><span class="chip bad">${n('HOLD')} held</span>`;
    const el = $('#grid-invoices');
    el.classList.add('clickable');
    grid('invoices', el, {
      domLayout: 'autoHeight',
      getRowId: (p) => p.data.id,
      onRowClicked: (p) => openInvoice(p.data.id),
      columnDefs: [
        { headerName: 'Verdict', field: 'risk_status', width: 115, cellRenderer: (p) => chip(p.value) },
        {
          headerName: 'From', field: 'from_email', flex: 1.5, minWidth: 230,
          cellRenderer: (p) => {
            const d = p.data;
            const v = vendorName(d.vendor_id);
            const c = vendorName(d.claimed_vendor_id);
            return v
              ? `<strong>${esc(v)}</strong><span class="cell-sub">${esc(d.from_email)}</span>`
              : `<span class="cell-bad">${c ? `Claims to be ${esc(c)}` : 'Unknown sender'}</span><span class="cell-sub">${esc(d.from_email)}</span>`;
          },
        },
        { headerName: 'Invoice', field: 'invoice_number', width: 125 },
        { headerName: 'Period', field: 'period', width: 105, valueFormatter: (p) => period(p.value) },
        { headerName: 'Amount', field: 'amount_cents', width: 125, type: 'rightAligned', valueFormatter: (p) => money(p.value) },
        {
          headerName: 'Findings', flex: 2, minWidth: 260,
          valueGetter: (p) => p.data.findings.map((f) => f.title).join('; '),
          cellRenderer: (p) => {
            const f = p.data.findings;
            if (!f.length) return '<span class="cell-sub" style="margin:0">No issues</span>';
            const first = f.find((x) => x.severity === 'hold') || f[0];
            return `<span class="${first.severity === 'hold' ? 'cell-bad' : 'warn-text'}">${esc(first.title)}</span>${f.length > 1 ? `<span class="cell-sub">+${f.length - 1} more</span>` : ''}`;
          },
        },
        { headerName: 'Payment', field: 'payment_status', width: 130, cellRenderer: (p) => chip(p.value) },
      ],
    }, rows);
  }

  async function openInvoice(id) {
    const inv = await api(`/api/invoices/${encodeURIComponent(id)}`);
    const vendor = state.vendors.find((v) => v.id === (inv.vendor_id || inv.claimed_vendor_id));
    $('#drawer-title').innerHTML = `<div class="title">${esc(inv.subject || inv.id)}</div><div class="meta">${esc(inv.from_name)} &lt;${esc(inv.from_email)}&gt; · ${esc(when(inv.received_at))}</div>`;
    const payeeOk = !inv.pay_to || !vendor || inv.pay_to === vendor.payout_email;
    const body = $('#drawer-body');
    body.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${chip(inv.risk_status)} ${chip(inv.payment_status)} <span class="cell-sub" style="margin:0">Risk ${inv.risk_score}/100</span></div>
      <h3>Findings</h3>
      ${inv.findings.length ? inv.findings.map((f) => `<div class="finding ${f.severity}"><div class="t">${esc(f.title)} <span class="code">${esc(f.code)}</span></div><div class="d">${esc(f.detail)}</div></div>`).join('') : '<p class="sub">No issues found.</p>'}
      <h3>Extracted (from visible text only)</h3>
      <dl class="kv">
        <dt>Matched vendor</dt><dd>${inv.vendor_id ? esc(vendorName(inv.vendor_id)) : `<span class="cell-bad">none${inv.claimed_vendor_id ? ` (claims ${esc(vendorName(inv.claimed_vendor_id))})` : ''}</span>`}</dd>
        <dt>Invoice</dt><dd>${esc(inv.invoice_number || '—')}</dd>
        <dt>Period</dt><dd>${esc(period(inv.period))}</dd>
        <dt>Hours × rate</dt><dd>${inv.hours != null ? `${esc(inv.hours)}h × ${money(inv.rate_cents)}` : '—'}</dd>
        <dt>Amount due</dt><dd><strong>${money(inv.amount_cents, inv.currency)}</strong></dd>
        <dt>Asks to pay</dt><dd class="mono ${payeeOk ? '' : 'cell-bad'}">${esc(inv.pay_to || '—')}${payeeOk ? '' : ' ✗'}</dd>
        ${vendor ? `<dt>Verified account</dt><dd class="mono">${esc(vendor.payout_email)}</dd>` : ''}
      </dl>
      <h3>What a human sees</h3>
      <pre class="email" id="email-visible"></pre>
      ${inv.hidden_text.length ? '<h3 style="color:var(--bad)">Hidden from human readers</h3><div id="email-hidden"></div>' : ''}`;
    $('#email-visible').textContent = inv.visible_text;
    if (inv.hidden_text.length) {
      for (const h of inv.hidden_text) {
        const pre = document.createElement('pre');
        pre.className = 'email hidden-text';
        pre.textContent = h;
        $('#email-hidden').append(pre);
      }
    }
    $('#drawer').classList.add('open');
    $('#scrim').classList.add('open');
  }

  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#scrim').classList.remove('open');
  }
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());

  $('#rescan').addEventListener('click', async () => {
    await post('/api/scan');
    toast('Inbox re-scanned.');
    await load();
  });

  // ---------- payments ----------

  function renderPayments() {
    const month = new Date().toISOString().slice(0, 7);
    const rows = state.batches
      .filter((b) => b.approved_at)
      .flatMap((b) => b.items.map((i) => ({ ...i, batch_status: b.status, approved_at: b.approved_at, paypal_batch_id: b.paypal_batch_id })));
    const thisMonth = rows.filter((r) => (r.approved_at || '').startsWith(month));
    const sum = (xs) => xs.reduce((s, x) => s + x.amount_cents, 0);
    const paid = thisMonth.filter((r) => r.status === 'SUCCESS');
    const flying = thisMonth.filter((r) => ['QUEUED', 'PENDING', 'ONHOLD'].includes(r.status));
    const problems = thisMonth.filter((r) => !['SUCCESS', 'QUEUED', 'PENDING', 'ONHOLD', 'CANCELED'].includes(r.status));
    $('#payment-tiles').innerHTML = `
      <div class="card tile"><div class="label">Paid this month</div><div class="value">${money(sum(paid))}</div></div>
      <div class="card tile"><div class="label">In flight</div><div class="value">${money(sum(flying))}</div></div>
      <div class="card tile"><div class="label">Needs attention</div><div class="value">${problems.length}</div></div>
      <div class="card tile"><div class="label">Budget left this month</div><div class="value">${money(state.mandate.remaining_cents)}</div></div>`;
    grid('payments', $('#grid-payments'), {
      domLayout: 'autoHeight',
      getRowId: (p) => p.data.id,
      columnDefs: [
        { headerName: 'Status', field: 'status', width: 120, cellRenderer: (p) => chip(p.value) },
        { headerName: 'Vendor', field: 'vendor_name', flex: 1, minWidth: 140, cellRenderer: (p) => `<strong>${esc(p.value)}</strong>` },
        { headerName: 'Invoice', field: 'invoice_number', width: 120 },
        { headerName: 'Amount', field: 'amount_cents', width: 120, type: 'rightAligned', valueFormatter: (p) => money(p.value) },
        { headerName: 'Paid to', field: 'payout_email', flex: 1.3, minWidth: 200, cellClass: 'mono' },
        { headerName: 'Batch', field: 'batch_id', width: 175, cellClass: 'mono' },
        { headerName: 'PayPal transaction', field: 'transaction_id', flex: 1, minWidth: 170, cellClass: 'mono', valueFormatter: (p) => p.value || '—' },
        { headerName: 'Approved', field: 'approved_at', width: 140, valueFormatter: (p) => when(p.value), sort: 'desc' },
      ],
    }, rows);
  }

  $('#reconcile').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await post('/api/reconcile');
      toast(`Reconciled: ${r.paid.length} paid, ${r.in_flight.length} in flight, ${r.receipts_written.length} receipts written.`);
      await load();
    } catch (err) {
      toast(err.message, true);
    } finally {
      e.target.disabled = false;
    }
  });

  // ---------- vendors ----------

  function renderVendors() {
    const el = $('#grid-vendors');
    el.classList.add('clickable');
    grid('vendors', el, {
      domLayout: 'autoHeight',
      getRowId: (p) => p.data.id,
      onRowClicked: (p) => openVendorDialog(p.data),
      columnDefs: [
        { headerName: 'Name', field: 'name', flex: 1, minWidth: 140, cellRenderer: (p) => `<strong>${esc(p.value)}</strong>` },
        { headerName: 'Category', field: 'category', width: 125 },
        { headerName: 'Contact', field: 'contact_email', flex: 1.2, minWidth: 190 },
        { headerName: 'Verified payout account', field: 'payout_email', flex: 1.3, minWidth: 210, cellRenderer: (p) => `<span class="mono">${esc(p.value)}</span><span class="verified">✓</span>` },
        { headerName: 'Rate', width: 130, valueGetter: (p) => (p.data.rate_type === 'hourly' ? `${money(p.data.rate_cents)}/h` : `${money(p.data.fixed_fee_cents)} fixed`) },
        { headerName: 'Monthly cap', field: 'monthly_cap_cents', width: 125, type: 'rightAligned', valueFormatter: (p) => money(p.value) },
        { headerName: 'Verified via', field: 'verified_via', flex: 1.2, minWidth: 180 },
      ],
    }, state.vendors);
  }

  function openVendorDialog(v) {
    const f = $('#vendor-form');
    f.reset();
    if (v) {
      f.name.value = v.name;
      f.category.value = v.category;
      f.contact_email.value = v.contact_email;
      f.domain.value = v.domain;
      f.payout_email.value = v.payout_email;
      f.rate_type.value = v.rate_type;
      f.rate.value = ((v.rate_type === 'hourly' ? v.rate_cents : v.fixed_fee_cents) / 100).toFixed(2);
      f.monthly_cap.value = (v.monthly_cap_cents / 100).toFixed(2);
      f.dataset.id = v.id;
    } else delete f.dataset.id;
    $('#vendor-dialog').showModal();
  }
  $('#add-vendor').addEventListener('click', () => openVendorDialog(null));
  $('#vendor-dialog').addEventListener('close', async () => {
    if ($('#vendor-dialog').returnValue !== 'save') return;
    const f = $('#vendor-form');
    const data = Object.fromEntries(new FormData(f));
    data.id = f.dataset.id;
    if (data.rate_type === 'fixed') data.fixed_fee = data.rate;
    try {
      await post('/api/vendors', data);
      toast(`Vendor ${data.name} saved and recorded in the audit log.`);
      await load();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------- mandate ----------

  function renderMandate() {
    const st = state.mandate;
    const m = st.mandate;
    if (!m) {
      $('#view-mandate').innerHTML = '<div class="card empty"><strong>No mandate signed</strong>Nothing can be paid until you sign one.</div>';
      return;
    }
    const t = m.terms;
    const date = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    if (!setHtml($('#view-mandate'), `
      <div class="view-head"><div><h1>Spending mandate</h1>
        <p class="sub">Your signed rules for what the agent may pay. The agent can read this mandate; only you can change it, by signing a new one.</p></div></div>
      <div class="card mandate-card">
        <div class="mandate-top">
          <div><h2>${esc(t.purpose)} · <span class="mono">${esc(t.id)}</span></h2>
            <div class="sub">Signed by ${esc(t.issuer)} on ${esc(date(t.signed_at))} · valid ${esc(date(t.valid_from))} to ${esc(date(t.valid_until))}</div></div>
          <span class="pill ${st.signature_valid ? 'ok' : 'bad'}">${st.signature_valid ? '✓ Signature valid' : '✗ Signature invalid'}</span>
        </div>
        <div class="terms">
          <div class="term"><div class="label">Max per payment</div><div class="value">${money(t.max_per_payment_cents)}</div></div>
          <div class="term"><div class="label">Max per batch</div><div class="value">${money(t.max_per_batch_cents)}</div></div>
          <div class="term"><div class="label">Monthly budget</div><div class="value">${money(t.monthly_budget_cents)}</div></div>
          <div class="term"><div class="label">Left this month</div><div class="value">${money(st.remaining_cents)}</div></div>
        </div>
        <ul class="rules">
          <li>Registered, verified vendors only; payouts go to the account on file, never to one named in an invoice.</li>
          <li>A human approves every batch.</li>
          <li>Categories: ${esc(t.allowed_categories.join(', '))}.</li>
        </ul>
        <h3 class="section-title" style="margin-top:20px">Signature (${esc(m.algorithm)})</h3>
        <div class="sig mono">${esc(m.signature)}</div>
        <form class="resign" id="mandate-form">
          <h2>Change limits and re-sign</h2>
          <div class="form-grid">
            <label>Max per payment (USD)<input name="max_per_payment" value="${(t.max_per_payment_cents / 100).toFixed(2)}"></label>
            <label>Max per batch (USD)<input name="max_per_batch" value="${(t.max_per_batch_cents / 100).toFixed(2)}"></label>
            <label>Monthly budget (USD)<input name="monthly_budget" value="${(t.monthly_budget_cents / 100).toFixed(2)}"></label>
            <label>Valid until<input name="valid_until" type="date" value="${esc(t.valid_until.slice(0, 10))}"></label>
          </div>
          <button class="btn primary">Sign new mandate</button>
        </form>
      </div>`)) return;
    $('#mandate-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const m2 = await post('/api/mandate', Object.fromEntries(new FormData(e.target)));
        toast(`Signed mandate ${m2.terms.id}.`);
        await load();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // ---------- audit ----------

  const summarize = (data) => {
    try {
      const o = JSON.parse(data);
      return Object.entries(o)
        .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
        .map(([k, v]) => `${k}=${typeof v === 'number' && k.endsWith('_cents') ? money(v) : v}`)
        .join('  ');
    } catch {
      return data;
    }
  };

  async function renderAudit(showBanner = false) {
    const { entries, verification } = await api('/api/audit');
    if (showBanner || !$('#audit-banner').hidden) {
      const b = $('#audit-banner');
      b.hidden = false;
      b.className = `banner ${verification.ok ? 'ok' : 'bad'}`;
      b.textContent = verification.ok
        ? `✓ Chain intact: ${verification.entries} entries verified. Head ${verification.head.slice(0, 20)}…`
        : `✗ Chain broken at entry ${verification.broken_at}: ${verification.reason}`;
    }
    grid('audit', $('#grid-audit'), {
      getRowId: (p) => String(p.data.seq),
      columnDefs: [
        { headerName: '#', field: 'seq', width: 70, sort: 'desc' },
        { headerName: 'Time', field: 'ts', width: 150, valueFormatter: (p) => when(p.value) },
        { headerName: 'Actor', field: 'actor', width: 210 },
        { headerName: 'Action', field: 'action', width: 190, cellClass: 'mono' },
        { headerName: 'Details', field: 'data', flex: 1, minWidth: 260, valueFormatter: (p) => summarize(p.value), tooltipValueGetter: (p) => p.value },
        { headerName: 'Hash', field: 'hash', width: 150, cellClass: 'mono', valueFormatter: (p) => `${p.value.slice(0, 12)}…` },
      ],
    }, entries);
  }
  $('#verify-audit').addEventListener('click', () => renderAudit(true));

  // ---------- misc ----------

  $('#reset-demo').addEventListener('click', async () => {
    if (!confirm('Reset all demo data?')) return;
    await post('/api/demo/reset');
    toast('Demo data reset.');
    await load();
  });

  window.addEventListener('hashchange', () => setTab(location.hash.slice(1) || 'approvals'));

  let reloadTimer;
  const scheduleReload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => load().catch(() => {}), 120);
  };
  try {
    new EventSource('/api/events').onmessage = scheduleReload;
  } catch {
    /* polling below still works */
  }
  setInterval(scheduleReload, 5000);

  // ---------- hooks for the recorded demo (same-origin only) ----------

  async function demoClickApprove() {
    if (tab !== 'approvals') {
      location.hash = '#approvals';
      setTab('approvals');
    }
    await load();
    const btn = $('[data-approve]');
    if (!btn) throw new Error('No batch awaiting approval');
    btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(500);
    btn.closest('.batch-card').classList.add('flash');
    const cur = $('#demo-cursor');
    cur.hidden = false;
    cur.style.transition = 'none';
    cur.style.transform = `translate(${innerWidth * 0.45}px, ${innerHeight * 0.3}px)`;
    await frame();
    await frame();
    const r = btn.getBoundingClientRect();
    cur.style.transition = '';
    cur.style.transform = `translate(${r.left + r.width * 0.5}px, ${r.top + r.height * 0.55}px)`;
    await sleep(1100);
    cur.classList.add('click');
    const id = btn.dataset.approve;
    // Re-query: a live reload may have replaced the element while the cursor moved.
    const live = document.querySelector(`[data-approve="${CSS.escape(id)}"]`) || btn;
    live.classList.add('pressed');
    await sleep(260);
    const done = approve(id, live);
    await sleep(600);
    cur.classList.remove('click');
    setTimeout(() => (cur.hidden = true), 900);
    await done;
    return id;
  }

  window.addEventListener('message', async (e) => {
    if (e.origin !== location.origin || !e.data?.cmd) return;
    const { cmd, reqId, ...args } = e.data;
    let ok = true;
    let result = null;
    try {
      if (cmd === 'tab') {
        closeDrawer();
        location.hash = `#${args.tab}`;
        setTab(args.tab);
      } else if (cmd === 'openInvoice') {
        if (tab !== 'invoices') {
          location.hash = '#invoices';
          setTab('invoices');
        }
        await openInvoice(args.id);
      } else if (cmd === 'closeDrawer') closeDrawer();
      else if (cmd === 'scrollDrawer') {
        const body = $('#drawer-body');
        body.scrollTo({ top: args.to === 'top' ? 0 : body.scrollHeight, behavior: 'smooth' });
      }
      else if (cmd === 'clickApprove') result = await demoClickApprove();
      else if (cmd === 'reload') await load();
      else if (cmd === 'verifyAudit') {
        location.hash = '#audit';
        setTab('audit');
        await renderAudit(true);
      }
    } catch (err) {
      ok = false;
      result = String(err.message || err);
    }
    e.source?.postMessage({ reqId, ok, result }, e.origin);
  });

  setTab(location.hash.slice(1) || 'approvals');
  load().catch((err) => toast(err.message, true));
})();
