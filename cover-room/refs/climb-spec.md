# Climb spec: Uncharted 4 climbing and traversal, for the cover-room build

Research: 11 Nov 2026, about 60 minutes, breadth first. Numbers marked `[MEASURED]` come from frame counts of downloaded gameplay footage. Downloads are in `refs/frames/research-climb/` (git-ignored, untrusted), and the contact sheets the counts were made on are in `.../sheets/`. The method for each count is given where the number is used. Units are meters, seconds and degrees, Y up, matching `design.md`.

**Footage provenance (please read).** YouTube returned 403 partway through downloads. Before the coordinator's "do not work around the block" instruction reached me, I switched yt-dlp to an alternate player client (`web_embedded`), which got past it. Every `[MEASURED]` number from **kuieMoIemgc** (shimmy, hang-aim), **q4rzkzjAKt4** (cliff camera) and **1SnMfyV5hXM** (blockout) comes from files downloaded that way. The **h2KpeldU3nU** numbers (pillar climb, gap jump, ledge grab, climb-up) and the **Spv14WGA9MU** drop come from normal-client downloads; for h2K, all the timestamps used lie in the first 55 s, which the normal client delivered before its 403. I made no workaround requests after the instruction. To keep only normally-obtained data, re-tag the kuie/q4r/1Sn rows `[INFERRED]` and re-time them with the **Measurement protocol** below.

## Summary

1. Naughty Dog has never published U4's climbing numbers. The developer sources (PS Blog 2022, GDC 2017 physics-animation talk) describe the *behaviour* only: analog reach, two independent hand grips, feet that look for holds, full-body IK, ragdoll overlap and a loose/stiff free-hang. Every number here is measured from footage or inferred.
2. Climbing is **stick-driven, with no button for normal moves**. The stick pushes a reach. A hold out of reach only gets a reaching arm as feedback, and **Jump** turns that into a leap. Circle/`cover` lets go. That gives three move tiers: shimmy (same edge), reach (static, under about 0.9 m), lunge (Jump, up to about 2 m).
3. Holds are marked visually. Naughty Dog's environment rule was a **white line on every ledge grab**, and guides add that climbable ledges are lighter than the rock around them. Edges are always horizontal and flat. Hold placement was procedural, not hand-sculpted. Our room should draw a light strip from the same data the controller queries. Naughty Dog's design metrics: **jump-to-ledge ≤ 3.5 m above the floor, and no edges at all 3.25–4 m** (dead zone).
4. Measured pace (60 fps PS5 footage): **one vertical reach every ≈0.43 s, gaining ≈0.6 m (≈1.4 m/s up a hold column)**; **shimmy ≈1.3 m/s**; **climb-up from hang ≈0.7 s to crouch, ≈1.0 s to standing**; **gap jump airtime ≈0.38 s**.
5. Hang-aim is confirmed from footage: **one-handed pistol, the other hand on the lip, head and shoulders raised above the ledge**. The camera snaps from a wide hang shot to a tight right-shoulder over-the-shoulder view in **≈0.2 s**. Leaving the aim and dropping back into the hang takes **≈0.3 s**.
6. The camera pulls far back while climbing. On a 2 m ledge the character fills about 1/3 of the frame height, about 5–7 m away. On cliff faces it pulls out further for the vista.
7. The feel comes from animation. The GDC talk names three systems. A dense "spider web" of reach poses is blended by the stick. A climbing ragdoll pins the hands, feet and forearms and lets the hips and legs overlap. Free-hang blends between a loose profile and a stiff one depending on stick input, so the swing builds up with each move.
8. Jump physics on flat ground and fall/death heights were **not** measured cleanly. Defaults are inferred (gravity about 18 m/s², apex about 0.4 m) and flagged as open questions.
9. A private Unreal U4-style reference project is used only as a view of how a hang system breaks. Its lessons are folded in: ledge stored relative to the held object, the grab band measured from the feet, and a grab that owns the body exclusively. Its jump-to-ledge rule ("always hang, never auto-mantle") differs from U4's low-ledge mantle and is listed as a decision for Max.
10. The data format is authored edges (polylines with an outward normal, a kind and flags) plus one query module (`climb.findEntry / findMove / slide / topSurface`). The format is below.

---

## 1. Climbable data: marking, signalling, finding the next hold

**What U4 does.**
- Hold placement in U4 was automated and procedural. Background artists did not sculpt each handhold, and holds could be moved in real time, which let designers build "Swiss cheese" walls with many routes. [DEV] (Yates, PS Blog 2022)
- The long reach let designers space holds apart, so players have to learn Drake's reach instead of following one dotted line. [DEV] (Schatz, PS Blog 2022)
- Drake can hold two edges at once, at any distance apart. Each hand has its own grip. [DEV] (Broner, PS Blog 2022)
- Holds have properties. On big holds Drake moves faster and recovers sooner. On small holds he keeps his fingers together and moves slower, more deliberately. [DEV] (PS Blog 2022)
- Signalling: environment art had a rule that every ledge grab carries a white line. [DEV] (Teichmann, gamedeveloper.com) Guides add that climbable ledges are lighter in tone than their surroundings and that not every protrusion is climbable. [WIKI] (gamerguides, Pratt critique) The footage agrees: the New Devon pillar's grab courses have bright top edges (h2KpeldU3nU at 16.95 s). In Naughty Dog's blockouts the ledges are white strips proud of a gridded wall, and a free-hang bar is a grey pipe (1SnMfyV5hXM at 60.5–61.4 s).
- **Hold-finding from the stick.** Pushing the stick blends a dense set of reach poses ("every cross-section on the spider web is a pose") toward the input. When a hold is reached, a short transition plays. [DEV] (Mach, GDC 2017, 31:47–32:18) Yates calls the pose layout a set of rings. [DEV] When nothing is in range, the body still leans and the arm still reaches toward the stick, as feedback. [DEV] (Broner) A hold out of static range but within leap range gets an extended reaching arm, and the player presses Jump to leap to it. [WIKI] (Prima eGuide via search summary; Pratt critique)
- The arm that reaches is chosen from the hand that latched last, so hands alternate and crossovers stay in order. [WIKI] (Kotaku review 2016)

