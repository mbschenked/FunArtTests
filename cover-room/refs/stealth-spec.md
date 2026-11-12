# Stealth spec: Uncharted 4 stealth takedowns, for the cover-room build

Research: 11 Nov 2026, text sources only (no video was downloaded; YouTube downloads were off-limits for this pass). The
only timing numbers come from `refs/stealth-measured.md` (in-page frame reads of gameplay footage by another session) and
are tagged `[MEASURED]` with its video key. Tags: `[DEV]` Naughty Dog developer source, `[WIKI]` guide / wiki,
`[MEASURED]` read off footage, `[INFERRED]` reasoned from those, `[ASSUMED]` my call. Units: meters, seconds, degrees,
Y up (design.md). Code: `src/player/stealth.js` (module), `src/character/animator.js` (poses), every number is a
`stealth.*` param in the tuning panel.

## Summary

1. A stealth takedown is **Square (PC: F) on an enemy who has not spotted you**; it is an instant, silent neck-break
   kill [WIKI]. Valid positions: behind him on foot, behind a wall or a low crate, in tall grass, hanging on a ledge
   below him [WIKI] (Prima). Built here: **rear takedown**, **ledge pull-down**, **cover pull-over** (low cover).
2. **No button icon.** When a takedown is available "Nathan's arm slightly raises" [WIKI] (Gamer Guides, Prima), and
   none was seen in indicator-on footage [MEASURED] (stealth-measured §4, V1). Here the player's free arm lifts toward
   the victim (hanging: he looks up at him). The "[F] Takedown" text exists as a test aid, `stealth.prompt.icon` 0.
3. **Ledge pull timing is measured**: grab → victim over the edge **1.1–1.3 s**, Drake settled back on the ledge
   **1.6–1.8 s** after the grab [MEASURED] (V1 130.97–132.8 s). Built: off the lip at grab + 0.95 s, player free at
   grab + 1.70 s. Rear and cover durations were not measured anywhere: rear 2.0 s, cover 1.95 s [INFERRED].
4. **Noise.** The kill makes no gunshot and no struggle noise [WIKI] "silent" [ASSUMED 0 m]. The body hitting the
   floor is a non-loud noise of **4 m** (ai-spec §1.3 "melee takedown / body fall" [INFERRED]).
5. **AI.** Existing perception and alert states, unchanged. An NPC that sees the act (attacker or victim in his view
   cone with line of sight for 0.15 s, between the press and the kill) **goes to combat** (director.enterCombat). A body
   seen afterwards goes through the brain's own `lookForBodies` → `director.bodyFound` → **everyone searches** [DEV]
   (Chou: bodies are distractions; a found body ends Unaware for good). A body falling into view breaks stealth
   [WIKI] (Prima): the fall is inside the witness window.
6. Not built: drop / vertical takedown (optional in the brief), the helmeted button-mash, the edge kick, grass
   takedowns, the brawl on aware enemies. See open questions.

---

## 0. What all three share

- **Who can be taken down:** alive, not already in a takedown, alert not `combat` (unaware, suspicious, search).
  "Orange means no stealth takedown" is [INFERRED] from the grass rule; no guide states it. Off while aiming a grenade.
- **Pick:** each step, by the player's mode (`ground` → rear, `cover` → cover, `climb` → ledge), the nearest valid
  victim. The cue (arm) follows it.
- **Lock:** the player is in controller mode `takedown` until `T.end` (move, fire, cover and climb input ignored), then
  hands back to `ground`, `cover` (same wall, same s) or `climb` (re-caught on the same edge). No source states a lock
  or a camera change [WIKI: not found]; the camera keeps the mode's profile (explore/combat, cover, climb).
- **Victim:** brain suspended (`alive = false`, `ai.takenDown`, `ai.bodySeen` so nobody "finds" him mid-move); the
  stealth module owns his root path and pose. At the kill `brain.die()` runs and his pose is already the death pose at
  the matching death clock, so the hand-back is seamless. Interrupted before the grab: he carries on unharmed.
- **Events:** `takedown {kind, phase start|grab|kill|impact|end, victim, duration}` (measure logs them), `state`
  `sys: 'stealth'` (player phases), `'stealth.victim'`, `'stealth.witness'`, and `noise {kind: 'bodyfall'}`.

## 1. Rear takedown

**What U4 does.** Walk or run up behind an unaware enemy, press Square: a choke and a neck break, an instant kill
[WIKI] (Prima, fandom Melee, Gamer Guides ch.7). Trophies count them ("Shh Sleep Now", 30) [WIKI] (gamepressure).

