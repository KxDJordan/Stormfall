# Stormfall · Tactical Royale

A browser tactical battle royale game. Play it solo against AI, or online with friends.

## Play

Open `index.html` in a modern browser. There's no build step or server to run.
Fonts load from Google Fonts. Everything else is in the repo.

It's live in two places:

- GitHub Pages: <https://kxdjordan.github.io/Stormfall/>
- Cloudflare (with cloud saves, the global daily leaderboard and its own matchmaking server), once the deploy below
  is set up: `https://stormfall.<your-subdomain>.workers.dev`

## Modes

| Mode  | Players                | Map   | Notes |
|-------|------------------------|-------|-------|
| Solo  | up to 8, free for all  | 40×40 | Second Wind: get back up once |
| Duos  | up to 4 teams of 2     | 40×40 | revive your partner |
| Trios | up to 4 teams of 3     | 48×48 | wider storm that shrinks faster, 4 objectives |
| Quads | up to 4 teams of 4     | 56×56 | extra early storm stage (round 3), 5 supply drops, 4 objectives |
| Quick | up to 4, free for all  | 40×40 | tight storm, about six minutes |
| King of the Hill | up to 4 teams of 2 | 32×32 | no storm; hold the moving hill (every 5 rounds) alone at round end for a point, first to 8 (or the most after round 24); respawns after 2 rounds |
| Siege | 2 teams of 4           | 32×32 | attackers breach a walled compound and hold the data core, defenders hold 10 rounds; best of 3, sides swap; breaching charges, barricades |
| Rumble | up to 4 teams of 2    | 24×24 | no storm, team deathmatch with respawns after 2 rounds, first to 12 eliminations (or the most after round 24) |
| Infection | up to 8, survivors vs Infected | 40×40 | one (two with 7+) turns in round 1; the Infected regenerate and get back up, anyone they take down rises as Infected; survivors hold out to round 15 |
| Blackout | up to 8, free for all | 40×40 | night: 3.5-tile sight, flares, drones and muzzle flashes reveal from normal range |
| Survival | co-op, 1–4 (humans or AI teammates) vs zombie waves | 32×32 | no storm; zombies hunt by sound; loud noise calls extra hordes from the map edge; 10 steeply growing waves with 2-round breathers; horde difficulty Recruit / Veteran / Elite; not in Ranked |

In the team modes a downed operative bleeds out in 2 turns unless an adjacent teammate revives them; a team is out
when nobody on it is standing. Empty seats are filled by bots, and team pings / commands steer AI teammates. The map
size comes from the mode, so it is the same on every client, for spectators and in replays. Classic modes keep
generating the exact same 40×40 maps for a given seed.

**Regions.** Fifteen, picked by the map roulette after Deploy (never the one you just played; online the host's client
picks, and the region travels in the match config and in replays). Every mode plays on every region, at the mode's map
size. The daily challenge draws from all fifteen from 2026-11-06 (earlier days keep the first ten).

| Region | Plays like |
|--------|------------|
| Neo-Kowloon | city grid of streets and blocks, neon towers with rooftops, cars and barriers |
| Frostfall Station | bunkers, rock clusters and sandbag lines in the snow; footprints in snowfall |
| Ember Wastes | mesas with walkable tops, ruined walls, wrecks; sandstorms cut sight |
| Verdant Ruins | tree clusters, stepped temples, broken colonnades, burnable undergrowth |
| Ironhaven Docks | container rows (some double-stacked), gantry cranes, warehouses |
| Blackwell Refinery | tank clusters, pipe racks, control cabins, plenty of explosives |
| Sandsea Bazaar | a souk of 1-tile alleys and flat roofs: most fights go up a ladder |
| Hollow Quarry | a terraced pit with long sightlines across it, rock shelves on the rim |
| Mirefen Marsh | shallow water (+1 move to wade), boardwalks, stilt houses, reed beds |
| Cinder Lab | lava channels crossed only by bridges; sight and shots cross the lava |
| Skyreach Monastery | a gorge split by rope-bridge chokepoints; contour terraces, crags and pagodas stack fights three or four levels high |
| Underline Transit | tunnels and station platforms with parked trains (walkable roofs), a warren of rooms full of doors, a pillared concourse, a flooded tunnel with a junction box |
| Saltglass Airfield | open salt flats and a runway: long sightlines, sparse hard cover (revetments, sandbag pits, jets), hangars, a two-story control tower |
| Drowned Quarter | flooded streets (+1 move per tile waded), dry pavements, a deep canal crossed by footbridges, a rooftop high road over the tenements, junction boxes that electrify the water |
| Frostvent Caldera | a frozen lake, hot springs and geysers that erupt every 3 rounds: a steam cloud that blocks sight through the next round, 2 damage to anyone on the vent |