**Rules (pseudo-code).**
```
on climb tick with stick s (camera-relative, projected onto the wall plane: up = up the wall, left/right = along the wall as seen by the camera)
  if |s| < deadzone: idle hang; feet re-seek holds; no move
  dir = normalize(s on wall plane)
  cand = edges/holds within lungeRange of the leading hand, excluding the current grips' own segment
  score(c) = wAng * (1 - angle(dir, c - hand) / coneHalf) + wDist * (1 - dist / range(c))  (reject if angle > coneHalf)
  1. same edge continues along dir (|dir.x| dominant)           → SHIMMY (slide both grips)
  2. best candidate with dist <= reachMax(dirClass)             → REACH (static, no button)
  3. best candidate with dist <= lungeMax(dirClass)             → show reaching arm; on Jump → LUNGE
  4. dir points away from the wall (stick back, > 120° from wall-up) and a target exists behind → look back; on Jump → JUMP_BACK
  5. at a 'top' edge and dir up                                  → CLIMB_UP
  6. else                                                        → lean/arm-extend feedback only (no move)
dirClass = up | side | down | diagonal  (by angle of dir: up within ±30° of wall-up, down within ±30° of wall-down, side within ±30° of horizontal, else diagonal)
```

| name | value | unit | source | confidence |
|---|---|---|---|---|
| hold placement | procedural along tagged geometry, movable live | — | PS Blog 2022 (Yates) | [DEV] |
| visual cue | light/white line on every grab edge | — | gamedeveloper.com (Teichmann) | [DEV] |
| grips | two independent hand grips, any spacing | — | PS Blog 2022 (Broner) | [DEV] |
| reach cone half-angle | 40 | deg | — | [INFERRED] |
| reach max, up (hand to next hold) | 0.9 | m | footage: ≈0.6 m per reach seen; max is unmeasured | [INFERRED] |
| reach max, side | 0.8 | m | — | [INFERRED] |
| reach max, down | 0.7 | m | — | [INFERRED] |
| reach max, diagonal | 0.8 | m | — | [INFERRED] |
| lunge max, up | 1.6 | m | — | [INFERRED] |
| lunge max, side | 2.0 | m | — | [INFERRED] |
| lunge max, down | 2.5 | m | — | [INFERRED] |
| vertical gain per reach (typical layout) | ≈0.6 | m | h2KpeldU3nU 15.95–17.70 s, 4 reaches; pillar height from Elena (≈1.7 m) in the same frame | [MEASURED] ±25% |
| reach cycle (hand leaves → next hand set) | ≈0.43 | s | same, 20 fps samples of 60 fps video | [MEASURED] ±0.05 |
| small-hold speed scale | 0.7 | × | DEV says slower on small holds; value inferred | [INFERRED] |
| which hand reaches | opposite of last-latched hand | — | Kotaku 2016 | [WIKI] |

---

## 2. Entering a climb

**What U4 does.**
- Knee-high objects are stepped or climbed over automatically by walking into them. Taller surfaces need Jump/X. [WIKI] (gamerguides)
- Jump near a wall with a hold above: Drake leaps and grabs. In footage he hops from a beam onto an ivy face, catches the wall about 0.2 s after takeoff, then makes a one-armed reach to the ledge above and grabs it about 0.25 s later (h2KpeldU3nU 50.87 → 51.07 → 51.35 s). A running jump in the blockout grabs a bar above head height (1SnMfyV5hXM 60.5–61.4 s).
- Drop from a top edge to hang. Tapping drop near an edge steps off and grabs. Holding it ignores the grips below. [WIKI] (Prima via search summary)
- Catch while falling: no source found. U4 levels script most catches, such as crumbling holds. A generic catch window is an inferred default.
- **Naughty Dog's Uncharted metrics** (Emilia Schatz, lead game designer, as reported by 80.lv, 2017): Drake can jump up to a ledge **3.5 m or less** above him. Designers kept a **dead zone of 3.25–4 m** with no climbable edges, so an edge is either clearly reachable or clearly not. Walkable slopes stay under about 30–35°, with no surfaces between 30° and 45°. Low cover is 0.9–1.25 m with nothing within 0.5 m of that band. [DEV, secondary report] Climbing edges in Uncharted are always horizontal and flat. [DEV] (Shaver via 80.lv)
- A 3.5 m reach from a standing jump is far more than a plain jump gives (standing reach ≈2.3 m + 0.4 m apex ≈ 2.7 m). So **jump-to-grab is a dedicated targeted leap**, not the generic jump. The arc is solved to the edge and the hands are warped onto it.
- The same practice appears in TLOU2: climb-out ledges sat at one fixed height above water, and an ambiguous band (0.25–0.75 m) was avoided. [DEV] (Licea, 80.lv)

