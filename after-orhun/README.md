# after-orhun

Three browser studies inspired by [orhun](https://github.com/orhun)'s terminal-native dynamic art.

Live: **https://mbschenked.github.io/FunArtTests/after-orhun/**

Visual homage; unaffiliated. Each piece is written from scratch in plain HTML/CSS/JS — no Rust, no WASM, no vendored upstream code.

## The three pieces

| # | Piece | Source thread | Web primitive |
|---|---|---|---|
| A | [Phosphor Cell Field](a-phosphor.html) | [`theattyr`](https://github.com/orhun/theattyr) — VT100 cell-mutation loop | DOM `<pre>` grid + `requestAnimationFrame` |
| B | [Warped Console](b-warped.html) | [`ratty`](https://github.com/orhun/ratty) — Möbius surface warp of a terminal buffer | WebGL via Three.js, custom vertex + fragment shaders |
| C | [Boot Scatter](c-scatter.html) | [`ratatui-splash-screen`](https://github.com/orhun/ratatui-splash-screen) — progressive scatter-point image reveal | HTML5 Canvas 2D + offscreen mask buffer |

Web-bridge precedent: [`ratatui/ratzilla`](https://github.com/ratatui/ratzilla) (Rust → WASM, DOM/Canvas/WebGL2 backends).

## Variants on B — similarity gradient

Three more pieces, all derived from B (Warped Console), arranged on a similarity gradient — minimum departure → wildly different.

| # | Piece | Departure axis | Web primitive |
|---|---|---|---|
| B1 | [Wave Console](b1-wave.html) — *most similar* | Drop the twist; keep the wave. Static camera | Same Three.js plane + shader recipe as B, twist block removed |
| B2 | [Glyph Polyhedron](b2-glyph-solid.html) — *not similar* | Discrete spinnable 3D solid; single directional light | Three.js `DodecahedronGeometry` + flat-shaded Phong + `OrbitControls` + glyph-atlas texture; matrix-rain backdrop quad |
| B3 | [Glyph Particle Cloud](b3-glyph-cloud.html) — *wildly different* | No surface — only points in volume; pure procedural motion | Three.js `Points` × 5000 with custom shader (galaxy rotation + per-seed lissajous + glyph-atlas sampling + z-depth color grade) |

B2 is the interactive one: drag to spin, releases auto-resume after 2 s.

## Iteration 2 — variants on B3

Same gradient pattern applied recursively: three more pieces, this time derived from **B3** (the previous round's wildly-different piece). Extra constraint: each piece has a **mouse-proximity repulsion mechanic** — one behavior per piece. New palettes form a warm → violet → sunset triptych.

| # | Piece | Departure axis | Mouse mechanic | Palette |
|---|---|---|---|---|
| B3-1 | [Solar Flare](b3-1-solar-flare.html) — *most similar* | Keep the recipe; recolor only | **Springs out** — damped harmonic spring per particle, snaps back through center | warm amber/ember |
| B3-2 | [Glyph Swarm](b3-2-glyph-swarm.html) — *not similar* | Curl-like vector-field flow instead of disk rotation | **Explodes outward** — outward impulse + brief size collapse, friction return | violet / ultraviolet |
| B3-3 | [Sediment Field](b3-3-sediment-field.html) — *wildly different* | Canvas 2D, no WebGL. State-machine particles | **Falls to bottom** — touch kills lift; particles fall and pile as sediment | sunset gold / terracotta / mauve |

All three respect `prefers-reduced-motion` (single static frame, no rAF loop, mouse repulsion suppressed).

## Iteration 3 — new thread: Destiny Director

A departure from the orhun lineage: one piece staging Destiny 2's **Director orbit-view** as a browser study. A procedural Europa-palette ice world on a near-black window, lit by its three nearest stars — the visible star sprites feed the planet shader's light uniforms directly, so the terminator tracks them.

| # | Piece | Departure axis | Interaction | Palette |
|---|---|---|---|---|
| D | [Director Globe](d-director-globe.html) — *new thread* | Lit solid-surface planet + DOM/SVG destination overlay; no glyphs | **Click re-orients** — critically damped spring snap over a 4°/s idle drift; gold markers focus their site | Europa ice `#e8eaf0/#8090a8/#2a3d5c` in Director chrome `#0a0e1a` + gold `#fdcd47` |

Technical design document: [d-director-globe.tdd.md](d-director-globe.tdd.md). Same reduced-motion guarantee as iteration 2.

## Source palette catalog

Near-black backgrounds with sparse cool accents. The full catalog these pieces draw from — individual pieces use subsets, not all of it:

- `#000000` background
- `#7fd0ff` ratty cyan
- `#3c8cba` ratzilla slate
- `#e6ac73` Black Waves amber
- `#5F8787` Black Waves teal
- `#a7da1e` Black Waves lime
- `#b657ff` Black Waves purple

## Run locally

No build, no dependencies. Piece A works from `file://`; pieces B and C use ES-module imports (Three.js / strict CORS), so they need a local server:

```sh
python3 -m http.server 8000
# → http://localhost:8000/after-orhun/
```

## Credits

- **Orhun Parmaksız** — original style and the source repos linked above. `orhun.dev`
- **Three.js** — used by piece B, loaded from jsdelivr CDN
- **Fira Code** — font, loaded from Google Fonts

Honors the project's `prefers-reduced-motion` setting on all ten pieces (renders a single static frame instead of looping; B2 still allows user-initiated drag rotation; iteration-2 mouse mechanics are suppressed in reduced-motion mode).
