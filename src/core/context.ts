import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { type Config, loadConfig } from '../config.js';
import { MockPayPal } from '../paypal/mock.js';
import { RestPayPal } from '../paypal/rest.js';
import type { PayPalClient } from '../paypal/types.js';
import { AuditLog } from './audit.js';
import { type DB, openDb } from './db.js';
import { applyWebhookEvent } from './payments.js';
import { setDeterministic } from './util.js';

export interface AppContext {
  config: Config;
  db: DB;
  audit: AuditLog;
  paypal: PayPalClient;
  bus: EventEmitter;
  mandateKey: string;
  inboxDir: string;
  receiptsDir: string;
}

function loadOrCreateKey(file: string): string {
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const key = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

export function createContext(config: Config = loadConfig()): AppContext {
  if (config.fixedIdSeed !== undefined) setDeterministic(config.fixedIdSeed);
  const inboxDir = path.join(config.dataDir, 'inbox');
  const receiptsDir = path.join(config.dataDir, 'receipts');
  for (const d of [config.dataDir, inboxDir, receiptsDir]) fs.mkdirSync(d, { recursive: true });

  const db = openDb(path.join(config.dataDir, 'countersign.db'));
  const bus = new EventEmitter();
  bus.setMaxListeners(200);
  const paypal = config.mode === 'mock' ? new MockPayPal(db, config.mockSettleMs) : new RestPayPal(config);

  const ctx: AppContext = {
    config,
    db,
    audit: new AuditLog(db),
    paypal,
    bus,
    mandateKey: config.mandateSigningKey ?? loadOrCreateKey(path.join(config.dataDir, '.mandate-key')),
    inboxDir,
    receiptsDir,
  };

  if (paypal instanceof MockPayPal) {
    paypal.onEvent = (event) => {
      try {
        applyWebhookEvent(ctx, event, 'paypal (mock webhook)');
      } catch (err) {
        console.error('[countersign] mock webhook failed', err);
      }
    };
  }
  return ctx;
}
