# Cover Room: design and module contracts

**Status:** v1, 2026-11-11. Written by Claude from Max's request. Decisions marked `[ASSUMED]` are Claude's calls and stand until Max overturns them.

## Intent

Max asked for one room of a level "in Uncharted 4 fashion". The character controls, the gunplay (pistol + grenades), the enemy AI and the climbing should match the game as closely as possible. **The point is to measure how closely the gameplay matches.** So every feel number has a source (GDC talk, footage measurement, wiki) recorded in `refs/*-spec.md`, and the page measures its own timings against those numbers (see "Test seams").

## Boundaries

- **A separate, standalone app** (Max). Everything lives in `cover-room/` and runs if that folder is copied out on its own. Code from `vfx-studies/` is copied in, never imported or linked at runtime. The only outside dependencies are the CDN importmap entries. It is not part of Project Known.

- **Original content only.** The room, the characters, the props and the HUD art are our own. No game assets, character likenesses, names or level layouts. Only mechanics, timings and behaviour rules are matched. The page title and the folder don't use the game's name; the README credits the talks as research sources.
- The Known repo (`~/ClaudeCode/references/project-known-database`, private) is reference only. Nothing from it is copied into this public repo; we paraphrase and cite.

## Goals

1. Player: third-person locomotion, camera, cover (enter, move, corners, pop-up aim, blind fire, swap), roll, jump, mantle.
2. Pistol: aim and hip fire, spread and bloom, recoil, reload, ammo, hit feedback, headshots.
3. Grenades: hold to aim with an arc preview, release to throw, bounce, fuse, blast with falloff. The AI throws them too.
4. Climbing: a climbable wall up to a balcony, with ledges and holds, shimmy, reach/hop, climb-up, drop, and one-handed aiming while hanging (if the spec confirms it).
5. Enemy AI modelled on Naughty Dog's GDC 2017 combat-AI talk: perception and awareness, posts, roles, shooting tokens, accuracy ramp, flanking, grenades, search.
6. The existing tracer and muzzle flash (from `vfx-studies/`) on every shot.
7. One adjustable version: every feel number is a param in the side panel, with copy settings.

## Non-goals (for now)

Melee, more weapons, the rope/grapple, stealth takedowns, a story, audio beyond placeholder clicks [ASSUMED], mobile/touch, multiplayer, save games.

## Anti-goals (a failure even if it "works")

- Floaty or laggy controls: input-to-motion latency must stay at the sim step (16.7 ms) with no smoothing beyond what the spec measures.
- AI that is aimbot-accurate or brain-dead. The accuracy ramp and the shooting tokens are the point.
- Anything that reads as a copy of the game's level or character.

## How it is made [ASSUMED unless noted]

- Three.js r160 + lil-gui 0.19.2 via an importmap from cdn.jsdelivr.net, the same as `vfx-studies`. Plain ES modules, no build step, works on GitHub Pages.
- Local server: `python3 -m http.server 8434 --bind 127.0.0.1 --directory ~/ClaudeCode/FunArtTests-cover-room`, then open `http://127.0.0.1:8434/cover-room/`.
- Units: meters, seconds, radians. Y up. A character's forward is local +Z; yaw 0 faces +Z.
- Fixed simulation step of 1/60 s (`game.dt`). Rendering runs once per rAF after 0–4 sim steps, without interpolation in v1. All randomness goes through `game.rng` (seeded mulberry32), so headless runs repeat.
- Input: keyboard/mouse **and** gamepad (standard mapping), with bindings from a table. Defaults come from `refs/player-spec.md`.
- Character: an **original procedural mannequin** on the SMPL/HumanML3D 22-joint skeleton, animated in code (decided by Max: "mannequin first, mocap later"). The PC generates text-to-motion clips on that same skeleton (branch `cover-room-mocap`); they swap in later behind a toggle through `character/clips.js`.

## File layout and owners

