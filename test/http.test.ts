import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../src/http.js';
import * as repo from '../src/core/repo.js';
import { testContext, waitFor } from './helpers.js';

test('HTTP: MCP over Streamable HTTP + dashboard approval + auth', async () => {
  const ctx = testContext();
  ctx.config.dashboardToken = 'dash-secret';
  ctx.config.mcpToken = 'mcp-secret';
  const server = (await startHttpServer(ctx, { mcp: true }))!;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // MCP requires the bearer token.
    const denied = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    assert.equal(denied.status, 401);

    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: 'Bearer mcp-secret' } } }));
    const prop = (await client.callTool({ name: 'propose_payment_batch', arguments: { invoice_ids: ['oct-priya', 'oct-sam'] } })) as any;
    const batchId = prop.structuredContent.batch.id;
    assert.equal(prop.structuredContent.batch.status, 'PENDING_APPROVAL');
    await client.close();

    // Dashboard API needs the session cookie...
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    const cookie = `cs_session=dash-secret`;
    const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
    assert.equal(state.batches[0].id, batchId);

    // ...and the anti-CSRF header for state changes.
    const noHeader = await fetch(`${base}/api/batches/${batchId}/approve`, { method: 'POST', headers: { cookie } });
    assert.equal(noHeader.status, 403);

    const approve = await fetch(`${base}/api/batches/${batchId}/approve`, { method: 'POST', headers: { cookie, 'x-countersign': '1' } });
    assert.equal(approve.status, 200);
    await waitFor(() => repo.getBatch(ctx.db, batchId)!.status === 'PAID');

    // Webhooks are refused from the network in mock mode.
    assert.equal((await fetch(`${base}/webhooks/paypal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});
