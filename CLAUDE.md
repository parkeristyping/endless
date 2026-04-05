# Endless Song

An endlessly evolving music site powered by Strudel and Claude.

## Architecture

- **Backend**: Node.js + Express + WebSocket (`ws`) — `server.js`
- **Frontend**: Vanilla HTML/JS + `@strudel/repl` web component (CDN) — `public/`
- **LLM**: Anthropic SDK (`claude-sonnet-4-20250514`) generates new Strudel patterns every 30s
- **No database** — all state (current pattern, pending suggestions) lives in server memory

## How It Works

1. Users visit the site and click to start (required for browser audio policy)
2. Strudel REPL plays the current pattern with code visible
3. Users submit anonymous suggestions via chat panel (WebSocket)
4. Every 30s the server samples up to 20 suggestions, sends them + current pattern to Claude
5. Claude returns an evolved pattern; server validates with acorn, broadcasts to all clients
6. Suggestions clear each turn; users only see their own suggestions

## Key Files

- `server.js` — Express server, WebSocket, LLM loop, pattern validation
- `public/index.html` — Splash screen + Strudel editor + chat panel
- `public/app.js` — WebSocket client, pattern updates, chat UI
- `public/style.css` — Dark theme, split layout
- `.env` — `ANTHROPIC_API_KEY` (not committed)

## Running

```
npm install
npm start
# Open http://localhost:3000
```

## Notes

- LLM loop only runs when at least one client is connected
- Pattern validation uses acorn JS parser to catch syntax errors
- Strudel patterns are JS expressions — no imports/declarations allowed
- Cost estimate: ~$14/day on Sonnet at 30s intervals with continuous usage