```
cover-room/
  index.html            boot page (A1)
  README.md             (Claude)
  refs/                 design.md (this file), player-spec.md, ai-spec.md, climb-spec.md (research)
  src/
    main.js             boot + system order (A1; Claude integrates)
    core/
      events.js         pub/sub (Claude, done)
      game.js           loop, systems, rng, time scale (Claude skeleton → A1 completes)
      params.js         tunable registry (Claude skeleton → A1 adds GUI, URL ?set, copy settings)
      input.js          action map, KB/M + pad, inject() for tests (A1)
      render.js         renderer + post pipeline + tone map E + grade hook (A5)
      world.js          collision: boxes, capsule move, raycast, sweeps, hitboxes (A2)
    level/
      room.js           geometry, materials, lights, colliders, markup, spawns (A3)
      nav.js            nav graph + A* (A3)
    character/
      skeleton.js       SMPL-22 definition + mannequin mesh (A4)
      animator.js       procedural animator: state → pose, IK, layers (A4)
      clips.js          mocap clip player (later)
    player/  controller.js camera.js cover.js climb.js          (phase B)
    weapons/ pistol.js grenade.js                               (phase B)
    ai/      perception.js posts.js brain.js director.js enemy.js (phase B)
    vfx/     muzzle.js tracer.js impact.js explosion.js         (A5)
    hud/     hud.js hud.css                                     (A6)
    debug/   measure.js overlay.js                              (A1 measure, phase B overlay)
  tests/                standalone test pages per module + node unit tests
  tools/                shoot.mjs (copied from vfx-studies) + play.mjs (scripted input runs)
```

Each agent owns only its files. When you need something from another module that doesn't exist yet, code against the contract below and stub it locally in your test page. Never edit another owner's file; note what you need in your final report.

## Contracts

### `core/events.js`: `game.events`
`on(type, fn) → off()`, `emit(type, payload)`. Event types and payloads (all Vector3 are THREE.Vector3):

| type | payload |
|---|---|
| `shot` | `{shooter, weapon, origin, dir, hit: {point, normal, dist, collider?, actor?, part?} or null, muzzle: {pos, dir}}` |
| `damage` | `{target, amount, source, part: 'head'or'torso'or'limb', dir, kind: 'bullet'or'blast'}` |
| `death` | `{actor, source}` |
| `noise` | `{pos, radius, kind: 'gunshot'or'grenade'or'footstep'or'impact', source}` |
| `grenade:throw` | `{owner, pos, vel}` |
| `grenade:explode` | `{pos, radius, owner}` |
| `state` | `{actor, sys: 'move'or'cover'or'climb'or'weapon'or'ai'…, from, to, t}`: the measurement feed. Every state machine emits this on every transition. |

### `core/game.js`: `game`
```
game.dt (1/60), game.time (sim s), game.frame (sim step count), game.timeScale (debug slow-mo), game.paused
game.rng() → [0,1)
game.scene, game.camera, game.render   (render.js)
game.world (world.js), game.level (room.js), game.input, game.params, game.events, game.hud, game.vfx
game.actors: Actor[]; game.player; game.enemies
game.addSystem({name, order, update(dt, game), lateUpdate?(dt, game), frame?(realDt, game)})
   update: fixed step, ascending order. frame: once per rAF (camera smoothing, HUD, VFX animation).
```
System order: input 0 · player 10 · ai 20 · weapons 30 · projectiles 40 · physics/actors 50 · animation 60 · camera 70 · vfx 80 · hud 90 · measure 100.

### Actor (plain object shape shared by player and enemies)
```
{ id, team: 'player'or'enemy', pos: Vector3 (feet), vel: Vector3, yaw, height: 1.8, radius: 0.35,
  health, maxHealth, alive, rig (character instance), hitboxes (registered with world),
  state: { move, cover, climb, weapon, ai … } }
```

### `core/params.js`: `game.params`
`define(key, default, {min, max, step, label, options}) → value` registers a param. Keys are dotted, and the first segment is the panel folder (`player.run.speed`). `get(key)`. `set(key, v)`. `onChange(key, fn)`. The panel (lil-gui) is built from the registry. `?set=key:val,key:val` applies URL overrides; **Copy settings** copies the JSON; `localStorage` persistence is on per-page (try/catch). Modules read params every step (`P('player.run.speed')`), not once, so live tuning works.

### `core/input.js`: `game.input`
Actions (fixed names): `move` (axis2), `look` (axis2), `aim`, `fire`, `reload`, `grenade`, `cover`, `jump`, `swapShoulder`, `walk`.
`down(a)`, `pressed(a)` (edge this step), `released(a)`, `axis('move') → {x, y}` (deadzone-shaped, |v| ≤ 1; +y = forward), `lookDelta() → {yaw, pitch}` in radians this step (mouse delta × sensitivity, plus pad stick × rate × acceleration × dt), `device` ('kbm' or 'pad', the last used). `inject({actionName: value, …})` overrides real input for the next steps (headless tests); `inject(null)` releases. Pointer lock on click.

