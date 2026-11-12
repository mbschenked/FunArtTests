# Vantage, perches and designer hard points

This file covers three systems that sit on top of the post / selector / role frame in `ai-spec.md` §0 and §3–4. It follows Gallant's GDC 2017 talk (G = video timestamp, G-deck = slide page; full source line in `ai-spec.md` Sources). Tags: [DEV] = stated in the talk or deck, [INFERRED] = derived from another spec in this repo, [ASSUMED] = the talk is silent and this is a chosen value.

Code: `src/ai/vantage.js` (new), `src/ai/layout.js` (new), small hooks in `posts.js`, `brain.js`, `director.js`, `perception.js`, `index.js`, `debug.js`, `testbed.js`. Level data: `LAYOUT.hardPoints` and `LAYOUT.posts` in `src/level/room.js`.

## 1. What the talk says, and what we took from it

- **Vantage** (G 17:55–19:24, G-deck p65–68) [DEV]. Two questions: what positions could the player reach with about 3 seconds of movement, and how many of those points can each position see? Positions that see more have better vantage.
- **Vantage did not replace zones** (G-deck p69–72) [DEV]. Naughty Dog tried connectivity plus vantage as an automatic replacement for designer zones and dropped it. The results were inconsistent, they ended up reverse-engineering the high-level decisions, and it limited designers. So this repo does **not** use vantage to place NPCs on its own. It is one more post measure, and the defender's search.
- **Defend search** (G 39:51, G-deck p136 "Vantage Manager" debug panel) [DEV]. Defenders don't walk search splines. They stay in their hard point and look outward from the posts with the best vantage.
- **Post types** (G-deck p46) [DEV]: open (green), cover (orange), perch (teal), climb (purple). Climb posts are not built: enemies rarely climb (`ai-spec.md` §3.1).
- **Perches** (G 11:03, 44:19, G-deck p146–147) [DEV]. They sit on cliff edges and thin railings. The enemy leans out to aim down at a player climbing below.
- **Hard points** (G 24:51–27:28, G-deck p88) [DEV]. Five fields: name, zone region, min, max, on/off. Designer posts join the same pool as generated ones and are scored the same way (Chou, `ai-spec.md` Sources).

## 2. Vantage

**Reach set** (`VantageManager.rebuild`). A path-distance field from the LKP's nav node, out to R = `reachTime × speed` = 3.0 s × 4.8 m/s = 14.4 m of path. `sampleReach` (pure, unit-tested) sorts the reached nodes into `sectors` bearings × `rings` path-distance bands. Ring k targets R·(k+1)/K. Each bucket keeps the node nearest its target. The result is up to 8 × 2 points plus the LKP itself, raised `pointH` = 1.0 m (player torso). The set is rebuilt only when the LKP moves ≥ `resample` 2 m, and each rebuild bumps a generation counter.

**Per-post vantage** (`compute`). One static ray from the post's fire point to each reach point: `post.vantage` = share visible (0..1), `post.vBits` = which ones. The result is cached against the generation (`post.vGen`), so a post is measured once per reach set. Rays come from their own budget, `ai.budget.vantageRays` (64 per step), separate from the selector's line-of-fire rays. There are two consumers:
- Post queries (`PostQuery.step`, `measureVantage`) measure a candidate on demand when the selector uses the term.
- A background sweep after the queries (`sweep`). It measures every live NPC's current post first, then posts inside enabled hard-point regions round-robin. This keeps the defender trigger and the debug colours warm.

**In the score** (`posts.js`). `vantage` is a 0..1 term through the curve `ai.posts.curve.vantage` (0 → 0.15, 0.3 → 0.7, 0.6 → 1) in the existing weighted geometric mean. If a post has no measurement yet (no LKP, or the cache is stale) the term is left out of the weight sum, so it never blocks a decision. Weights:
- `defend` 2: the defender's main use, G 39:51.
- `engage` and `advance` 0.5: light, because the talk dropped vantage as a placement driver.

**Defend search in combat** (`selectorFor`, [ASSUMED]: the talk only describes it in search). Trigger: a defender is at a post whose measured vantage is < `min` 0.15, and it has had no line of fire for `lostT` 2 s. It then runs the `defendSearch` selector: posts inside its own hard point, filter `mustVantage`, terms vantage 3, path 1, cover 1, high 0.5. It is forced, so it ignores the min-dwell at a post. That way a defender who can no longer see where the player can be moves to a post inside its zone that can. It returns to plain `defend` in three cases:
- it has a line of fire again;
- it stands at a post with vantage ≥ `min`;
- no post in its zone has vantage (it retries after `lostT`).

**Defend search in search** (`searchStep`, [DEV] G 39:51). When the director drops to search, defenders with a hard point are not given a search loop (`assignSearch` skips them). Each one runs `defendSearch` inside its zone and then looks outward: `ai.lookAt` cycles over the reach points its post can see, `lookDwell` 1.5 s each.

## 3. Perches