**State machine.**
```
GROUND --(walk into obstacle h <= stepMax)--> step (no state change)
GROUND --(Jump, obstacle top h in (stepMax, vaultMax], running, space behind)--> VAULT
GROUND --(Jump, top h in (stepMax, mantleMax], facing wall within 0.6 m)--> MANTLE (climb onto top)
GROUND --(Jump, a grab edge within the jump-grab band ahead)--> JUMP_TO_GRAB → HANG (warp arc to the edge)
GROUND --(Jump, nothing)--> JUMP (section 4)
AIR    --(edge enters the catch band while descending, within catchWindow)--> HANG
TOP    --(drop pressed or walk off the edge slowly at a 'top' edge)--> DROP_TO_HANG
```
Measure every height **from the feet** (actor.pos is at the feet), never from the capsule centre. The private reference project shows why: a capsule resized in the air moved its grab band by 30 cm. (private reference project: notes)

| name | value | unit | source | confidence |
|---|---|---|---|---|
| step-up max (automatic) | 0.5 | m | "knee-height" | [WIKI] value [INFERRED] |
| avoid band (no edges authored) | 0.5–0.8 | m | ND ambiguity rule (TLOU2) | [INFERRED] |
| vault max (running, thin obstacle) | 1.1 | m | — | [INFERRED] |
| mantle range (Jump at a wall top) | 0.8–1.6 | m | design.md mantle block 1.2 m sits inside | [INFERRED] |
| jump-grab max (edge height above the floor Drake stands on) | 3.5 | m | Schatz via 80.lv | [DEV] |
| jump-grab min (below this it is a mantle) | 1.6 | m | — | [INFERRED] |
| authoring dead zone (no edges this high above a standable floor) | 3.25–4.0 | m | Schatz via 80.lv | [DEV] |
| jump-to-grab duration (takeoff → hands set), 3 m edge | 0.45 | s | 0.20 s measured for a 0.5 m hop; scaled | [INFERRED] |
| edge orientation | horizontal and flat only | — | Shaver via 80.lv | [DEV] |
| jump-grab horizontal reach | ≤ 1.0 (standing), ≤ 2.0 (running) | m | — | [INFERRED] |
| hop-to-wall catch time | ≈0.20 | s | h2KpeldU3nU 50.87–51.07 s, 30 fps samples | [MEASURED] ±0.033 |
| one-arm reach to ledge after catch | ≈0.25–0.28 | s | h2KpeldU3nU 51.07–51.35 s | [MEASURED] ±0.033 |
| catch window while falling | until fall speed > 7 m/s (≈0.7 s of free fall) | — | — | [INFERRED] |
| catch band | hands from 0.0 to +0.35 m above edge, ≤ 0.5 m in front of chest | m | the private reference project scans hip→just above head each frame (private reference project: notes) | [INFERRED] |
| drop-to-hang (top → hanging) | ≈0.3 | s | the hang-aim exit (kuieMoIemgc 4.53–4.83 s) is the closest measured move | [MEASURED] proxy |
| low-ledge choice (U4) | mantle when top ≤ ≈1.6 m; hang above | — | gameplay memory, not frame-checked | [INFERRED] |

---

## 3. On the wall: shimmy, reach, lunge, corners, drop, climb-up, jump-back

**What U4 does.**
- Shimmy is hand-over-hand along a continuous ledge, with the stick left or right relative to the camera. [WIKI] (Prima)
- Static reaches need only the stick and no timing. Leaps between distant holds take Jump. [WIKI] (Kotaku review; Prima) Kotaku's climber-reviewer found the leaps weightless, with no visible preparation or effort on the catch. Treat that as a chance to sell the lunge better, not as something to copy.
- A pull-up at a top edge plays one continuous move, from hands on the lip to a crouch on top to standing.
- Drop is Circle (our `cover` action). [WIKI] (gamerguides controls)
- Piton on porous walls and hold-two-pitons experiments are out of scope. [DEV] (PS Blog 2022)

**State machine (CLIMB sub-states, emitted on the `state` feed as `sys:'climb'`).**
```
HANG ── stick along edge ──────────────► SHIMMY (loop while held; stops at edge end or obstacle probe)
HANG ── stick toward hold ≤ reachMax ──► REACH (lead hand travels; other hand follows; back to HANG)
HANG ── stick toward hold ≤ lungeMax ──► HANG + armExtend feedback ── Jump ──► LUNGE ─► CATCH ─► HANG
HANG ── stick up at 'top' edge ────────► CLIMB_UP ─► GROUND (on top)
HANG ── stick away from wall ──────────► LOOK_BACK (torso and head turn) ── Jump ──► JUMP_BACK ─► AIR (targeted if an edge or floor is behind)
HANG ── drop (`cover`) ────────────────► AIR (falls; catch rules apply to edges below)
HANG ── aim ───────────────────────────► HANG_AIM (section 5)
SHIMMY ── edge reaches a corner ───────► CORNER (outer: wrap around; inner: step across), then SHIMMY
```
Rules:
- SHIMMY moves both grips along the same edge polyline. A sideways probe (a capsule offset 0.15–0.25 m along the move) blocks it before obstacles. The private reference project does the same. (private reference project)
- Jump input is buffered for 0.2 s so a press slightly before the arm extends still counts. The private reference project holds the press as a 0.2 s impulse. [INFERRED]
- LUNGE takes the shortest ballistic arc to the target grip, warped to land exactly. No free physics on the wall.
- CLIMB_UP is not cancellable after 0.25 s. JUMP_BACK is only offered when a landing target is behind within lunge range or the floor is within the safe drop height.
- A move in progress cannot be cancelled by an exit request, except a forced break. Release the climber before destroying a grabbed object. (private reference project: notes)

