# LAST CORDON

**Created by Slim ABASSI** ([@absslouma](https://github.com/absslouma)) · © 2026 · All rights reserved

An original 3D third-person battle royale that runs in the browser. Twenty operators parachute
onto a tropical island, loot, fight, and get squeezed together by a shrinking energy barrier
(the Cordon) until one is left. Every model, texture, particle and sound is generated in code:
there are no image, audio or 3D asset files, and nothing is fetched from the internet at runtime.

## Play

Double-click **`start.bat`** (Windows). It starts a tiny local server and opens the game.

Or from a terminal:

```
npm start
```

Requires Node.js and a browser with WebGL2 (current Chrome, Edge or Firefox).

## Play on your phone

1. Start the game on the PC (`start.bat`). The window prints a line like
   `On your phone:  http://192.168.x.x:5173/`.
2. On a phone connected to the same Wi-Fi, open that address in Chrome or Safari and hold it sideways.
3. The first time, Windows Firewall asks whether Node.js may accept connections: allow it on
   **private networks**. If the phone cannot connect, that is almost always the cause.

Phones get on-screen controls automatically: the left thumb moves (push fully forward to sprint),
the right thumb drags to look, the big red button fires (slide it to keep aiming), and the ring
around it has Aim, Jump, Reload, Crouch, Wall and Heal. Tap a weapon name at the top to switch and
the minimap for the full map. Look speed can be set on the menu. Add `?touch=1` or `?touch=0` to the
address to force touch controls on or off.

## Multiplayer on your network

One PC runs the game server (`start.bat`); everyone else, on PCs or phones on the same Wi-Fi,
opens the address it prints.

1. Press **Multiplayer** on the main menu and pick a name.
2. One player types a room name and presses **Create room**. Everyone else sees it in
   **Rooms on this network** and presses **Join**. A room holds up to **20 players**.
3. The host chooses whether empty slots are filled with bots (on by default, so a match always
   has 20 operators) and how good those bots are, then presses **Start match**.
4. When the match ends, **Back to room** returns everyone to the room for a rematch. People who
   join while a match is running wait in the room and play the next one. If the host leaves,
   someone else becomes host; if a player drops out mid-match, a bot takes over their operator.

The match runs on the server PC, so everyone sees the same fight. Your own movement is predicted
on your device so it responds instantly, and your shots are checked against where the other
players were on your screen, so you hit what you aimed at even on Wi-Fi.

## Controls

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| W A S D | Move / steer the parachute | Mouse | Look |
| Shift | Sprint | Left click | Fire |
| Space | Jump | Right click | Aim down sights / scope |
| C | Crouch (toggle) | R | Reload |
| G | Deploy a Bulwark wall | 1 2 3 / wheel | Switch weapon |
| H | Use a medkit | M or Tab | Full map |
| Esc | Pause (click to resume) | F3 | Performance readout |

Walk over glowing crates to pick them up. Beam colour tells you what is inside:
orange and red are weapons, white is ammunition plus a Bulwark charge, blue is armour, green is a medkit.

## The game

- **Match**: you and 19 bots. The Cordon closes in six stages and is fully shut at 7:20, so every
  match ends by then. Across 30 simulated matches the final fight landed between 5:27 and 6:41.
- **Weapons**: WARDEN assault rifle (balanced automatic), HORNET submachine gun (fast, close range),
  LANCE sniper rifle (one heavy round, scope on right click). Hitscan with spread, bloom and recoil.
- **Bulwark**: G throws up an instant curved energy wall. It blocks movement and bullets for both
  sides, cracks as it takes damage, and dissolves after 24 seconds. Bots use it too.
- **Bots** loot what they need, rotate into the Cordon, strafe and take cover, throw walls when shot,
  and fight each other as well as you. Opposition level is set on the menu.
- **Feedback**: floating damage numbers (yellow, red for headshots), hitmarkers, damage direction
  arcs, a rotating minimap with the Cordon rings and gunfire pings, kill feed, alive counter.

## How it is built

```
index.html            page shell, HUD markup and styles, import map
server.mjs            static file server; also hosts multiplayer rooms (WebSocket at /ws)
src/sim/              the match itself: pure JavaScript, no DOM, no rendering
  world.js              island generation, collision volumes, navigation grid
  game.js               actors, movement, hitscan combat, loot, walls, the Cordon, pacing director
  bots.js               bot perception, decisions and steering
  nav.js                grid A* with door portals
src/render/           three.js view of the simulation
  core.js               renderer, sky, atmosphere, shadows, HDR post chain, auto quality
  textures.js           every texture, synthesised from noise
  world3d.js            terrain, sea, buildings, vegetation
  characters.js         instanced soldiers posed with two-bone IK
  effects.js            particles, tracers, Bulwark shader, loot beacons, the Cordon
src/net/              multiplayer: rooms.js (server), client.js (prediction, interpolation), protocol.js
src/hud.js, audio.js, input.js, touch.js, lobby.js, main.js
tools/                verification and debugging scripts
```

The simulation is deterministic for a given seed and runs without a browser, which is what makes
the pacing testable: `tools/simtest.mjs` plays whole matches in under a second each.

three.js is the only library the page uses; the server adds `ws` for multiplayer. Both are
installed locally under `node_modules` (start.bat does this on first run).

## Verify

```
npm run verify      # 63 end-to-end checks in headless Chrome, screenshots written to ./shots
npm run simtest     # 30 full matches in Node: length, single winner, no stuck or invalid actors
npm run touchtest   # 30 checks of the phone controls in an emulated phone with multi-touch input
npm run mptest      # 35 multiplayer checks: 3 real game clients (one a phone) + 17 network clients in one room
```

`verify` drives the real page with keyboard and mouse events and fails on any console error,
warning or failed request. Add `--quick` to skip the full accelerated match at the end.

Other tools: `tools/tour.mjs` (screenshots and frame cost at set viewpoints),
`tools/profile.mjs` (frame cost with parts of the scene switched off),
`tools/worldtest.mjs` (top-down debug map of the island).

## Useful URL options

`?q=low|medium|high|auto` graphics preset, `?seed=123` fixed match seed,
`?auto=1` let a bot play your operator, `?speed=4` run the simulation faster.

## Author and license

LAST CORDON was created by **Slim ABASSI**, built with Claude (Anthropic) in Claude Code.

Copyright © 2026 Slim ABASSI. All rights reserved. The code is public so it can be seen; it is
**not open source**. You may not copy, modify, redistribute or reuse it, or any part of it,
without written permission. See [LICENSE](LICENSE) for the full terms.