**Survival** is co-op PvE: one squad holds out against waves of zombies that come in from the map edges. Zombies see
only 4–6 tiles and track sound. Every sound has a hearing radius, shown in the match as a ring: unsuppressed gunshots 14
tiles, explosions 20, suppressed shots 3, melee 2, a normal move 2, a sprint (2-AP move) 5, doors 6, and a thrown Noise
Maker 16 (it keeps beeping for 2 rounds). Rain shortens all of them. A zombie heads for the loudest, freshest sound it
heard and shows a yellow "?". One that sees you locks on (red "!"): it tracks you for 3/5/8 rounds out of sight
(Recruit/Veteran/Elite), and its growl (12 tiles) locks the pack onto you too. Locked-on zombies take full moves, spread
round you instead of queueing, go round choke points, and feed on a downed squadmate first (each bite takes a turn off
its bleed-out). During a wave a zombie with no lead homes in on the nearest squad member within a couple of rounds;
quiet play stops the lock-on and the pack calls, and Noise Makers still pull zombies away. Types:
Walker (the bulk), Runner (fast, fragile), Brute (smashes doors and cover in its way), Screamer (calls every zombie
on the map to what it found), Bloater (bursts into a poison cloud through the hazards gas system) and an
Abomination boss every 5th wave. A closed door holds the others back for a couple of rounds while they bang it open.
Toxic barrels and power boxes are always on the map, for luring the horde into gas and live current.
Each operative starts with a barricade and a Noise Maker. A breather after each wave brings crates, +8 HP, a barricade
charge and eliminated squadmates back. Clear wave 10 to extract. The horde acts as one NPC turn after the squad's turns.
It is simulated zombie by zombie with the seeded RNG, so it stays lockstep online and in replays, and it is animated in
batches. Waves grow roughly with the square of the wave number. The on-map cap is 22 zombies, +3 per squad member and +3
per wave, up to 58.

**Noise hordes.** Loud sounds fill a noise meter shown under the minimap. An explosion adds 8. A sniper rifle, railgun,
AM-50 or heavy-weapon shot adds 5, another unsuppressed shot 3, a sidearm shot 2 and a Noise Maker 3. The meter does
not drop after a round with loud noise; otherwise it ticks down about 15% (at least 2) at the round start, and the HUD
shows the tick. When it reaches 14 + 8 per squad member (22 solo, 46 for four), right after the turn that filled it, an
extra horde (separate from the wave count) comes in from a seeded random map edge, headed for the loudest sound. Two
loud turns in a row usually do it. A banner, a red edge flash with an arrow and a minimap edge mark show where the
horde comes from. A rest of 3 rounds (+2 per extra squad member) follows, and the meter drains to a quarter. Zombies
the cap holds back come in at the next round starts. A turn that makes 4+ noise during a wave also pulls that wave's
next zombies in at once. New zombies appear right after the noisy turn but first act in that round's horde phase, so
they never move in the middle of the squad's turn order.

**Mutators** (waiting room, host or offline) stack on any mode: Low gravity (+1 mobility, grenades +3 tiles, drop off any
ledge), Explosive everything (destroyed objects explode like oil drums), One-shot, Double storm speed, Melee only and
Perma-smoke. They travel in the match config, so guests, spectators and replays play with the same set.

## Classes

Seven classes, all available from level 1. Each has a class ability, a five-tier perk tree (a choice of two perks at
levels 3, 6, 9, 12 and 15, some of them new actions) and its own weapons, armor and utilities.

| Class | Role | Kit |
|-------|------|-----|
| Ranger | close assault | Blade Strike: dash to an enemy and slash |
| Sharpshooter | long range, +2 sight | Deadeye: −15 aim, +50% damage |
| Grenadier | heavy weapons | Hail of Bullets: a guaranteed hit; extra grenade charges, longer throws |
| Specialist | drone support | a deployable combat drone with its own AP and model actions |
| Engineer | fortification | **Deploy Turret** (1 AP, cooldown 4): a sentry up to 3 tiles away, 5 HP, 3 shots over 3 rounds, one reaction shot at each enemy that moves in its sight · **Build Cover** (1 AP, cooldown 2): half cover (6 HP) or full cover (4 HP) on an adjacent tile · **Repair** (1 AP, cooldown 2): +3 shield to you or an ally, or 3 HP to a turret or drone. SMG, shotgun, slug gun or carbine |
| Medic | combat support | **Heal Field** (1 AP, cooldown 4): allies starting a turn in it heal 1 HP for 2 rounds · **Revive Beam** (1 AP, cooldown 3): revive from 3 tiles · **Adrenaline** (1 AP, cooldown 5): +1 AP next turn for you or an ally. Passive: revives cost 1 AP and give 4 HP; regenerates 1 HP a turn. Carbine (or SMG / rifle), pistol sidearm |
| Recon | intel and traps, +2 sight | **Wall Scan** (free, cooldown 4): reveals everything within 6 tiles through walls for the team until the end of next round · **Trip Mine** (1 AP, cooldown 2, two out): hidden from other teams; 3–4 damage, stops the move and costs the victim 1 AP next turn · **Mark Target** (free, cooldown 2): the team gets +15 aim against it until the end of next round. Marksman DMR, the suppressed Hush SMG or the Specter Gauss |

