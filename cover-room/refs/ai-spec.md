# Enemy AI spec: U4-style human grunts (cover room prototype)

Research date: 2026-11-11. Scope: basic rifle/pistol grunts in one room. Only mechanics, timings and rules are matched. No names, assets or layouts.

**Confidence tags.** [DEV] = stated by Naughty Dog (talk, book chapter, dev article, slide). [MEASURED] = read or measured off material by me. In this pass that is only debug text and ring sizes on the talk's slides; gameplay footage could not be downloaded (see Open questions). [WIKI] = strategy guide or community source. [INFERRED] = my recommended default where no source exists. Where a [DEV] number comes from an earlier Naughty Dog game (Uncharted 2 = UC2, The Last of Us = TLOU), the source column says so. U4 runs on the TLOU engine and AI framework (Gallant 2:19, 8:29), and UC2's archetype data model predates both.

**Source keys** (full list at the end): **G** = Gallant, GDC 2017, "Authored vs. Systemic" (U4), timestamps `m:ss`. **G-deck pN** = page N of the official slide deck PDF for that talk. Several slides show Naughty Dog's actual Lisp defaults. The deck's credits slide (p6) lists the U4 combat-AI team as Chou, Botta, Dyckhoff, Gallant, Bellomy, McIntosh and Rieke, so the TLOU book chapters below are by the same people. **M** = McIntosh, "Human Enemy AI in The Last of Us", Game AI Pro 2 ch. 34 (book page numbers). **D** = Dyckhoff, "Ellie: Buddy AI in The Last of Us", GAP2 ch. 35. **B** = Botta, "Infected AI in The Last of Us", GAP2 ch. 33. **R** = Benson Russell, "The Secrets of Enemy AI in Uncharted 2" (Gamasutra, 2010). **C** = Allen Chou, U4 work post-mortem (2016). **P** = Prima U4 eGuide (as quoted in search snippets; the pages themselves returned 403).

---

## Summary

1. Architecture (G 8:51, M p.426): each NPC has a prioritized list of **skills** (panic, combat, investigate, search, flank, ...). The highest-priority skill that wants control runs. Each skill has its own small state machine and pushes low-level **behaviours** (move-to, shoot, take-cover) onto a stack.
2. Positioning is always "pick the best **post**". Posts are precomputed points: cover, open and perch. **Post selectors** score posts by multiplying 0..1 criteria, filters reject outright, and the highest score wins (G 11:40, M p.425).
3. An **encounter coordinator** gives each NPC one core role: **Engager** (pushes the player), **Ambusher** (waits ~20 m ahead on the navmesh) or **Defender** (holds a designer hard point). Counts come from per-encounter "global combat params" (G 29:30–34:35).
4. **Orthogonal roles** sit on top of the core role: **Shooter** (only token holders may fire; U4 default min 2 / max 3), **Grenade thrower** (grenade director punishes camping) and **Flanker** (combat-vector cost pathfind, dispatched after 6 s unless the player moves 4 m) (G 35:02–43:43, G-deck p114).
5. Perception: a vision cone that narrows with distance, one raycast to the chest (stealth) or head-top (combat), and a notice meter that fills while seen and drains while unseen, at about 1–2 s typical (M p.421–423). U4 shows it as a white → yellow → orange indicator (C).
6. States: Unaware → Suspicious/Investigate (pair: investigator + watcher) → Combat → (player > snuck-away distance from last known position) → Search along designer loops → re-spot → Combat. After a body is found or combat happens, the NPCs never return to Unaware (C, G 7:07).
7. NPCs never cheat on position. Only perception updates the shared last-known position (LKP), which is broadcast to all NPCs (M p.423).
8. Shooting: accuracy ramps to full after spotting over a U4 "time to accuracy" curve: light enemies take 3.0 s at 5 m, 4.5 s at 15 m and 6.0 s at 30 m (G 43:54, G-deck p145). There is a floor at long range (G 46:59). UC2 data adds distance-accuracy curves, a 3.5 s pop-out ramp and burst patterns (R).
9. Health: integer 100 base. UC2 pistol does 34 to light enemies (3 body shots), and TLOU uses 3 shots as its example (R, D). U4 per-weapon damage is unpublished, so it is [INFERRED].
10. Biggest gaps: U4's actual notice-meter timings, burst timings and the grenade-director timer and radius values. The combat-param defaults were found on the slides. No gameplay footage could be measured this session (YouTube returned 403/429). A measurement protocol is in Open questions.

---

## 0. Frame: brain, posts, roles (implement first)

```
class NPC {
  skills: Skill[]            // sorted by priority, high first
  behaviourStack: Behaviour[]// MoveTo, TakeCover, StandAndShoot, PeekShoot, Throw, LookAround
  coreRole: Engager|Ambusher|Defender
  orthRoles: Set<Shooter|GrenadeThrower|Flanker>
  anchor: Vec3               // player pos | ambush point | hard-point centre
  params: ArchetypeParams    // same brain for all types; params differ (G 40:23)
}
tick(npc):
  active = first skill in npc.skills where skill.wantsControl(npc)    // G 9:02, M p.426
  if active != npc.activeSkill: npc.activeSkill?.exit(); active.enter()
  active.update(dt)          // may push/replace behaviours
  npc.behaviourStack.top.update(dt)
```

Skill priority order [INFERRED from G/M/R skill lists]: `Scripted > Dodge/GrenadeAvoid > HitReact > Panic > Flank > Combat(cover/open) > Search > Investigate > Ambient(patrol/idle)`.

| name | value | unit | source | confidence |
|---|---|---|---|---|
| maxSimultaneousNPCs (PS4) | 16 | NPCs | G 7:33 (8 on PS3) | [DEV] |
| skill evaluation | every frame | – | M p.426 | [DEV] (TLOU) |
| combat-behaviour / target re-evaluation | 1 | s | R | [DEV] (UC2) |
| recommended brain tick for browser | 0.1 (skills), 0.5 (post scoring) | s | – | [INFERRED] |

---

## 1. Perception

### 1.1 Vision

Rules:
- Use a cone plus an occlusion raycast. Plain frustums failed TLOU playtests: NPCs missed a player right beside them and spotted one too far away. Fix: the view angle is **inversely proportional to distance**, wide up close and narrow far away (M p.421, figs. 34.2–34.3) [DEV].
- **Visibility test point** (M p.423) [DEV]: one ray from the NPC eye to a single point on the player. While the player is in stealth (never engaged), the point is the **centre of the chest**. Once combat has started, it moves to the **top of the head**. TLOU first tried rays to every joint with a 60% weighted threshold and abandoned it: players could not predict whether a cover spot was safe.
- Crouching and cover work through that one point: a crouched player behind low cover hides the chest point. No separate crouch multiplier is documented [INFERRED: none needed beyond the lower test point].
- **Stealth grass** is navmesh polygons tagged in the editor (G 9:56, C) [DEV]. Guide numbers [WIKI, P]: a player in tall grass is still seen within **6 m**, and a player behind typical cover is seen up to **18 m**. During orange (combat) alert, stepping into grass does not hide you. You must break line of sight and let the threat level drop first.
- UC2 model (R) [DEV]: there are two cones, an outer **peripheral** cone (suspicion: "might have seen something", turn toward it) and an inner **direct** cone (identify). Each cone has a horizontal angle, vertical angle, range and acquire time. **Acquire time scales linearly with distance**: full value at the range edge, shorter up close. The ambient state uses a smaller direct cone and longer acquire times. The combat state uses a much larger direct cone and much shorter times.

```
halfAngle(d)   = clamp(K / d, HALF_MIN, HALF_MAX)          // TLOU inverse law
canSee(npc, p) = d <= range(state)
              && angleH(npc.forward, p - npc.eye) <= halfAngle(d) * stateConeMul
              && |angleV| <= HALF_V
              && !raycastBlocked(npc.eye, testPoint(p))      // chest if player.inStealth else headTop
              && !(p.inGrass && p.crouched && d > GRASS_RANGE && state != Combat)
```

