# FunArtTests

A pile of small web-based art experiments by [Max Schenk](https://github.com/mbschenked). Each study folder is self-contained — open `index.html` to view, or use the live links below.

**Tools page:** [mbschenked.github.io/FunArtTests/tools/](https://mbschenked.github.io/FunArtTests/tools/) collects the interactive tools (Camera Shake Lab, Trajectory Sandbox, the Uncharted 4 VFX range) on one page you can share. It lives in [`tools/`](tools/) and only links to the study folders.

## Studies

### [`after-orhun/`](after-orhun/) &nbsp; · &nbsp; [▶ live](https://mbschenked.github.io/FunArtTests/after-orhun/)

Three browser-renderable adaptations of [orhun](https://github.com/orhun)'s terminal-native dynamic-art style:

- **Phosphor Cell Field** — DOM character grid, sum-of-sines noise, four-tint phosphor cycle (`theattyr`)
- **Warped Console** — matrix-rain texture on a vertex-shader-deformed 3D plane (`ratty`)
- **Boot Scatter** — Canvas 2D scatter-point progressive reveal across rotating sources (`ratatui-splash-screen`)

### [`camera-shake-lab/`](camera-shake-lab/) &nbsp; · &nbsp; [▶ live](https://mbschenked.github.io/FunArtTests/camera-shake-lab/)

An interactive visualizer for Unreal Engine 5.8 camera shakes:

- **Details-panel replica** — every field of a Wave Oscillator or Perlin Noise shake, engine defaults included
- **Live views** — camera view, per-axis timeline and peak offsets redraw as you change a value
- **Gotchas + presets** — what the engine source does that the editor doesn't tell you, plus gun kick / hit / landing / explosion starting points

### [`threads-of-god-2d/`](threads-of-god-2d/) &nbsp; · &nbsp; [▶ live](https://mbschenked.github.io/FunArtTests/threads-of-god-2d/)

A playable Sekiro-style boss duel — **Micheal vs Arelius** — porting the combat grammar of my UE5 project [ThreadsOfGod](https://github.com/mbschenked/ThreadsOfGod) to vanilla Canvas:

- **Posture combat** — poise fills to break, deflect / counter / finisher, paired clash reactions, 0.1s hitstop
- **Two-phase boss AI** — weighted attacks with pity counters, escalating deflects vs spam, giant-sword throw → teleport mixup
- **Zero assets** — procedural vector swordsmen, keyframed FK poses, WebAudio oscillator SFX

### [`trajectory-sandbox/`](trajectory-sandbox/) &nbsp; · &nbsp; [▶ live](https://mbschenked.github.io/FunArtTests/trajectory-sandbox/)

A sandbox for the flight path of a Death From Above takedown, the leap from a ledge onto an enemy below:

- **Draggable curve** — Control points, play-back at 1× / 0.5× / 0.25×, undo and redo
- **One equation for every jump** — four reference jumps (near / far × low / high drop) blend by distance and drop
- **Unreal export** — Curve Vector `.csv` for one Span, or all four references on shared keys

### [`vfx-studies/`](vfx-studies/) &nbsp; · &nbsp; [▶ live](https://mbschenked.github.io/FunArtTests/vfx-studies/u4-range-combined.html)

Real-time Three.js studies of two effects from *Uncharted 4*, matched against captured gameplay frames:

- **Bullet tracer** — a contrasty streak with a quick hand-off, a mist trail behind the head, and a warm light that travels with each round
- **Muzzle flash** — soft glowing opening flames, a white column that tears into hot pieces, a cream-peach rim; some shots open full size, the rest with a small puff
- **One adjustable build per effect** — every element is a control, with presets and Copy settings, on a shared range with six cameras, day / dusk / night and slow motion down to 0.05x

## Conventions

- Each study lives in its own folder, self-contained, no shared dependencies.
- Plain HTML + CSS + JS; no build step. CDN imports only when needed (Three.js, web fonts).
- Each study folder has its own README with deeper notes.
- Visual homages are credited inline. Nothing is endorsed by or affiliated with the source artists.
