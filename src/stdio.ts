#!/usr/bin/env node
/**
 * stdio entry point for Claude Desktop / Claude Code:
 *   { "command": "node", "args": ["/abs/path/countersign/dist/stdio.js"] }
 * It also starts the approval dashboard on PORT if nothing else is using it.
 * Everything is logged to stderr; stdout carries only MCP messages.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContext } from './core/context.js';
import { listVendors } from './core/repo.js';
import { seedDemo } from './core/seed.js';
import { startHttpServer } from './http.js';
import { createMcpServer } from './mcp/server.js';

const ctx = createContext();
if (ctx.config.seedOnStart && listVendors(ctx.db).length === 0) seedDemo(ctx);

await createMcpServer(ctx).connect(new StdioServerTransport());
console.error(`[countersign] MCP server on stdio (PayPal ${ctx.config.mode})`);

if (process.env.DASHBOARD_WITH_STDIO !== 'false') {
  const http = await startHttpServer(ctx, { mcp: false, quietIfBusy: true }).catch(() => null);
  console.error(http ? `[countersign] dashboard at ${ctx.config.publicUrl}` : `[countersign] dashboard port ${ctx.config.port} busy; assuming it is already running`);
}
