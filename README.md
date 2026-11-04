# Stormfall · Tactical Royale

A browser tactical battle royale game. Play it solo against AI, or online with friends.

## Play

Open `index.html` in a modern browser. There's no build step or server to run.
Fonts load from Google Fonts. Everything else is in the repo.

Once GitHub Pages is on, it's live at <https://kxdjordan.github.io/Stormfall/>.

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

- Matchmaking uses the free public PeerJS server (`0.peerjs.com`). To use your own
  ([peerjs-server](https://github.com/peers/peerjs-server)), set `window.STORMFALL_PEER = {host, port, path, secure}`
  in a script tag before the game script.
- Connections use public STUN only and no TURN relay. Most home and mobile networks connect. Some strict
  corporate or carrier networks can't.
- All players should run the same version of the page. The lobby rejects mismatched versions.
- Fog of war is enforced on screen only. Each client knows the full game state.

## Files

- `index.html`: the full game (HTML, CSS and JS in one file)
- `vendor/peerjs.min.js`: PeerJS 1.5.5 (MIT, see `vendor/PEERJS-LICENSE`), used for online play
- `assets/icon-512.png`: favicon / app icon
- `assets/apple-touch-icon.png`: iOS home-screen icon
