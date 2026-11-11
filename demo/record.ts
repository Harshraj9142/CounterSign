/**
 * Records the demo video: demo/output/countersign-demo.mp4 (+ .srt captions + cover.png).
 *
 *   npm run demo:record                 # mock PayPal (no credentials needed)
 *   DEMO_VOICE="Samantha" DEMO_RATE=178 npm run demo:record
 *
 * How it works: starts the real server on a scratch data dir, generates narration
 * with macOS `say`, plays public/demo in headless Chromium (real MCP calls, real
 * dashboard), captures frames with the DevTools screencast, then muxes with ffmpeg.
 * Requires macOS (`say`), ffmpeg and `npx playwright install chromium`.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { buildScenes, type EvalSummary, type Scene } from './scenes.js';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'demo', 'output');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'countersign-video-'));
const voice = process.env.DEMO_VOICE ?? 'Samantha';
const rate = process.env.DEMO_RATE ?? '178';
const port = Number(process.env.DEMO_PORT ?? 4320);
const base = `http://localhost:${port}`;
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(work, 'frames'), { recursive: true });

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const probe = (file: string) => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim());
const log = (s: string) => console.log(`[demo] ${s}`);

/** Synthesizes soft mouse-click and keystroke sounds at the player's event times (mono 48 kHz WAV). */
function writeSfx(file: string, events: { t: number; kind: 'click' | 'key' }[], seconds: number) {
  const rate = 48000;
  const data = new Float32Array(Math.ceil(seconds * rate) + rate);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (const e of events) {
    const start = Math.round((e.t / 1000) * rate);
    const click = e.kind === 'click';
    const len = Math.round((click ? 0.045 : 0.018) * rate);
    const pitch = click ? 1800 : 2600 + rnd() * 500;
    const gain = click ? 0.32 : 0.09 + Math.abs(rnd()) * 0.04;
    for (let i = 0; i < len && start + i < data.length; i++) {
      const tt = i / rate;
      const env = Math.exp(-tt * (click ? 140 : 320));
      data[start + i] += gain * env * (0.55 * rnd() + 0.45 * Math.sin(2 * Math.PI * pitch * tt) + (click ? 0.5 * Math.sin(2 * Math.PI * 140 * tt) : 0));
    }
  }
  const buf = Buffer.alloc(44 + data.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data.length * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(data.length * 2, 40);
  for (let i = 0; i < data.length; i++) buf.writeInt16LE(Math.max(-1, Math.min(1, data[i])) * 32767, 44 + i * 2);
  fs.writeFileSync(file, buf);
}

// ---------- 1. eval numbers for the results card ----------
const resultsFile = path.join(root, 'eval', 'results.json');
if (!fs.existsSync(resultsFile)) {
  log('running eval to get results…');
  execFileSync(process.execPath, ['--import', 'tsx', path.join(root, 'eval', 'run.ts')], { cwd: root, stdio: 'inherit' });
}
const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
const manifest: { kind: string; pattern: string }[] = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'manifest.json'), 'utf8'));
const summary: EvalSummary = {
  cases: results.cases,
  bad: results.fraud.total + results.policy.total,
  badHeld: results.fraud.held + results.policy.held,
  legit: results.legit.total,
  legitPayable: results.legit.payable,
  wrongPayments: results.rubber_stamp.wrong_payments,
  patterns: new Set(manifest.filter((c) => c.kind !== 'legit').map((c) => c.pattern)).size,
};
const transcriptFile = path.join(root, 'demo', 'transcript.json');
if (!fs.existsSync(transcriptFile)) {
  console.error('demo/transcript.json is missing. Run `npm run demo:capture` first (needs the Claude Code CLI).');
  process.exit(1);
}
const transcript = JSON.parse(fs.readFileSync(transcriptFile, 'utf8'));
const mode = 'mock';
const scenes: Scene[] = buildScenes(summary, transcript.model, mode);
const tag = `Claude's replies: real session (${transcript.model}) · tool calls & payouts: live · PayPal ${mode} mode`;

// ---------- 2. narration ----------
log(`generating narration with voice "${voice}"…`);
const clips: string[] = [];
for (const [i, s] of scenes.entries()) {
  const aiff = path.join(work, `scene-${i}.aiff`);
  const wav = path.join(work, `scene-${i}.wav`);
  run('say', ['-v', voice, '-r', rate, '-o', aiff, '--', s.narration]);
  run('ffmpeg', ['-y', '-i', aiff, '-ar', '48000', '-ac', '1', wav]);
  s.audioMs = Math.round(probe(wav) * 1000);
  clips.push(wav);
}
const spoken = scenes.reduce((t, s) => t + (s.audioMs ?? 0), 0) / 1000;
log(`narration: ${spoken.toFixed(1)}s across ${scenes.length} scenes`);
fs.writeFileSync(path.join(root, 'public', 'demo', 'scenes.json'), JSON.stringify({ tag, transcript, scenes }, null, 2));