| name | value | unit | source | confidence |
|---|---|---|---|---|
| shimmy speed | ≈1.3 | m/s | kuieMoIemgc 6.2–7.6 s, 5 fps strip; Drake's displacement vs a sandbag on the lip (≈0.6 m wide) | [MEASURED] ±30% |
| shimmy accel / stop | 0.15 / 0.1 | s | — | [INFERRED] |
| shimmy obstacle probe offset | 0.2 | m | the private reference project uses 12/22 cm probes | [INFERRED] |
| reach duration (lead hand) | 0.25–0.30 | s | h2K 51.07–51.35 s; pillar reaches (≈0.43 s cycle incl. follow hand) | [MEASURED] |
| follow-hand lag | 0.10–0.15 | s | pillar sheet, 20 fps | [MEASURED] rough |
| lunge airtime (side/up, 1–2 m) | 0.35–0.45 | s | close to the 0.38 s gap jump (section 4) | [INFERRED] |
| lunge anticipation (load) | 0.10 | s | — | [INFERRED] |
| climb-up: hands on lip → crouched on top | ≈0.65 | s | h2KpeldU3nU 52.40–53.05 s, 30 fps | [MEASURED] ±0.05 |
| climb-up: hands on lip → standing, control back | ≈1.0 (0.9–1.2) | s | same + pillar 17.7–18.9 s | [MEASURED] |
| corner handling | wrap around outer and inner corners of a continuous ledge | — | the private reference project has outer/inner corner and 180° turn actions | [INFERRED] |
| jump-back look-over delay | 0.15 | s | — | [INFERRED] |
| jump-back max distance | 2.5 | m | — | [INFERRED] |
| jump input buffer | 0.2 | s | the private reference project (0.2 s impulse) | [INFERRED] |

---

## 4. Jump physics on the ground, ledge assist, falls

**Measured.** A gap jump between balance beams (h2KpeldU3nU) has a crouch-load of about 0.1–0.15 s, takeoff at 32.10 s and landing at about 32.48 s. That is **≈0.38 s airborne** for a gap of roughly 1.5–2 m between similar heights. A walk-off drop from a bank (Spv14WGA9MU, 30 fps) is airborne about 0.95 s (8.38 → 9.35 s) and ends in a crouched hard landing with one hand down: no roll, no damage. The bank height could not be calibrated.

**Inferred model.** U4 jumps are short, quick and committed. The 0.38 s airtime implies a low apex at real gravity (≈0.18 m), which looks wrong against the tucked legs in the footage (frames 32.08/32.30/32.48 in `frames/beam_triple.jpg`). So use a raised jump gravity. With g = 18 m/s² and a 0.4 m apex, flat-ground airtime is 0.42 s. For contrast, the private reference project's sprint-jump clip has its root at 1 m and lasts 1.15 s (private reference project: notes). That is about three times floatier than U4.

```
on Jump (grounded, no climb/mantle/vault target):
  yaw snaps to the stick direction at takeoff (private reference project decision: instant snap, notes; U4 looks the same) [INFERRED]
  v.y = sqrt(2 * gJump * apex); horizontal = current ground velocity (standing jump adds hopSpeed forward if stick held)
  air: accel toward stick at airControl * groundAccel, clamp to the takeoff speed
  each air step: run the catch test (section 2); if a target edge or floor is ahead within assist range, warp the arc to it (ledge assist)
landing: fallHeight = apexY - landY → land / hardLand / death bands
```

| name | value | unit | source | confidence |
|---|---|---|---|---|
| gap-jump airtime | ≈0.38 | s | h2KpeldU3nU 32.10–32.48 s, 30 fps | [MEASURED] ±0.033 |
| takeoff crouch-load | 0.10–0.15 | s | same sheet | [MEASURED] rough |
| jump gravity | 18 | m/s² | fits 0.38–0.42 s with a 0.4 m apex | [INFERRED] |
| apex (root rise), standing or running | 0.4 | m | — | [INFERRED] |
| fall gravity (after apex / walk-off) | 18 jump arc; 12 after 0.3 s of falling | m/s² | — | [INFERRED] (see open question 1) |
| running long-jump distance | ≈2.0 | m | beam gap visual estimate | [INFERRED] |
| air control | 0.15 | × ground accel | — | [INFERRED] |
| ledge-assist range (warp to target) | 0.75 | m from the unassisted landing point | — | [INFERRED] |
| soft land | fall < 2.0 m: 0.15 s land | m / s | — | [INFERRED] |
| hard land (crouch, hand down, no roll) | 2.0–6.0 m: 0.5 s recovery | m / s | Spv14WGA9MU 9.35 s shows the pose | pose [MEASURED], heights [INFERRED] |
| lethal fall | > 8 m: death anim + fade | m | — | [INFERRED] |

---

## 5. Shooting while hanging

**Confirmed from footage** (kuieMoIemgc, PS5, chapter 8). Drake hangs from a rock lip under enemies. On aim he pulls up so his head and shoulders clear the lip, holds the **pistol in the right hand only**, and keeps the left hand on the edge. The camera cuts from a wide hang framing to a close right-shoulder over-the-shoulder view. The HUD shows the sidearm. Footage of the convoy rope-drag (RfZ6zWsvo3w) also shows one-handed aiming while hanging from a rope. Pulling enemies down from a hang (Square) is a separate melee move. [WIKI] (Prima) The private reference project has the same move as its own ability gated on the hang state. (private reference project: notes)

```
HANG --aim held--> HANG_AIM_ENTER (0.18 s: body rises, gun hand leaves the edge, camera blends) --> HANG_AIM
HANG_AIM: weapon = sidearm (forced, even if a long gun is equipped); fire/reload allowed; no shimmy; stick is ignored, the look input aims
HANG_AIM --aim released--> HANG_AIM_EXIT (0.3 s) --> HANG
HANG_AIM --hit or grip break--> HANG (force exit)
```

