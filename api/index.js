// Vercel entry point. It serves the same Express app as `npm start`, but exported
// as a request handler instead of listening on a port. Code comes from dist/,
// which the build command (`npm run build`) produces before Vercel packages this.
import { createContext } from '../dist/core/context.js';
import { listVendors } from '../dist/core/repo.js';
import { seedDemo } from '../dist/core/seed.js';
import { createApp } from '../dist/http.js';

// Defaults that suit Vercel. Values set in the Vercel dashboard win.
// HOST: with 127.0.0.1 the MCP SDK only accepts localhost Host headers.
process.env.HOST ??= '0.0.0.0';
// Only /tmp is writable on Vercel, and it is wiped when an instance is recycled.
process.env.DATA_DIR ??= '/tmp/countersign';
if (!process.env.PUBLIC_URL && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
  process.env.PUBLIC_URL = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
}

const ctx = createContext();
if (ctx.config.seedOnStart && listVendors(ctx.db).length === 0) seedDemo(ctx);

export default createApp(ctx, { mcp: true });
