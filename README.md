# Adventure Quest

A multiplayer, online, text-based fantasy adventure where Claude is the Game Master.

- Players enter a **waiting room** with a name and a character concept. The first person in sets the party size (1-8).
- The adventure starts automatically when the party is full, or **any player can start it early** with whoever is waiting.
- Each round, every player says what their character does. The GM resolves the actions together and narrates what happens next.
- When an outcome is uncertain, the GM **calls for dice rolls**. Players click to roll; the server rolls fairly and shows the result to everyone.
- The party sheet tracks HP, conditions, and inventory, and the GM updates it.
- Table talk lets players chat with each other without the GM reading it.

## How it works

| Piece | Tech |
|---|---|
| Server | Node.js, Express, Socket.IO (`server/`) |
| Game Master | Claude API via `@anthropic-ai/sdk`, model `claude-opus-5-5`, streaming, adaptive thinking, prompt caching (`server/gm.js`) |
| Client | Plain HTML/CSS/JS, no build step (`public/`) |
| Hosting | Railway (one service) |

The GM uses two tools:
- `request_rolls` pauses the game until players roll.
- `update_character` updates the party sheet.

The server owns all dice rolls and game state. Players reconnect automatically after a refresh or a dropped connection: their browser keeps a player ID in local storage, and the server sends back the full story so far.

> **Note:** game state lives in memory. Restarting or redeploying the server ends any adventures in progress. Run a **single instance** on Railway (the default).

## Run locally

```bash
npm install
cp .env.example .env              # then set ANTHROPIC_API_KEY
npm run dev                       # http://localhost:3000
```

To try the game without API calls or cost, use the mock GM:

```bash
npm run dev:mock
```

To test multiplayer locally, open the site in a normal window and in a private window. Each window is a separate player.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Claude API key |
| `CLAUDE_MODEL` | `claude-opus-5-5` | GM model |
| `CLAUDE_EFFORT` | `medium` | `low` gives faster, cheaper turns; `high` gives deeper reasoning |
| `ACCESS_CODE` | (none) | If set, players need this code to join. Recommended for a public URL. |
| `MAX_ACTIVE_GAMES` | `10` | Limit on simultaneous adventures |
| `CLAUDE_FALLBACKS` | `true` | Server-side refusal fallback (`fallbacks: "default"`) |
| `MOCK_GM` | (off) | `1` uses the fake GM |

## Deploy to Railway

1. Push this repo to GitHub.
2. In Railway, choose **New Project → Deploy from GitHub repo** and pick this repo.
3. Under **Variables**, add `ANTHROPIC_API_KEY`. Add `ACCESS_CODE` too, so strangers can't spend your API credits.
4. Under **Settings → Networking**, choose **Generate Domain**.

Railway detects Node, runs `npm start`, and uses `/health` as its health check (see `railway.json`). WebSockets work without extra setup. Every push to `main` redeploys automatically.
