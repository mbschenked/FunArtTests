# Threads of God — 2D

A playable 2D side-view boss duel: **Micheal vs Arelius**, recreating the combat
grammar of [ThreadsOfGod](https://github.com/mbschenked/ThreadsOfGod) (my UE5
Sekiro-like) in vanilla Canvas + ES modules. Zero dependencies, procedural
vector art, WebAudio oscillator SFX.

**Play:** serve the folder (`python3 -m http.server`) and open `index.html` —
ES modules don't run from `file://`.

| Key | Action |
|---|---|
| A / D | move |
| J | slash chain · counter (after deflect) · finisher (on stagger) |
| K | thrust combo |
| L (hold) | 3-stage charge attack |
| Space | dodge — i-frames; A-held = dash-back, else dash-through |
| S | guard — **tap = deflect**, hold = block |
| H / R | help · rematch |

The mechanics are the TOG set, extracted from the source repos rather than
invented: poise **fills 0→100 and breaks at max** (stagger → finisher window),
deflect/counter/finisher (no "parry" — enforced by grep), block chips the
*blocker's* poise, player-only input buffering, dodge post-cooldown,
active-window hitboxes, 0.1s hitstop. Arelius runs two phases with
weighted-random attack selection + pity counters, escalating deflects against
move-spam, and a phase-2 giant-sword-throw → teleport-to-sword mixup. His
poise regen follows his health on the original curve — which turned out to be
exactly `3x² − 2x³`.

Deeper notes: [`docs/TDD.md`](docs/TDD.md) (design + provenance + tuning
rationale) and [`docs/BUILD-LOG.md`](docs/BUILD-LOG.md) (how a ~30-agent
Claude Code orchestration built and play-tested it). The scripted verification
playbook lives in [`verify/assertions.md`](verify/assertions.md).