**Generation** (`layout.js addPerchPosts`, at load):
- **Rail perches**: generated low-cover posts whose far side drops ≥ `minDrop` 2.5 m (`convertRails`). They stay cover-like for normal fights (pop-up `fire` point) and gain a `perchFire` lean-out point, `leanPast` 0.25 m beyond the rail and `railUp` 0.3 m above it. In this room these are the rampart crenels and the stair rail: 27 posts.
- **Ledge perches**: open edges with a drop (`addLedges`). Probe `ledgeProbe` 0.8 m past each nav edge, spaced `ledgeSpacing` 1 m. Lean point = fire point. In this room, 9 are generated, at the climb gap and along the west edge of the stair.

**When an NPC perches** (`selectorFor` → `perch` selector, [ASSUMED] thresholds). It applies to engagers and defenders, and all three must hold:
- the LKP is ≥ `below` 2 m under the NPC's floor;
- the LKP is within `near` 4 m (2D) of a perch's lean point;
- the NPC has had no line of fire for `noLof` 1 s.

This is the talk's case: the player climbs below a balcony defender (G-deck p146). The `perch` selector takes perch posts only (in the NPC's hard point if it is a defender), gathers them nearest the target, requires a clear shot from the lean point (`leanFire`, `mustShoot`), and scores range (curve 0–6 m → 1, 15 m → 0.4), path and cover. A failed query waits `retry` 3 s. Perch mode ends when the player is no longer below, or when combat ends.

**In perch mode** the eye and muzzle move to `perchFire` (`perception.js npcEye`, `brain.js firePoint`). The downward half-angle of the view cone opens to `lookDown` 88°, so it can see straight down the wall. Ledge perches are only used by the `perch` selector. Other selectors reject them, so NPCs don't idle at drop edges.

**No lean animation.** `src/character/*` is out of scope for this work. The rig plays the cover pop-up while its eye and muzzle sit at the lean point. A lean-out clip is the missing piece.

## 4. Designer hard points and posts

Level data (`src/level/room.js LAYOUT`, copied to `level.hardPoints` / `level.posts` by `buildRoom`):

```js
hardPoints: [
  { id: 'hp-north-rampart', name: 'north rampart', min: 0, max: 1,
    region: { y: 6, poly: [[-10, -11.2], [9, -11.2], [9, -7.9], [-10, -7.9]] } },
  { id: 'hp-stair-foot', name: 'stair foot', min: 0, max: 1, region: { y: 0, poly: [...] } },
  { id: 'hp-climb-foot', name: 'climb foot', min: 0, max: 1, enabled: false, region: { y: 0, poly: [...] } },
],
posts: [
  { id: 'climb-top', type: 'perch', pos: [-7.5, 6, -8.4], face: [0, 1], hardPoint: 'hp-north-rampart' },
  { id: 'stair-watch', type: 'open', pos: [13.5, 0, 5.5], face: [-1, -0.4], hardPoint: 'hp-stair-foot' },
]
```

- **Regions** (`normalizeRegion`, `regionContains`, `regionDist`). A region is a polygon on a floor `{y, poly}` or a circle `{center: {x, y, z}, radius}` (a bare point `{x, y, z}` gets radius 4). Containment means the same floor (within 1.5 m) plus an even-odd polygon test. `regionDist` is 0 inside, otherwise 2D distance to the centre plus |dy|. Role assignment uses it ("closest suitable NPC", G 33:11).
- **Hard points** (`loadHardPoints`). Fields follow G-deck p88: `id`, `name`, `region`, `min`, `max`, `enabled`. The director's assignment order is unchanged (`ai-spec.md` §4.1): fill each enabled hard point to min, then the roles, then top hard points up to max. Auto hard points sit alongside the designer ones: each overwatch spawn still gets a 4 m auto hard point (min 1, max 1), unless an enabled designer zone already contains it. In this room enemy2 spawns inside the north rampart, so it holds that zone and gets no auto one. Disabled hard points are drawn grey and ignored.
- **Designer posts** (`addDesignerPosts`). Posts are snapped to the nav, and any generated post within `designerClear` 0.75 m is dropped. Then they are renumbered into the same pool and scored the same way. A perch gets its drop probed (0.3 m further out, to skip climb holds). Optional tags filter who may use them: `hardPoint` (only an NPC holding that hard point) and `roles` (e.g. `['defender']`).
- **The room's choices**:
  - **north rampart**: the walkway over the climb, held by the overwatch spawn.
  - **stair foot**: the stair route up, filled by a leftover NPC.
  - **climb foot**: disabled, to show the on/off toggle.
  - Designer posts: a perch over the climb gap, and an open watch post at the stair foot facing the yard.

## 5. Params

All are live `game.params` (`src/ai/tuning.js`). The talk gives only the 3 s reach and the post types and perch rule. Every number below the reach time is a chosen value.