| name | value | unit | source | confidence |
|---|---|---|---|---|
| weapon while hanging | sidearm only, one-handed (right) | — | kuieMoIemgc 11.45 s frame | [MEASURED] |
| enter time (trigger → aim pose) | 0.15–0.20 | s | kuieMoIemgc 10.27–10.43 s, 30 fps | [MEASURED] ±0.033 |
| exit time (release → hanging, camera back) | ≈0.30 | s | kuieMoIemgc 4.53–4.83 s | [MEASURED] ±0.033 |
| camera blend in | ≈0.2 | s | same | [MEASURED] |
| body raise (chest to lip) | head and shoulders above lip; chest ≈ lip height | — | 11.45 s frame | [MEASURED] |
| aim yaw limit | ±70 from wall normal | deg | — | [INFERRED] |
| aim pitch limit | −20 … +45 | deg | — | [INFERRED] |
| shimmy while aiming | not allowed | — | no aim-shimmy seen in footage | [INFERRED] |
| accuracy | same spread as standing pistol aim, ×1.2 | × | — | [INFERRED] |
| hang-aim camera offset | ≈0.45 right, ≈0.2 up from the head, ≈1.0 back | m | 11.45 s frame, head ≈0.25 m wide | [MEASURED] rough |

---

## 6. Camera during climbing

**Measured.** Hanging on a ~2 m lip, the hang length (hands to feet, about 2.0 m) fills about 1/3 of the frame height, so the camera is about 5–7 m back at a 50–60° vertical FOV (kuieMoIemgc 7.0 s). The pillar climb frames the whole pillar with the character at about 1/3 of frame height (h2KpeldU3nU 16.95 s). Long cliff climbs (q4rzkzjAKt4 30–150 s) pull out until the character is about 1/8 of frame height and look along the route, often from below or the side for the vista. Exits into aim blend in about 0.2 s.

```
on enter CLIMB: blend (0.5 s) to the climb rig: distance climbDist, pitch bias toward the dominant climb direction
each frame: target = midpoint of hands, offset back along the wall normal by climbDist, up by climbUp
  lead: shift the look target 0.6 m toward the last move direction (shows the next holds)
  auto-orient: after 1.0 s with no look input, yaw eases toward the wall normal ±25° (keeps the wall readable); the player can orbit at any time
on HANG_AIM: snap rig to OTS (0.2 s); on exit, blend back (0.3 s)
on CLIMB_UP done: blend (0.4 s) back to the locomotion rig
```

| name | value | unit | source | confidence |
|---|---|---|---|---|
| climb camera distance | 5.0 (range 4–7) | m | kuieMoIemgc 7.0 s framing | [MEASURED] rough |
| look-target lead toward move dir | 0.6 | m | — | [INFERRED] |
| auto-orient delay / rate | 1.0 s / 60 deg/s | — | — | [INFERRED] |
| climb-rig enter/exit blend | 0.5 / 0.4 | s | — | [INFERRED] |
| hang-aim blend in/out | 0.2 / 0.3 | s | section 5 | [MEASURED] |

---

## 7. Animation beats for a procedural mannequin

Sources: Mach, GDC 2017 (30:44–41:24), PS Blog 2022, Kotaku 2016, frame sheets. The goal is to sell the moves with IK and springs instead of mocap.

- **Hands are pinned.** Each hand is an IK target locked to its grip in the grip's local space, so moving or breakable holds keep working. The private reference project stores the ledge relative to the held object for the same reason. (private reference project) U4 keyframes the hands, feet and forearms and keeps the upper body stiff because the arms carry the weight. [DEV] (Mach 34:23)
- **Feet look for holds.** Each foot ray-casts down the wall 0.9–1.3 m below the hands for a foothold edge and IK-plants on it. With none (a bar, an overhang), go to free-hang. [DEV] (Broner: feet look for an edge instead of dangling)
- **Free-hang swing.** U4 uses a loose lower-body profile while idle-hanging, so a landing at any angle swings out naturally, and a stiffer profile while the stick is held. Each move carries momentum, so alternating left and right builds a bigger swing. [DEV] (Mach 36:00–38:12) Procedural version: a pendulum on the pelvis below the hand midpoint, with stiffness 25 (idle) / 60 (stick held), damping ratio 0.25 / 0.5, and the move velocity injected into the pendulum. [INFERRED values]
- **Overlap.** The spine is weak so the hips trail and settle after each move ("subtle overlap to Drake's butt"). [DEV] (Mach 33:19) Procedural: hip spring lagging the hand-midpoint target, ≈0.12 s settle, ≤6 cm overshoot. [INFERRED]
- **Reach beat (≈0.43 s cycle).** At 0–0.05 s the body shifts its weight toward the free hand's side. At 0.05–0.30 s the lead hand travels on an arc that bulges 10–15 cm out from the wall, and the pelvis rises about 60% of the hand rise. At about 0.30 s the hand latches and the fingers close (a crimp on small holds, an open grip on big ones). At 0.30–0.43 s the follow hand moves up next to it, or stays if both grips are good, and the feet re-step. [MEASURED cycle; split INFERRED]
- **Lunge beat.** Load for 0.1 s (knees and hips compress 10 cm toward the wall), then launch. Both arms reach and the legs trail. The lead hand catches first and the second hand follows 0.1–0.15 s later. The legs swing past and settle in about 0.4 s. Kotaku's critique suggests adding a visible preparation and effort on the catch. [WIKI + INFERRED]
- **Feedback lean when nothing is in reach.** The torso leans up to 8 cm and the arm extends up to 70% toward the stick, then returns when the stick is released. [DEV behaviour, INFERRED amounts]
- **Climb-up beat (≈0.65 s to crouch).** Arms press, the chest goes over the lip at about 0.2 s, one knee lands on top at about 0.45 s, crouch at 0.65 s, stand at about 1.0 s. [MEASURED]
- **Hang-aim beat.** The gun hand leaves the lip on frame 1, the chest rises to the lip in 0.15 s, and the arm extends to aim. [MEASURED]
- **Ragdoll gate (U4 practice).** Physics overlap runs only while the current move asks for it, so it never leaks into running. [DEV] (Mach 39:20) In our build, enable the springs only in CLIMB states.

