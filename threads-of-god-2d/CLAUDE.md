# ThreadsOfGod-2D

2D side-view recreation of the TOG boss duel (Micheal vs Arelius) — Sekiro-style
deflect/poise combat. Vanilla ES modules, single canvas, zero dependencies.

## Run

```bash
cd /Users/mbschenk/ClaudeCode/ThreadsOfGod-2D
python3 -m http.server 8420
# open http://localhost:8420
```

Controls: **A/D** move · **J** slash (chain / counter / finisher) · **K** thrust ·
**L** charge (hold) · **Space** dodge (A held = dash-back, else dash-through) ·
**S** guard (tap = deflect, hold = block) · **H** toggle help.

## Verify

- Open the browser console: zero errors on load.
- `window.__game.state()` returns the full sim snapshot; `window.__game` is the
  whole debug surface (input injection, timescale, frame-step, deterministic
  `reset(seed)`).
- The scripted mechanic assertions live in `verify/assertions.md` — each is a
  paste-able `evaluate_script` snippet.

## Architecture (one-paragraph orientation)

`src/config.js` is the single data table (all tuning numbers — the UE5
DataTable analogue). `fighter.js` = shared FSM/resources; `combat.js` = the
ONLY writer of combat-outcome states (hit/block/deflect/stagger/finisher),
applied atomically to both actors. `input.js` (player-only buffer) is imported
only by `player.js` — the boss (`boss.js`) has no input system by construction.
`main.js` owns the fixed-60Hz loop and the single hitstop freeze point.
Full design: `docs/TDD.md`. Build history: `docs/BUILD-LOG.md`.

## Rules for future edits

- No balance literals outside `config.js`. No `Math.random` (seeded `RNG` only).
- The word "parry" does not exist in this codebase — deflect / counter / finisher.
- Combat-outcome states are written only by `CombatSystem` (single-writer rule).