Engineer, Medic and Recon abilities are lockstep commands like every other action (`{k:'kit',...}`, perk actions
`{k:'act',...}`), validated again when they run. Turrets are drone-like entities (they can be shot, blown up, zapped
and jammed, and see for their team); walls are ordinary breakable cover; mines are drawn only for their own team (and
for spectators and replays). AI operatives use every ability from their team's knowledge only, and the AI loadout pool
includes all seven classes. An Infected operative loses its class abilities; Melee only switches turrets off.

### Weapons

Every primary (prestige weapons aside) has a role and one trait, so none is just a bigger version of another; the
Loadout card shows both. Mk II / III upgrades add the same bonuses to every weapon.

| Weapon | Role | Trait |
|--------|------|-------|
| Pulse Rifle | all-rounder | Steady: overwatch and return fire take no reaction penalty |
| Lynx Carbine | skirmisher | Snap shot: +10 aim on a shot after moving |
| Wasp SMG | rusher | a shot costs 1 AP and never ends the turn: shoot twice, or shoot and move on |
| Hush SMG | infiltrator | silent, and nobody can return fire on it |
| Needler | attrition | 30% chance a hit makes the target bleed (a crit always does) |
| Breacher Shotgun | breacher | Spread: within 3 tiles a miss still grazes for half damage |
| Saiga Drum | brawler | Knockback: a hit within 3 tiles pushes the target a tile back, out of its cover |
| Slug Gun | finisher | +2 damage against targets at half HP or less |
| Kodiak Lever-Action | gunslinger | a crit gives back 1 AP, once a turn |
| Volt Caster | point blank | Arc lock: never misses within 2 tiles (ignores armor) |
| Tesla Arc Rifle | disruptor | a hit shocks the target: −15 aim, no overwatch or hunker (ignores armor) |
| Hailstorm Cannon | demolition | Splash: a hit deals 2 damage to other enemies next to the target |
| Tempest Minigun | suppressor | hit or miss, the target gets −15 aim through its next turn; −10 aim on a shot after moving |
| Warden Burst Rifle | cover shredder | every shot at a target in cover also hits the cover for 2 damage |
| Thunderclap Launcher | blinder | a hit disorients (−20 aim) and breaks overwatch |
| Marksman DMR | marksman | Braced: +5 aim and +5% crit if you have not moved this turn |
| Vanguard SR-7 | tracker | +10 aim against the last enemy you hit with it |
| Longshot Railgun | long-range killer | +25% crit at 8+ tiles (needs both AP) |
| Specter Gauss | cover buster | cover counts one step less: full as half, half as none (needs both AP; Recon) |
| Goliath AM-50 | heavy sniper | ignores shields and armor; +3 damage to drones, turrets and objects (needs both AP) |
| Nightjar Crossbow | silent hunter | Pinning bolt: a hit halves the target's mobility through its next turn. Silent; one bolt, re-cocked for free at the start of every turn (no reloads) |
| Rhino Double Rifle | stopper | Both barrels: within 5 tiles, with both barrels loaded, a shot fires both for +3 damage (2 rounds) |