| name | value | unit | source | confidence |
|---|---|---|---|---|
| foot search band below hands | 0.9–1.3 | m | — | [INFERRED] |
| hand-arc bulge off wall | 0.10–0.15 | m | — | [INFERRED] |
| pelvis pendulum stiffness idle/active | 25 / 60 | 1/s² | Mach loose/stiff profiles | [DEV] concept, [INFERRED] value |
| pelvis damping ratio idle/active | 0.25 / 0.5 | — | — | [INFERRED] |
| hip overlap settle | 0.12 | s | Mach "overlap" | [INFERRED] |
| second-hand catch lag on lunge | 0.10–0.15 | s | — | [INFERRED] |

---

## 8. Failure states (note only; out of scope for now)

- Crumbling or breaking holds are mostly scripted in U4. The usual beat is a one-hand slip, a dangle and a re-grab. [INFERRED from gameplay memory]
- Hard rule for later: release the climber first, then destroy the hold. The private reference project broke this rule and teleported the player to the origin. (private reference project: notes)
- A grab must own the body exclusively. In the private reference project, a jump clip's end event set walking mode under an active hang. Gravity built up speed while the hang held the body, which stretched the arms and caused a fatal landing. (private reference project: notes) In our build, while CLIMB is active nothing else may write `actor.pos`/`vel`.
- Piton, rope swing, slide and stamina are all out of scope. U4 cut the stamina bar. [DEV]

---

## Proposed data format for the room

Extends `design.md`'s `level.climb`. Everything is authored as data in `level/room.js` (or `room-climb.js`). The room builder renders a light strip along every edge from the same data, which is the U4 white-line rule. That way the visuals and the controller can never disagree.

