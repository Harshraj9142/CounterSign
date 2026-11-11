import type { DB } from './db.js';
import { canonicalJson, nowIso, sha256 } from './util.js';

export const GENESIS = '0'.repeat(64);

export interface AuditEntry {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  data: string;
  prev_hash: string;
  hash: string;
}

export interface AuditVerification {
  ok: boolean;
  entries: number;
  head: string;
  broken_at?: number;
  reason?: string;
}

function entryHash(prev: string, seq: number, ts: string, actor: string, action: string, data: string): string {
  return sha256([prev, seq, ts, actor, action, data].join('|'));
}

/**
 * Append-only, hash-chained log. Each entry commits to the previous entry's hash,
 * so editing or deleting any past entry breaks every hash after it.
 * (Tamper-evident, not tamper-proof: receipts also record the head hash, which
 * anchors the chain outside the database.)
 */
export class AuditLog {
  constructor(private db: DB) {}

  append(actor: string, action: string, data: unknown = {}): AuditEntry {
    const payload = canonicalJson(data);
    for (let attempt = 0; ; attempt++) {
      try {
        const last = this.db.prepare('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1').get() as
          | { seq: number; hash: string }
          | undefined;
        const seq = (last?.seq ?? 0) + 1;
        const prev = last?.hash ?? GENESIS;
        const ts = nowIso();
        const hash = entryHash(prev, seq, ts, actor, action, payload);
        this.db
          .prepare('INSERT INTO audit (seq, ts, actor, action, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(seq, ts, actor, action, payload, prev, hash);
        return { seq, ts, actor, action, data: payload, prev_hash: prev, hash };
      } catch (err) {
        // Another process appended at the same moment: retry against the new head.
        if (attempt < 5 && /UNIQUE|constraint/i.test(String(err))) continue;
        throw err;
      }
    }
  }

  list(limit = 500): AuditEntry[] {
    return this.db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(limit) as unknown as AuditEntry[];
  }

  head(): string {
    return ((this.db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined)?.hash) ?? GENESIS;
  }

  verify(): AuditVerification {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY seq ASC').all() as unknown as AuditEntry[];
    let prev = GENESIS;
    let expectedSeq = 1;
    for (const r of rows) {
      if (r.seq !== expectedSeq) return { ok: false, entries: rows.length, head: prev, broken_at: r.seq, reason: `entry ${expectedSeq} is missing` };
      if (r.prev_hash !== prev) return { ok: false, entries: rows.length, head: prev, broken_at: r.seq, reason: 'prev_hash does not match the previous entry' };
      const h = entryHash(prev, r.seq, r.ts, r.actor, r.action, r.data);
      if (h !== r.hash) return { ok: false, entries: rows.length, head: prev, broken_at: r.seq, reason: 'entry contents were modified' };
      prev = r.hash;
      expectedSeq++;
    }
    return { ok: true, entries: rows.length, head: prev };
  }
}