| name | value | unit | source | confidence |
|---|---|---|---|---|
| cone law | halfAngle ∝ 1/distance | – | M p.421 | [DEV] |
| K (angle·distance constant) | 300 | deg·m | – | [INFERRED] (gives 90° half at 3.3 m, 30° at 10 m) |
| HALF_MAX / HALF_MIN | 90 / 25 | deg | – | [INFERRED] |
| HALF_V (vertical half-angle) | 40 | deg | – | [INFERRED] |
| stateConeMul (combat) | 1.5 | × | R says combat cone is "much larger" | [INFERRED] value, [DEV] direction |
| range, unaware | 30 | m | – | [INFERRED] |
| range, combat | 60 | m | R's accuracy curve reaches 0% at 60 m | [INFERRED] |
| test point, stealth | chest centre | – | M p.423 | [DEV] |
| test point, combat | top of head | – | M p.423 | [DEV] |
| abandoned multi-joint threshold | 60 | % | M p.423 | [DEV] (do not use) |
| GRASS_RANGE (seen in grass inside) | 6 | m | P | [WIKI] |
| behind-cover detection cap | 18 | m | P (meaning ambiguous, read as max range at which a partly exposed player in cover is noticed) | [WIKI] |

### 1.2 Notice meter (awareness) and the U4 indicator

Rules:
- TLOU (M p.421–422) [DEV]: seeing the player starts a timer. Each frame the player is seen, it goes up. Each frame unseen, it goes down. The player counts as perceived only when the timer reaches a threshold, about **1–2 s** for a typical NPC. The threshold is **much lower in combat**, and **much higher if this NPC has never perceived the player** (pure stealth).
- U4 indicator (C) [DEV] has three colours over the enemy's head, driven by perception data:
  - **white**: the enemy is about to notice something.
  - **yellow**: the enemy has perceived a distraction and is suspicious or investigating.
  - **orange**: the enemy is fully aware of the player (combat).
  
  A buzzing tension bed plays while threats are building, and a loud stinger plays at full awareness. U4 has no listen mode, so the indicator is the player's only read.
- Guide [WIKI, P]: in the white stage the enemy stops patrolling to look. Getting into cover can stop the meter before it fills. A filled orange meter alerts nearby enemies too.

Implementation (two-phase meter, matching UC2's peripheral→direct staging onto U4's colours):

```
// per NPC, per target. a in [0, 2]: 0..1 = white phase, 1..2 = yellow->orange phase
acquire(d) = lerp(ACQ_NEAR, ACQ_FAR, saturate(d / range)) * neverSeenMul * difficultyMul
update(dt):
  if canSee: a += dt / (a < 1 ? acquire(d) : confirm(d)) * grassMul
  else:      a -= dt * DECAY_RATE
  if canSee && d < INSTANT_RANGE && inDirectCone: a = max(a, 2 - INSTANT_TIME/confirm(d))  // point-blank: near-instant orange
  if a >= 1 and state == Unaware: enter Suspicious(stimulusPos = player.pos)   // yellow
  if a >= 2: enter Combat; broadcastLKP(player.pos, now)                       // orange
indicator: hidden if a == 0; white arc filling (a<1); yellow arc filling (1..2); solid orange in Combat
           Searching NPCs show yellow while their meter refills (stealth regained)
```

| name | value | unit | source | confidence |
|---|---|---|---|---|
| typical perceive threshold | 1–2 | s | M p.422 | [DEV] (TLOU) |
| ACQ_NEAR / ACQ_FAR (white phase, unaware) | 0.5 / 3.0 | s | anchored to M's 1–2 s at mid range | [INFERRED] |
| confirm(d) (yellow→orange) | lerp(0.3, 1.5, d/range) | s | – | [INFERRED] |
| acquire scales linearly with distance | yes | – | R | [DEV] (UC2) |
| neverSeenMul | 1.5 | × | M says "much higher" | [INFERRED] value |
| combat re-acquire threshold | 0.2 | s | M says "much lower" | [INFERRED] value |
| DECAY_RATE | 1.0 | meter units/s | M says timer simply decrements | [INFERRED] |
| INSTANT_RANGE / INSTANT_TIME | 2.5 / 0.3 | m / s | – | [INFERRED] |
| grassMul (crouched in grass, inside 6 m) | 0.5 | × | – | [INFERRED] |
| indicator colours | white / yellow / orange | – | C | [DEV] |

### 1.3 Hearing

Rules (TLOU Infected chapter describes the shared sensory system, B p.~404–405) [DEV]:
- The AI does not listen to real audio. Gameplay code emits **logical sound events**, each with a designer-set radius. Every character inside the radius may hear it, Infected or human.
- Each listener multiplies the radius by a tunable per-type, per-behaviour factor. TLOU's Infected hear about **6×** better than human Hunters. Hearing is weaker when unaware.
- Sounds are **partially occluded**: rays from each listener to the source reduce the effective radius.
- TLOU humans: a crouched player could approach from behind undetected (B, contrasted with the Infected) [DEV].
- Hearing a sound gives **Suspicious** at the sound's position (investigate). A gunshot or explosion while the NPC already suspects the player, or inside the combat radius, gives **Combat** with LKP set to the source [INFERRED].

| name (logical sound) | radius | unit | source | confidence |
|---|---|---|---|---|
| player pistol shot (unsilenced) | 50 (whole room) | m | – | [INFERRED] |
| grenade explosion | 50 | m | – | [INFERRED] |
| bullet impact / ricochet near NPC | 4 | m | – | [INFERRED] |
| sprint footsteps | 8 | m | – | [INFERRED] |
| run / walk footsteps | 5 / 2 | m | – | [INFERRED] |
| crouch-walk | 0 | m | B (humans can be approached crouched) | [INFERRED] value, [DEV] behaviour |
| melee takedown / body fall | 4 | m | – | [INFERRED] |
| thrown distraction landing | 12 | m | – | [INFERRED] |
| occlusion per blocking wall | ×0.5 radius | × | B says "partially occluded" | [INFERRED] value |
| human vs Infected hearing | 1 : 6 | ratio | B | [DEV] (TLOU) |

### 1.4 Bodies and shared knowledge

- Bodies are distractions (C) [DEV]. If the investigated distraction is a body, the investigator becomes alerted to the player and **all** enemies start searching. This **irreversibly** ends the Unaware state. The game highlights the body so the player sees what gave them away.
- Bodies in tall grass are not discovered by patrols [WIKI, P].
- **No cheating** (M p.423) [DEV]: when any NPC perceives the player, it creates a record `{pos, time}` and signals all other NPCs. If nobody perceives the player, the record is not updated.

---

## 2. Alert states and transitions

```
Unaware(patrol/idle)
  --meter a>=1 | heard sound | sees body-------------> Suspicious (yellow)
Suspicious
  --pair up: nearest ally recruited (C)---------------> Investigate (investigator walks, watcher watches)
Investigate
  --a>=2 | gunshot | finds player--------------------> Combat (orange, LKP broadcast)
  --finds body-------------------------------------> Search (all NPCs; never back to Unaware) (C)
  --nothing after look-around-----------------------> Unaware (return to previous spot/script) (M p.426)
Combat
  --player perceived-------------------------------> Combat (update LKP)
  --player > SNUCK_AWAY from LKP and unseen ---------> Combat.ConfirmLKP: one NPC approaches LKP now (M p.423)
  --no LOS for LKP_TIMEOUT after advancing max ------> Combat.ConfirmLKP (M p.423)
Combat.ConfirmLKP
  --LKP checker sees LKP area empty-----------------> Search (bark "lost him")
Search (stealth regained: meter works again, faster)
  --a>=2 (lower threshold) | gunshot ---------------> Combat
  (no timeout back to Unaware)                        [INFERRED from C "irreversible"]
```

