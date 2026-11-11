import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import path from 'node:path';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { projectRoot } from './config.js';
import type { AppContext } from './core/context.js';
import { mandateStatus, signAndStoreMandate } from './core/mandate.js';
import { approveBatch, batchView, expireStale, reconcile, refreshBatch, rejectBatch, retryBatch, applyWebhookEvent } from './core/payments.js';
import * as repo from './core/repo.js';
import { scanInbox } from './core/scan.js';
import { seedDemo } from './core/seed.js';
import type { Vendor } from './core/types.js';
import { nowIso, parseMoney, safeEqual } from './core/util.js';
import { createMcpServer } from './mcp/server.js';

const COOKIE = 'cs_session';

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

const owner = (ctx: AppContext) => repo.kvGet(ctx.db, 'owner_name') ?? 'Owner';

export function dashboardState(ctx: AppContext) {
  expireStale(ctx);
  const st = mandateStatus(ctx);
  return {
    business: ctx.config.businessName,
    owner: owner(ctx),
    mode: ctx.paypal.mode,
    demo_mode: ctx.config.demoMode,
    public_url: ctx.config.publicUrl,
    mandate: st,
    vendors: repo.listVendors(ctx.db),
    invoices: repo
      .listInvoices(ctx.db)
      .filter((i) => i.file)
      .map(({ raw: _raw, visible_text: _v, ...rest }) => rest),
    batches: repo.listBatches(ctx.db, 50).map((b) => batchView(ctx, b.id)),
    audit: { head: ctx.audit.head(), entries: (ctx.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n },
  };
}

export function createApp(ctx: AppContext, opts: { mcp: boolean }): express.Express {
  const app = createMcpExpressApp({ host: ctx.config.host });
  const { dashboardToken, mcpToken } = ctx.config;

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, mode: ctx.paypal.mode });
  });

  // ---------- PayPal webhooks ----------
  app.post('/webhooks/paypal', async (req, res) => {
    if (ctx.paypal.mode === 'mock') {
      res.status(404).json({ error: 'In mock mode, webhook events are delivered in-process.' });
      return;
    }
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    const verified = await ctx.paypal.verifyWebhook(headers, req.body).catch(() => false);
    if (!verified) {
      ctx.audit.append('unknown', 'webhook.rejected', { event_id: req.body?.id ?? null, reason: 'signature verification failed' });
      res.status(400).json({ error: 'Webhook signature verification failed.' });
      return;
    }
    const r = applyWebhookEvent(ctx, req.body, 'paypal (webhook)');
    // Batch-level events carry no item details, so pull them from the Payouts API.
    if (r.batch_id && String(req.body?.event_type).startsWith('PAYMENT.PAYOUTSBATCH.')) {
      refreshBatch(ctx, r.batch_id).catch((err) => console.error('[countersign] refresh after webhook:', err.message ?? err));
    }
    res.json({ received: true, ...r });
  });

  // ---------- MCP over Streamable HTTP ----------
  if (opts.mcp) {
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const mcpAuth = (req: Request, res: Response, next: NextFunction) => {
      if (!mcpToken) return next();
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (safeEqual(bearer, mcpToken) || safeEqual(String(req.query.token ?? ''), mcpToken)) return next();
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    };
    app.post('/mcp', mcpAuth, async (req, res) => {
      const sid = req.headers['mcp-session-id'] as string | undefined;
      let transport = sid ? transports.get(sid) : undefined;
      if (!transport) {
        if (sid || !isInitializeRequest(req.body)) {
          res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid MCP session. Send an initialize request first.' }, id: null });
          return;
        }
        const t = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, t);
          },
        });
        t.onclose = () => {
          if (t.sessionId) transports.delete(t.sessionId);
        };
        await createMcpServer(ctx).connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res, req.body);
    });
    const sessionRequest = async (req: Request, res: Response) => {
      const t = transports.get(req.headers['mcp-session-id'] as string);
      if (!t) {
        res.status(400).send('Unknown MCP session');
        return;
      }
      await t.handleRequest(req, res);
    };
    app.get('/mcp', mcpAuth, sessionRequest);
    app.delete('/mcp', mcpAuth, sessionRequest);
  }

  // ---------- dashboard auth ----------
  app.get('/login', (_req, res) => {
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Countersign login</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f6f8">
<form method="post" action="/login" style="background:#fff;padding:28px;border-radius:12px;box-shadow:0 2px 12px #0001;display:grid;gap:12px;width:min(320px,90vw)">
<strong>Countersign dashboard</strong><input name="token" type="password" placeholder="Dashboard token" autofocus style="padding:10px;border:1px solid #ccd;border-radius:8px">
<button style="padding:10px;border:0;border-radius:8px;background:#4338ca;color:#fff;font-weight:600">Sign in</button></form></body>`);
  });
  app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    if (dashboardToken && safeEqual(String(req.body?.token ?? ''), dashboardToken)) {
      const secure = ctx.config.publicUrl.startsWith('https') ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(dashboardToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
      res.redirect('/');
      return;
    }
    res.redirect('/login');
  });
  app.use((req, res, next) => {
    if (!dashboardToken) return next();
    if (safeEqual(readCookie(req, COOKIE), dashboardToken)) return next();
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Sign in at /login' });
      return;
    }
    res.redirect('/login');
  });
  // Cross-site request forgery guard: browsers can't add custom headers cross-origin without CORS.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.headers['x-countersign'] !== '1') {
      res.status(403).json({ error: 'Missing x-countersign header' });
      return;
    }
    next();
  });

  // ---------- dashboard API ----------
  app.get('/api/state', (_req, res) => {
    res.json(dashboardState(ctx));
  });

  app.get('/api/invoices/:id', (req, res) => {
    const inv = repo.getInvoice(ctx.db, req.params.id);
    if (!inv) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(inv);
  });

  app.get('/api/audit', (_req, res) => {
    res.json({ entries: ctx.audit.list(500), verification: ctx.audit.verify() });
  });

  app.post('/api/scan', (_req, res) => {
    scanInbox(ctx, { actor: `${owner(ctx)} (dashboard)` });
    res.json({ ok: true });
  });

  app.post('/api/batches/:id/approve', async (req, res) => {
    const view = await approveBatch(ctx, req.params.id, `${owner(ctx)} (dashboard)`, 'dashboard');
    res.json(view);
  });

  app.post('/api/batches/:id/reject', (req, res) => {
    res.json(rejectBatch(ctx, req.params.id, `${owner(ctx)} (dashboard)`, String(req.body?.reason ?? 'Rejected in dashboard')));
  });

  app.post('/api/batches/:id/refresh', async (req, res) => {
    res.json((await refreshBatch(ctx, req.params.id)).view);
  });

  app.post('/api/batches/:id/retry', async (req, res) => {
    res.json(await retryBatch(ctx, req.params.id, `${owner(ctx)} (dashboard)`));
  });

  app.post('/api/reconcile', async (_req, res) => {
    res.json(await reconcile(ctx, `${owner(ctx)} (dashboard)`));
  });

  // Vendor onboarding and payout-account changes are human-only (no MCP tool).
  app.post('/api/vendors', (req, res) => {
    const b = req.body ?? {};
    const required = ['name', 'contact_email', 'payout_email', 'rate_type', 'category', 'verified_via'];
    const missing = required.filter((k) => !String(b[k] ?? '').trim());
    if (missing.length) {
      res.status(400).json({ error: `Missing: ${missing.join(', ')}` });
      return;
    }
    const id = String(b.id || b.name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const before = repo.getVendor(ctx.db, id);
    const contact = String(b.contact_email).trim().toLowerCase();
    const v: Vendor = {
      id,
      name: String(b.name).trim(),
      contact_email: contact,
      domain: String(b.domain || contact.split('@')[1] || '').toLowerCase(),
      payout_email: String(b.payout_email).trim().toLowerCase(),
      rate_type: b.rate_type === 'fixed' ? 'fixed' : 'hourly',
      rate_cents: b.rate_type === 'fixed' ? null : parseMoney(String(b.rate ?? '0')),
      fixed_fee_cents: b.rate_type === 'fixed' ? parseMoney(String(b.fixed_fee ?? '0')) : null,
      monthly_cap_cents: parseMoney(String(b.monthly_cap ?? '5000')),
      category: String(b.category).trim().toLowerCase(),
      verified_via: String(b.verified_via).trim(),
      verified_at: nowIso(),
      created_at: before?.created_at ?? nowIso(),
    };
    repo.upsertVendor(ctx.db, v);
    ctx.audit.append(`${owner(ctx)} (dashboard)`, before ? 'vendor.updated' : 'vendor.verified', {
      vendor_id: id,
      payout_email: v.payout_email,
      previous_payout_email: before?.payout_email ?? null,
      verified_via: v.verified_via,
    });
    scanInbox(ctx, { quiet: true });
    res.json(v);
  });

  app.post('/api/mandate', (req, res) => {
    const b = req.body ?? {};
    const cur = mandateStatus(ctx).mandate?.terms;
    const cents = (k: string, fallback: number) => (b[k] != null && b[k] !== '' ? parseMoney(String(b[k])) : fallback);
    const m = signAndStoreMandate(ctx, {
      issuer: cur?.issuer ?? owner(ctx),
      business: ctx.config.businessName,
      purpose: String(b.purpose ?? cur?.purpose ?? 'Contractor payouts'),
      currency: 'USD',
      max_per_payment_cents: cents('max_per_payment', cur?.max_per_payment_cents ?? 500000),
      max_per_batch_cents: cents('max_per_batch', cur?.max_per_batch_cents ?? 1500000),
      monthly_budget_cents: cents('monthly_budget', cur?.monthly_budget_cents ?? 2000000),
      allowed_categories: cur?.allowed_categories ?? [],
      registered_vendors_only: true,
      human_approval_required: true,
      valid_from: cur?.valid_from ?? nowIso(),
      valid_until: b.valid_until ? new Date(String(b.valid_until)).toISOString() : (cur?.valid_until ?? new Date(Date.now() + 180 * 86400_000).toISOString()),
    }, `${owner(ctx)} (dashboard)`);
    scanInbox(ctx, { quiet: true });
    res.json(m);
  });

  app.post('/api/demo/reset', (_req, res) => {
    if (!ctx.config.demoMode) {
      res.status(403).json({ error: 'Demo reset is only available with DEMO_MODE=true.' });
      return;
    }
    seedDemo(ctx);
    res.json({ ok: true });
  });

  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    ctx.bus.on('change', send);
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
    req.on('close', () => {
      ctx.bus.off('change', send);
      clearInterval(keepAlive);
    });
  });

  app.use(express.static(path.join(projectRoot, 'public'), { extensions: ['html'] }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  });
  return app;
}

/** Polls PayPal for in-flight batches, as a fallback when webhooks can't reach us (e.g. localhost). */
function startPoller(ctx: AppContext): NodeJS.Timeout {
  return setInterval(async () => {
    for (const b of repo.listBatches(ctx.db, 50).filter((x) => x.status === 'SUBMITTED' && x.paypal_batch_id)) {
      await refreshBatch(ctx, b.id).catch((err) => console.error(`[countersign] status poll ${b.id}:`, err.message ?? err));
    }
  }, ctx.paypal.mode === 'mock' ? 5_000 : 20_000).unref();
}

export function startHttpServer(ctx: AppContext, opts: { mcp: boolean; quietIfBusy?: boolean }): Promise<http.Server | null> {
  const app = createApp(ctx, opts);
  return new Promise((resolve, reject) => {
    const server = app.listen(ctx.config.port, ctx.config.host);
    server.once('listening', () => {
      startPoller(ctx);
      resolve(server);
    });
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (opts.quietIfBusy && err.code === 'EADDRINUSE') resolve(null);
      else reject(err);
    });
  });
}