**Trigger** [INFERRED]: on foot, victim within **1.6 m**, the player within **±75°** of straight behind him, height
difference ≤ 0.5 m, line of sight at chest (1.2 m) and knee (0.35 m) height (a planter between them blocks it).

**Timeline** (s after the press) [INFERRED]: close in to 0.52 m behind him over **0.2** (grab); choke hold, he claws at
the forearm; neck snap at **1.3** (kill); the player lowers him and is free at **2.0**; he falls forward and hits the
floor at ~**2.25** (4 m noise).

## 2. Ledge pull-down

**What U4 does.** Hang below an enemy standing at the edge, press Square, he is yanked over and falls [WIKI] (Prima,
Gamer Guides ch.7; trophy "Cliffhanger": pull 20 enemies over while hanging). Timing [MEASURED] (stealth-measured §4,
V1): grab → over the edge and highlight gone 1.1–1.3 s, Drake settled back on the ledge ~1.6–1.8 s after the grab.

**Trigger** [INFERRED]: hanging (`hang`, `shimmy`, `reach`, `hangAim`), the victim's feet −0.25…+0.4 m from the lip
height, ≤ 0.8 m back from the lip, ≤ 1.0 m along it.

**Timeline** (s after the press): the free hand reaches up and takes his ankle at **0.35** [INFERRED]; he struggles
(feet dragged 30 %, leaning back) and is pulled over in the last **0.4** before he leaves the lip at **1.3** = grab +
0.95 [MEASURED-derived]; he falls ballistically (1.8 m/s out, 0.7 m/s sideways past the player, 0.6 m/s up,
g 9.81) and turns face-down; the player is back in the hang at **2.05** = grab + 1.70 [MEASURED]. He dies on landing
(6 m in this room: ~1.2 s of flight) and the landing is the 4 m noise. The hanging player keeps anim mode `climb` so the
skin's hang correction applies (character/skins.js).

## 3. Cover pull-over

**What U4 does.** Not documented as its own move: Prima lists "behind a wall" and "crouched behind a low crate" as
takedown positions [WIKI, snippet]. Built per the brief as a pull over low cover [ASSUMED mechanic, INFERRED numbers].

**Trigger** [INFERRED]: in low cover (`in` or `edge`), the victim 0.3–1.6 m behind the wall face (wall 0.55 m + reach),
within 0.9 m along it, line of sight from above the wall top to his chest.

**Timeline** (s after the press) [INFERRED]: rise and take his collar at **0.3**; haul him over the wall top (he goes
over on his back if his back was to the wall, else face-first) and he lands 0.85 m out on the player's side at
**0.95** (4 m noise); kneel beside him, one strike at **1.35** (kill); back in cover on the same wall at **1.95**.

## 4. AI reactions

