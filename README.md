# Stormfall · Tactical Royale

A browser tactical battle royale game. Play it solo against AI, or online with friends.

## Play

Open `index.html` in a modern browser. There's no build step or server to run.
Fonts load from Google Fonts. Everything else is in the repo.

It's live in two places:

- GitHub Pages: <https://kxdjordan.github.io/Stormfall/>
- Cloudflare (with cloud saves, the global daily leaderboard and its own matchmaking server), once the deploy below
  is set up: `https://stormfall.<your-subdomain>.workers.dev`

## Saving your progress

Progress is stored in your browser. Two ways to keep it safe:

- **Cloud save** (Profile → Cloud save): after your first match the game makes an anonymous account by itself (no
  email, no sign-up) and syncs your progress after matches, purchases and loadout changes. Profile shows your
  **account code**. On another device, or after removing and re-adding the home-screen app (iOS deletes the app's data
  when you do that), tap **Sign in with account code** and enter it. If two devices changed progress at the same time,
  the game shows both and lets you choose. Replays stay on the device.
- **Save backup** (Profile → Save backup): a file or text code with everything, replays included, that you keep yourself.
  - **Save file**: on iPhone this opens the share sheet (choose *Save to Files*); elsewhere it downloads a `.txt` file.
  - **Copy save code**: a compact text code you can keep in Notes or Messages.
  - **Restore**: paste a code or pick a backup file. It shows what is in the backup and asks before replacing your progress.

Without a connection (or without the backend) the game works exactly as before and syncs later.

## Online play

1. One player taps **Play online → Host a room** and shares the 5-letter room code (or **Copy invite link**).
2. Friends open the game, tap **Play online**, and enter the code. An invite link joins automatically.
3. The host picks Solo (8), Duos (4 teams of 2) or Quick (4) and taps **Start match**. AI fills the empty slots.
   In Duos, players are paired in join order.

How it works:

