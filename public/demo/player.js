/*
 * Countersign demo player.
 * - Replays a REAL Claude conversation captured by `npm run demo:capture` (demo/transcript.json).
 * - Re-runs every tool call live against this server's /mcp endpoint, so cards show real results.
 * - Drives the real dashboard (same-origin iframe) with an on-screen cursor, plus camera zooms,
 *   highlights, chapters and captions. Used by `npm run demo:record`; /demo/?autoplay=1 to watch.
 */
(() => {
  'use strict';
  const $ = (s, root = document) => root.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (c) => `$${((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const W = 1920;
  const H = 1080;
  const SAFE_H = H - 120; // keep the caption strip clear when framing
  const TOP = 64; // dark band for the chapter label when zoomed
  let T0 = performance.now();
  const sfx = [];
  const mark = (kind) => sfx.push({ t: performance.now() - T0, kind });

  const camera = $('#camera');
  const frame = $('#dash');
  const overlay = $('#overlay');
  const cursor = $('#cursor');
  const messages = $('#messages');
  const warnings = [];
  let transcript = null;
  const results = {};

  // ---------------- MCP client (Streamable HTTP) ----------------
  const mcp = { sid: null, id: 0, proto: null };
  async function rpc(method, params, notify = false) {
    const body = { jsonrpc: '2.0', method, params };
    if (!notify) body.id = ++mcp.id;
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (mcp.sid) headers['mcp-session-id'] = mcp.sid;
    if (mcp.proto) headers['mcp-protocol-version'] = mcp.proto;
    const res = await fetch('/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
    mcp.sid = res.headers.get('mcp-session-id') || mcp.sid;
    if (notify) return null;
    const text = await res.text();
    let msg;
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
      for (const block of text.split(/\n\n/)) {
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (data) {
          const m = JSON.parse(data);
          if (m.id === body.id) msg = m;
        }
      }
    } else msg = JSON.parse(text);
    if (!msg) throw new Error(`No response to ${method}`);
    if (msg.error) throw new Error(msg.error.message);
    return msg.result;
  }
  async function connect() {
    const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'countersign-demo-player', version: '2.0.0' } });
    mcp.proto = r.protocolVersion;
    await rpc('notifications/initialized', {}, true);
  }

  // ---------------- geometry ----------------
  const ddoc = () => frame.contentDocument;
  const camScale = () => camera.getBoundingClientRect().width / W;
  function stageRect(el) {
    const c = camera.getBoundingClientRect();
    const s = c.width / W;
    const r = el.getBoundingClientRect();
    return { x: (r.left - c.left) / s, y: (r.top - c.top) / s, w: r.width / s, h: r.height / s };
  }
  function find(t) {
    const doc = t.in === 'dash' ? ddoc() : document;
    let els = [...doc.querySelectorAll(t.sel)];
    if (t.text) els = els.filter((e) => e.textContent.includes(t.text));
    const el = els[t.nth ?? 0];
    if (!el) throw new Error(`Element not found: ${t.sel}${t.text ? ` "${t.text}"` : ''}`);
    return el;
  }
  function rectOf(t, el = find(t)) {
    let r;
    if (t.all) {
      const doc = t.in === 'dash' ? ddoc() : document;
      let els = [...doc.querySelectorAll(t.sel)];
      if (t.text) els = els.filter((e) => e.textContent.includes(t.text));
      const rs = els.map((e) => rectOf({ ...t, all: false }, e)).sort((a, b) => a.y - b.y).slice(0, t.count ?? els.length);
      const x1 = Math.min(...rs.map((q) => q.x));
      const y1 = Math.min(...rs.map((q) => q.y));
      r = { x: x1, y: y1, w: Math.max(...rs.map((q) => q.x + q.w)) - x1, h: Math.max(...rs.map((q) => q.y + q.h)) - y1 };
    } else if (t.in !== 'dash') {
      r = stageRect(el);
    } else {
      const f = stageRect(frame);
      const b = el.getBoundingClientRect();
      r = { x: f.x + b.left, y: f.y + b.top, w: b.width, h: b.height };
    }
    if (t.crop) {
      const c = { top: 0, bottom: 0, left: 0, right: 0, ...t.crop };
      r = { x: r.x + r.w * c.left, y: r.y + r.h * c.top, w: r.w * (1 - c.left - c.right), h: r.h * (1 - c.top - c.bottom) };
    }
    return r;
  }
  async function waitFor(t, timeout = 6000) {
    const start = Date.now();
    for (;;) {
      try {
        return find(t);
      } catch (err) {
        if (Date.now() - start > timeout) throw err;
        await sleep(100);
      }
    }
  }

  // ---------------- camera ----------------
  async function cameraTo(target, opts = {}) {
    const ms = opts.ms ?? 1150;
    let s = 1;
    let tx = 0;
    let ty = 0;
    if (target && target !== 'full') {
      const r = target.rect ?? rectOf(target, await waitFor(target));
      const pad = target.pad ?? 36;
      s = Math.max(1, Math.min(target.maxScale ?? 1.75, W / (r.w + pad * 2), (SAFE_H - TOP) / (r.h + pad * 2)));
      const cx = r.x + r.w / 2 + (target.dx ?? 0);
      const cy = r.y + r.h / 2 + (target.dy ?? 0);
      tx = Math.min(0, Math.max(W - W * s, W / 2 - s * cx));
      // Frame the target between the chapter band (top) and the caption strip (bottom).
      // The stage's empty bottom strip (112px) may slide out of frame.
      ty = Math.min(TOP, Math.max(SAFE_H - (H - 112) * s, TOP + (SAFE_H - TOP) / 2 - s * cy));
    }
    camera.style.transition = `transform ${ms}ms cubic-bezier(0.65, 0, 0.35, 1)`;
    camera.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    await sleep(ms + 60);
  }

  // ---------------- cursor ----------------
  let cur = { x: 1240, y: 620 };
  const place = (x, y) => {
    cur = { x, y };
    cursor.style.transform = `translate(${x - 3}px, ${y - 3}px)`;
  };
  place(cur.x, cur.y);
  async function showCursor(on) {
    cursor.hidden = !on;
  }
  async function moveTo(x, y, ms) {
    const from = { ...cur };
    const dist = Math.hypot(x - from.x, y - from.y);
    if (dist < 1) return;
    ms = ms ?? Math.min(1050, 420 + dist * 0.5);
    const len = dist || 1;
    const bend = Math.min(90, dist * 0.14);
    const c = { x: (from.x + x) / 2 + (-(y - from.y) / len) * bend, y: (from.y + y) / 2 + ((x - from.x) / len) * bend };
    const t0 = performance.now();
    await new Promise((res) => {
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms);
        const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
        const u = 1 - e;
        place(u * u * from.x + 2 * u * e * c.x + e * e * x, u * u * from.y + 2 * u * e * c.y + e * e * y);
        if (t < 1) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });
  }
  async function press(x, y) {
    mark('click');
    cursor.classList.add('down');
    const r = document.createElement('div');
    r.className = 'ripple';
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    overlay.append(r);
    setTimeout(() => r.remove(), 700);
    await sleep(130);
    cursor.classList.remove('down');
  }
  function fire(el, win) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, view: win, button: 0 }));
    }
  }
  async function click(t) {
    const el = await waitFor(t);
    if (t.in === 'dash' && t.scrollIntoView) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(600);
    }
    const r = rectOf(t, el);
    const x = r.x + r.w * (t.fx ?? 0.5);
    const y = r.y + r.h * (t.fy ?? 0.5);
    await moveTo(x, y);
    await sleep(120);
    await press(x, y);
    // Re-query: the dashboard re-renders on live updates.
    const target = t.in === 'dash' ? find(t) : el;
    fire(target, t.in === 'dash' ? frame.contentWindow : window);
    await sleep(t.after ?? 350);
  }
  async function openRow(a) {
    await click({ in: 'dash', sel: '#grid-invoices .ag-row', text: a.text, fx: 0.3, after: 500 });
    if (!ddoc().querySelector('#drawer.open')) {
      frame.contentWindow.postMessage({ cmd: 'openInvoice', id: a.id, reqId: -1 }, location.origin);
    }
    await waitFor({ in: 'dash', sel: '#drawer.open' });
    await sleep(450);
  }

  async function hover(t) {
    const r = rectOf(t, await waitFor(t));
    await moveTo(r.x + r.w * (t.fx ?? 0.5), r.y + r.h * (t.fy ?? 0.5));
  }

  // ---------------- highlights ----------------
  async function highlight(t) {
    const r = t.rect ?? rectOf(t, await waitFor(t));
    const pad = t.pad ?? 8;
    const el = document.createElement('div');
    el.className = `hl ${t.tone || ''} ${t.below ? 'below' : ''}`;
    Object.assign(el.style, { left: `${r.x - pad}px`, top: `${r.y - pad}px`, width: `${r.w + pad * 2}px`, height: `${r.h + pad * 2}px` });
    if (t.label) el.innerHTML = `<span class="hl-label">${esc(t.label)}</span>`;
    overlay.append(el);
    await sleep(t.hold ?? 0);
  }
  async function clearHighlights() {
    const hs = [...overlay.querySelectorAll('.hl')];
    hs.forEach((h) => h.classList.add('out'));
    await sleep(hs.length ? 300 : 0);
    hs.forEach((h) => h.remove());
  }

  // ---------------- scrolling inside the dashboard ----------------
  async function scroll(t) {
    const el = await waitFor(t);
    const to = t.to === 'top' ? 0 : t.to === 'bottom' ? el.scrollHeight - el.clientHeight : t.to;
    const from = el.scrollTop;
    const ms = t.ms ?? 900;
    const t0 = performance.now();
    await new Promise((res) => {
      const step = (now) => {
        const p = Math.min(1, (now - t0) / ms);
        const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
        el.scrollTop = from + (to - from) * e;
        if (p < 1) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });
  }

  // ---------------- chat ----------------
  const scrollChat = () => (messages.scrollTop = messages.scrollHeight);
  const md = (text) => (window.marked ? marked.parse(text, { breaks: true }) : `<p>${esc(text)}</p>`);

  async function typeTurn(i) {
    const text = transcript.turns[i].user;
    const composer = $('#composer');
    await click({ in: 'stage', sel: '#composer', fx: 0.25, after: 150 });
    composer.classList.add('focus');
    composer.innerHTML = '<span class="typed"></span><span class="caret"></span>';
    const typed = $('.typed', composer);
    for (const ch of text) {
      typed.textContent += ch;
      if (ch !== ' ') mark('key');
      $('#send').classList.add('ready');
      await sleep(ch === ' ' ? 45 : /[.,?']/.test(ch) ? 110 : 26 + Math.random() * 34);
    }
    await sleep(280);
    const send = $('#send');
    const r = stageRect(send);
    await moveTo(r.x + r.w / 2, r.y + r.h / 2);
    await press(r.x + r.w / 2, r.y + r.h / 2);
    send.classList.add('pressed');
    setTimeout(() => send.classList.remove('pressed', 'ready'), 150);
    composer.classList.remove('focus');
    composer.innerHTML = '<span class="placeholder">Reply to Claude…</span>';
    $('#empty-chat')?.remove();
    const el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML = `<div class="bubble">${esc(text)}</div>`;
    messages.append(el);
    scrollChat();
    await sleep(350);
  }

  const TOOL_TITLES = {
    scan_invoices: 'Scan invoices',
    read_invoice: 'Read invoice',
    propose_payment_batch: 'Propose payout batch',
    draft_vendor_verification: 'Draft vendor verification',
    get_batch_status: 'Check payout batch',
    reconcile_payments: 'Reconcile with PayPal',
    verify_audit_log: 'Verify audit log',
    get_payment_mandate: 'Read signed mandate',
    list_vendors: 'List verified vendors',
    payment_history: 'Payment history',
    spending_summary: 'Spending summary',
  };
  const chip = (s) => {
    const m = { CLEAR: ['ok', 'Clear'], REVIEW: ['', 'Review'], HOLD: ['bad', 'Held'], PENDING_APPROVAL: ['accent', 'Awaiting approval'], PAID: ['ok', 'Paid'], SUCCESS: ['ok', 'Paid'], SUBMITTED: ['accent', 'Sent'], PENDING: ['accent', 'Pending'] };
    const [cls, label] = m[s] || ['', s];
    return `<span class="chip ${cls}">${esc(label)}</span>`;
  };
  function renderResult(name, d, text) {
    if (!d) return `<div>${esc((text || '').split('\n')[0])}</div>`;
    switch (name) {
      case 'scan_invoices': {
        const s = d.summary;
        const rows = [...d.invoices]
          .sort((a, b) => (b.risk_status === 'HOLD') - (a.risk_status === 'HOLD'))
          .map((i) => `<div class="row">${chip(i.risk_status)}<span class="who">${esc(i.vendor || `claims to be ${i.claims_to_be || i.from}`)}${i.findings.length ? ` · <span style="color:#c0262d">${esc(i.findings[0].title)}</span>` : ''}</span><span class="amt">${esc(i.amount)}</span></div>`)
          .join('');
        return `<div class="summary">${s.total} invoices · ${s.clear} clear · ${s.hold} held · ${money(s.payable_cents)} payable</div>${rows}`;
      }
      case 'propose_payment_batch': {
        const b = d.batch;
        if (!b) return `<div class="summary">${esc(d.problem || 'No batch created')}</div>`;
        return `<div class="summary">Batch <span class="mono">${esc(b.id)}</span> · ${b.items.length} payouts · ${money(b.total_cents)} ${chip(b.status)}</div>` +
          b.checks.map((c) => `<div class="row"><span class="check">${c.ok ? '✓' : '✗'}</span><span class="who">${esc(c.label)}</span></div>`).join('');
      }
      case 'draft_vendor_verification':
        return d.to ? `<div class="summary">Draft to <span class="mono">${esc(d.to)}</span> (address on file)</div><div class="row"><span class="who">“${esc(d.subject)}”</span></div>` : `<div>${esc(d.problem)}</div>`;
      case 'get_batch_status': {
        const b = d.batch;
        return `<div class="summary">Batch <span class="mono">${esc(b.id)}</span> ${chip(b.status)} · PayPal ${esc(b.paypal_status || '')}</div>` +
          b.items.map((i) => `<div class="row">${chip(i.status)}<span class="who">${esc(i.vendor_name)} · <span class="mono">${esc(i.transaction_id || '')}</span></span><span class="amt">${money(i.amount_cents)}</span></div>`).join('');
      }
      case 'reconcile_payments':
        return `<div class="summary">${d.paid.length} paid · ${money(d.paid_total_cents)} · ${d.receipts_written.length} receipts written</div>` +
          d.paid.map((p) => `<div class="row"><span class="chip ok">Paid</span><span class="who">${esc(p.vendor)}</span><span class="amt">${money(p.amount_cents)}</span></div>`).join('');
      case 'verify_audit_log':
        return `<div class="summary">${d.ok ? '✓ Audit chain intact' : '✗ Audit chain broken'} · ${d.entries} entries</div>`;
      default:
        return `<div>${esc((text || '').split('\n')[0])}</div>`;
    }
  }

  async function toolCard(parent, block) {
    const el = document.createElement('div');
    el.className = 'tool';
    el.innerHTML = `<div class="tool-head"><span class="tool-icon">⚙</span><span class="tool-name">${esc(TOOL_TITLES[block.name] || block.name)}</span>
      <span class="tool-fn">countersign · ${esc(block.name)}</span><span class="tool-status"><span class="spinner"></span>Running</span></div>
      <div class="tool-body"><div></div></div>`;
    parent.append(el);
    scrollChat();
    let ms = 0;
    const call = (async () => {
      const t0 = performance.now();
      const r = await rpc('tools/call', { name: block.name, arguments: block.input || {} });
      ms = Math.round(performance.now() - t0);
      return r;
    })();
    const [result] = await Promise.all([call, sleep(900)]);
    const text = (result.content || []).map((c) => c.text).join('\n');
    results[block.name] = result.structuredContent;
    $('.tool-status', el).className = 'tool-status done';
    $('.tool-status', el).innerHTML = `✓ ${ms} ms`;
    $('.tool-body > div', el).innerHTML = renderResult(block.name, result.structuredContent, text);
    requestAnimationFrame(() => $('.tool-body', el).classList.add('open'));
    for (const step of [100, 250, 450]) setTimeout(scrollChat, step);
    await sleep(650);
  }

  async function streamText(parent, text) {
    const div = document.createElement('div');
    div.className = 'md';
    parent.append(div);
    const parts = text.split(/(\s+)/);
    let shown = '';
    for (const p of parts) {
      shown += p;
      if (p.trim()) {
        div.innerHTML = md(shown);
        scrollChat();
        await sleep(24);
      }
    }
    div.innerHTML = md(text);
    scrollChat();
  }

  async function claudeTurn(i) {
    const turn = transcript.turns[i];
    const msg = document.createElement('div');
    msg.className = 'msg assistant';
    msg.innerHTML = '<div class="avatar">✳</div><div class="a-body"><div class="thinking"><span class="shimmer">Thinking…</span></div></div>';
    messages.append(msg);
    scrollChat();
    const body = $('.a-body', msg);
    await sleep(1100);
    $('.thinking', body).remove();
    for (const block of turn.blocks) {
      if (block.type === 'tool') await toolCard(body, block);
      else await streamText(body, block.text);
    }
    // Ids in Claude's captured text must match what the live replay produced.
    const said = turn.blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    const liveId = results.propose_payment_batch?.batch?.id;
    const mentioned = said.match(/CS-\d{8}-[0-9A-F]{4}/g) || [];
    for (const id of mentioned) if (liveId && id !== liveId) warnings.push(`turn ${i + 1} mentions ${id} but replay created ${liveId}`);
    await sleep(300);
  }

  // ---------------- title cards, chapters, captions ----------------
  function countUp(el, value) {
    const m = String(value).match(/^(\d+)(.*)$/);
    if (!m) return void (el.textContent = value);
    const target = Number(m[1]);
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 1100);
      el.textContent = `${Math.round(target * (1 - (1 - p) ** 3))}${m[2]}`;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function showTitle(a) {
    const card = $('#title-card');
    const inner = $('#title-inner');
    const parts = [];
    let delay = 0.15;
    const d = () => `style="animation-delay:${(delay += 0.18).toFixed(2)}s"`;
    if (a.logo) parts.push(`<svg class="big-logo" viewBox="0 0 32 32" ${d()}><rect width="32" height="32" rx="8"/><path d="M8 17l5 5 11-12"/></svg>`);
    if (a.kicker) parts.push(`<div class="kicker" ${d()}>${esc(a.kicker)}</div>`);
    if (a.title) {
      const lines = a.title.split('\n').map((l, i) => `<span class="line" style="animation-delay:${(delay + 0.2 + i * 0.55).toFixed(2)}s">${esc(l)}</span>`);
      parts.push(`<h1 style="opacity:1;animation:none">${lines.join('')}</h1>`);
      delay += 0.2 + (a.title.split('\n').length - 1) * 0.55;
    }
    if (a.subtitle) parts.push(`<p class="sub" ${d()}>${esc(a.subtitle)}</p>`);
    if (a.fact) parts.push(`<div class="fact" ${d()}><b>${esc(a.fact.value)}</b><span>${esc(a.fact.label)}</span></div>`);
    if (a.stats) {
      parts.push(`<div class="stats" style="opacity:1;animation:none">${a.stats.map((s, i) => `<div class="stat" style="animation-delay:${(delay + 0.3 + i * 0.25).toFixed(2)}s"><div class="v" data-v="${esc(s.value)}">0</div><div class="l">${esc(s.label)}</div></div>`).join('')}</div>`);
      delay += 0.3 + a.stats.length * 0.25;
    }
    if (a.footer) parts.push(`<div class="t-footer" ${d()}>${esc(a.footer)}</div>`);
    inner.innerHTML = parts.join('');
    card.classList.remove('leaving');
    card.hidden = false;
    inner.querySelectorAll('.stat .v').forEach((v, i) => setTimeout(() => countUp(v, v.dataset.v), 600 + i * 250));
  }
  async function hideTitle() {
    const card = $('#title-card');
    if (card.hidden) return;
    card.classList.add('leaving');
    await sleep(700);
    card.hidden = true;
  }
  function chapter(a) {
    const el = $('#chapter');
    if (!a.n) {
      el.hidden = true;
      return;
    }
    $('#chapter-num').textContent = a.n;
    $('#chapter-text').textContent = a.text;
    el.hidden = true;
    el.classList.remove('gone');
    void el.offsetWidth;
    el.hidden = false;
    clearTimeout(chapter.timer);
    chapter.timer = setTimeout(() => el.classList.add('gone'), 3600);
  }
  async function captions(text, durationMs) {
    const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text];
    const total = sentences.reduce((s, x) => s + x.length, 0);
    for (const s of sentences) {
      $('#caption').textContent = s.trim();
      await sleep((durationMs * s.length) / total);
    }
  }

  async function waitPaid(timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const st = await (await fetch('/api/state')).json();
      const b = st.batches.find((x) => x.status !== 'PENDING_APPROVAL' && x.created_by !== 'imported');
      if (b?.status === 'PAID') return;
      await sleep(300);
    }
    warnings.push('payout batch did not reach PAID in time');
  }

  async function run(a) {
    switch (a.type) {
      case 'title': return showTitle(a);
      case 'hideTitle': return hideTitle();
      case 'chapter': return chapter(a);
      case 'cursor': return showCursor(a.show);
      case 'camera': return cameraTo(a.target, a);
      case 'click': return click(a);
      case 'hover': return hover(a);
      case 'openRow': return openRow(a);
      case 'highlight': return highlight(a);
      case 'clearHighlights': return clearHighlights();
      case 'scroll': return scroll(a);
      case 'type': return typeTurn(a.turn);
      case 'claude': return claudeTurn(a.turn);
      case 'waitPaid': return waitPaid();
      case 'wait': return sleep(a.ms);
      case 'parallel': return Promise.all(a.actions.map(run));
      default: throw new Error(`Unknown action ${a.type}`);
    }
  }

  const frameReady = new Promise((resolve) => {
    const check = () => frame.contentWindow?.location.pathname === '/' && frame.contentDocument?.readyState === 'complete';
    if (check()) resolve();
    frame.addEventListener('load', () => resolve(), { once: true });
  });

  /** Plays all scenes; returns scene start times so the recorder can lay narration under them. */
  window.runDemo = async (scenes, opts) => {
    transcript = opts.transcript;
    $('#tag').textContent = opts.tag || '';
    $('#model').textContent = `Claude · ${transcript.model}`;
    await frameReady;
    await waitFor({ in: 'dash', sel: '#tabs a[data-tab="mandate"]' }, 15000);
    await sleep(1200);
    await connect();
    const t0 = performance.now();
    T0 = t0;
    const timeline = [];
    for (const [i, scene] of scenes.entries()) {
      const start = performance.now() - t0;
      const audioMs = scene.audioMs || Math.max(2500, scene.narration.split(/\s+/).length * 330);
      const actions = (async () => {
        for (const a of scene.actions) await run(a);
      })().catch((err) => warnings.push(`scene ${scene.id}: ${err.message}`));
      await Promise.all([actions, captions(scene.narration, audioMs), sleep(audioMs + 500)]);
      timeline.push({ index: i, id: scene.id, start, end: performance.now() - t0 });
    }
    $('#caption').textContent = '';
    return { startedAt: performance.timeOrigin + t0, timeline, durationMs: performance.now() - t0, warnings, sfx };
  };

  if (new URLSearchParams(location.search).has('autoplay')) {
    fetch('/demo/scenes.json')
      .then((r) => r.json())
      .then((s) => window.runDemo(s.scenes, s))
      .catch((err) => ($('#caption').textContent = `Could not start: ${err.message}. Run npm run demo:record once first.`));
  }
})();
