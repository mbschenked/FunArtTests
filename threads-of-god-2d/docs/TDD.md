# Technical Design Document — ThreadsOfGod-2D

> Status: **living draft** — written at contract-freeze (P0), finalized after
> the play-test/tuning loop. Tuning tables reflect `src/config.js`, which is
> the single source of truth for numbers; this doc explains *why*.

## 1. One-liner

A 2D side-view recreation of the TOG boss duel — Micheal vs Arelius — built on
the same combat grammar as the UE5 original: Sekiro-style poise that **fills
0→100 and breaks at max**, **deflect / counter / finisher** (no "parry"),
player-only input buffering, active-window hitboxes, and a two-phase boss with
weighted-random attack selection and pity counters.

## 2. Provenance — what is TOG-faithful vs adapted vs invented

| Element | Source | Status |
|---|---|---|
| Poise fills→breaks at max | TOG-Remake audit (Sekiro posture, flip of shipped direction) | faithful |
| deflect/counter/finisher vocabulary | TOG audit ("parry" purged; deleted parry folder) | faithful |
| Counter heals + recovers poise + bonus poise dmg | TOG-GAS-Architecture §5 poise economy | faithful |
| Block chips blocker poise + 1.0s regen pause | same | faithful |
| Player-only input buffer | Max's 2026-06-10 design intent | faithful |
| Dodge post-cooldown | same | faithful |
| Hitstop 0.1s | `TOGAbilityTypes.h` HitstopMagnitude | faithful (exact constant) |
| Active-window hitboxes + per-swing dedup | `ANS_Hitbox`/`UTOGHitboxComponent` | faithful (AABB instead of sweep) |
| Boss poise regen ∝ health (smoothstep) | `Curve_Arelius_Health_vs_StaminaRegenRate` — points are exactly 3x²−2x³ | faithful (closed form) |
| Phase 2 at 50% HP | `BTD_CheckBossHealth` 0.5 | faithful |
| Follow-up chance 0.25–0.75 + pity 2–5 | BT decorators | faithful |
| Boss reactive defense escalating vs spam | defensive tree hit-count tracking | faithful (chance model) |
| Finisher snap 25–150px | DT finisher ExcDistance 50–300uu @ 1px≈2uu | faithful (converted) |
| Giant Sword javelin + teleport-to-sword | `BP_GiantSword_JavelinAttack`, `AN_InitiateTeleportToSword` | adapted to 2D |
| Side-view dash-back/dash-through | TOG 6-directional dodges | adapted |
| Velocity gate → retreat-only check | TOG 100–1000 u/s band | simplified (anti-whiff intent kept; approach-gating dropped — reads as passivity in 1D) |
| All specific frame data & damage numbers | not in the repos (live in montage assets) | invented, tuned in P4 (see §6) |
| Counter heals + recovers poise | TOG poise economy | faithful mechanic; magnitudes tuned down in P4 |

## 3. Architecture

### 3.1 Module graph

```
config.js ──> everything (data only, no imports)
utils.js  ──> RNG / EventBus / math (no imports)
input.js  ──> player.js ONLY (+ main.js constructs/updates)   ← buffer is player-only BY IMPORT GRAPH
fighter.js ──> player.js, boss.js, combat.js, main.js
poses.js  ──> render.js
combat.js / player.js / boss.js / render.js / hud.js / audio.js ──> main.js
```

### 3.2 The four load-bearing rules

1. **Single-writer combat.** Only `CombatSystem` writes combat-outcome states
   (HITSTUN, BLOCKSTUN, DEFLECT_RECOIL, DEFLECT_SUCCESS, STAGGERED,
   FINISHING/BEING_FINISHED, DEAD) — and it writes both actors **atomically in
   one block**. This makes the paired deflect reaction (the source's
   "two combatants animated as one synchronized exchange") frame-perfect by
   construction rather than by event-listener luck.
2. **One hitstop freeze point.** `Game.step()` checks `combat.hitstop` once,
   before any system updates. No per-system freeze checks → no double-freeze
   or missed-freeze bugs. Particles/shake run on real dt in render — sparks
   fly *through* the freeze; that contrast is the feel.
3. **Determinism.** Fixed 60Hz accumulator loop, one seeded RNG, `Math.random`
   banned, no wall-clock reads in sim. `__game.reset(seed)` reproduces a fight
   exactly — verification is assertable, not probabilistic.
4. **config.js is the data table.** All balance in one file (UE5 DataTable
   analogue); `__game.tune()/dumpTuning()` round-trips play-test results back
   into it.

### 3.3 Fixed step order (frozen)

input → hitstop gate → player controller → boss AI (reads same-tick player
windups for reactive defense) → entity physics/timers → combat resolution →
outcome checks (phase trigger, death). Documented in `main.js`; changing the
order is a breaking change.

## 4. Combat model

### 4.1 Hit-resolution pipeline (victim-arbitrated)

