# Scripted mechanic assertions — verification playbook

Run against http://localhost:8420 via chrome-devtools `evaluate_script`.

**REAL-INPUT RULE (Max's directive):** every player action — in assertions and
play-testing alike — is produced by dispatching genuine keyboard events on
`window`:

```js
const kd = k => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
const ku = k => window.dispatchEvent(new KeyboardEvent('keyup',   { key: k, bubbles: true }));
```

These hit the exact listeners a human hits. `__game.input.inject()` is NOT
used to play. `__game` is referee only: reading `state()`/`events()`,
`pause`/`stepFrames`/`reset(seed)`, and boss-side configuration
(`boss.forceAttack` etc. — the boss is not a user control).
Note: synthetic events can't unlock WebAudio (no user gesture) — audio is
expected to stay silently suspended during automated runs.

Common setup for every assertion:

```js
__game.reset(1234); __game.pause(); __game.boss.aiEnabled(false);
```

Position helpers: `__game.player.teleport(x)` and boss starts at its reset
position; `__game.state()` for reads; `__game.events(sinceTick)` for the
tick-stamped event log; `__game.stepFrames(n)` to advance precisely.

| # | Assertion | Pass condition |
|---|---|---|
| 1 | **Deflect pairing** — force boss `slashA`, tap GUARD so the active frame lands inside the 8-frame deflect window | player hp unchanged; boss poise += `deflectPoiseToAttacker`; player poise ≤ +`deflectPoiseSelfCost`; SAME tick: boss `DEFLECT_RECOIL`, player `DEFLECT_SUCCESS`; exactly one `deflect` event |
| 2 | **Block chip + regen pause** — hold GUARD early (deflect window lapsed), take `slashA` | hp unchanged; player poise += `poiseDamage * blockChipMult`; `poiseRegenPause ≈ 1.0`; poise does NOT decay for the next 60 ticks; zero `deflect` events |
| 3 | **Dodge i-frames** — dash-through during boss active frames | zero `hit` events; hp/poise unchanged; player x ends on the boss's far side |
| 4 | **Dodge post-cooldown** — dodge; first tick after DODGE ends, press DODGE again | rejected (state ≠ DODGE); after `postCooldownFrames` more ticks, accepted |
| 5a | **Player buffer exists** — press SLASH mid-recovery within `inputBufferMs` before the combo window | `slash2` starts at the window's first frame |
| 5b | **Boss buffer doesn't** — deflect the boss mid-string; inspect `events()` | boss's next attack is always preceded by a fresh `bossDecision` after recoil; no queued action. Static check: `grep -rl "input.js" src/` → only `player.js` + `main.js` |
| 6 | **Poise break → stagger → finisher** — `boss.setPoise(poiseMax-1)`, land any hit | poise clamps at max; `poiseBreak` event; boss `STAGGERED`; SLASH in range → `FINISHING`/`BEING_FINISHED` pair; `finisherImpact` damage == config; attacker end-distance within [25,150]px |
| 7 | **Hitstop = 0.1s exactly** — after a `hit` event, step frame by frame | both fighters' `stateFrame` frozen exactly 6 ticks, advance on the 7th |
| 8 | **Combo whiff reset** — whiff `slash1`, let `comboWindow` lapse, press SLASH | new attack is `slash1`, `comboIndex` 0. Control: press inside window → `slash2` |
| 9 | **Phase 2 at 50% + unlock gating** — `boss.setHp(0.51*hpMax)`, land a crossing hit | `PHASE_TRANSITION` then `phase === 2`; `forceAttack('teleportStrike')` returns false in phase 1, true in phase 2 |
| 10 | **Per-swing dedup** — `setTimescale(0.1)`, force a wide attack overlapping many ticks | exactly one `hit` event for that swing; a second forced swing registers again |
| 11 | **Boss poise regen follows health curve** — at hp 100% vs 30%: set boss poise 50, step 120 ticks each | decay ratio ≈ `smoothstep01(1.0)/smoothstep01(0.3)` = 1/0.216, within 5% |
| 12 | **Counter rewards** — deflect → SLASH inside `counterWindow`, counter connects | player hp += `counterHeal`; player poise −= `counterPoiseRecover`; boss poise gain includes `counterBonusPoiseDmg`; one `counterLanded` event |

Static checks (run from repo root):

```bash
grep -rn "Math.random" src/          # must be empty
grep -rln "from './input.js'" src/   # must list ONLY player.js and main.js
grep -rni "parry" src/ index.html    # must be empty — deflect/counter/finisher
# (docs/ excluded: TDD provenance section quotes the banned word historically)
```