The Sharpshooter carries the Railgun, DMR, Carbine, SR-7, AM-50, Nightjar Crossbow (level 9) and Rhino Double Rifle
(level 13); the Specter Gauss moved to the Recon, where Wall Scan finds the targets it shoots through cover (with
the Recon's lower aim it lost its −5 aim and part of its close-range penalty). Saved
loadouts with a weapon the class no longer carries fall back to the class's first weapon.

Sidearms: the P9 pistol carries 4 rounds, the Whisper is silent, and a Machete hit makes the target bleed.
Balance is checked with AI-vs-AI duels (1v1 and 2v2, mixed maps and ranges): every weapon wins roughly 43–58% overall
and has ranges where it is the best pick.

### Class prestige and ascended forms

Every match's XP also levels the class you played (up to class level 20). At level 20 a class can be prestiged
(Profile → Prestige): its level resets, it gains a rank (I–V) and pays prestige tokens. Ranks unlock prestige weapons
(Mk III-grade sidegrades, the Prestige II / IV ones with a unique effect), prestige cosmetics in the class's theme and,
at Prestige I, the class's **ascended form**: a stronger version of the class with its own look and a themed health
bar plate that every player sees.

| Ascended form | Stats | Trait |
|---------------|-------|-------|
| Ranger | +5 aim | Long Lunge: Blade Strike reaches 1 tile farther |
| Sharpshooter | +1 HP | Ghillie Shroud: while it has neither moved nor shot since the start of its last turn, enemies see and target it only within 6 tiles, and AI enemies lose track of it unless they spot it again. While hidden it is drawn see-through on your side. Drawn in a full ghillie suit |
| Grenadier | +1 HP, +1 armor | Siege Plating: damaging grenades blast 0.5 tiles wider. Drawn bulkier, with domed pauldrons and a grenade bandolier |
| Specialist | +1 HP, +5 aim | Overclocked Protocol: Combat Protocol is ready a turn sooner (cooldown −1) and zaps for +1 damage; every zap jams its target (disoriented: −20 aim on its next turn, overwatch broken) and marks it (the team gets +10 aim against it until the end of next round) |
| Engineer | +1 HP, +5 aim | Rapid Sentries: Deploy Turret is ready a turn sooner (cooldown −1) and turrets carry one more reaction shot |
| Medic | +1 HP | Second Breath: revives give 2 more HP |
| Recon | +1 HP, +5 aim | Deep Scan: Wall Scan radius +2 |

It is on by default once unlocked and can be switched off per class in Loadout or the Prestige tab. Higher ranks add
looks, never more power. The online spec carries it and every client keeps it only when the spec's cleaned prestige
ranks allow it (like prestige weapons), then applies it in `setupMatch`, so lockstep play, spectators and replays agree.
It is off in Ranked (every player in the room is on the ranked queue) and in the daily challenge, and the AI never
plays it.

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

1. One player taps **Play with friends**, picks a mode card (Solo, Duos, Trios, Quads, Quick, Infection, Blackout or Survival) and taps **Create lobby**, then shares
   the 5-letter room code (or the **Invite** link).
2. Friends open the game, tap **Play with friends**, and enter the code under **Join** (or **Watch** to spectate).
   An invite link joins automatically.
3. In the waiting room the host adds bots and picks their difficulty and the turn timer, then taps **Deploy**.
   AI fills the empty slots. In Duos, Trios and Quads, everyone picks a team (**Join** on a team); the host can move
   players, and bots fill the empty seats. A room holds up to 8 players (12 in Trios, 16 in Quads).

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
             ├─ /api/social/* (friends, requests, profiles)                 ──► D1
             ├─ /api/ranked/*, /api/bat/*, /api/report                      ──► D1
             └─ /api/peerjs (WebSocket), /api/peerjs/id, /api/social/ws,    ──► Durable Object "Signal" (SQLite-backed,
                /api/ranked/ws                                                  WebSocket Hibernation): signaling +
                                                                                presence + ranked matchmaking
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
| `/api/social/*` | friends, requests, presence socket, invites: see **Socials** below | |
| `/api/ranked/*`, `/api/bat/*`, `/api/report` | ranked queue, results, leaderboard; battalions, chat, moderation: see **Ranked & battalions** below | |

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
- No PII: the only player-entered text is the callsign shown on the leaderboard (A–Z, 0–9, 12 characters). Friends
  see the same callsign plus level, class and name plate ids (see Socials).

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

### Socials: friends, presence, room invites

Each account can publish a small **public profile** (callsign, level, class, name plate title and banner: no PII) and
gets a **friend code**: 8 random Crockford base32 characters (40 bits), shown as `XXXX-XXXX`, separate from the private
account code. Players add each other by code or by a share link `?friend=CODE`, which opens Friends with the code
filled in. Requests can be accepted, declined, cancelled; friends removed or blocked (a blocked player's request
disappears, and looking up your code then answers exactly like a wrong code). Caps: 100 friends + outgoing requests,
30 outgoing pending, 50 incoming pending, 100 blocks; requests nobody answers are dropped after 60 days.

**Presence** runs over one hibernating WebSocket per open app, served by the same `Signal` Durable Object as PeerJS
signaling. Why the same object and not a new class: an object is billed for duration only while it is awake, and one
global object awake 24 h at 128 MB is ~11,000 GB-s, under the free 13,000 GB-s/day, so one object can never exceed
the free duration however busy it gets (two always-awake objects could). It also shares the single WebSocket
auto-response pair (`{"type":"HEARTBEAT"}`), so heartbeats from idle apps never wake it. Social sockets carry the tag
`S` and are counted, capped (5,000; 4 per account) and swept separately from PeerJS peers.

- The socket (`/api/social/ws?c=<friend code>`) authenticates with its **first message** `{t:'auth', auth:'ID.SECRET'}`,
  checked against D1 by the object (secret hash, and that the code belongs to that account). The secret never appears
  in a URL or header (so never in logs). Unauthenticated sockets are ignored and closed after 20 s.
- Clients send **transitions only** (`menu` / `lobby` / `match`, plus room code and mode in a lobby); the object
  forwards a change to friends only if the visible state changed, and only to friends whose own list includes the
  sender (both sides must agree). The room code is shown to friends only while "Friends can join my rooms" is on
  (Friends sheet; on by default), which enables **Join** on the friends list.
- Heartbeat every 50 s (runtime auto-response, never wakes the object). An alarm every 3 minutes (only while presence
  sockets exist) closes sockets whose heartbeats stopped for 150 s, e.g. a phone that went to sleep. The client closes
  its socket 2 minutes after the app goes to the background and reconnects with backoff (4 s … 5 min).
- When the last socket of an account closes, friends get `off` and `profiles.seen` is written (one row): Friends shows
  "last seen" from the list when the socket is down, so presence degrades gracefully.
- **Only players who use Friends pay for any of this.** A friend code is created the first time Friends is opened, so
  before that nobody can be your friend; the socket opens only for players with friends or pending requests, or who
  opened Friends in this session (otherwise one list call per app start shows new requests).

**Invites.** In an online room, **Invite friends** (next to Invite in the waiting room) opens the friends picker (online
first). The invite (room code + mode) goes over the socket; the object checks that you are friends and that you are in
that room. Online friends get a card with **Join** (the existing join flow, same as a `?join=` link) and **Decline**
(the host is told) wherever they are in the menus; during a match they get a small non-blocking **Invite** badge
instead (Join waits until the match ends). Invites expire after 5 minutes and vanish when the host's room starts or
closes (seen through the host's presence). Offline friends: the invite is kept in D1 for 5 minutes (one row) and
delivered (then deleted) when they open the app, only if the host is still in that room; it is deleted as soon as the
host's room starts or closes. This is worth one write: "come play" is most useful in the minutes after it is sent, and
a stale invite is filtered anyway.

| Endpoint | Does | D1 cost |
|---|---|---|
| `POST /api/social/me` `{auth, name, lv, cls, title, banner}` | publish the public profile (only when it changed) → `{code}` | 1 read + 1 write |
| `POST /api/social/list` `{auth}` | `{code, friends, inc, out, blk}`: friends with `seen`; requests and blocks without | 1 + 2 per link |
| `POST /api/social/add` `{auth, code}` | send a request (or accept theirs) → `{st: 'o' \| 'f'}`; 5 lookups/min per account | ~3 reads + counts, 2 writes |
| `POST /api/social/act` `{auth, code, a}` | `accept`, `decline`, `cancel`, `remove`, `block`, `unblock` → `{st}` | ~3 reads, 1–4 writes |
| `GET /api/social/ws?c=CODE` | presence WebSocket (Durable Object), protocol below | at auth: 1 + 2 per friend reads |

Every change to friends is pushed to the presence object (one Durable Object RPC per add/act) so the other side's
list, badge and presence update live (`fx`). Socket messages, client → server: `auth {auth, s, r, m, o}`,
`st {s, r, m, o}`, `inv {to, r, m}`, `dec {c, r}`; server → client: `hi {c, on, inv}` (online friends + pending
invites), `p {c, s, r?, m?}` (`s: 'off'` = went offline), `fx` (refetch the list), `inv {c, n, r, m, exp}`,
`invd {c, live, exp}`, `invn {c, r}` (declined), `err {e}`. Rate limits: account-keyed `RL_ACCT` on every social call
and socket connect, `RL_NEW` keyed per account for friend-code lookups (enumerating 2^40 codes at 5/min is hopeless),
and per socket 40 messages and 12 invites a minute (a flood closes the socket).

D1 (migration `0002_social.sql`, applied by the deploy workflow like `0001`): `profiles(acct PK, fcode UNIQUE, name, lv,
cls, title, banner, seen, updated)`; `links(a, b, st, at)` PK `(a, b)`, both directions stored so "everything about me"
is one primary-key range, `st` = `f` friends / `o` outgoing / `i` incoming / `b` blocked, partial index on `at` for
pending requests; `invites(to_code, from_code, room, mode, name, exp)` PK `(to_code, from_code)`, indexes on `exp` (cron)
and `from_code` (room closed). The cron also drops expired invites and old requests, and never deletes an account that
has a profile.

Client (all in `index.html`, section "socials"): a Friends sheet (`openFriends()`, `#frSheet`), invite cards (`#sfInv`)
and the in-match badge (`#sfInvBadge`). It hooks into the rest of the game in three places only: the Friends button in
the Home header (`#bFriends`), `friendsInviteButtonHtml()` in `renderLobby()`'s room row, and `socialBoot()` at boot.
Presence is derived from the existing state (`G.scene`, `inRoom()`, `NET.code`, `NET.mode`) by a 2 s local check that
sends only transitions; nothing touches the simulation, and invites only call `openOnline()` + `netJoin()`. Without a
backend the Friends button is hidden and a `?friend=` link explains that Friends need the online service.

#### Socials budget (free plan)

Per player who uses Friends, per day (typical: 10 friends, 2 app sessions, 5 matches, 3 invites):

| | Worker requests | DO requests | D1 reads | D1 writes |
|---|---|---|---|---|
| Presence: 2 socket connects (auth reads 1 + 2 × 10 friends) | 2 | 2 | ~44 | 0 |
| Status transitions (~20 messages, billed 20:1) + 3 invites | 0 | ~1 | 0 | 0–3 (offline invites) |
| Heartbeats (auto-response) | 0 | 0 | 0 | 0 |
| 2 socket closes (last seen) | 0 | ~2 | 0 | 2 |
| Opening Friends twice (list) | 2 | 0 | ~42 | 0 |
| Profile publish when level/name/plate changed | 1 | 0 | 1 | 1 |
| One friend add / accept (both sides, with the DO push) | 1 | 1 | ~25 | 2 |
| Sweep alarm (shared by everyone: every 3 min while anyone is online) | 0 | ≤ 480/day total | 0 | ≤ 1 per stale socket |
| **Total** | **~6** | **~6** | **~110** | **~5** |

Next to the rest of the backend (~11 Worker requests, ~3 DO requests, ~7 D1 writes per active player), socials add
about half again in Worker requests; DO requests stay well under the 100,000/day limit (~9,000 social players ≈ 54,000
plus signaling), D1 reads stay tiny next to 5 M, and writes stay far under 100 k. Players who never open Friends add
nothing. Duration is bounded by the single object (see above). Optimizations: hibernation with auto-response heartbeats,
transitions only, no polling anywhere (presence is pushed; the list is refetched only when the server says it changed or
when Friends opens after 30 s), the room code withheld unless joining is allowed, attachments instead of storage for
socket state (no Durable Object storage writes), one D1 batch per socket auth, one write per session for last seen,
offline invites only when the friend is not connected, every query on a primary key or index, caps on lists.

### Ranked & battalions

Code: `src/rb.js` (HTTP routes), `src/queue.js` (the matchmaker, inside the Signal Durable Object), `src/rlib.js` (rating
math, consensus, moderation; unit tested), `migrations/0003_ranked_battalions.sql`; in the client one section,
"ranked & battalions", that hooks in by wrapping functions (no other lines changed). Both need the online account.

**Ranked** (Solo and Duos; the Ranked button on the mode select, a Ranked card in Profile):

- **Queue and matchmaking.** `GET /api/ranked/ws?a=<account id>` opens a WebSocket to the global Signal object; the first
  message `{t:'auth', auth, mode}` is checked against D1 in one batch (secret hash, this and last season's rating,
  callsign, battalion). The queue is the sockets' attachments (no storage writes, survives hibernation). On every join
  and every 3 s while anyone waits (the object's alarm, shared with the presence sweep), the longest-waiting player's
  window is ±150 rating, +25 per second waited (max 800); a lobby forms when it is full (8 humans in Solo, 4 in Duos) or
  when two or more fit and the oldest waited 10 s (`RANKED_WAIT`). The matchmaker writes the pending match to D1
  (`rmatch`, with a snapshot of every seat's rating), then tells the longest-waiting player to host room `code` and the
  others to wait; when the host's PeerJS room is open (`{t:'open'}`) the others get the code and join with the normal
  online flow, so the match itself is the usual lockstep. A host who leaves or never opens a room cancels the match and
  everyone is put back in the queue.
- **Fixed ruleset.** The host's client locks the room: the queue's mode, 30 s turns, no mutators, every region, AI in
  every empty seat at the lobby's difficulty (average rating < 1100 Recruit, < 1500 Veteran, else Elite), and in Duos one
  human per team with an AI partner. It registers who actually joined (`/api/ranked/start`) and starts by itself.
- **Rating (Glicko-lite).** Every pair of humans in the lobby is one game: the better team placement wins, equal is a
  draw; each pair is weighted 1/√(N−1). Each player has a rating r (start 1000) and a deviation RD (start 300, min 60,
  grows 15/day idle up to 350): new players move fast and settle as RD shrinks. Changes are capped at ±200 and applied as
  `r = r + d` (relative), so two matches finishing at once never lose an update. Tiers: Bronze, Silver (1100), Gold
  (1300), Platinum (1500), Diamond (1700), each with divisions III–I, then Stormlord (1900). A tier shows after 5
  placement matches.
- **Seasons.** 8 weeks from 2026-01-05. Ratings are per season and mode; a new season starts halfway back to 1000 with
  RD ≥ 200 (soft reset). Rewards for the peak tier of the last season: a title for every tier, a banner from Gold up
  (granted on the device from `/api/ranked/me`).
- **Leaderboard.** `GET /api/ranked/top?mode=solo|duos[&s=season]`: top 100, cached (isolate memory, Cache API and browser
  60 s; past seasons 1 h). `POST /api/ranked/rank` gives your position when you are not in the top 100.
- **Leavers.** A player who disconnects or abandons is played by AI from their next turn (the existing `{k:'ai'}`
  takeover, executed in sim order, so every client sees it at the same point). The reports list them as `left` and the
  server rates them last, whatever their AI did.

**Result reporting and the threat model.** Every human client reports once: `{mid, h: final simHash, pl: {seat: team
place} for every registered human, left: [seat]}`, or `{bad: 1}` when the start cfg broke the ranked rules (each client
checks mode, turn timer, mutators, bot difficulties, seats and that every player is a matched seat). The report lands
with one `UPDATE … json_set … WHERE the seat has not reported` and is checked against the matchmaker's snapshot (the
seat must belong to the caller's account and be registered). A match is rated when an agreeing group is a strict
majority of all registered humans; otherwise, 60 s after the first report, when an agreeing group is a strict majority of
the reports received; anything else (a tie, a `bad` report, no reports) voids it.

| Threat | Defence |
|---|---|
| Inventing a win, a fake opponent, a match that never happened | matches exist only when the matchmaker made them; seats are bound to accounts in its D1 snapshot; reports need the account secret |
| Picking your opponent (win trading with a second account) | the queue picks the lobby by rating and time; you cannot choose who you get. Two colluders who land together can agree on a fake result: accepted risk (cost: they also need a full lockstep match, and RD makes farming slow) |
| A modded client that plays differently (wallhack aside) or lies about placements | the lockstep makes every client simulate everything; a different simulation gives a different simHash and placements, so its report disagrees and, alone, cannot outvote the others. With two humans the liar can only void the match |
| A host that changes the rules (mutators, easy bots, a long timer) | every guest checks the start cfg and reports `bad` → void |
| Reporting twice / for someone else / after the result | one report per seat (guarded update), seat must be the caller's, the result is fixed once rated |
| Quitting to dodge a loss | the leaver's operative is AI-controlled and listed as `left` by everyone else → rated last. If the leaver keeps playing alone (the host quitting a 2-human match, then finishing vs AI), both reports claim the other left: they disagree and the match is void |
| Replaying old reports, guessing match ids | match ids are 50-bit random and single-use; reports after the result change nothing |

Known limits: two colluding humans in the same lobby can agree on anything; with exactly two humans one player can
void a match (not win it); the client trusts the server's tier only for display; battalion tags and rank badges on name
plates are cosmetic and come from the player's own client (the matchmaker's lobby list, the leaderboards and the
battalion pages come from the server).

**Battalions** (the shield button on Home, the Battalion button in an online waiting room, a card in Profile):

- Create with a name (3–20, unique, case-insensitive), a tag (3–4 letters/digits, unique), an emblem (a name plate
  banner you own as the background + one of 12 glyphs) and a description; open to everyone or invite only. Roles:
  leader, officers, members; up to 30 members (guarded `UPDATE … WHERE n < 30`). Officers invite (by friend code, 7
  days) and remove members; the leader promotes, demotes, hands over leadership and removes anyone; when the leader leaves
  the oldest officer (else member) leads; the last one out disbands it.
- The tag is shown beside the callsign above every operative in matches and in the unit panel. Battalion points per
  member per week: ranked win 10, top half 6, others 3 (from the server-agreed result), first daily challenge of the day
  3. `GET /api/bat/top` is the weekly board (top 50, cached 60 s); `GET /api/bat/get?id|tag` is the public profile page
  (members with roles, weekly points and ranked tier; cached 60 s).
- Chat: `POST /api/bat/say` stores one line in D1 (one write; 160 chars, profanity masked, one line per 1.5 s and 15 a
  minute per account) and the Worker pushes it to the battalion's connected members through the presence socket
  (`{t:'bm'}`); `POST /api/bat/chat {since}` fetches the last 50 (on opening the chat, or every 8 s only while the chat is
  open and the presence socket is down). Lines older than 7 days are deleted by the cron.
- Battalion mates use the presence socket like friends: they see each other online / in a lobby / in a match, and can
  invite each other into an online room from the battalion page (the same invite card as friends; only when the mate is
  connected). Membership changes push `{t:'bx'}` so lists refresh without polling.
- Moderation: names and tags are refused when they contain a word from a small profanity list (leetspeak folded, a
  short allow-list for innocent words); descriptions and chat are masked; chat and invites are rate limited; and
  `POST /api/report {kind: player|bat|chat, target, why, ctx}` stores a report (5 a minute) for a human to read with
  `wrangler d1 execute stormfall --remote --command "SELECT * FROM reports ORDER BY at DESC LIMIT 50"`.

| Endpoint | Does | D1 cost |
|---|---|---|
| `GET /api/ranked/ws?a=` | the matchmaking socket (Signal Durable Object) | auth: ~6 reads; match: 1 insert |
| `POST /api/ranked/me` `{auth}` | season, rating per mode (tier, division, placements left, peak), last season's peaks | ~8 reads |
| `GET /api/ranked/top?mode=&s=` | top 100 (cached) | ≤ 200 reads per miss |
| `POST /api/ranked/rank` `{auth, mode}` | your position and the total | index range count |
| `POST /api/ranked/start` `{auth, mid, sids, teams}` | the host registers who joined (once) | ~5 reads, 1 write |
| `POST /api/ranked/report` `{auth, mid, h, pl, left \| bad}` | one report; `{st: wait \| done \| void, d, r}` | ~6 reads, 1 write (+ the rating writes when it decides) |
| `POST /api/ranked/result` `{auth, mid}` | the outcome for you (decides after the grace period) | ~5 reads |
| `POST /api/bat/create \| me \| join \| leave \| invite \| act \| edit` | battalion management (`act`: kick, promote, demote, lead, decline) | 1–4 reads, 1–4 writes; `me` ~4 reads per member |
| `GET /api/bat/get?id= \| tag=`, `GET /api/bat/top` | public profile, weekly board (cached 60 s) | ≤ 120 / ≤ 100 reads per miss |
| `POST /api/bat/say \| chat` | chat line (pushed live) / fetch since | 1 write / ≤ 50 reads |
| `POST /api/report` | moderation report | 1 write |

D1 tables: `ratings (acct, season, mode)` + index `(season, mode, r DESC)`; `rmatch` (pending → registered → done / void,
seat snapshot, reports, result); `bat`, `bat_mem` (one battalion per account), `bat_inv`, `bat_wk (week, bat)` + index
`(wk, pts DESC)`, `bat_chat (bat, at)`, `reports`. The cron voids matches nobody finished after a day and deletes them
after 30 days, deletes expired invites, chat older than 7 days and weekly rows older than 120 days.

#### Ranked & battalions budget (free plan)

Per ranked match with N humans (D1 counts index entries as rows written; estimates from the queries above):

| | Worker requests | DO requests | D1 reads | D1 writes |
|---|---|---|---|---|
| Queue: socket + auth per human, the match row | N | ~N (messages billed 20:1) | ~6 N | 2 |
| Host registers the match | 1 | 0 | ~5 | 1 |
| Reports (one per human) + ~1 result poll each | 2 N | 0 | ~11 N | N |
| Rating the match: guard + rating upserts (row + index) + battalion points | 0 | 0 | 0 | 1 + 3 N + up to 2 N |
| `/api/ranked/me` after the match | N | 0 | ~8 N | 0 |
| **Two humans** | **~7** | **~2** | **~55** | **~17** |
| **Eight humans** | **~25** | **~8** | **~205** | **~55** |

So about **8–9 D1 writes and ~28 reads per human per ranked match**, plus the queue alarm (one DO request every 3 s, only
while someone is waiting: at most 28,800 a day if the queue is never empty).

Per active player per day (5 ranked matches, a battalion of 20, opening Battalion 3 times, 10 chat lines, the boards):

| | Worker requests | DO requests | D1 reads | D1 writes |
|---|---|---|---|---|
| 5 ranked matches (2–4 humans) | ~20 | ~5 | ~140 | ~45 |
| Battalion: 3 opens (`me` with 20 members) + 1 chat fetch | 4 | 0 | ~250 | 0 |
| 10 chat lines (each pushed through the DO) | 10 | 10 | ~40 | 10 |
| Leaderboards (cached: shared misses) | 3 | 0 | ~0 | 0 |
| **Total** | **~37** | **~15** | **~430** | **~55** |

Writes are the first ranked limit: 100,000 / ~55 ≈ **1,800 heavy ranked players a day** (≈ 11,000 ranked matches);
Worker requests next (with the ~17 of saves, dailies and socials: 100,000 / ~54 ≈ 1,850); reads stay far below 5 M
(~430 × 1,800 ≈ 0.8 M). A typical player who plays one or two ranked matches costs a third of that. Optimizations: the
queue lives in socket attachments (no D1 or storage writes while waiting) and shares the presence object's alarm and
heartbeat auto-response; one batch per queue auth; ratings snapshotted at matchmaking and written once per match as a
relative update (no read before write); one write per report (`json_set` with a guard); boards and battalion pages
cached in isolate memory, the Cache API and the browser; your rank only when you are not in the top 100; chat pushed
over the existing presence socket instead of polled, kept 7 days; membership changes pushed (`bx`), never polled.

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
                      # (the ranked API tests start theirs with --var RANKED_WAIT:1 --var RANKED_GRACE:3: short queue
                      #  wait and report grace; with SF_API=<running worker> start it with the same two vars)
node test/e2e/cloud.cjs                         # browser tests (Playwright + Chromium) against npm run dev
node test/e2e/online.cjs quick 0 veteran spec   # two browsers + a spectator, lockstep over the own signaling DO
node test/e2e/social.cjs                        # two players: friends, presence, invites, join, match in lockstep
node test/e2e/battalion.cjs                     # create / find / join a battalion, live chat, report, invite a mate to a room
node test/e2e/ranked.cjs                        # two players queue, get matched, play in lockstep, both ratings change
```

## Files

- `index.html`: the full game (HTML, CSS and JS in one file)
- `vendor/peerjs.min.js`: PeerJS 1.5.5 (MIT, see `vendor/PEERJS-LICENSE`), used for online play
- `manifest.json`: web app manifest (fullscreen, portrait) for home-screen installs
- `assets/icon-512.png`, `assets/icon-192.png`: favicon / app icons
- `assets/apple-touch-icon.png`: iOS home-screen icon
- `cloudflare/`: the backend (Worker, Durable Object, D1 migrations, build and deploy scripts, tests)
- `.github/workflows/deploy-cloudflare.yml`: deploys to Cloudflare on pushes to `main`
