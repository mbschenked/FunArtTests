---
name: after-orhun-style
description: Apply the after-orhun house conventions whenever creating a new browser art study, modifying an existing piece, or updating index.html/README.md in after-orhun/ — even if the user only says "make a new piece" or "add a variant" without mentioning conventions. Covers naming taxonomy, the single-file skeleton, CRT/HUD chrome, runtime patterns, and the ship protocol.
when_to_use: New study requested ("make a new piece/variant/study"), editing any after-orhun/*.html, adding tiles to index.html, or updating the README taxonomy table.
paths: after-orhun/**
allowed-tools: Read, Write, Edit, Bash(python3 *)
---

# after-orhun house style

Single-file browser art studies. No build step, no npm. Every piece is one self-contained `.html`. Read 1–2 neighboring pieces before writing — match what's actually there over what this file says if they ever disagree.

## Naming & taxonomy
- Root pieces (new thread): `{letter}-{concept}.html` — `a-phosphor`, `b-warped`.
- Variants of a root: `{parent}{n}-{concept}.html`, no separator before the digit — `b1-wave`, `b2-glyph-solid`.
- Sub-variants of a variant: `{parent}{n}-{m}-{concept}.html` — `b3-1-solar-flare`, `b3-2-glyph-swarm`.
- Never name a file as a variant of an unrelated parent; a new direction gets a new root letter.

## Single-file skeleton (every piece)
1. `<style>`: fullscreen fixed canvas (`position:fixed; inset:0`); CRT overlay = scanlines (`repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0 1px, transparent 1px 3px)`, `mix-blend-mode:multiply`) + radial vignette, both `pointer-events:none`.
2. HUD: top-left title header with `← index` link to index.html; bottom-right meta (counts, mechanic); bottom-left interaction hint. Monospace, uppercase, letter-spaced.
3. `<script type="module">`: palette constants at the top; Three.js (when used) pinned `three@0.160.0` from cdn.jsdelivr.net; custom shaders inline as template strings, written in full — never elided with placeholder comments.

## Runtime patterns
- `devicePixelRatio` capped at 2; canvas buffer size kept separate from CSS size. When using `renderer.setSize(w, h, false)`, the canvas CSS MUST set `width:100%; height:100%` — without it the canvas displays at buffer size (2× at dpr 2) and the scene lands off-center.
- rAF loop with clamped dt; `resize` listener rebuilds size-dependent state.
- `prefers-reduced-motion: reduce` → render exactly one static frame: no rAF loop, no interaction listeners.
- WebGL text uses the glyph-atlas pattern: 1024×32 canvas texture, 32 cells of 32×32; `texture.flipY = false` with shader-side v-flip.

## Shipping a piece (protocol)
1. Write the `.html` (target 250–500 lines; complex WebGL + shader pieces may run longer).
2. Add a tile to index.html: `<a class="tile t-{key}">` with `.num`, `.name`, `.desc`, `.chip`, and a CSS-pattern thumbnail keyed to the piece's accent color; a new thread gets a `.row-sep` section header.
3. Add the piece to README.md under its iteration section — match that section's existing table columns exactly (they vary per iteration; read the table before adding a row).
4. Verify served (`python3 -m http.server`) — ES modules will NOT run from `file://`. Pass = canvas renders, zero console errors, `← index` link resolves, interaction responds, reduced-motion emulation shows one static frame. Report any failure instead of shipping.