Rules:
- **Investigate pair** (C) [DEV]: the NPC that registers a distraction recruits a nearby ally. Whichever of the two is **closer** to the distraction becomes the **investigator**; the other becomes the **watcher**. The spotter can end up in either role, with different barks. Start and end times and indicator fades are staggered so the two never move in lockstep.
- TLOU investigate (M p.426–427) [DEV]: an NPC requests the coordinator's **Investigator** role (only one at a time). It walks to the best post from a dedicated investigate post selector and plays a look animation. If it finds nothing, it returns to where it was and resumes its routine.
- **Aggressive investigation** (C) [DEV]: consecutive investigations make enemies search more aggressively, which raises their chance to spot a player in grass. On the hardest difficulty they always investigate aggressively. Guide numbers per difficulty are in §9.
- **Combat → search cycle** (M p.423) [DEV]: NPCs surround the player and advance. If they have advanced as far as they can and nobody has seen the player for **≥10 s**, one NPC goes to check the LKP. If the player is gone, the group switches to search. On its own this cycle took about **2 min** in focus tests, which was too slow. The fix was a cheat: if the player gets **>5 m** from where the NPCs think he is, he has "snuck away", and an NPC is sent to the LKP immediately. That cut the cycle to about **30 s**.
- U4 makes snuck-away distance a per-encounter param, tuned to the size of the space (G 35:21) [DEV]. Its **default is 8.0 m**, and a flag `allow-pursue-on-timeout` (default true) presumably enables the timeout LKP check described above (G-deck p114) [DEV]. U4 also adds the **full stealth loop**: break line of sight and NPCs drop into search, after which the player can sneak again (G 7:07) [DEV].
- **Search, as U4 shipped it** (G 38:06–40:05) [DEV]:
  - Designers draw **spline loops**. Searchers follow them, flow from segment to segment and get reassigned dynamically.
  - Searchers may deviate a little to check behind cover or look over an edge.
  - Each spline has a cap on how many NPCs it takes, so they don't bunch. Two NPCs on one spline can check in with each other or pair up for a while.
  - Defenders don't walk splines. They stay on their hard point and look outward from the points with the best **vantage**: the count of clear raycasts to navmesh points the player could reach in about 3 s (G 18:46–19:24, 39:51).
  - Rejected approaches: heat-diffusion search (G 20:43–23:46) and TLOU's spreading search-grid (M p.427). Gallant's reasons: heat search turns NPCs unpredictably and unhumanly, bunches them up, and pulls them into nooks. Design the search for the player's experience: predictable lines of motion the player can plan takedowns around (G 48:06).

| name | value | unit | source | confidence |
|---|---|---|---|---|
| LKP_TIMEOUT (no sight before LKP check) | 10 | s | M p.423 | [DEV] (TLOU) |
| SNUCK_AWAY distance (U4 default) | 8.0 | m | G-deck p114 (`snuck-away-distance`), G 35:21 | [DEV] |
| SNUCK_AWAY distance (TLOU) | 5 | m | M p.423 | [DEV] (TLOU) |
| allow-pursue-on-timeout | true | bool | G-deck p114 | [DEV] |
| num-searchers | −1 (unset → system decides) | NPCs | G-deck p114 | [DEV] value, [INFERRED] meaning |
| combat→search cycle with cheat | ~30 | s | M p.423 | [DEV] (TLOU) |
| combat→search cycle without cheat | ~120 | s | M p.423 | [DEV] (TLOU, the bad case) |
| vantage horizon (player reach) | ~3 | s of movement | G 18:52 | [DEV] |
| investigate look-around duration | 4–6 | s | – | [INFERRED] |
| investigator/watcher stagger | 0.3–0.8 random | s | C (staggered, no number) | [INFERRED] value |
| NPCs per search spline (cap) | 2 | NPCs | G 39:21 (cap exists, value not given) | [INFERRED] |
| search re-spot threshold (Search state) | 0.6× unaware acquire | × | C (aggressive searchers spot better) | [INFERRED] |
| search loops for one room | 2 (perimeter + centre) | loops | – | [INFERRED] |

---

## 3. Tactical position selection (posts and selectors)

### 3.1 Candidate generation

- **Post types** (G 11:03–11:31, 44:19) [DEV]: **open** posts, **cover** posts, **perch** posts and **climb** posts. Perch posts sit on cliff edges and thin railings and play lean-out animations to aim down. Climb posts are mostly for buddies; enemies rarely climb. Generate them offline from navmesh and cover markup.
- TLOU candidate gathering (M p.424) [DEV]:
  - Each NPC gathers the **closest 20 cover spots** in a radius. Candidates must face away from the threat.
  - Up to **160 rays/frame** check them, **4 rays per cover** testing whether the NPC could shoot and hit the target from there. Any cover with all rays blocked is rejected.
  - **Open posts** are generated around the player and kept only if they have a clear ray to the LKP.
  - Pathfinds are computed to every viable post, max **20/frame**, round-robin, refreshing about every **0.5 s**.
- U4 radius (G 14:43, 32:05) [DEV]: post selection only considers posts within **25 m of the selector's anchor**. Each role has its own anchor (§4.1), which fixed the bug where a zoned NPC found no valid post and stood frozen in the open.

### 3.2 Scoring

```
score(post, selector, npc) =
   0 if any FILTER criterion rejects (path invalid, claimed, behind player, wrong facing,
        cannot see target, path runs toward player too long, outside role region)
   else  Π_i  curve_i(measure_i(post, npc))          // each in [0,1]   (M p.425, G 12:00)
best = argmax score; claim it (posts are exclusive: 'available' criterion)
All selectors are evaluated continuously, so a state switch has its post ready (M p.426).
```

Criteria seen in Naughty Dog's own listings:
- TLOU "panic" (hide) selector (M Listing 34.1) [DEV]: post type cover. Filters: path valid, within close-in distance, available, static path not near player, not behind the player. Distance-to-player curve: **3 m → 0.0, 5 m → 1.0**.
- U4 "ambush" selector (slide at G ~15:00, captured in Known repo: docs/reference/uncharted4-combat-ai/transcript.md "slide facts") [DEV]. Post types: cover or open. Restricted to the role region. Filter: frustum-valid. Scorers:
  - **elevation**, weight 10, curve **−10 m → 0.1, 0 m → 0.2, +5 m → 1.0** (prefers high ground).
  - **NPC path distance**, weight 1, curve **0 m → 1.0, 5 m → 0.9, 20 m → 0.1**, falloff 0.1.
- U4 advance example (G 12:20–13:41) [DEV]: posts near the NPC with a good line to the target score high. A **rifleman prefers a little more distance**, so the per-archetype distance preference picks among the good posts. Covers facing the wrong way, covers that can't see the target, and covers behind an advancing NPC are rejected.
- TLOU "static-pathfind-not-near-player" (M p.425) [DEV]: reject covers whose path runs toward the player for a long stretch. Players complained about NPCs rushing forward just to take cover.
- UC2 mid-range combat behaviour (R) [DEV], a usable weight set for a grunt:
  - attracted to stay within **15 m** of the target, repelled inside **5 m**.
  - repelled within **2 m** of allies.
  - cover weight **10**, travels up to **15 m** to reach cover, ignores cover within **8 m** of the target, current-cover stickiness **1.0**.
  - target-visibility weight **5**.
  - Known flaw: the separate pathfinder may still route within 5 m of the target.
- Lesson (G 15:42–16:25) [DEV]: do **not** hard-enforce ideal weapon range. Because the player moves fast, NPCs never settled and kept repositioning. Use soft distance curves instead.

Recommended selectors for the room [INFERRED unless tagged]:

| selector | used by | filters | scorers (curve) |
|---|---|---|---|
| `engage` | Engager in Combat | can-shoot-target (≥1 of 4 rays), available, not-behind-player, path-not-toward-player | dist-to-player (5 m→0.3, 10 m→1, 15 m→1, 25 m→0.2); path-dist-from-NPC (0→1, 5→0.9, 20→0.1) [DEV curve, G slide]; cover-vs-open (cover 1.0, open 0.4); ally spacing (<2 m → 0) [DEV value, R] |
| `advance` | Engager, advance timer fired | as engage + post must be closer to player than current | dist-to-player (pistol prefers 6–10 m, rifle 10–15 m); path-dist (short) |
| `defend` | Defender | inside hard-point region | can-see-target 1.0 / else 0.5; elevation (−10→0.1, 0→0.2, 5→1.0) [DEV curve, G slide] |
| `ambush` | Ambusher | within 25 m of ambush point, frustum-valid | elevation, path-dist [DEV, G slide]; hidden-from-player 1.0 / visible 0.2 |
| `panic` | Panic (low HP, grenade) | path-not-near-player, not-behind-player | dist-to-player 3 m→0, 5 m→1 [DEV, M] |
| `investigate` | Investigator | clear LOS to stimulus | dist-to-stimulus (2–4 m best) |