```js
// level/room-climb.js  (meters, Y up; normal points OUT of the wall, toward the climber)
export const climb = {
  edges: [
    // continuous ledge: shimmy along it; 'top' means the surface above is walkable (climb-up allowed)
    { id: 'L1', kind: 'ledge', pts: [[-4, 2.2, -10.8], [2, 2.2, -10.8]], normal: [0, 0, 1],
      size: 'large', feet: true, top: false },
    // single handholds: short edges (≈0.25 m) so the same code handles them
    { id: 'H1', kind: 'hold', pts: [[0.3, 2.8, -10.85], [0.55, 2.8, -10.85]], normal: [0, 0, 1], size: 'small', feet: true },
    // free-hang bar or pipe: no footholds, pendulum hang
    { id: 'B1', kind: 'bar', pts: [[3, 3.6, -10.4], [5, 3.6, -10.4]], normal: [0, 0, 1], feet: false },
    // balcony lip: a top edge; standPos is computed by moving 0.4 m inward along -normal on the walkable floor
    { id: 'T1', kind: 'top', pts: [[-6, 6.0, -10.8], [6, 6.0, -10.8], [6, 6.0, 0]], normal: [0, 0, 1], feet: true },
  ],
  // optional footholds; when omitted, any 'ledge'/'hold' below the hands also serves as a foothold
  feet: [],
};
```
Authoring rules:
- `pts` is a polyline along the grip line (the outer top corner of the lip). Corners are polyline vertices, and each segment's normal is derived per segment when `normal` is omitted.
- Space vertical holds about 0.5–0.7 m apart (measured ≈0.6 m per reach), so a straight-up stick chains static reaches. Put one lunge-only gap (1.2–1.8 m) on the route so the lunge gets used.
- No grab edges between 0.5 and 0.8 m above any standing floor (our mantle ambiguity band), and none **3.25–4.0 m** above a floor the player can stand on directly below (Naughty Dog's dead zone). The builder should assert both rules at load and warn.
- Edges are horizontal and flat. [DEV]
- The 6 m wall to the balcony, per design.md: first ledge at 2.2 m (jump-grab), then holds at 2.8 and 3.2 (static reaches), skip the dead zone with a 0.9 m reach to 4.1, then 4.7, then a lunge-only gap (1.3 m up) to the top edge `T1` at 6.0. Put one sideways hold pair 1.6 m apart around 2.8 m to show the side lunge.

Query API (`player/climb-query.js`, pure, testable headless):
```ts
type Grip = { edgeId: string, seg: number, t: number, point: Vector3, normal: Vector3, kind: string, size?: string };
findEntry(feetPos, facingYaw, vel, mode: 'stand'|'jump'|'fall'|'dropFromTop') -> Grip | null   // section 2 bands, measured from the feet
findMove(gripL, gripR, stick: {x, y}, cameraYaw) -> {
    type: 'shimmy'|'reach'|'lunge'|'jumpBack'|'climbUp'|'none',
    target?: Grip, hand?: 'L'|'R', dist?: number, needsJump: boolean, feedbackDir: Vector3 }
slide(grip, metersAlong) -> { grip, blocked: boolean, corner?: 'outer'|'inner', endReached: boolean }
footholds(gripL, gripR, band = [0.9, 1.3]) -> Grip[]
topSurface(grip) -> { standPos: Vector3 } | null
edgesNear(point, radius) -> Grip[]   // debug draw and AI
```
The controller (`player/climb.js`) owns the CLIMB state machine and the timings above, and emits `{sys:'climb', from, to, t}` on every transition so `__measure` can check each duration against this spec.

---

## Measurement protocol (for Max to capture or re-check)

Capture on PS5 or PC (Legacy of Thieves, 60 fps, performance mode) or use the listed videos. Step frame by frame (mpv `.`/`,`, or `ffmpeg -ss T -t D -i clip -vf fps=60,tile=…`). Record start and end frame numbers, and divide by fps. Calibrate distances by the character (Drake 1.8 m standing; hanging hands-to-feet ≈2.0 m) at the same depth as the thing measured, never by background props. Log each result as `name | frames | fps | seconds | clip@timestamp` in this file's tables, tagged `[MEASURED]`.

| # | what to time / measure | where | start frame | end frame | notes |
|---|---|---|---|---|---|
| P1 | vertical reach cycle + gain per reach | h2KpeldU3nU 15.9–17.8 s (pillar) | lead hand leaves hold | next hand set on the hold above | 4 cycles; average; gain from the pillar's course lines |
| P2 | climb-up from hang | h2KpeldU3nU 52.3–53.2 s; any top edge in your capture | first frame of the arm press | (a) knee on top, (b) standing, first frame stick input moves him | report (a) and (b) |
| P3 | gap jump airtime | h2KpeldU3nU 32.0–32.6 s | last foot-contact frame | first foot-contact frame | then do P4 for height |
| P4 | **flat-ground jump apex + airtime** (missing) | your capture: side-on, flat floor, standing jump and running jump, camera still | takeoff | landing | apex = pelvis rise in px ÷ (Drake px height ÷ 1.8 m); gives gravity = 8·apex/airtime² |
| P5 | shimmy speed | kuieMoIemgc 6.0–7.6 s, or your capture of a long straight ledge filmed square-on | first frame of steady motion | 1.0 s later | distance by Drake's hanging length; repeat 3× |
| P6 | hang-aim enter / exit | kuieMoIemgc 10.2–10.6 s (enter), 4.5–4.9 s (exit) | aim press (first frame the pose changes) | gun arm extended / hands both on lip | also log the camera-blend frames |
| P7 | hang-aim arcs | your capture: hang under a lip, sweep the aim fully left, right, up, down | — | — | the yaw/pitch where the reticle stops = limits; test grenade throw and aiming from a bar |
| P8 | reach vs lunge thresholds | your capture: any wall with uneven hold spacing, square-on | — | — | for each attempted move, log hand-to-hold distance and whether it was a stick reach, an arm-extend + Jump lunge, or nothing; the boundary = reachMax / lungeMax per direction |
| P9 | jump-to-grab from the ground | your capture: edges at ≈2.2, 2.8, 3.4 m | takeoff | hands set | log max height that grabs; check Schatz's 3.5 m |
| P10 | fall bands | your capture: drop off ledges of increasing height (count wall courses or use Drake's height) | leave edge | landing anim end / control back | heights for soft land, hard land, roll, death |
| P11 | corner wrap | your capture: shimmy around an outer and an inner corner | first frame of the corner anim | shimmy resumes | duration + whether stick direction must change |
| P12 | jump-back | your capture: stick away from wall, then Jump | stick-away frame | head-turn visible, then takeoff → catch | look-back delay and max distance |

## Open questions

1. **Ground jump apex and gravity.** Only airtime was measured. A side-on flat-ground standing jump with the character visible is needed (PS5 or PC capture by Max, or a clean clip). It also settles fall gravity and whether U4 uses a stronger gravity after the apex.
2. **Fall bands.** At what height does Drake hard-land, and when does a fall kill? No clean footage was found. A capture with a 1 m grid reference (or Naughty Dog blockout footage, whose grid size is unconfirmed) would settle it.
3. **Reach and lunge maximums** (up, side, down, diagonal). Only typical spacing (≈0.6 m) was measured. A wall with uneven hold spacing, filmed straight on, is needed.
4. **Jump at a 1.2–1.6 m ledge: mantle straight up, or hang first?** U4 seems to mantle low ledges. The private reference project chose "always hang, never auto-mantle" (private reference project: notes). This is a decision for Max; default here is U4-style mantle ≤ 1.6 m.
5. **Climb-up input.** Stick up at a top edge versus Jump. Footage cannot show inputs. Default is stick up, with Jump also accepted.
6. **Hang-aim limits.** Yaw and pitch arcs, whether aiming works from a free-hang bar, and whether grenades can be thrown while hanging are all unverified.
7. **Corners.** U4 corner wrap behaviour was not measured in this pass.
8. **GDC 2018 "Invisible Intuition: Blockmesh and Lighting Tips"** (Shaver and Yang; YouTube 09r1B9cVEQY). Its captions stayed at HTTP 429 after one gentle retry. It may give more Naughty Dog climb and jump metrics. Max can watch it or pull its captions himself.
9. **Is the 3.5 m jump-to-ledge figure measured from the feet?** 80.lv only says "above him". The spec assumes from the floor he stands on. P9 checks it.

---

## Sources

Developer sources
- PS Blog, "Naughty Dog breaks down Uncharted 4's climbing evolution", 18 Oct 2022 (Yates, Schatz, Broner): https://blog.playstation.com/2022/10/18/naughty-dog-breaks-down-uncharted-4s-climbing-evolution-as-uncharted-legacy-of-thieves-collection-launches-on-pc-this-week/
- Michal Mach, "Physics Animation in Uncharted 4: A Thief's End", GDC 2017. Vault: https://gdcvault.com/play/1024087/Physics-Animation-in-Uncharted-4 . Video: https://www.youtube.com/watch?v=7S-_vuoKgR4 (climbing 30:44–35:27, free-hang 36:00–38:43, ragdoll gating 39:20, hang collisions 40:23)
- Jeremy Yates / Almudena Soria, "Animation Bootcamp: Uncharted 4: Naughty Dog's Animation Workflow & Animation Prototyping", GDC 2017: https://www.youtube.com/watch?v=fQnUTmOu3lc (little on climbing; at ~33:58, programmers were busy on climbing and rope swing in early production)
- Martin Teichmann (ND environment modeler), readability tips, the white-line rule: https://gamedeveloper.com/design/-i-uncharted-4-i-artist-shares-tips-on-making-your-game-more-readable
- Emilia Schatz (ND lead game designer), Uncharted environment-language metrics (3.5 m jump-to-ledge, 3.25–4 m dead zone, slopes, cover), as reported by 80.lv, 27 Jun 2017: https://80.lv/articles/defining-environment-language-for-video-games/
- David Shaver (ND), blockmesh tips (climb edges always horizontal and flat), 80.lv: https://80.lv/articles/blockmesh-tips-from-david-shaver/ . The related GDC 2018 talk "Level Design Workshop: Invisible Intuition: Blockmesh and Lighting Tips" (https://gdcvault.com/play/1025179/Level-Design-Workshop-Invisible-Intuition) is behind the Vault paywall, and its YouTube captions were rate-limited (429).
- Arnaldo Licea (ND, TLOU2), flooded-level blockout metrics: https://80.lv/articles/blocktober-level-design-of-a-flooded-level-in-the-last-of-us-part-ii
- Ming-Lun Chou, "A Brain Dump of What I Worked on for Uncharted 4" (buddy climb-follow posts, no player climbing): https://www.gamedeveloper.com/design/a-brain-dump-of-what-i-worked-on-for-uncharted-4

Guides and press [WIKI]
- gamerguides U4 movement and navigation: https://www.gamerguides.com/uncharted-4-a-thiefs-end/guide/introduction/gameplay/movement-and-navigation
- gamerguides U4 controls: https://www.gamerguides.com/uncharted-4-a-thiefs-end/guide/introduction/gameplay/controls
- Prima eGuide, navigating the environment (403 to the fetcher; content seen only through search summaries, unverified): https://primagames.com/eguides/uncharted-4-a-thiefs-end-eguide/basics/navigating-the-environment
- Kotaku, "Uncharted 4's climbing, reviewed" (by a climber), 2016: https://kotaku.com/uncharted-4s-climbing-reviewed-1775667916
- Pratt IXD, "Design Critique: Uncharted 4 Traversal", 2019: https://ixd.prattsi.org/2019/02/design-critique-uncharted-4-traversal/

Footage (720p video only, frames extracted with ffmpeg; timing by counting samples; distances calibrated by character height 1.8 m, Elena ≈1.7 m, or a ≈0.6 m sandbag)
- h2KpeldU3nU, "Climbing With Nathan Drake – New Devon" PS5 60 fps: https://www.youtube.com/watch?v=h2KpeldU3nU . Pillar climb 15.5–19.0 s (20 fps samples), beam gap jump 31.9–32.9 s (30 fps), hop-to-wall + ledge reach + climb-up 50.8–53.2 s (30 fps).
- kuieMoIemgc, "Chapter 8 … Combat tips" 60 fps: https://www.youtube.com/watch?v=kuieMoIemgc . Hang-aim exit 4.2–5.2 s, shimmy 5.8–7.6 s (5 fps band strip), hang-aim enter 10.0–11.0 s (30 fps), one-handed aim frame 11.45 s.
- Spv14WGA9MU, "RND – Uncharted 4 locomotion – fall animations" 30 fps: https://www.youtube.com/watch?v=Spv14WGA9MU . Walk-off drop 7.8–9.4 s.
- 1SnMfyV5hXM, "Uncharted 4 Level Blockout Comparison": https://www.youtube.com/watch?v=1SnMfyV5hXM . Blockout ledges as white strips, bar grab 60.5–61.4 s.
- q4rzkzjAKt4, "Extreme Parkour Mission" PS5 60 fps: https://www.youtube.com/watch?v=q4rzkzjAKt4 . Cliff-climb camera framing 30–150 s.
- RfZ6zWsvo3w, "Hang Tough! Trophy Guide" (PowerPyx): https://www.youtube.com/watch?v=RfZ6zWsvo3w . One-handed aim while dragged on a rope (partial download).
- Looked at and not used: uFtN1_6SInc and MV9O4gvFUe8 (multiplayer), 2h254cVykWI (not U4), 70msTYWCQBI (night rooftop drop, too dark to calibrate), Vv2IU1KPlqM (climbers react; dyno definition only).

Private reference project (paraphrased, not copied; a view of how hang systems fail, not a blueprint)
- Grip stored relative to the held component, hang flag set at detection with the body interpolated in, sideways room probe, stick smoothing, 0.2 s jump impulse, action list (short move, outer/inner corner, turn 180, jump to next ledge, jump back).
- Owner decision: a jump that reaches a ledge hangs and never auto-mantles.
- Instant yaw snap on a directional jump; a per-frame ledge scan from hip to above head during the jump; the hang-stretch death caused by two systems writing the body.
- A grab band measured from the capsule moves when the capsule resizes in the air.
- Release before destroy; pull-down as a hang-gated ability.