### `core/world.js`: `game.world`
```
addBox({center, size, yaw=0}, {tags: Set<string>, material, owner}) → collider       // static solids
addHitboxes(actor, parts: [{bone, a: Vector3 local, b: Vector3 local, radius, part}]) // capsules on rig bones, updated from the rig each step
raycast(origin, dir, maxDist, {ignore: actor or Set, hitActors=true, mask}) → {point, normal, dist, collider?, actor?, part?} or null
sweepSphere(from, to, radius, opts) → hit or null                  // grenades
moveCapsule(actor, delta, {stepHeight=0.35, snapDown=0.3}) → {grounded, groundY, hitWall, wallNormal}  // feet-anchored capsule, move-and-slide
overlapSphere(center, radius) → actors[]
lineOfSight(a, b, {ignore}) → bool
groundAt(x, z, fromY) → y or null
```

### `level/room.js`: `game.level`
```
build(game)                                   adds meshes to the scene and colliders to the world
spawns: {player: {pos, yaw}, enemies: [{pos, yaw, role?}]}
cover: [{id, a, b (Vector3 on the floor at the wall face), normal (out of the wall, toward where the user stands), height: 'low'or'high', top: y, ends: {a: 'corner'or'wall'or'open', b: …}}]
climb: {edges: [{id, a, b, normal (out of the wall), kind: 'ledge'or'top'or'hold', y}], holds: …}
       (final shape comes from refs/climb-spec.md, which proposes the markup format; A3 builds the room so edges are easy to add)
nav: {findPath(from, to) → Vector3[] or null, nearest(pos) → node, nodes, links}
bounds: {min, max}
```
The room [ASSUMED]: an original sunlit stone courtyard of a ruined coastal fort, about 30 × 22 m. Low walls (≈1.0 m) and high pillars/crates (≈2.0 m) for cover, a central low fountain ring, and a fallen column. The north side has a ≈6 m climbable wall with ledges and holds up to a balcony that runs along the north and east sides with a low parapet; enemies reach it by stairs on the east. A mantle block (≈1.2 m) sits near the start. The player starts at the south gate; 3 enemies (param) start in the north half.

### `character/*`: rig
```
const rig = createCharacter(game, {palette: 'player'or'enemy', seed})
rig.root: Object3D (placed at actor.pos/yaw by the animation system)
rig.bones: {pelvis, spine1, …} (SMPL-22 names), rig.getBoneWorld(name, outVec)
rig.socket('hand_r' | 'hand_l' | 'muzzle' | 'head' | 'grenade_hand') → Object3D
rig.update(dt, animState)
animState = {
  mode: 'locomotion'or'cover'or'roll'or'jump'or'fall'or'land'or'mantle'or'climb'or'hitreact'or'death',
  speed (m/s), localVel {x, z}, turnRate,
  aim: {on, yaw, pitch, weight}, fireT (s since last shot, drives the recoil additive),
  action: {type: 'reload'or'throw'or'throwAim'or…, t: 0..1} or null,
  cover: {height, side: -1 or 1, pose: 'idle'or'move'or'popup'or'lean'or'blind'or'enter'or'exit', t},
  climb: {pose: 'hang'or'shimmy'or'reach'or'climbup'or'drop'or'hangAim', handL, handR (world Vector3 targets), dir, t},
  hit: {dir, part, t}, death: {dir, t}
}
```
The controllers own movement (no root motion); the animator only poses. Animation timings are params, defaulted from the research specs.