| name | value | unit | source | confidence |
|---|---|---|---|---|
| post selection radius from anchor | 25 | m | G 14:43 | [DEV] |
| cover candidates per NPC | 20 nearest | posts | M p.424 | [DEV] (TLOU) |
| rays per cover candidate | 4 | rays | M p.424 | [DEV] (TLOU) |
| ray budget | 160 | rays/frame | M p.424 | [DEV] (TLOU) |
| path refresh to all posts | ~0.5 | s | M p.425 | [DEV] (TLOU) |
| pathfinds per frame (post paths) | 20 | /frame | M p.424 | [DEV] (TLOU) |
| number of selectors shipped | 17 | selectors | M p.424 | [DEV] (TLOU) |
| score combine | product of [0,1] criteria | – | M p.425, G 12:00 | [DEV] |
| re-score interval (browser) | 0.5 | s | – | [INFERRED] |
| switch hysteresis | new ≥ 1.2 × current | × | – | [INFERRED] |
| min dwell at a post before voluntary move | 3 | s | – | [INFERRED] |
| cover post spacing along cover | 1.0 | m | – | [INFERRED] |
| open post grid | 2.0 | m | – | [INFERRED] |

Open point: the ambush slide gives `:weight 10` and `:weight 1` while scores multiply. The semantics are unknown. [INFERRED] Use a weighted geometric mean, `score = Π c_i^(w_i / Σw)`, so weights act as exponents and the result stays in [0,1].

### 3.3 Vantage, perches, designer hard points (implemented; full design in `refs/ai-vantage.md`)

- **Vantage** (G 17:55–19:24, G-deck p65–68) [DEV]: the share of the player's ~3 s reach set (sampled navmesh points around the LKP) that a post can see, using one cached, budgeted raycast per point. The talk dropped connectivity plus vantage as an automatic replacement for zones (G-deck p69–72). So here it is only a selector term (strong in `defend`, light in `engage` and `advance`) and the defender's **defend search** (G 39:51): a defender with no vantage moves to a post inside its own hard point that has some, and in search it looks outward from there.
- **Perches** (G 11:03, 44:19, G-deck p46, p146–147) [DEV]: rails over a drop and open ledges become `perch` posts with a lean-out fire point. When the player is below the edge and out of the line of fire, the `perch` selector moves the NPC there to aim down. Thresholds are [ASSUMED].
- **Designer hard points and posts** (G-deck p88) [DEV]: `level.hardPoints` (`id`, `name`, `region` polygon, `min`, `max`, `enabled`) and `level.posts` (optional `hardPoint` / `roles` tags) join the same pool as the generated ones.

---

## 4. Combat coordination

### 4.1 Core roles and role assignment (U4)

- **Engager**: approaches and attacks the player's current position, may move anywhere, selects posts around the player (G 29:36, 32:13) [DEV]. Pac-Man analogy: Blinky.
- **Ambusher**: claims an **ambush point generated 20 m from the player along the navmesh**, takes cover there and pops out when the player comes its way. This keeps the areas the player flees into from feeling empty (G 29:53–30:52) [DEV]. Pac-Man analogy: Pinky. Known flaw: navmesh distance ignores drops, and the shipped workaround was setting ambushers = 0 for that encounter (G 45:37–46:06) [DEV].
- **Defender**: stays inside its **hard point** and gets line of sight and cover there (G 30:52) [DEV].
- **Hard point** (G 25:31–27:28) [DEV] has five fields: `name`, `region`, `minNPCs`, `maxNPCs`, `enabled`. A **hard-point coordinator** assigns NPCs by distance, target and weapon type, and avoids sending NPCs backwards. Example: an exit hard point with min 1, so one NPC always guards the exit. When reinforcements take over a hard point (min 1 / max 2), the original holders are freed to push forward.
- **Assignment pass** (G 33:11–34:30) [DEV], run whenever the roster changes:

```
assignRoles(npcs):
  1. for hp in hardPoints(enabled): assign closest suitable NPCs until hp.min      // highest priority
  2. pick X engagers (closest to player)                                           // X = params.numEngagers
  3. pick Y ambushers                                                              // Y = params.numAmbushers
  4. fill hard points up to hp.max
  5. leftovers -> Engager  (+ dev warning: "under-specified encounter")
  archetype pins override: shotgunner always Engager, sniper always Defender (G 41:26)
  NPCs may *request* a role; the coordinator decides by rating (distance, LOS, weapon) (G 32:46)
on engager death: after ENGAGER_REPLACE_DELAY = 6.0 s, promote the best non-engager (G 35:08, G-deck p114)
```

### 4.2 Shooter tokens (the most important coordination rule)

- U4 (G 36:10–37:59, Q&A 53:50–55:00, G-deck p114, p126) [DEV]:
  - Cap how many NPCs may fire at once: the talk says **usually 3–4**, and the shipped default is **min 2, max 3**, set per encounter. Otherwise difficulty scales with headcount: the fight starts very hard and gets easier with each kill.
  - Shooter is a role **orthogonal** to core roles. Only holders may fire. The coordinator ranks every NPC for the role and picks the best.
  - A holder **releases** the token when it (a) reloads, (b) plays a hit reaction from being shot, or (c) loses line of sight to the target (G-deck p126). Waiting NPCs hunker in cover and look busy.
  - Priority: **closer NPCs** get the token more readily, and an NPC the player is **directly engaging** gets top priority.
  - Fudging is allowed. An NPC that clearly should be shooting may skip its reload so it doesn't look silly.
- TLOU (M p.427–428) [DEV]: the **OpportunisticShooter** role guarantees at least one NPC is shooting whenever any NPC can. Any NPC that can see and shoot the player requests it, first come first served. The holder **instantly** stops what it is doing, even mid-animation, and blends to stand-and-shoot. Before this change, a rushing player took almost no damage.

```
shooterManager.tick():
  eligible = npcs where hasLOS(player) && !reloading && state == Combat
  rank = sort(eligible, by: directlyEngagedByPlayer desc, distance asc)
  holders = holders ∩ eligible                         // drop lost-LOS / reloading
  while holders.size < maxShooters and rank not empty: grant(rank.pop())
  if holders.size < minShooters: grant to best NPC that can reach LOS soonest (peek)
```

### 4.3 Flanking

- U4 (G 42:50–43:48, 35:50–36:10, Q&A 55:38–56:11, G-deck p114) [DEV]:
  - **Flanker** is an orthogonal role, dispatched by a **flank timer** to push a player who has stayed in one place too long. Defaults: `wait-to-flank-time` **6.0 s**, `move-flank-distance-reset` **4.0 m** (if the player moves more than 4 m, the timer restarts), `min-flank-path-rating` **0.5**.
  - Its path uses a cost that makes travel through the **combat vector** region more expensive. The combat vector is a fixed oblong shape from the player toward the average direction of enemy threat.
  - A **min flank-path rating** param gates bad routes. Lowering it makes NPCs more aggressive but sloppier.
  - Only send a flanker when **enough other NPCs are already pressuring** the player. Prefer an NPC that is doing something boring.
- TLOU (M p.428) [DEV]: the combat vector is the average of NPC positions **weighted by shots fired recently**. The cost rises toward the centre line. Each frame the coordinator picks one ideal flanker by route cost and rejects requests from everyone else. The exposure-map flank route flickered frame to frame and was replaced by this.

```
flankTimer: if dist(player.pos, flankAnchor) > 4.0: flankAnchor = player.pos; t = 0   // G-deck p114
            else t += dt;  if t >= 6.0 and pressureOK: dispatch (then t = 0)
combatVector = normalize(Σ_i w_i (npc_i.pos - player.pos)),  w_i = 1 + recentShots_i(last 3 s)
cost(edge) = baseCost * (1 + FLANK_COST_MUL * max(0, 1 - lateralDist(edge, axis)/HALF_WIDTH))
             for edges inside the oblong (length FLANK_LEN along combatVector, from player)
flankRating = straightLineDist / pathCost   ; dispatch if rating >= minFlankRating
```

### 4.4 Advance and suppression