- Players connect browser-to-browser over WebRTC using [PeerJS](https://peerjs.com/). The host's browser
  relays commands. There is no game server.
- Every client runs the same seeded simulation (lockstep). Only player commands go over the network, so a match
  uses very little bandwidth.
- If a guest disconnects or abandons, AI takes over their operative for everyone. If the host leaves, each guest
  finishes the match against AI.
- Online turns always have a timer (your setting, or 45 seconds if it's off), so nobody can stall the room.

Notes:

- Matchmaking (signaling) uses the game's own backend when there is one (see below: a PeerJS-compatible server in a
  Durable Object), and the free public PeerJS server (`0.peerjs.com`) otherwise. If the own server is unreachable,
  hosts use the public one, and joiners who can't find a room on the own server look for it on the public one.
  To use another server, set `window.STORMFALL_PEER = {host, port, path, secure}` in a script tag before the game script.
- Connections use STUN. With the optional TURN setup below, players on strict corporate or carrier networks
  connect through Cloudflare's TURN relay.
- All players should run the same version of the page. The lobby rejects mismatched versions.
- Fog of war is enforced on screen only. Each client knows the full game state.

## Cloudflare backend

Everything lives in `cloudflare/` and runs on the **Workers Free plan**.

```
browser ──► Worker "stormfall" (workers.dev or your domain)
             ├─ static assets: index.html, vendor/, assets/, manifest.json   (served without running the Worker)
             ├─ /api/account, /api/save/*, /api/daily/*                     ──► D1 "stormfall" (SQLite)
             ├─ /api/turn                                                   ──► Cloudflare Realtime TURN (optional)
             └─ /api/peerjs (WebSocket), /api/peerjs/id                     ──► Durable Object "Signal" (SQLite-backed,
                                                                                WebSocket Hibernation)
```

- **One Worker with Static Assets** (not Pages + Functions): one deploy, one URL, one config, and the
  `run_worker_first: ["/api/*"]` rule means asset requests never invoke the Worker (free and unlimited), while the
  API, the Durable Object binding, cron and rate-limit bindings live in the same project.
- **GitHub Pages keeps working.** The client reads the API base from `<meta name="sf-api" content="">` in
  `index.html`: empty = same origin (what the Cloudflare build uses), `off` = no backend, or a full URL. On
  `*.github.io` an empty value means no backend. To give the GitHub Pages copy cloud saves and the leaderboard, put
  your Worker URL in that meta tag on `main` (the deploy log prints it). The API allows CORS from
  `https://kxdjordan.github.io` and the Worker's own origin; add more with the `SF_ALLOWED_ORIGINS` repository variable.
  Note that the two sites have separate browser storage: the account code moves you between them.
- **Offline first.** Every network call is fire-and-forget with a timeout; failures and `429`s back off
  exponentially (honouring `Retry-After`); nothing in the match or turn flow waits on the network.

### Endpoints

All JSON. POST bodies are sent as `text/plain` and GETs have no custom headers, so cross-origin calls are CORS
"simple requests" and never pay for a preflight. Authentication is `auth: "ID.SECRET"` in the body.

| Endpoint | Does | D1 cost |
|---|---|---|
| `POST /api/account` | new anonymous account → `{id, auth, code}` (5/min per IP) | 1 write |
| `POST /api/save/get` `{auth, have}` | `{rev, at, data}`; `data` is null when you already have `rev` | 1 read |
| `POST /api/save/put` `{auth, base, data}` | `{rev, at}` if the cloud is still at `base`, else `409 {rev, at, data}` | 1 read + 1 write |
| `POST /api/daily/submit` `{auth, day, of, place, win, kills, dmg, rounds, name, cls}` | first score per account per UTC day; the server recomputes the score and checks caps → `{score, rank, total, dup}` | 1 read + 3 writes + rank reads |
| `GET /api/daily/top?day=YYYY-MM-DD` | top 50 + player count; cached (isolate memory 30 s, Cache API and browser 60 s; closed days 1 h) | ≤ 51 reads per cache miss |
| `POST /api/daily/me` `{auth, day}` | your rank, only asked for when you're not in the top 50 | rank reads |
| `GET /api/turn` | `{iceServers, ttl}`: Cloudflare TURN credentials (shared, minted once per isolate per 12 h) or `null` | – |
| `GET /api/peerjs/id` | a fresh peer id (PeerJS protocol) | – |
| `GET /api/peerjs?key=peerjs&id=&token=&version=` | WebSocket to the signaling Durable Object | – |
| `GET /api/health` | `{ok, turn}` | – |

Signaling messages (PeerJS server protocol): server → client `OPEN`, `ID-TAKEN` (room code already in use),
`INVALID-KEY`, `ERROR`, `EXPIRE` (peer not connected → the client's "No room called …"); client ↔ client relayed by
`dst`: `OFFER`, `ANSWER`, `CANDIDATE`, `LEAVE`, `EXPIRE`. `HEARTBEAT` is answered by the runtime's WebSocket
auto-response, so it never wakes the object.

### Data model (D1)

- `accounts(id PK, sh, created, rev, save, save_at)`: `sh` is SHA-256 of the 100-bit random secret (never stored);
  `save` is the backup format (`SFS1.` + base64(deflate(json))) without replays or daily map thumbnails, typically
  1–3 KB, capped at 64 KB. The account code is `id` + secret in six groups of five (Crockford base32).
- `daily(day, acct, score, at, name, cls, place, kills, dmg, rounds, win)`, PK `(day, acct)`, index
  `daily_rank(day, score DESC, at)`; `daily_count(day PK, n)`. Leaderboards older than 40 days and accounts that never
  saved anything (after 7 days) are deleted by a daily cron.
- No PII: the only player-entered text is the callsign shown on the leaderboard (A–Z, 0–9, 12 characters).

### Free-tier budget

Free-plan limits as I know them (Cloudflare's docs weren't reachable from the build machine; check them on the
pricing pages): Workers 100,000 requests/day and 10 ms CPU per request, static assets free and unlimited;
D1 5 M rows read/day, 100 k rows written/day, 500 MB per database; Durable Objects (SQLite-backed only) 100,000
requests/day and 13,000 GB-s duration/day, with incoming WebSocket messages billed 20:1; KV 1,000 writes/day (not used);
Cache API free but a no-op on `workers.dev`; Rate Limiting binding included; Realtime TURN about 1,000 GB/month free.

| Per active player per day (typical) | Worker requests | D1 reads | D1 writes | DO requests |
|---|---|---|---|---|
| App start pull | 1 | 1 | 0 | 0 |
| 5 matches → about 4 debounced pushes | 4 | 4 | 4 | 0 |
| Daily challenge: submit + 2 board views | 3 | ~1 + rank | 3 | 0 |
| One online session (turn, id, WebSocket, ~40 signaling messages) | 3 | 0 | 0 | ~3 |
| **Total** | **~11** | **~10 + leaderboard misses** | **~7** | **~3** |

That's roughly **9,000 daily active players** before the Workers request cap (the first limit you'd hit),
~14,000 before D1 writes, and leaderboard reads are capped by caching (at most about 2 misses a minute per isolate × 51
rows). Durable Object duration: the object is awake only while signaling messages arrive (a match setup is a few
seconds, then it hibernates), so about 13,000 GB-s ÷ (≈20 s × 0.125 GB) ≈ 5,000 match setups a day. Idle sockets
during a match cost nothing (hibernation + heartbeat auto-response). CPU per request is a SHA-256 and a JSON parse,
well under 1 ms.

Optimizations applied: no Worker on static assets; simple CORS requests (no preflights); one D1 row per save
operation (auth + compare-and-swap in one `UPDATE … RETURNING`); `have` revision so unchanged pulls carry no payload;
pushes debounced (8 s, at most one per 20 s, held until the match ends) and skipped when the content hash is
unchanged; small compressed saves; an index for every query and a per-day counter instead of `COUNT(*)`; leaderboard
cached in isolate memory, the Cache API and the browser; the client only asks for its rank when it isn't in the top
50; rate limits per IP and per account with the free Rate Limiting binding (falling back to an in-memory window);
WebSocket Hibernation with a heartbeat auto-response and a 25 s PeerJS ping; TURN credentials minted once and cached
both in the Worker and in the browser for their lifetime; a daily cron that prunes old rows; no KV.

### One-time setup

1. Create a free Cloudflare account and open **Workers & Pages** once (this gives you a `workers.dev` subdomain).
2. Create an API token: **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template**, then
   **+ Add more → Account · D1 · Edit**. Account resources: your account. Create it and copy the token.
3. Copy your **Account ID** (Workers & Pages overview, right-hand side).
4. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**: `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`.
5. Push to `main` (or run **Actions → Deploy to Cloudflare → Run workflow**). The workflow creates the D1 database if
   needed, writes its id into the config, applies migrations, builds the static files and deploys. The run summary shows
   the game URL.

Optional:

- **TURN** (players behind strict NATs): Cloudflare dashboard → **Realtime → TURN Server → Create**; add its
  **Turn Token ID** and **API Token** as the `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` repository secrets. The Worker
  then hands out short-lived (24 h) credentials from `/api/turn`. Without them the game keeps PeerJS's default ICE
  servers, as before. TURN only carries traffic for players who can't connect directly, and a match is a few hundred KB.
- **Custom domain**: add it to the Worker in the dashboard and to the `SF_ALLOWED_ORIGINS` repository variable. On a
  custom domain the Cache API also caches the leaderboard per location.
- **GitHub Pages copy**: set `<meta name="sf-api" content="https://stormfall.<subdomain>.workers.dev">` in `index.html`.

Without the two secrets the workflow finishes green with a notice and deploys nothing.

### Local development and tests

```
cd cloudflare
npm ci
npm run dev           # builds public/, applies migrations to a local D1, runs wrangler dev on :8787
npm test              # unit tests + API tests against a fresh local Worker (wrangler dev / Miniflare)
node test/e2e/cloud.cjs                         # browser tests (Playwright + Chromium) against npm run dev
node test/e2e/online.cjs quick 0 veteran spec   # two browsers + a spectator, lockstep over the own signaling DO
```

## Files

- `index.html`: the full game (HTML, CSS and JS in one file)
- `vendor/peerjs.min.js`: PeerJS 1.5.5 (MIT, see `vendor/PEERJS-LICENSE`), used for online play
- `manifest.json`: web app manifest (fullscreen, portrait) for home-screen installs
- `assets/icon-512.png`, `assets/icon-192.png`: favicon / app icons
- `assets/apple-touch-icon.png`: iOS home-screen icon
- `cloudflare/`: the backend (Worker, Durable Object, D1 migrations, build and deploy scripts, tests)
- `.github/workflows/deploy-cloudflare.yml`: deploys to Cloudflare on pushes to `main`
