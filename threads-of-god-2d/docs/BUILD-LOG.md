# BUILD-LOG — orchestration history

Chronological record of how this game was built: every phase, every agent,
every design decision and its reason. Finalized at the end of the build.

## Phase −1 — Research (3 Explore agents, plan mode)

1. **TOG-Remake architecture agent** — mined `references/TOG-Remake` (branch
   `docs/generated-tdd`): attribute set (Health/Poise, stamina vestigial),
   gameplay-tag state machine, hitbox component lifecycle, counter/finisher
   paired-execution data shape (`InstaKill?` flag), combo row struct, input
   buffering design, hitstop constant 0.1s, boss poise-regen health curve.
2. **Original ThreadsOfGod agent** — mined the UE5.4 repo remotely via `gh`
   (read-only): Arelius's real moveset from 364 montage names (thrusts F/L/R/U,
   slash chains, 3-stage charge, plunge, Giant Sword javelin + slice,
   teleport-to-sword), guard/guard-break anims, 2-phase BTs, PlayStation input
   scheme, theme assets.
3. **Data-dump agent** — swept `docs/planning/tog-data-dump/`: 9 datatables
   (combos, counters, finishers with execution distances 50–300uu, parry
   reactions), BT decorator values (range bands 400–1200, follow-up chance
   0.25–0.75, pity counters 2–5, phase threshold 0.5), 44 notify inventory,
   defensive-tree hit-count tracking.

Design decisions locked with Max: side-view duel · Health+Poise only (remake
TDD intent) · full orchestration · full autopilot · independent audit gates
between phases · acceptance bar = "play test your game, make sure you enjoy it".

## Phase 0 — Scaffold + contract freeze (main session, sequential)

- Wrote `config.js` (complete data table — every TOG-derived number annotated),
  `utils.js` (seeded RNG, EventBus, smoothstep01 == the Arelius regen curve).
- Wrote compilable skeletons for all 10 remaining modules with frozen export
  signatures + full JSDoc contracts; parallel agents implement bodies only.
- Key architectural commitments (rationale in docs/TDD.md):
  single-writer CombatSystem (paired deflect reaction by construction),
  player-only buffer enforced via import graph, one hitstop freeze point,
  fixed 60Hz + seeded RNG for deterministic verification.

## Audit gate 0 — independent contract review (code-review-worker agent)

Verdict: **NOT READY** — exactly what the gate exists to catch. 4 blockers,
6 majors, 7 minors, all contract-level ambiguities that would have become
cross-agent integration bugs:

- **B1** shared `Fighter.iframes` would throw for the boss (`CONFIG.BOSS` has
  no `dodge` object) — guard added to the contract.
- **B2** three events (`dodge`, `kneel`, `phaseChange`) had subscribers but no
  documented emitter — each WP would have assumed another owned it. Emitter
  map added to render.js; emit duties pinned to player.js/boss.js.
- **B3** attack-start SFX had no event; `attackStart`/`chargeStart`/
  `chargeRelease` events defined, fighter/player emit duties assigned.
- **B4** `comboWindow` units ("frames into recovery") documented only in
  config — restated with the exact formula in player.js.
- Majors: frames-vs-seconds timer decrements pinned; auto-exit destination
  table written; snapshot() fields enumerated + state() merge spec;
  chargeLevel ownership (fighter maintains, combat reads); CONFIG immutability
  for the teleportStrike weight boost; DEFLECT→BLOCK preempt rule (no 1-tick
  gap). Minors: frontal formula, teleport pose split, poise clamp symmetry,
  stagger-reset on override exits, dodge-cooldown set-on-exit owner, facing
  flip owner, "parry"-grep scope.

Lesson recorded: contract-freeze + independent gate caught 17 issues at the
cost of one review — every one would have been a multi-agent debugging session
post-integration.

## Phase 1 — Parallel implementation (Workflow: 5 pipelines)

Five work packages, each an independent pipeline implement → adversarial
audit → fix (auditor never the author; no barrier between packages):
WP-A fighter+combat (sim core, one agent on purpose — coupled heart),
WP-B input+player, WP-C boss AI, WP-D1 poses+render, WP-D2 hud+audio.
*(results pending)*

Mid-phase directive from Max: play-testing must use REAL user controls —
genuine KeyboardEvent dispatch on window, never debug input injection.
Encoded in verify/assertions.md as the Real-Input Rule; the planned
`__game.input.sequence` choreography is demoted to referee-only duties.

### P1 results (15 agents: 5 implementers + 5 auditors + 5 fixers)

Every package's audit found real blockers the authors missed: WP-A — charge-hold
silently self-aborted mid-windup (stateDuration vs frozen attack.frame);
WP-B — `_chargeHeld` field-name drift; WP-C — `slashB/C` missing from weight
tables + enabled-guard ordering; WP-D1 — boss attack tracks resolving to
`idle` + 19 `Math.random` calls in render; WP-D2 — finisher prompt drawn at
screen center + dead audio fields. All fixed by per-package fix agents.

## Phase 2 — Integration (main session) + audit gate 2

Integrator work: `main.js` (frozen step order, single hitstop freeze point with
epsilon, spiral-of-death guard, event ring buffer, banners/restart, separate
render RNG so visuals never consume sim randomness, full `__game` surface);
fixed two issues found while reading the core: inverted hit-knockback
direction, and the single-writer guard throwing on CombatSystem's own writes
(added `byCombat` authorship token). Headless Node smoke test: boss kills an
idle player in 767 ticks — sim core runs end-to-end without a browser.

