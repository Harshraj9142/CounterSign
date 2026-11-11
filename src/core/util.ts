import crypto from 'node:crypto';

// Optional seeded randomness so demo recordings can be replayed with identical ids.
let prng: (() => number) | null = null;
export function setDeterministic(seed: number): void {
  let a = seed >>> 0;
  prng = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function randomBytes(n: number): Buffer {
  return prng ? Buffer.from(Array.from({ length: n }, () => Math.floor(prng!() * 256))) : crypto.randomBytes(n);
}
export const randomHex = (bytes: number): string => randomBytes(bytes).toString('hex').toUpperCase();

/** Deterministic JSON (sorted keys) so hashes and signatures are stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/** "3,230.00" -> 323000 (integer cents). Returns NaN when unparseable. */
export function parseMoney(s: string): number {
  const n = Number(s.replace(/[,$\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

export function fmtMoney(cents: number, currency = 'USD'): string {
  const sign = cents < 0 ? '-' : '';
  const s = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'USD' ? `${sign}$${s}` : `${sign}${s} ${currency}`;
}

export const centsToValue = (cents: number): string => (cents / 100).toFixed(2);

export const nowIso = (): string => new Date().toISOString();

export const monthOf = (d: Date | string = new Date()): string =>
  (typeof d === 'string' ? d : d.toISOString()).slice(0, 7);

export function periodLabel(period: string | null | undefined): string {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return period ?? 'unknown period';
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function batchId(): string {
  const ymd = process.env.DEMO_ID_DATE ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `CS-${ymd}-${randomHex(2)}`;
}

export function randomToken(len = 13): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