Detect (AABB overlap, **active window only** — the AnimNotifyState analogue;
skip if in per-swing `hitVictims`; skip silently if victim i-framed) →
**victim decides**: DEFLECTED (in deflect window + deflectable + facing) else
BLOCKED (blocking + blockable + frontal) else HIT → apply atomically →
poise-break check (≥ max → clamp, STAGGERED, finisher-eligible) → dedup add →
death check. Projectiles run the same arbitration.

### 4.2 State machines

Shared states: IDLE, MOVE, RUN(player), DODGE, BLOCK, DEFLECT, ATTACK,
HITSTUN, BLOCKSTUN, DEFLECT_RECOIL, DEFLECT_SUCCESS, STAGGERED,
FINISHING/BEING_FINISHED, DEAD. Boss-only: KNEEL (whiff vulnerability),
TELEPORT (i-framed), PHASE_TRANSITION (invulnerable ceremony at 50% HP, once).
Transition tables live as JSDoc in `fighter.js`/`player.js`/`boss.js`;
combat-outcome entries only via CombatSystem (rule 3.2.1).

### 4.3 Poise economy

- Land hits → victim poise rises by `poiseDamage`.
- Block → blocker chips `poiseDamage × blockChipMult` + 1.0s decay pause.
- Deflect → attacker +24 poise, deflector +2 (skill reward).
- Counter → boss takes attack poise + 12 bonus; player heals 4 hp and sheds
  15 poise (defense becomes offense — the TOG counter economy).
- Poise decays 12/s toward 0 when unpaused; boss decay is scaled by
  `smoothstep01(hp/hpMax)` — a healthy Arelius shrugs poise off, a dying one
  stays broken. The duel opens up as you win it.
- Break at max → STAGGERED 150 frames → finisher window → exit resets poise to 0.

### 4.4 Boss AI (Arelius)

Three layers, priority-ordered (see `boss.js` contract): reactive defense
(deflect chance 0.12 base, +0.15 per repeat of the same player move in the
last 6 — spam gets punished, mixups don't), opportunity (finisher staggered
player, punish recoveries), and the decision tick (range bands, retreat
velocity gate, weighted pick, follow-up/sequence pity, whiff-kneel). Phase 2
unlocks giantSwordThrow / giantSwordSlice / teleportStrike; while a thrown
sword is stuck in the arena, teleportStrike's weight jumps to 5 — throw,
vanish, strike from the sword. Every decision emits `bossDecision` so cadence
is measurable (tuned from the event log, not vibes).

## 5. Debug & verification surface

`window.__game` (contract in `main.js`): deep-JSON `state()`, tick-stamped
`events()` ring buffer, virtual input through the real input path, timescale /
pause / `stepFrames(n)`, deterministic `reset(seed)`, boss/player state
setters, live `tune()` + `dumpTuning()`. The 12 mechanic assertions +
3 static greps live in `verify/assertions.md`.

## 6. Tuning tables — final P4 values and rationale

`src/config.js` is normative; this table records what the play-test loop
changed and why. Method: two real-input bot personas at timescale 1 — "sharp"
(60ms reactions, perfect timing) and "human-ish" (140ms, 25% deflect miss,
30% dodge fail) — all actions via dispatched KeyboardEvents.

| Key | Initial | Final | Why |
|---|---|---|---|
| `BOSS.hpMax` | 300 | **360** | sharp win in 52s — fight too short |
| `BOSS.walkSpeed` | 160 | **185** | player could disengage freely |
| `BOSS.phases[1].followUpChance` | 0.3 | **0.4** | zero phase-1 pressure |
| `BOSS.decisionCooldownFrames` | [18,42] | **[14,36]** | boss "thinking" gaps read as passivity |
| `phases[2].attackWeights.giantSwordThrow` | 2 | **3** | signature move never fired in R1 |
| `PLAYER.counterHeal` | 6 | **4** | deflect→counter loop was self-sustaining (R2: sharp won at 82hp) |
| `COMBAT.deflectPoiseToAttacker` | 30 | **24** | 4 deflects = break was too fast a stagger cycle; now 5 |
| boss attack `damage` (roster-wide) | 14/18/12/12/20/26/20/24/16 | **−~20%** (11/14/10/10/16/21/16/19/13) | human-ish persona died in 24.5s — skill cliff, not a curve |

Fight-length target revised 90–180s → **40–90s**: the original target was a
pre-data guess; the TOG duel plays as an intense posture duel, not attrition.
Final calibration: sharp WIN 63s @79hp · human-ish WIN 37.7s @16hp (clutch)
or LOSS depending on seed — graceful skill degradation.

Two real bugs were found only through play: the dodge had i-frames but no
movement (dash distances were dead config), and `giantSwordThrow` played its
animation without ever spawning the projectile (5 throws, 0 spawns in R2
stats). Both fixed; the projectile launch is now generic in `combat.update`.

Documented design ruling (gate-2): blocked **charged** attacks chip poise at
the charge multiplier — punishing passive block against charged hits is
intentional, TOG-flavored behavior.

## 7. Build process

See `docs/BUILD-LOG.md` for the orchestration history (research agents →
contract freeze → parallel implementation → audits → integration →
scripted verification → play-test loop).