### `render.js` (A5): `game.render`
`renderer, scene, camera, composer`, `setGrade({saturation, vignette, tint, contrast})` (the HUD's damage look), `addPass(pass)`, `resize()`, `look(name)` (lighting preset), the tone map E path from `vfx-studies`.

### `vfx/*` (A5): `game.vfx`
`muzzleFlash(muzzleObject3D or {pos, dir}, opts)`, `tracer(from, to, opts)`, `impact(point, normal, material)`, `explosion(pos, opts)`. All pooled, no allocation per shot.

### `hud/hud.js` (A6): `game.hud`
`setReticle({mode: 'none'or'hip'or'aim'or'grenade', spread, onTarget})`, `setAmmo(mag, reserve, visible)`, `setGrenades(n)`, `hitMarker(kind: 'body'or'head'or'kill')`, `damage(dirWorld)`, `setHealthLook(0..1)` (calls `render.setGrade`), `awareness(actor, 0..1, state)` (the world-space indicator over enemy heads), `prompt(text or null)`, `toggle(visible)`.

### `weapons/*` (B2): guns and grenades, for both the player and the AI
```
createWeapon(game, owner, kind: 'pistol'or'rifle', overrides) → weapon
weapon.setTrigger(down)             // player path: semi-auto press-to-fire with fire-rate gating
weapon.fireAt(point) → bool         // AI path: fires one round now if able; the AI's accuracy model picks the point (hit or a deliberate near-miss)
weapon.reload() · weapon.update(dt) · weapon.state = {mag, reserve, reloading, cooldown, lastShotT}
   every round emits 'shot' (with muzzle + hit) and 'noise'; hits emit 'damage'
game.grenades.beginAim(owner) / updateAim(owner, aimDir) / release(owner)   // player: hold to aim, release to throw
game.grenades.throwAt(owner, targetPos, {arc: 'high'or'low'}) → bool        // AI: solves the launch velocity
game.grenades.live → [{pos, vel, fuseLeft, owner, radius}]                 // the AI reads this to flee
```

### `player/*` (B1 controller, B3 climbing): mode plug-ins
```
createPlayer(game) → actor (team 'player'); actor.ctrl:
ctrl.mode: 'ground'or'roll'or'air'or'cover'or'mantle'or'climb'or'dead'
ctrl.registerMode(name, {enter(from, ctx), update(dt), exit(to)})
ctrl.setMode(name, ctx)   // emits 'state' {sys: 'move'}
game.climb (B3): canGrab(actor, {fromAir, intentDir}) → grab or null   // the ground and air modes call this on jump / while falling
                 mode impl registered as 'climb'; it writes actor.pos/yaw and actor.anim.climb
game.cameraRig (B1): setProfile('explore'or'combat'or'aim'or'cover'or'climb'or'hangAim', blendS) · yaw, pitch · aimRay(out)
```
Climbing (B3) is a self-contained mode. It reads `game.input`, `game.level.climb` and `game.world`, and drives the actor; B1 only routes into it.

### `ai/*` (B4): enemies
`createEnemy(game, spawn) → actor` (team 'enemy'). `game.ai` is the encounter director: roles, shooter tokens, advance/flank timers and the grenade director. Per-enemy brains handle perception, awareness, posts, shooting and search. `src/ai/debug.js` draws posts with scores, view cones, tokens and roles behind a toggle. The AI reads `game.player` only through the Actor shape (pos, alive, actor.ctrl.mode for cover), so it can be tested against a scripted dummy player.

### `debug/measure.js` (A1): `window.__game`, `window.__measure`
Records every `state` event with `game.time`. `__measure.log()` returns the event list; `__measure.span(sysName, fromState, toState)` returns the durations. Used by `tools/play.mjs`, which runs a scripted input timeline headlessly and prints JSON.

## Test seams

Tests sit only at these seams, and every expected value comes from an independent source (the research specs' measured or stated numbers, or geometry), never recomputed the way the code computes it:

1. **Timing seam:** `tools/play.mjs` + `__measure`: scripted inputs → state-transition durations (roll, cover enter, reload, climb-up, throw-to-explode) compared to the `refs/*-spec.md` values, with tolerance.
2. **Geometry seam:** `world.js` pure-math node tests (capsule slide, step-up, raycast vs box/capsule, sphere bounce) against hand-computed cases.
3. **Visual seam:** each module's `tests/<module>.html?preflight` page, shot with `tools/shoot.mjs`.

## Rules for every build agent

- Write `.html` files with Bash heredocs or a node/python generator, never with the Write/Edit tools: those pop the file open in Max's Browser pane. Test only in headless Chrome via `tools/shoot.mjs` (`arch -arm64 node …`; see `vfx-studies/tools/shoot.mjs`). Never use the Browser-pane tools or the Chrome tools.
- JS/MD/CSS files may be written with Write/Edit.
- Keep the 60 fps budget: no per-frame allocation in hot paths, and pool everything.
- Every feel number goes through `game.params` with its source in a comment (`// player-spec §5 [MEASURED]`).
- Don't commit; Claude commits after integration.

## Not yet specified (fog: blocks nothing, but don't decide it silently)

- Final control bindings (they wait on `player-spec.md`).
- Climb markup format (waits on `climb-spec.md`).
- Audio.
- Difficulty presets.