| case | what happens | source |
|---|---|---|
| another NPC (not in combat) sees the attacker's chest or the victim's pelvis, in cone + LOS, for 0.15 s, between the press and the kill (ledge: the landing) | `state stealth.witness none→saw`, director.enterCombat → combat for all | brief; [ASSUMED] window and time |
| body hits the floor | `noise {kind: 'bodyfall', radius 4}`: hearers within 4 m × hearing go suspicious, investigator + watcher pair (ai-spec) | ai-spec §1.3 [INFERRED] |
| body seen once his move has ended (rear: on the floor + 0.05 s, 1.0 s after the kill; ledge: landing + 0.4 s; cover: the player's end, 0.6 s after the kill) | brain.lookForBodies → director.bodyFound → all search, never back to unaware | ai-spec §1.4, Chou [DEV] |
| the player is seen after the kill | ordinary perception (notice meters) | unchanged |

Runs (seed 1, `refs/frames/stealth/*-board.png`): rear: the guard 2.5 m away hears the fall at 2.25 s after the press,
finds the body 0.13 s later, the room searches. Ledge: the guard 1.9 m from the landing hears it, the second guard is
recruited as the watcher, body found 0.43 s later, search. Cover: a guard 6.3 m away turns toward the wall mid-haul
and sees it, the room goes to combat.

## 5. Params

| param | value | unit | tag |
|---|---|---|---|
| stealth.rear.range / cone / maxDy | 1.6 / 75 / 0.5 | m / ° / m | [INFERRED] |
| stealth.rear.gap / snap / kill / duration | 0.52 / 0.2 / 1.3 / 2.0 | m / s / s / s | [INFERRED] |
| stealth.ledge.back / lateral / dyMin / dyMax | 0.8 / 1.0 / −0.25 / 0.4 | m | [INFERRED] |
| stealth.ledge.grab | 0.35 | s | [INFERRED] |
| stealth.ledge.release | 1.3 (grab + 0.95) | s | [MEASURED] V1 grab → over the edge 1.1–1.3 |
| stealth.ledge.yank | 0.4 | s | [INFERRED] |
| stealth.ledge.duration | 2.05 (grab + 1.70) | s | [MEASURED] V1 settled 1.6–1.8 after the grab |
| stealth.ledge.rise / throw / side / up | 0.25 / 1.8 / 0.7 / 0.6 | m / m/s | [INFERRED] |
| stealth.cover.minBehind / maxBehind / lateral | 0.3 / 1.6 / 0.9 | m | [INFERRED] |
| stealth.cover.grab / over / kill / duration | 0.3 / 0.95 / 1.35 / 1.95 | s | [INFERRED] |
| stealth.cover.land / kneelOff | 0.85 / 0.55 | m | [INFERRED] |
| stealth.noise.bodyFall | 4 | m | ai-spec §1.3 [INFERRED] |
| stealth.noise.struggle | 0 | m | [ASSUMED] silent |
| stealth.witness.time | 0.15 | s | [ASSUMED] |
| stealth.prompt.icon | 0 | – | [MEASURED] none in V1, [WIKI] |
| stealth.reach.time / dist | 0.2 / 0.45 | s / m | [ASSUMED] |
| stealth.gravity | 9.81 | m/s² | physics |
| blend.takedown (animator) | 0.12 | s | [INFERRED] |

## Open questions

1. **Rear and cover durations.** Not measured. The measured noticed front grab (contact → victim down 2.3–2.5 s,
   stealth-measured §4) is a brawl, not this move. Next pass: time press → limp on indicator-on footage.
2. **The cue.** The arm lift is the U4 cue; is it enough on PC without the text? `stealth.prompt.icon` 1 shows it.
3. **Takedowns on suspicious / searching enemies** are allowed (only combat blocks them). U4 lets you re-stealth during
   a search; whether an investigating (yellow) enemy who is looking at you can be taken down is not documented.
4. **Not built:** drop / vertical takedown (works on alert enemies too, instant kill except a helmeted Brute [WIKI]),
   the helmet button-mash, the edge kick (a victim at a drop with nothing below is kicked over [WIKI]), grass
   takedowns and grass hiding bodies, the brawl and counters on aware enemies, the body highlight on discovery [DEV].
5. **Witness window and time** (press → kill, 0.15 s of sight) are mine. Between the kill and the end of the victim's
   move (up to 1.0 s, rear) neither rule fires: the attacker is ordinary perception and the body is not yet "found".
   U4 may count that stretch as a witness too. Closing the window at the kill keeps a guard who turns toward the
   landing noise on the found-body path (search) rather than combat.
6. **Ledge landing camera.** From the hang camera the body lands under the camera (2–3 m out, 6 m down): the GIF follows
   the fall with a look-down but the impact is just out of frame.

## Sources

- Allen Chou (Naughty Dog), U4 AI, 80.lv repost [DEV]: https://80.lv/articles/behind-the-scenes-ai-of-uncharted-4
- Gamer Guides, U4 chapter 7 (Square takedowns, arm raise, ledge and railing pulls) [WIKI]:
  https://gamerguides.com/uncharted-4-a-thiefs-end/guide/walkthrough/chapter-7-2847
- Gamer Guides, trophy guide part 2 (Cliffhanger) [WIKI]:
  https://gamerguides.com/uncharted-4-a-thiefs-end/guide/appendix/trophies-2867/trophy-guide-part-2
- gamepressure trophy list [WIKI]: https://www.gamepressure.com/uncharted4/singleplayer/z689bc
- Prima U4 eGuide, Basics > Combat (search snippets only, page 403) [WIKI]:
  https://primagames.com/eguides/uncharted-4-a-thiefs-end-eguide/basics/combat
- Uncharted wiki, Melee (snippet only, series-wide) [WIKI]: https://uncharted.fandom.com/wiki/Melee
- `refs/stealth-measured.md` §4 (V1 = `m-RM25lpOCs`, ledge pull and noticed grab timings) [MEASURED]
- `refs/ai-spec.md` §1.3 (noise table), §1.4 (bodies); `refs/player-spec.md` §1 (melee = Square / F)
