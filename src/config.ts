import fs from 'node:fs';
import path from 'node:path';

/** Repository root (works from both src/ via tsx and dist/ after build). */
export const projectRoot = path.resolve(import.meta.dirname, '..');

// Load .env from the project root, so the stdio server works no matter which
// directory Claude Desktop launches it from. Existing env vars win.
const envFile = process.env.ENV_FILE ?? path.join(projectRoot, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export type PayPalMode = 'mock' | 'sandbox' | 'live';

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  mode: PayPalMode;
  paypalClientId?: string;
  paypalClientSecret?: string;
  paypalWebhookId?: string;
  dashboardToken?: string;
  mcpToken?: string;
  mandateSigningKey?: string;
  seedOnStart: boolean;
  demoMode: boolean;
  sandboxRecipients: string[];
  mockSettleMs: number;
  businessName: string;
  /** Ask the user to approve in chat when the MCP client supports elicitation. */
  elicitation: boolean;
  /** Seed for reproducible ids (demo recordings only). */
  fixedIdSeed?: number;
}

const env = (k: string): string | undefined => {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
};

function resolveMode(): PayPalMode {
  const explicit = env('PAYPAL_MODE')?.toLowerCase();
  if (explicit === 'mock' || explicit === 'sandbox' || explicit === 'live') return explicit;
  if (explicit) throw new Error(`PAYPAL_MODE must be mock, sandbox or live (got "${explicit}").`);
  return env('PAYPAL_CLIENT_ID') ? 'sandbox' : 'mock';
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const port = Number(overrides.port ?? env('PORT') ?? 3000);
  const cfg: Config = {
    port,
    host: env('HOST') ?? '127.0.0.1',
    publicUrl: (env('PUBLIC_URL') ?? env('RENDER_EXTERNAL_URL') ?? `http://localhost:${port}`).replace(/\/$/, ''),
    dataDir: path.resolve(projectRoot, env('DATA_DIR') ?? 'data'),
    mode: overrides.mode ?? resolveMode(),
    paypalClientId: env('PAYPAL_CLIENT_ID'),
    paypalClientSecret: env('PAYPAL_CLIENT_SECRET'),
    paypalWebhookId: env('PAYPAL_WEBHOOK_ID'),
    dashboardToken: env('DASHBOARD_TOKEN'),
    mcpToken: env('MCP_TOKEN'),
    mandateSigningKey: env('MANDATE_SIGNING_KEY'),
    seedOnStart: env('SEED_ON_START') === 'true',
    demoMode: env('DEMO_MODE') === 'true',
    sandboxRecipients: (env('SANDBOX_RECIPIENTS') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    mockSettleMs: Number(env('MOCK_SETTLE_MS') ?? 2500),
    businessName: env('BUSINESS_NAME') ?? 'Larkspur Studio',
    elicitation: env('DISABLE_ELICITATION') !== 'true',
    fixedIdSeed: env('DEMO_FIXED_ID_SEED') ? Number(env('DEMO_FIXED_ID_SEED')) : undefined,
    ...overrides,
  };

  if (cfg.mode === 'live' && env('ALLOW_LIVE') !== 'true') {
    throw new Error('Refusing to start in live mode. Set ALLOW_LIVE=true only if you really intend to move real money.');
  }
  if (cfg.mode !== 'mock' && (!cfg.paypalClientId || !cfg.paypalClientSecret)) {
    throw new Error(`PAYPAL_MODE=${cfg.mode} needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (see .env.example).`);
  }
  return cfg;
}