- The advance skill moves an NPC cover to cover on a per-encounter **advance timer**. While one NPC advances, another can be asked to lay **suppressing fire** (G 35:44, Q&A 55:38–55:49) [DEV]. That is one of the few NPC-to-NPC requests the talk names. Defaults: `wait-to-advance-time` **6.0 s**, `move-advance-distance-reset` **6.0 m**: the timer restarts when the player moves more than 6 m (G-deck p114) [DEV]. So a player who keeps relocating is not pushed, and a static player gets pushed every ~6 s.

### 4.5 Archetypes (note only)

- All enemy types run the **same brain**. Types differ only in **combat params**, which use inheritance (a child of the default rifleman with take-cover turned off) and composition (an armored grenade launcher built from two parents) (G 40:23–41:19) [DEV].
- UC2 classes (R) [DEV]: Light, Medium, Heavy, Armored, Shield. U4 adds snipers, shotgunners, heavy weapons and armored types (G 40:34). For now only **rifle grunt** and **pistol grunt** are needed, both Light-class.
- Per-NPC combat-param fields visible on the U4 heavy-gunner slide (G-deck p138) [DEV]: `combat-min-distance`, `combat-max-distance` (heavy gunner 1.0 / 3.0), `attitude` (aggressive), `strafe` (always), `speed` (slow), `range` (close), `allow-grenades`, `allow-cover`, `allow-flank`, `allow-ambush`, `allow-hardpoint-assignment`, `always-counts-as-flanking`, `ignore-enemy-grenades`, `dodge-delay` (a min–max range; 999 = never dodge), plus buddy flags. The heavy gunner turns all the allow-flags off and ignores grenades. Grunt defaults [INFERRED]: all `allow-*` on; `ignore-enemy-grenades` off; `strafe` when exposed; `range` medium (rifle) or close-medium (pistol); `dodge-delay` 0.3–0.8 s.

| name | value | unit | source | confidence |
|---|---|---|---|---|
| numEngagers (X) | 2–3 typical; slide default −1 (unset) | NPCs | G 33:36; G-deck p114 | [DEV] |
| numAmbushers (Y) | 2–3 typical; slide default 2 | NPCs | G 33:49; G-deck p114 | [DEV] |
| ambush point distance | 20 (navmesh) | m | G 30:07 | [DEV] |
| maxShooters (talk) | 3–4 | NPCs | G 36:43 | [DEV] |
| min / max shooters (shipped default) | 2 / 3 | NPCs | G-deck p114 | [DEV] |
| **room defaults** (5–6 grunts): X / Y / minShooters / maxShooters | 2 / 0–1 / 2 / 3 | NPCs | shooters = U4 default; X, Y scaled from G | [DEV] shooters, [INFERRED] X/Y |
| ambush distance for one room | 0.6 × room diagonal (or Y = 0) | m | G 46:06 workaround | [INFERRED] |
| engager-replacement-delay | 6.0 | s | G-deck p114 | [DEV] |
| wait-to-advance-time | 6.0 | s | G-deck p114 | [DEV] |
| move-advance-distance-reset | 6.0 | m | G-deck p114 | [DEV] |
| wait-to-flank-time | 6.0 | s | G-deck p114 | [DEV] |
| move-flank-distance-reset | 4.0 | m | G-deck p114 | [DEV] |
| min-flank-path-rating | 0.5 | ratio (0..1) | G-deck p114 | [DEV] value, [INFERRED] rating formula |
| min other NPCs pressuring before flank | 2 | NPCs | G 55:55 (qualitative) | [INFERRED] |
| FLANK_LEN / HALF_WIDTH / FLANK_COST_MUL | 12 / 4 / 8 | m / m / × | M fig. 34.9 shape only | [INFERRED] |
| combat-vector shot weighting window | 3 | s | M p.428 ("recently") | [INFERRED] |
| TLOU coordinator roles | Flanker, Approacher, Investigator, StayUpAndAimer, OpportunisticShooter | – | M p.428 | [DEV] |

---

## 5. Shooting model

Rules:
- **Accuracy ramp** (G 43:54–44:14) [DEV]: from the moment they spot the player, NPCs ramp to full accuracy **over time, based on distance**. Agile players who keep moving between covers take little damage; turtling players lose the benefit. The shipped **time-to-accuracy curves** (G-deck p145) [DEV] map distance to seconds-to-full-accuracy, interpolated between points:
  - Light enemies: 5 m 3.0 s, 15 m 4.5 s, 30 m 6.0 s.
  - Medium enemies: 5 m 2.5 s, 15 m 4.0 s, 30 m 5.5 s.
  
  The ramp's shape (linear or eased) and its starting accuracy are not on the slide [INFERRED: linear from 0].
- **Accuracy floor** (G 46:59–47:06) [DEV]: even at extreme range, accuracy never drops below a floor. This was added because players chipped at NPCs with a pistol from about **50 m**.
- **Player side, for the gunplay spec** (G 46:27–50:59) [DEV]: the player's first pistol shot goes **dead centre of the reticle**, because playtesters called anything else sloppy and fell back on melee. Damage wobble on the camera discourages long-range sniping.
- **UC2 concrete accuracy model** (R) [DEV]:
  - Per-weapon **distance curve**, assault rifle: **60 m 0%, 30 m 30%, 20 m 40%, 12 m 40%, 8 m 50%, 4 m 90%**, linear between points.
  - **"Time to accurate cover"**: when the player **pops out of cover**, AI accuracy drops to the worst value (0%) and ramps back to the best (100%) over **3.5 s**. This is the documented "deliberate early misses".
  - **Target movement modifiers**: running ×0.9, rolling ×0.5, standing ×1.0.
  - **Master accuracy additive**: +0.1 for Medium-class enemies over Light. Master multiplier: 1.0.
- **Burst pattern** (R, UC2 assault rifle) [DEV]:
  - Initial delay 0 s.
  - Each burst has a **33%** chance to be single shots (**1–3 shots, 0.16–0.20 s apart**). Otherwise it is full auto, **3–5 rounds** at weapon fire rate.
  - **0.4–0.8 s** pause between bursts.
  - Each weapon gets a distinct pattern, so not everyone fires full-auto at once and the audio stays readable.
- **Reaction**: TLOU's shooter blends to firing **instantly** on getting the role (M p.428) [DEV]. UC2 re-evaluates targets every **1 s** (R) [DEV]. The ramp starting near 0 makes instant firing fair.

```
hitChance(npc, player) =
  clamp( distCurve[npc.weapon](d)
         * rampSinceSpot(tSpot, d)          // 0 -> 1
         * popOutRamp(tSincePlayerExposed)  // 0 -> 1 over 3.5 s (UC2)
         * moveMod(player.motion)           // run .9, roll .5, stand 1
         * difficulty.accMul
         + archetype.accAdd,
         ACC_FLOOR, 1)
rampSinceSpot(t, d) = saturate(t / timeToAccuracy[npc.class](d))   // U4 curve, G-deck p145
timeToAccuracy.light(d)  = piecewiseLinear([5,3.0],[15,4.5],[30,6.0])(clamp(d,5,30))
timeToAccuracy.medium(d) = piecewiseLinear([5,2.5],[15,4.0],[30,5.5])(clamp(d,5,30))
on each shot: if rand() < hitChance -> hit (damage) else -> miss: aim at a point 0.4–1.2 m off the
  player's silhouette (prefer hitting the cover in front) so misses read as near-misses
reset tSpot when the NPC re-acquires after losing LOS > 2 s; reset popOutRamp when player leaves cover
```