// ---------- 3. server ----------
const server = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'server.ts')], {
  cwd: root,
  env: {
    ...process.env,
    DATA_DIR: path.join(work, 'data'), PAYPAL_MODE: mode, PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: base,
    DEMO_MODE: 'true', SEED_ON_START: 'true', MOCK_SETTLE_MS: '1700', DASHBOARD_TOKEN: '', MCP_TOKEN: '', SANDBOX_RECIPIENTS: '',
    // Same seed/date as the capture, so batch ids in Claude's replies match the live replay.
    DISABLE_ELICITATION: 'true', DEMO_FIXED_ID_SEED: String(transcript.id_seed), DEMO_ID_DATE: transcript.id_date,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => !String(d).includes('ExperimentalWarning') && process.stderr.write(d));
await new Promise((r) => server.stdout.once('data', r));
await fetch(`${base}/api/demo/reset`, { method: 'POST', headers: { 'x-countersign': '1' } });

try {
  // ---------- 4. play & capture ----------
  log('recording (this takes about as long as the video)…');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: Number(process.env.DEMO_DPR ?? 2) });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.goto(`${base}/demo/`);
  await page.waitForFunction(() => typeof (window as any).runDemo === 'function');
  await page.evaluate(() => document.fonts.ready);

  const cdp = await page.context().newCDPSession(page);
  const frames: { file: string; ts: number }[] = [];
  const writes: Promise<void>[] = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = path.join(work, 'frames', `${String(frames.length).padStart(6, '0')}.jpg`);
    frames.push({ file, ts: (metadata.timestamp ?? Date.now() / 1000) * 1000 });
    writes.push(fs.promises.writeFile(file, Buffer.from(data, 'base64')));
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });

  const res = (await page.evaluate(([s, t, tr]) => (window as any).runDemo(s, { tag: t, transcript: tr }), [scenes, tag, transcript] as const)) as {
    startedAt: number; timeline: { index: number; start: number; end: number }[]; durationMs: number; warnings: string[];
    sfx: { t: number; kind: 'click' | 'key' }[];
  };
  for (const w of res.warnings) console.warn(`[demo] WARNING: ${w}`);
  const endAt = res.startedAt + res.durationMs + 800;
  await new Promise((r) => setTimeout(r, 900));
  await cdp.send('Page.stopScreencast');
  await Promise.all(writes);
  await browser.close();
  log(`captured ${frames.length} frames, ${(res.durationMs / 1000).toFixed(1)}s (${(frames.length / (res.durationMs / 1000)).toFixed(1)} fps average)`);

  // ---------- 5. video track (variable frame timing → 30 fps) ----------
  const usable = frames.filter((f, i) => f.ts >= res.startedAt || frames[i + 1]?.ts > res.startedAt);
  const lines: string[] = [];
  usable.forEach((f, i) => {
    const start = Math.max(f.ts, res.startedAt);
    const next = i + 1 < usable.length ? usable[i + 1].ts : endAt;
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, (next - start) / 1000).toFixed(4)}`);
  });
  lines.push(`file '${usable[usable.length - 1].file}'`);
  const list = path.join(work, 'frames.txt');
  fs.writeFileSync(list, lines.join('\n'));
  const video = path.join(work, 'video.mp4');
  run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', video]);

  // ---------- 6. narration track placed at actual scene starts, plus UI sounds ----------
  const total = (endAt - res.startedAt) / 1000;
  const sfxFile = path.join(work, 'sfx.wav');
  writeSfx(sfxFile, res.sfx, total);
  const inputs = [...clips.flatMap((c) => ['-i', c]), '-i', sfxFile];
  const delays = res.timeline.map((t, i) => `[${i}]adelay=delays=${Math.round(t.start)}:all=1[a${i}]`).join(';');
  const mix = `${res.timeline.map((_, i) => `[a${i}]`).join('')}[${clips.length}]amix=inputs=${clips.length + 1}:normalize=0:dropout_transition=0,apad[out]`;
  const narration = path.join(work, 'narration.wav');
  run('ffmpeg', ['-y', ...inputs, '-filter_complex', `${delays};${mix}`, '-map', '[out]', '-t', total.toFixed(2), '-ar', '48000', narration]);

  // ---------- 7. mux, captions, cover ----------
  const out = path.join(outDir, 'countersign-demo.mp4');
  run('ffmpeg', ['-y', '-i', video, '-i', narration, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', out]);
  run('ffmpeg', ['-y', '-ss', '2.5', '-i', out, '-frames:v', '1', path.join(outDir, 'cover.png')]);

  const srtTime = (ms: number) => {
    const d = new Date(Math.max(0, Math.round(ms)));
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')},${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
  };
  let n = 0;
  const srt: string[] = [];
  res.timeline.forEach((t, i) => {
    const s = scenes[i];
    const sentences = s.narration.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [s.narration];
    const len = sentences.reduce((a, x) => a + x.length, 0);
    let cursor = t.start;
    for (const sentence of sentences) {
      const dur = ((s.audioMs ?? 0) * sentence.length) / len;
      srt.push(String(++n), `${srtTime(cursor)} --> ${srtTime(cursor + dur)}`, sentence.trim(), '');
      cursor += dur;
    }
  });
  fs.writeFileSync(path.join(outDir, 'countersign-demo.srt'), srt.join('\n'));
  fs.writeFileSync(path.join(outDir, 'narration.txt'), scenes.map((s) => `[${s.id}]\n${s.narration}\n`).join('\n'));

  const seconds = probe(out);
  log(`done: ${path.relative(root, out)} (${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')})`);
  if (seconds > 180) console.warn(`[demo] WARNING: video is ${seconds.toFixed(0)}s, over the 3-minute limit. Raise DEMO_RATE or trim narration in demo/scenes.ts.`);
} finally {
  server.kill();
  if (!process.env.DEMO_KEEP_WORK) fs.rmSync(work, { recursive: true, force: true });
  else log(`work dir kept at ${work}`);
}
