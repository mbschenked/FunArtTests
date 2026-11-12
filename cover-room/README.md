# Cover Room

One courtyard of a ruined fort, playable in the browser as a third-person cover shooter. It is a study of how closely a web build can match the player and enemy mechanics of Uncharted 4: movement, cover, the pistol, grenades, climbing, stealth takedowns, the HUD, and enemy AI built from Matthew Gallant's GDC 2017 talk on the game's AI.

Every timing and distance that is meant to match the game is a tunable param, tagged in the code and in `refs/*-spec.md` by where it came from:

| tag | meaning |
|---|---|
| `[DEV]` | stated by the developers (GDC talk, interviews) |
| `[MEASURED]` | measured frame by frame from gameplay footage |
| `[WIKI]` | from a wiki or a controls page |
| `[INFERRED]` / `[ASSUMED]` | our call where no source gives a number |

The app is self-contained. Everything it runs is in this folder, and nothing is loaded from the other studies. The characters are the CC0 Quaternius "Ultimate Modular Men" figures (`assets/figures/`). The room, HUD and effects are original.

## Run it

There is no build step. Serve the repository root (the folder above this one) over HTTP and open the page:

```bash
python3 -m http.server 8434 --bind 127.0.0.1
```

Then open <http://127.0.0.1:8434/cover-room/>. Click the page to capture the mouse.

Three.js r160 and lil-gui load from a CDN through the import map in `index.html`, so the first load needs a network connection.

### Query flags

| flag | effect |
|---|---|
| `?set=key:value,key:value` | override any param, e.g. `?set=ai.count:0` for an empty room |
| `?seed=N` | fix the random seed (the seed is logged to the console on boot) |
| `?test` | headless mode for the tools below: no pointer lock, the sim only advances when stepped |
| `?skip=hud,ai` | boot without those modules |

## Controls

| action | mouse and keyboard | gamepad |
|---|---|---|
| move | W A S D | left stick |
| look | mouse | right stick |
| aim / fire | right mouse / left mouse | L2 / R2 |
| grenade (hold to see the arc and blast radius, release to throw) | G | R1 |
| cover, or roll in the open | Left Shift | Circle |
| jump, climb; swap shoulder while aiming | Space | Cross |
| reload | R | Triangle |
| stealth takedown on an enemy who hasn't spotted you: from behind, from cover, or pulling them off a ledge you hang from | F | Square |
| walk | C (Left Ctrl also works on macOS) | light stick push |

Debug keys:

| key | effect |
|---|---|
| `` ` `` | tuning panel: every param, plus Copy settings and Reset all |
| F2 | AI debug overlay: post scores, sight cones, roles, paths, last known position, director state |
| H | hide or show the HUD |
| P | pause; `.` steps one sim frame while paused |
| `[` / `]` | slow down / speed up time |

Param changes made in the panel are saved in the browser. **Copy settings** puts the changed values on the clipboard as JSON, and the console also prints them as a `?set=` string.

## Tests

Unit tests for the world geometry, climbing, weapons, player health and AI (Node 22+, no install):

```bash
node --test tests/*.test.mjs
```

Each `tests/*.html` page shows one module on its own (character, climb, hud, vfx, weapons, ai, level, world). Open it through the same server, e.g. <http://127.0.0.1:8434/cover-room/tests/hud.html>.

### Headless timing runs

`tools/play.mjs` drives headless Chrome and steps the fixed 60 Hz sim one frame at a time. Runs do not depend on wall-clock time, so the same timeline always gives the same frames and the same measurements:

```bash
node tools/play.mjs "http://127.0.0.1:8434/cover-room/index.html?test" timeline.json --out frames/
```

A timeline is a JSON list of `{t, inject, shot, eval}` entries: at sim time `t` it injects input, saves a screenshot and/or evaluates a page expression. The output is one JSON line with console errors, the `__measure` event log (state changes, shots, damage) and the eval results. `tools/shoot.mjs` takes a single screenshot of any page.

On an Apple Silicon Mac whose default `node` is an x86_64 build (e.g. from Anaconda), run the tools as `arch -arm64 node …`. Otherwise headless Chrome starts under Rosetta and is slow.

## Layout

```
index.html            the game page
src/main.js           boot: loads and installs each module in dependency order
src/core/             game loop (fixed 60 Hz), events, params + panel, input, render, collision world
src/level/            the courtyard, cover edges, climb holds, nav mesh
src/character/        SMPL-22 skeleton, animator, procedural clips, CC0 figure skins
src/player/           controller, camera rig, cover, climbing, health, stealth takedowns
src/weapons/          pistol and grenades (shared by the player and the AI)
src/ai/               perception, brains, roles, posts, director, shooting, F2 overlay
src/vfx/              muzzle flash, tracer, impacts, explosion
src/hud/              reticle, ammo, damage, awareness markers, prompts
src/debug/measure.js  window.__game and window.__measure for tests
tests/                per-module pages and node tests
tools/                play.mjs, shoot.mjs
refs/                 design contract (design.md) and the research specs
```

`refs/design.md` is the contract between modules: who owns which file, the event and actor shapes, and the test seams. The specs (`refs/player-spec.md`, `refs/ai-spec.md`, `refs/climb-spec.md`, `refs/stealth-spec.md`, `refs/stealth-measured.md`) hold the reference numbers and their sources. Frames and GIFs from the reference footage and from test runs go to `refs/frames/`, which is not committed.
