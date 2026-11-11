/**
 * HTTP entry point: approval dashboard + MCP (Streamable HTTP at /mcp) + PayPal webhooks.
 *   npm run build && npm start      (or: npm run dev)
 */
import { createContext } from './core/context.js';
import { listVendors } from './core/repo.js';
import { seedDemo } from './core/seed.js';
import { startHttpServer } from './http.js';

const ctx = createContext();
if (ctx.config.seedOnStart && listVendors(ctx.db).length === 0) seedDemo(ctx);

await startHttpServer(ctx, { mcp: true });
const { publicUrl, mode, dashboardToken, mcpToken } = ctx.config;
console.log(`Countersign running (PayPal ${mode})`);
console.log(`  Dashboard: ${publicUrl}/${dashboardToken ? '  (sign in with DASHBOARD_TOKEN)' : ''}`);
console.log(`  MCP:       ${publicUrl}/mcp${mcpToken ? '  (Authorization: Bearer MCP_TOKEN)' : ''}`);
if (mode !== 'mock') console.log(`  Webhooks:  ${publicUrl}/webhooks/paypal`);
if (!listVendors(ctx.db).length) console.log('  No data yet: run `npm run seed` or set SEED_ON_START=true.');