Gate 2 — four parallel single-axis reviewers (combat correctness / boss-AI
fidelity / structural rules / determinism+perf) found 4 blockers + ~10 majors:
- giant-sword projectile dealt ZERO damage (read melee row's damage:0, not
  projectile.damage:16)
- deflect could park a fighter at poise==max without staggering (deferred break)
- boss pity guarantee silently swallowed when phase-gating emptied the pool
- boss could attack out of HITSTUN via pending follow-up (no canAct guard)
- input state (incl. stale buffered presses) leaked across reset(seed) —
  broke same-seed-same-fight
- six event payloads mismatched renderer destructures → all big FX fired at
  screen center
- boss DEFLECT window expired 4 frames before player impact (lookahead 12 vs
  duration 8)
- plus: absolute deflect-chance cap, sticky phase-transition invulnerability,
  per-frame gradient allocation, movement literals → config keys.
Integrator ruling (kept as design, documented): blocked CHARGED attacks chip
more poise — charge multiplier applies to chip; punishing passive block is
TOG-flavored.
One consolidated fix agent applied all 18 fixes; smoke test re-passed.

## Phase 3 — Scripted verification (chrome-devtools, live browser)

Method honored Max's real-input rule: every player action was a genuine
`KeyboardEvent` dispatched on `window` (same listeners as fingers); `__game`
served as referee only (state reads, frame-stepping, boss-side setup). The sim
being synchronously frame-steppable made assertions frame-exact.

**Result: 12/12 PASS** (+3 static greps). Highlights: deflect pairing same-tick
with +30/+2 poise split exact; block chip 8.4 = 14×0.6 with full 1.0s decay
freeze; counter heal/refund/bonus to the digit; hitstop exactly 6 frozen ticks;
boss poise-decay ratio at 100% vs 30% hp = 4.63 vs theoretical 4.63 (the
smoothstep curve is exact); (note: deflectPoiseToAttacker was later retuned
30→24 in P4 — assertion pass-conditions are config-relative and still hold); per-swing dedup 1 hit per swing; pity-fresh
bossDecision before every post-deflect attack (no boss buffer).

Found & fixed during P3:
- **Dodge had i-frames but no movement** — controller set the DODGE state but
  nothing ever applied dash velocity; dashThrough/dashBack distances were dead
  config. Fixed: controller drives vx every dodge tick, direction sign locked
  at dodge start (prevents oscillation at the cross-up point).
- Boss reactive defense blocked the phase-2 test's slash (working as designed —
  assertion now zeroes defense odds via tune() and restores).
- Process lesson: Chrome memory-caches ES modules; plain reload serves stale
  code after edits — always hard-reload (ignoreCache) before re-verifying.
- Phase-transition invulnerability clears one tick after transition exit
  (step-order artifact, harmless, documented).

## Phase 4 — Play-test + tuning loop (4 rounds, real-input bots)

Per Max's rule, all play was genuine interface input: a reactive policy loop
("Claude the player") perceiving state and acting ONLY via dispatched
KeyboardEvents at timescale 1. Two personas: sharp (60ms reactions, perfect
timing) and human-ish (140ms, 25% deflect miss, 30% dodge fail).

- **R1** (sharp): WIN 52s @34hp — phase 1 a stomp, fight short, giant sword
  never thrown. Tuned: boss hp 300→360, walk 160→185, p1 followUp 0.3→0.4,
  decision cooldown [18,42]→[14,36], throw weight 2→3.
- **R2** (sharp): WIN 48s @82hp — buffs BACKFIRED: more attacks = more deflect
  fuel for the counter-heal snowball. Stats exposed a real bug: throw fired 5×,
  projectileSpawn 0 — **nobody wired the projectile launch**. Fixed in
  combat.update (generic: any projectile-def attack spawns on entering active).
- **R3** (human-ish): LOSS 24.5s — skill cliff too sharp (6 hits = dead).
  Tuned: boss damage −20% across the roster, counterHeal 6→4,
  deflectPoiseToAttacker 30→24 (5 deflects to break, was 4).
- **R4**: human-ish WIN 37.7s @16hp (clutch — 8 hits taken, 3 finishers,
  sword throws + teleport strike); sharp WIN 63s @79hp (boss deflected 7,
  2 teleport mixups). Graceful skill degradation achieved.

Revised target: 40–90s fight (plan's 90–180s guess pre-dated feel data; the
TOG duel is intense, not attrition). Verdict on the acceptance bar ("play
test your game, make sure you enjoy it"): the deflect clang into instant
riposte, the thread-snap stagger → finisher rhythm, and phase-2's
throw-vanish-strike mixup produce genuine tension — the 16hp clutch win was
a real fight. **Enjoyed.** Screenshots: mid-fight blade clash, THE THREAD IS
CUT victory.

## Phase 5 — Final audit + docs + publication

Final release-readiness audit (independent critic, whole repo + docs) run
post-tuning; findings applied. TDD §6 finalized with the full tuning table and
rationale. Project page published to Notion (AI Projects hub).

## Orchestration totals

~30 agents across the build: 3 research explorers · 1 architect · 1 contract
auditor (gate 0) · 15 in the P1 workflow (5 implement / 5 audit / 5 fix) ·
4 single-axis reviewers (gate 2) + 1 consolidated fixer · 1 release auditor
(gate 4) — plus the main session as integrator, verifier, and player.
Every audit gate was an independent critic that never reviewed its own work,
and every gate found real issues: 17 (gate 0) + ~15 (gate 1) + 14 applied
(gate 2) + release pass (gate 4). Two further bugs were found only by
playing (dodge motion, projectile spawn) — audits read code, play-tests feel
it; both layers earned their keep.