| param | value | what | tag |
|---|---|---|---|
| `ai.vantage.on` | true | vantage term + defend search | [ASSUMED] debug switch |
| `ai.vantage.reachTime` | 3.0 s | player reach horizon | [DEV] G 18:52, G-deck p66 |
| `ai.vantage.speed` | 4.8 m/s | player run speed | [INFERRED] player-spec |
| `ai.vantage.sectors` / `.rings` | 8 / 2 | reach sample buckets | [ASSUMED] |
| `ai.vantage.pointH` | 1.0 m | reach point height | [ASSUMED] |
| `ai.vantage.resample` | 2.0 m | LKP move that rebuilds the reach set | [ASSUMED] |
| `ai.vantage.min` | 0.15 | below this a post has no vantage | [ASSUMED] |
| `ai.vantage.lostT` | 2.0 s | no line of fire before combat defend search | [ASSUMED] |
| `ai.vantage.sweep` | true | background sweep | [ASSUMED] |
| `ai.vantage.lookDwell` | 1.5 s | look time per reach point in search | [ASSUMED] |
| `ai.budget.vantageRays` | 64 /step | vantage ray budget | [ASSUMED] |
| `ai.posts.curve.vantage` | 0:0.15, 0.3:0.7, 0.6:1 | vantage → score | [ASSUMED] |
| `ai.sel.defend.vantage` | 2 | weight | [ASSUMED] weight, [DEV] use G 39:51 |
| `ai.sel.engage.vantage` / `advance.vantage` | 0.5 / 0.5 | weight | [ASSUMED] |
| `ai.sel.defendSearch.*` | vantage 3, path 1, cover 1, high 0.5 | weights | [ASSUMED] |
| `ai.sel.perch.*` | range 1, path 1, cover 0.5 | weights | [ASSUMED] |
| `ai.posts.curve.perch` | 0:1, 6:1, 15:0.4 | 2D range to player → score | [ASSUMED] |
| `ai.posts.perchScore` | 0.6 | ledge perch cover score (open 0.4, cover 1) | [ASSUMED] |
| `ai.posts.designerClear` | 0.75 m | designer post clears generated posts | [ASSUMED] |
| `ai.perch.on` / `.rails` | true / true | perch posts; rails over drops are perches | [DEV] G-deck p46, p147 |
| `ai.perch.minDrop` | 2.5 m | drop that makes an edge a perch | [ASSUMED] |
| `ai.perch.leanPast` / `.railUp` | 0.25 / 0.3 m | lean point past and above the rail | [ASSUMED] |
| `ai.perch.ledgeProbe` / `.ledgeSpacing` | 0.8 / 1.0 m | ledge generation | [ASSUMED] |
| `ai.perch.eye` | 1.35 m | leaning eye height | [ASSUMED] |
| `ai.perch.below` / `.near` | 2.0 / 4.0 m | perch trigger: player below by / within of an edge | [ASSUMED] |
| `ai.perch.noLof` / `.retry` | 1.0 / 3.0 s | perch trigger delay / failed-query retry | [ASSUMED] |
| `ai.perch.lookDown` | 88° | downward view half-angle while leaning | [ASSUMED] |

## 6. Debug overlay (F2)

- Posts: teal rings = perches, with a tick to the lean point. Gold diamonds = designer posts.
- Hard-point outlines: gold = designer, blue = auto, grey = disabled. Each has a label: id, min, max, enabled, and the defenders holding it.
- Reach points as small octahedra: red = LKP, green = seen from an NPC's post, grey = unseen. Green sight lines run from each NPC's fire point.
- NPC labels add `@zone`, `SEARCH` (defend search), `PERCH`, and `post id type ◆designer vant x`. The director panel has a vantage line: reach radius, point count, generation, perch count.

## 7. Tests

- Unit (`tests/ai.test.mjs`, node): regions, hard-point loading, perch generation on a fake world, `sampleReach` on a line (ring targets 7.0 / 14.0 m), the vantage term and `defendSearch`, perch selector rules (ledge vs rail), and designer tags.
- Scenarios (`tests/ai.html?test&scenario=…`, headless via `tools/play.mjs`, real room). Each check is backed by fresh raycasts, not the cached values:
  - `perch`: the player climbs under the north-rampart defender. Perch mode 1.33 s after the climb; the shot from the lean point is clear; 13 shots fired from it.
  - `vantage`: the stair-foot defender's post sees 0 of the player's new reach. It relocates inside its zone within 0.97 s, to a post with vantage 0.69. In search it walks no loop and looks in 3 directions.
  - `vantageDwell`: the same with min-dwell 30 s, so only the combat defend search can move it. It triggers 2.42 s after the move and relocates at 2.97 s.
- Evidence (git-ignored): `refs/frames/ai/ai-perch.gif`, `ai-vantage-relocate.gif`, `ai-vantage-board.png`.

## 8. Not done / open

- No lean-out or look-over-the-edge animation (§3).
- The combat defend-search trigger and every threshold in §5 tagged [ASSUMED] are guesses to tune in play.
- Vantage counts a reach point as seen with one static ray to torso height, not a body-coverage test.
- The scenarios script the player's moves (place / combat / search keyframes) instead of driving input.
- Climb posts (purple) are not generated. Enemies don't climb here.