**Cover behaviour as shown on U4 debug overlays** (G-deck p128, the min/max-shooters demo) [DEV]:
- The cover behaviour has states **Idle** and **Aim**. Each NPC shows a permission list over five actions: `idle`, `aim`, `blindfire`, `peek` and `suppress`.
- In the frame shown, NPCs **without** the shooter token were allowed idle, aim and peek, and denied blindfire and suppress. **Token holders** ran a `BehaviorShoot` with flags "Can Fire" and "Suppress Allowed", with blindfire still denied.
- Every NPC carried a **"being shot at"** flag.
- Per-NPC timers read "Peek in 0.19 s" and "Peek in 2.31 s" (non-shooters peeking out without firing, which keeps waiting NPCs alive-looking), "Aim in −1.57 s" and "Aim in −0.15 s" (aim timer elapsed, still waiting for a token), and "Exit in 2.74 s" and "Exit in 4.64 s" (time left in a shooter's exposed aim window).
- From that single frame [MEASURED: read off the slide's debug text], an exposed aim window lasts **at least ~5 s**, and peeks recur on a **~0–3 s** timer.

**Peek / pop-out cycle** [structure from G-deck p128; durations INFERRED unless tagged]:
```
CoverCombat (G 9:14: open-combat and cover-combat states)
  Idle (hidden):
     peekTimer -> Peek: lean out 0.6–1.0 s, look, no fire; re-arm peekTimer = rand(1.0, 3.0) s
     aimTimer elapsed && has Shooter token -> Aim
  Aim (exposed, token holder only):
     exitTimer = rand(4.0, 6.0) s                         // ≥ ~5 s seen on G-deck p128
     fire bursts (pattern above) while LOS
     -> Idle on exitTimer, reload (token released), hit reaction (token released), LOS lost (released)
  Suppress: token holder fires at last-seen cover position without LOS (allowed for shooters, p128)
  BlindFire: exists in U4's permission list but was disallowed in the frame shown;
             prototype: disabled for grunts [INFERRED]
```

| name | value | unit | source | confidence |
|---|---|---|---|---|
| accuracy ramp after spotting | exists, distance-scaled | – | G 43:54 | [DEV] |
| time to accuracy, light (5 / 15 / 30 m) | 3.0 / 4.5 / 6.0 | s | G-deck p145 | [DEV] |
| time to accuracy, medium (5 / 15 / 30 m) | 2.5 / 4.0 / 5.5 | s | G-deck p145 | [DEV] |
| shooter-token release triggers | reload, hit reaction, no LOS | – | G-deck p126 | [DEV] |
| exposed aim window ("Exit in") | ≥ ~5 (4.64 left in one sample) | s | G-deck p128 debug text | [MEASURED] (one frame) |
| peek re-arm timer | ~0–3 (0.19, 2.31 in samples) | s | G-deck p128 debug text | [MEASURED] (one frame) |
| peek duration | 0.6–1.0 | s | – | [INFERRED] |
| accuracy floor | exists | – | G 47:06 | [DEV] |
| ACC_FLOOR | 0.05 | probability | – | [INFERRED] |
| player pistol sniping range (problem case) | ~50 | m | G 46:27 | [DEV] |
| AR distance curve (60/30/20/12/8/4 m) | 0/30/40/40/50/90 | % | R | [DEV] (UC2) |
| pistol grunt distance curve (40/20/12/8/4 m) | 0/25/35/45/80 | % | shape from R | [INFERRED] |
| pop-out ramp (worst→best) | 0% → 100% over 3.5 | s | R | [DEV] (UC2) |
| move modifiers run/roll/stand | 0.9 / 0.5 / 1.0 | × | R | [DEV] (UC2) |
| master accuracy additive (Medium) | +0.1 | prob. | R | [DEV] (UC2) |
| burst: single-shot chance | 33 | % | R | [DEV] (UC2 AR) |
| single-shot burst | 1–3 shots, 0.16–0.20 s apart | – | R | [DEV] (UC2 AR) |
| auto burst | 3–5 | rounds | R | [DEV] (UC2 AR) |
| inter-burst delay | 0.4–0.8 | s | R | [DEV] (UC2 AR) |
| pistol grunt burst | 1–3 shots, 0.3–0.45 s apart; 0.8–1.4 s pause | – | – | [INFERRED] |
| AR rate of fire (auto) | 600 | rpm | – | [INFERRED] |
| first-shot delay after token+LOS | 0.3–0.5 | s | M (instant blend) + aim settle | [INFERRED] |
| pop-out exposure per cycle | 4–6 | s | G-deck p128 (≥ ~5 s) | [INFERRED] from [MEASURED] |
| hidden time between pop-outs (token holder) | 1.0–2.5 | s | – | [INFERRED] |
| reload time (rifle / pistol) | 2.0 / 1.5 | s | – | [INFERRED] |
| magazine (rifle / pistol) | 30 / 12 | rounds | – | [INFERRED] |
| miss offset from silhouette | 0.4–1.2 | m | – | [INFERRED] |

---

## 6. AI grenades

Enemy throwing (U4 **grenade director**, G 42:03–42:50, 35:44) [DEV]:
- Purpose: grenades nudge a player who hunkers down in one spot to move, since U4 doesn't want to play like a static cover shooter.
- A timer tracks how long the player stays inside **a radius**. Leaving the radius resets it. When it runs out, the director asks for a thrower. **Grenade thrower** is a role that goes to the NPC with the best **clear arc**.
- The time before NPCs start throwing grenades is a per-encounter global param.
- The debug view shows the countdown as an on-screen meter.
- The debug overlay on G-deck p142–143 [DEV] shows "Sample Rate: 1.0s" (the player's position is sampled once a second) and "Multi Chance: 0.0%" (the chance of a multi-grenade throw is zero by default). It also shows three concentric rings around the player, labelled **Accuracy** (read as the landing-scatter radius), **Friend Check** (read as: don't throw if an ally is inside) and **Move Reset** (the dwell radius; leaving it resets the timer). Each NPC is ranked for the thrower role, with "<invalid>" when it has no arc.
- Ring radius ratio Accuracy : Friend Check : Move Reset ≈ **1 : 1.5 : 3.2** [MEASURED: pixel radii on both slides, 162/247/521 px and 139/210/432 px]. Absolute size isn't readable because the grid scale is unknown.
- The grenade-timer default sits below the crop on the params slide (p114) and is not visible.
- Players report enemies shout a warning before throwing [WIKI, guide snippet].

```
grenadeDirector.tick(dt):            // run at SAMPLE_RATE = 1.0 s (G-deck p142)
  if dist(player.pos, dwellCentre) > MOVE_RESET_RADIUS: dwellCentre = player.pos; t = 0
  else t += SAMPLE_RATE
  if t >= params.grenadeTimer and now >= nextAllowed and npcsInCombat >= 1:
     candidates = Combat NPCs with clearArc(npc, player.pos)
                  and no ally within FRIEND_CHECK_RADIUS of player.pos      // 'Friend Check' ring
     thrower = argmax(candidates, rank = −|d − 12 m| + (isShooter ? 0 : 2))
     aim = player.pos + randomInDisc(ACCURACY_RADIUS)                       // 'Accuracy' ring
     thrower.request(ThrowGrenade, aim)    // bark "Grenade out!" first; Multi Chance 0 → one grenade
     t = 0; nextAllowed = now + GRENADE_COOLDOWN
```

Reacting to the player's grenades (UC2 has a `grenade-avoidance` skill, plus `dodge` and `startle`; R) [DEV skill exists]. Rule [INFERRED]:
```
on grenade landed or predicted landing point L (also while in flight if NPC has LOS to it):
  for npc within FLEE_RADIUS of L, after REACT_DELAY (if NPC saw or heard it):
     bark "Grenade!"; push GrenadeAvoid: sprint to best post with dist(L) > FLEE_RADIUS (panic selector);
     if no path out in time (fuse remaining < 0.6 s) -> dive/flinch away in place
  GrenadeAvoid outranks Combat; Shooter token released while fleeing
```

| name | value | unit | source | confidence |
|---|---|---|---|---|
| grenade director: dwell radius | exists | – | G 42:16 | [DEV] |
| SAMPLE_RATE | 1.0 | s | G-deck p142 | [DEV] |
| multi-grenade chance | 0 | % | G-deck p142 | [DEV] |
| ring ratio Accuracy : Friend Check : Move Reset | 1 : 1.5 : 3.2 | ratio | G-deck p142–143 pixels | [MEASURED] |
| MOVE_RESET_RADIUS | 4.0 | m | matches flank reset 4.0 m (p114) | [INFERRED] |
| FRIEND_CHECK_RADIUS / ACCURACY_RADIUS | 1.9 / 1.25 | m | ring ratio × 4.0 m | [INFERRED] |
| grenadeTimer (dwell before throw), Moderate | 8 | s | G 35:50 (param exists; default cropped off p114) | [INFERRED] (sibling timers are 6.0 s) |
| GRENADE_COOLDOWN after a throw | 6 | s | – | [INFERRED] |
| max enemy grenades in flight | 1 | grenades | – | [INFERRED] |
| preferred throw distance | 8–18 | m | – | [INFERRED] |
| enemy grenade fuse (from throw) | 2.5 | s | – | [INFERRED] (match player spec) |
| FLEE_RADIUS (player grenade) | blast radius + 1 (≈ 5) | m | – | [INFERRED] |
| REACT_DELAY to player grenade | 0.3–0.6 | s | – | [INFERRED] |

---

## 7. Hit reactions, stagger, death, health

- **Health model** (R) [DEV]: integer health with base **100** for the player and most AI. Damage is defined **per weapon per damage-receiver class** in a spreadsheet. UC2's small pistol did **34** to Light and **17** to Medium, so 3 and 6 body shots. UC2's assault rifle did **5** per bullet to characters. (UC1 used flat damage and tuned health, which cascaded badly.)
- TLOU (D p.~350) [DEV]: the buddy must take as many shots as the player to down an enemy. The worked example is **three shots**.
- TLOU on lethality (M p.427) [DEV]: enemies are threatening because they deal real damage and every hit on the player is felt, not because they soak bullets. Bullet-sponge humans broke immersion.
- Friends notice deaths (M p.420) [DEV]: when an ally dies, NPCs react, via barks and engager replacement (§4.1).
- UC2 skills `dodge` and `startle` exist (R) [DEV]. The U4 hit-reaction details are unpublished. Physics-layered reactions were covered in Michal Mach's GDC 2017 talk, "Physics Animation in Uncharted 4" (not reviewed).

Rules [INFERRED unless tagged]:
```
onHit(npc, dmg, zone):
  dmg = weaponTable[weapon][npc.damageClass] * zoneMul[zone]   // per-class table (R)
  npc.hp -= round(dmg)                                          // integer hp (R)
  if npc.hp <= 0: die(ragdoll/anim), drop weapon + ammo; notify allies (LKP = shooter pos)
  else:
     cancel current burst; release Shooter token (U4 releases it on any hit reaction, G-deck p126)
     play flinch by zone: torso 0.35 s, arm 0.3 s, leg = stumble 0.8 s (breaks cover move)
     if 2 hits within 1.0 s: stagger 1.0 s (no fire, no move)
     if npc in cover & hp < 35%: Panic selector -> fall back one post (M panic listing)
```

| name | value | unit | source | confidence |
|---|---|---|---|---|
| base health (grunt, player) | 100 (integer) | hp | R | [DEV] (UC2) |
| pistol vs Light class | 34 | hp/shot | R | [DEV] (UC2) → 3 body shots |
| pistol vs Medium class | 17 | hp/shot | R | [DEV] (UC2) |
| shots to down a human (example) | 3 | shots | D | [DEV] (TLOU) |
| grunt health (room prototype) | 100 | hp | – | [INFERRED] |
| player pistol body damage vs grunt | 28 (UC2 reuse was 34) | hp | player-spec §5; Max confirmed 28, 12 Nov | [MEASURED low] |
| headshot multiplier (unarmored) | ×3 (one-shot kill) | × | – | [INFERRED] |
| limb multiplier | ×0.75 | × | – | [INFERRED] |
| flinch duration torso/arm | 0.35 / 0.3 | s | – | [INFERRED] |
| leg stumble | 0.8 | s | – | [INFERRED] |
| stagger (2 hits within 1 s) | 1.0 | s | – | [INFERRED] |
| panic fallback HP threshold | 35 | % | – | [INFERRED] |
| enemy rifle damage to player | 10 per hit (10 hits kill from full) | hp | Max, 12 Nov | (was [INFERRED] 8–10; UC2 AR did 5) |

---

## 8. Barks and communication (behaviour-relevant only)

- **Spotting is shared** (M p.423) [DEV]: an NPC that perceives the player creates `{pos, time}` and signals all NPCs. It is the only way the LKP changes.
- **Losing the player must be said out loud** (M p.420) [DEV]: NPCs tell each other, in a way the player can hear, that the player is lost. This tells the player stealth is regained.
- **Investigation barks** (C) [DEV]: the spotter recruits a partner, and there are different lines for investigator and watcher.
- **Body found** (C) [DEV]: the investigator alerts everyone, and everyone searches.
- **Grenade warning** before an enemy throws [WIKI].
- Dialog's job is to make the AI's decisions readable to the player (M p.429) [DEV]. Add barks after the decision logic works.

Implementation [INFERRED]:
```
on Combat enter (first NPC to orange): bark "There he is!"; all encounter NPCs -> Combat with LKP
     (P: a full orange meter alerts nearby enemies) — in one room, everyone.
on Suspicious: bark only from the spotter; no broadcast (others stay Unaware unless recruited)
on LKP confirmed empty: bark "Lost him" -> group Search
on flank dispatch: bark "Moving around!" (readability; not required for logic)
on throw: bark "Grenade out!" 0.6 s before release
on ally death: nearest ally barks; ENGAGER_REPLACE_DELAY starts
```

| name | value | unit | source | confidence |
|---|---|---|---|---|
| LKP broadcast latency | 0 (instant) | s | M p.423 | [DEV] (TLOU) |
| grenade bark lead time | 0.6 | s | – | [INFERRED] |

---

## 9. Difficulty knobs

- U4 modes: Explorer, Light, **Moderate (default)**, Hard, Crushing [WIKI].
- Aggressive investigation [WIKI, P]: never on Explorer or Light. On Hard, an enemy becomes aggressive within **10 s** of finishing an investigation. On Crushing, always. This agrees with C [DEV], who says consecutive investigations raise aggression and Crushing always investigates aggressively.
- Enemy accuracy is "slightly reduced" on lower settings [WIKI, low reliability, scraped forum text]. Enemy shotgun damage is reduced on easy and maxed on Crushing [WIKI, P].
- Fandom states player health and damage output are the same across U4 difficulties. Earlier games used 50% / 200% on Crushing. These sources conflict and are unverified [WIKI].
- UC2's documented class knobs (R) [DEV]: fire rate, time-to-accurate-cover and the master accuracy additive. Medium enemies were harder via faster fire, +10% accuracy and a shorter pop-out ramp.
- UC1 had dynamic difficulty keyed to encounter completion time, while UC2/3 tuned theirs to player skill (Russell, via VGC) [DEV]. Recommendation: **no DDA** in the prototype, because it would confound the measurement goal.
- Per-encounter global combat params are U4's main tuning surface (G 34:35) [DEV].

| knob | Light | **Moderate (default)** | Hard | Crushing | source / confidence |
|---|---|---|---|---|---|
| aggressive investigation | never | after repeated investigations | within 10 s after an investigation | always | [WIKI] P; C [DEV] (qualitative) |
| accMul | 0.8 | 1.0 | 1.1 | 1.2 | [INFERRED] |
| pop-out ramp time | 4.5 s | 3.5 s | 3.0 s | 2.5 s | [INFERRED] (3.5 s is [DEV] UC2 base) |
| min / max shooters (room) | 1 / 2 | 2 / 3 | 2 / 3 | 2 / 4 | Moderate = U4 default [DEV] G-deck p114; others [INFERRED] |
| time-to-accuracy curve | light × 1.2 | light | medium | medium × 0.8 | light/medium curves [DEV] G-deck p145; mapping [INFERRED] |
| enemy damage to player | ×0.7 | ×1.0 | ×1.3 | ×2.0 | [INFERRED] (×2 echoes older-games [WIKI]) |
| grenadeTimer | 12 s | 8 s | 6 s | 5 s | [INFERRED] |
| acquire-time multiplier (meter) | ×1.3 | ×1.0 | ×0.85 | ×0.7 | [INFERRED] |

---

## Open questions

1. **No [MEASURED] numbers yet.** Plain `yt-dlp` returned HTTP 429 for captions and HTTP 403 for video in this session, while other agents were also pulling from YouTube. Retrying with alternate clients was blocked as bot-check circumvention. Protocol for a later pass: get 60 fps Moderate footage (candidates: `ZnxQwfBs-DI` and `fBSTuRncpkI`, "No Guns" Moderate runs where every shot heard is an enemy's; `T73GW4klH4M` for stealth), then measure:
   - (a) white-arc start to orange, against distance estimated from enemy height on screen. This gives ACQ_NEAR/FAR and confirm(d).
   - (b) audio onset detection on the No-Guns runs for burst length and inter-burst gap. Compare with UC2's 0.4–0.8 s.
   - (c) timestamps of enemy grenade explosions while the player stays put. This gives grenadeTimer and cooldown.
   - (d) shots to kill a grunt with the starting pistol (body and head).
   - (e) the LKP-to-search time after breaking line of sight.
2. **Grenade timer default.** Mostly resolved: deck p114 gave the engager, ambusher, shooter, snuck-away, advance and flank defaults. The **grenade timer** and the grenade-director radii are still missing; the code listing is cropped below `move-flank-distance-reset`. The talk video around 34:53 may show the full listing. Also unread: what −1 means for `num-engagers` and `num-searchers` (assumed "unset, system decides").
3. Post-selector weight semantics (`:weight 10` with multiplicative scoring). The geometric-mean reading is a guess.
4. Does U4's Search ever time out back to an Unaware-like patrol? C says Unaware ends irreversibly after a body is found. It is not confirmed for the combat → search → stealth loop. The spec assumes no timeout.
5. What exactly does "seen behind typical cover up to 18 m" (Prima) mean: crouched at a low wall, or standing at high cover? This needs footage.
6. U4 indicator presentation details: arc versus chevron shape, whether it shows for off-screen enemies (screen-edge clamp), and whether Search shows yellow. Check against footage.
7. Blind fire is a U4 cover action (G-deck p128), but it was disallowed for every NPC in the one frame shown. When it is allowed is unknown. The spec disables it for grunts.
8. Accuracy ramp reset policy (on re-spot or only once per engagement). The talk says only "from the time they spot the player". UC2 also ramps on every player pop-out.
9. Enemy damage to the player, and the player's hidden-health model. Coordinate with the player/gunplay spec.

## Sources

Talks and Naughty Dog writing (confirmed to exist):
- **G**: Matthew Gallant (Naughty Dog), "Authored vs. Systemic: Finding a Balance for Combat AI in Uncharted 4", GDC 2017 Design track. Video: https://www.youtube.com/watch?v=G8W7EQKBgcg (57 min). Vault: https://gdcvault.com/play/1023949/Authored-vs-Systemic-Finding-a. Deck: https://media.gdcvault.com/gdc2017/Presentations/Gallant_Matthew_Authored_vs_Systemic.pdf. Read via the timestamped caption transcript in Known repo: docs/reference/uncharted4-combat-ai/transcript.md (captions of the YouTube video above; slide facts at the end of that file). Key timestamps: 2:13 zones in UC1–3; 7:07 stealth loop; 7:33 NPC cap 16; 8:51 skills/behaviours; 11:03 posts; 11:40 post selectors; 14:43 25 m radius; 15:42 weapon-range failure; 16:54 connectivity; 17:55 vantage; 20:43 heat search; 24:51 hard points; 29:30 roles; 30:07 ambush 20 m; 32:39 encounter coordinator; 33:11 assignment order; 35:02 global combat params; 36:10 min/max shooters; 38:06 spline search; 39:51 defender vantage search; 40:23 combat params / archetypes; 42:03 grenade director; 42:50 flankers / combat vector; 43:54 accuracy ramp; 44:19 perches; 45:37 ambush point flaw; 46:27 pistol sniping + accuracy floor; 47:46 takeaways; 53:50 shooter token Q&A; 55:38 suppression / flanker choice Q&A.
- **G-deck**: the official PDF of Gallant's talk (158 pages, 227 MB, downloaded to `refs/frames/research-ai/deck/`, git-ignored). Pages used:
  - p6: AI team credits.
  - p88: hard-point fields.
  - p113: role-assignment order.
  - **p114: `global-combat-params` Lisp defaults** (num-ambushers 2, engager-replacement-delay 6.0, min/max shooters 2/3, snuck-away 8.0, wait-to-advance 6.0 with move reset 6.0, wait-to-flank 6.0 with move reset 4.0, min-flank-path-rating 0.5).
  - p126: shooter release triggers.
  - p128: cover debug overlay.
  - p138: heavy-gunner combat params.
  - p142–143: grenade director debug.
  - **p145: time-to-accuracy curves.**
  - p149: ambush selector source.
- Gallant's own blog summary (vantage, search heat, hard points): https://gangles.ca/2019/04/15/combat-design-uncharted-4/
- **M**: Travis McIntosh, "Human Enemy AI in The Last of Us", Game AI Pro 2, ch. 34, pp. 419–429. http://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter34_Human_Enemy_AI_in_The_Last_of_Us.pdf. The companion talk, "The Last of Us: Human Enemy AI" (GDC 2014), exists on the Vault (https://gdcvault.com/play/1020338/) and was not watched; the chapter was used.
- **D**: Max Dyckhoff, "Ellie: Buddy AI in The Last of Us", Game AI Pro 2, ch. 35. http://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter35_Ellie_Buddy_AI_in_The_Last_of_Us.pdf. The GDC 2014 talk of the same name exists (https://www.gdcvault.com/play/1020364/). Speaker confirmed as Dyckhoff by the chapter byline.
- **B**: Mark Botta, "Infected AI in The Last of Us", Game AI Pro 2, ch. 33 (logical sound events, hearing ratio, occlusion). http://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter33_Infected_AI_in_The_Last_of_Us.pdf
- **R**: Benson Russell (Naughty Dog), "The Secrets of Enemy AI in Uncharted 2", Gamasutra 2010 (series part III): https://gamedeveloper.com/design/the-secrets-of-enemy-ai-in-i-uncharted-2-i- . Part II, "Designing Combat Encounters in Uncharted 2", has no AI numbers: https://gamedeveloper.com/design/designing-combat-encounters-in-i-uncharted-2-i-
- **C**: Ming-Lun "Allen" Chou (Naughty Dog), U4 post-mortem (threat indicators, investigation pairs, stealth grass, posts): http://allenchou.net/2016/05/a-brain-dump-of-what-i-worked-on-for-uncharted-4/ (repost: https://80.lv/articles/behind-the-scenes-ai-of-uncharted-4)
- Gallant interview summary (search reframed as interesting gameplay): https://gamedeveloper.com/design/rethinking-ai-behavior-in-i-uncharted-4-s-i-vast-world
- Russell on UC1 dynamic difficulty: https://videogameschronicle.com/news/uncharted-had-dynamic-difficulty-because-it-was-too-short-and-it-had-to-slow-the-player-down-says-former-designer/
- Naughty Dog GDC 2017 talk list. It confirms Gallant's is the only U4 AI talk, and that no stealth, buddy or melee talk was given: https://www.naughtydog.com/blog/naughty_dog_gdc_2017

Community / guide:
- **P**: Prima U4 eGuide (difficulty settings and combat pages), https://primagames.com/eguides/uncharted-4-a-thiefs-end-eguide/basics/difficulty-settings and .../basics/combat. The pages returned 403. Numbers were taken from search-result excerpts: 6 m grass, 18 m cover, the Hard 10 s rule, and Explorer/Light never aggressive.
- Uncharted fandom wiki, Difficulty: https://uncharted.fandom.com/wiki/Difficulty (402 on fetch; claims taken from search-result excerpts, conflicting).
- Third-party talk summary (roles, Reunion example): https://designerruminations.blogspot.com/2017/07

Max's private reference (paraphrased, nothing copied): Known repo: docs/reference/uncharted4-combat-ai/transcript.md (talk transcript and slide facts), docs/design/combat-ai-core-architecture.md (his module split for the talk's systems; it agrees with §§3–6 here), docs/design/enemy-detection-alpha.md (meter-with-thresholds approach on a marketplace kit; kit numbers deliberately not used).

Not found / not existing: no GDC talk specifically on U4 stealth, buddy or melee AI (per Naughty Dog's GDC 2017 list). Kurt Margenau, Ricky Cambier and Max Dyckhoff have no U4 AI talk that I could confirm. Dyckhoff's talk is TLOU 2014.
