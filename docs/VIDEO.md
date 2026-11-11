# Demo video

## What's already made

`demo/output/` contains:

- `countersign-demo.mp4`: about 2.5 minutes, 1080p, narrated, with on-screen captions, cursor, zooms and highlights
- `countersign-demo.srt`: captions to upload to YouTube
- `cover.png`: thumbnail
- `narration.txt`: the voice-over script

**What's real:** Claude's replies come from a real Claude session (`demo/transcript.json`, model recorded inside it) that used the Countersign MCP server. During recording, every tool call is run again live against a fresh server, and the dashboard, approval, PayPal payouts (mock mode), webhooks and audit log are the real app. Maya's three chat messages are fixed prompts, and the cursor is animated. The video says this on screen.

## Regenerate it

```bash
npm run demo:capture   # optional: new real Claude session → demo/transcript.json (needs the Claude Code CLI; CLAUDE_BIN=… if not on PATH)
npm run demo:record    # replays it with cursor, zooms, narration (macOS `say`), click sounds → demo/output/
```

Options: `DEMO_VOICE="Reed (English (US))" DEMO_RATE=172 npm run demo:record` (list voices with `say -v '?'`), `DEMO_DPR=1` for a faster, lower-detail render. Edit scenes and narration in `demo/scenes.ts`. If a new capture changes what Claude says, check the narration still matches.

`/demo/?autoplay=1` on a running server plays the same sequence live (without narration), which is handy for presenting.

## Optional: show money landing in the PayPal sandbox

After you add sandbox credentials (README → "Connect PayPal sandbox"), add a 5–10 second clip at the "PayPal webhooks stream the status back live" moment: log in to [sandbox.paypal.com](https://www.sandbox.paypal.com) as one of the recipients and show the payment in their activity. It's the one shot the generated video can't include, and judges like seeing the real PayPal side. Keep the total under 3:00.
