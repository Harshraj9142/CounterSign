/**
 * Captures a REAL Claude conversation with the Countersign MCP server, for the demo video.
 * Runs the Claude Code CLI headless (--print, stream-json) against a fresh demo server with
 * only Countersign's tools available, approves the batch in between (as the human would),
 * and writes demo/transcript.json. `npm run demo:record` then replays it on screen.
 *
 *   npm run demo:capture        # CLAUDE_BIN=/path/to/claude if it's not on PATH
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const port = 4330;
const base = `http://localhost:${port}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'countersign-capture-'));
const idSeed = 42;
const idDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');

export const USER_TURNS = [
  "It's month-end. Can you pay October's freelancer invoices?",
  "Yes, pay the four clear ones. And draft a note to Jake's real address so we can check.",
  'Did everyone get paid?',
];

const SYSTEM_PROMPT = [
  'You are Claude, an AI assistant, chatting with Maya Chen, owner of Larkspur Studio, a small design studio that pays six freelancers every month.',
  'You have the Countersign MCP tools for paying contractors through PayPal Payouts under her signed spending mandate.',
  'You are replying in a chat window, so keep each reply short and conversational: under about 110 words, plain sentences or a few brief bullets, no headings and no tables.',
  `Today is ${new Date().toDateString()}.`,
].join(' ');

function findClaude(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    return execFileSync('which', ['claude']).toString().trim();
  } catch {
    const ext = path.join(os.homedir(), '.vscode', 'extensions');
    const dirs = fs.existsSync(ext) ? fs.readdirSync(ext).filter((d) => d.startsWith('anthropic.claude-code-')).sort().reverse() : [];
    for (const d of dirs) {
      const bin = path.join(ext, d, 'resources', 'native-binary', 'claude');
      if (fs.existsSync(bin)) return bin;
    }
  }
  throw new Error('Claude Code CLI not found. Install it or set CLAUDE_BIN.');
}

type Block = { type: 'text'; text: string } | { type: 'tool'; name: string; input: Record<string, unknown>; is_error?: boolean };
interface Turn { user: string; blocks: Block[]; duration_ms?: number }

function runTurn(bin: string, prompt: string, mcpConfig: string, sessionId?: string): Promise<{ events: any[]; sessionId: string }> {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--tools', '',
    '--allowedTools', 'mcp__countersign',
    '--permission-mode', 'dontAsk',
    '--disable-slash-commands',
    '--setting-sources', '',
    '--system-prompt', SYSTEM_PROMPT,
    ...(sessionId ? ['--resume', sessionId] : []),
  ];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDECODE') && !k.startsWith('CLAUDE_CODE_')));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), 5 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const events = out.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
      const result = events.find((e) => e.type === 'result');
      if (code !== 0 || !result || result.is_error) return reject(new Error(`claude exited ${code}: ${err.slice(0, 800)} ${result?.result ?? ''}`));
      resolve({ events, sessionId: result.session_id });
    });
  });
}

function toTurn(user: string, events: any[]): Turn {
  const blocks: Block[] = [];
  const errors = new Set(
    events.filter((e) => e.type === 'user').flatMap((e) => e.message?.content ?? []).filter((c: any) => c.type === 'tool_result' && c.is_error).map((c: any) => c.tool_use_id),
  );
  for (const e of events.filter((x) => x.type === 'assistant')) {
    for (const c of e.message?.content ?? []) {
      if (c.type === 'text' && c.text.trim()) blocks.push({ type: 'text', text: c.text.trim() });
      if (c.type === 'tool_use') blocks.push({ type: 'tool', name: String(c.name).replace(/^mcp__countersign__/, ''), input: c.input ?? {}, is_error: errors.has(c.id) || undefined });
    }
  }
  return { user, blocks, duration_ms: events.find((e) => e.type === 'result')?.duration_ms };
}

const server = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'server.ts')], {
  cwd: root,
  env: {
    ...process.env, DATA_DIR: path.join(work, 'data'), PAYPAL_MODE: 'mock', PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: base,
    DEMO_MODE: 'true', SEED_ON_START: 'true', MOCK_SETTLE_MS: '1700', DASHBOARD_TOKEN: '', MCP_TOKEN: '', SANDBOX_RECIPIENTS: '',
    DISABLE_ELICITATION: 'true', DEMO_FIXED_ID_SEED: String(idSeed), DEMO_ID_DATE: idDate,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => !String(d).includes('ExperimentalWarning') && process.stderr.write(d));
await new Promise((r) => server.stdout.once('data', r));

try {
  const bin = findClaude();
  const version = execFileSync(bin, ['--version']).toString().trim();
  console.log(`[capture] using ${version}`);
  const mcpConfig = path.join(work, 'mcp.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { countersign: { type: 'http', url: `${base}/mcp` } } }));

  const turns: Turn[] = [];
  let sessionId: string | undefined;
  let model = 'unknown';
  for (const [i, prompt] of USER_TURNS.entries()) {
    if (i === 2) {
      // The human approves in the dashboard between turns, exactly as in the video.
      const st = await (await fetch(`${base}/api/state`)).json();
      const pending = st.batches.find((b: any) => b.status === 'PENDING_APPROVAL');
      if (!pending) throw new Error('Claude did not propose a batch in turn 2.');
      const r = await fetch(`${base}/api/batches/${pending.id}/approve`, { method: 'POST', headers: { 'x-countersign': '1' } });
      if (!r.ok) throw new Error(`approve failed: ${await r.text()}`);
      for (let t = 0; t < 60; t++) {
        const s2 = await (await fetch(`${base}/api/state`)).json();
        if (s2.batches.find((b: any) => b.id === pending.id)?.status === 'PAID') break;
        await new Promise((res) => setTimeout(res, 500));
      }
      console.log(`[capture] approved ${pending.id} in the dashboard`);
    }
    console.log(`[capture] turn ${i + 1}: ${prompt}`);
    const res = await runTurn(bin, prompt, mcpConfig, sessionId);
    sessionId = res.sessionId;
    model = res.events.find((e) => e.type === 'system' && e.subtype === 'init')?.model ?? model;
    const turn = toTurn(prompt, res.events);
    turns.push(turn);
    for (const b of turn.blocks) console.log(b.type === 'tool' ? `   ⚙ ${b.name} ${JSON.stringify(b.input)}${b.is_error ? ' (error)' : ''}` : `   💬 ${b.text.replace(/\n/g, '\n      ')}`);
  }

  const out = {
    captured_at: new Date().toISOString(),
    model,
    client: version,
    system_prompt: SYSTEM_PROMPT,
    id_seed: idSeed,
    id_date: idDate,
    turns,
  };
  fs.writeFileSync(path.join(root, 'demo', 'transcript.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`[capture] wrote demo/transcript.json (${model})`);
} finally {
  server.kill();
  fs.rmSync(work, { recursive: true, force: true });
}
