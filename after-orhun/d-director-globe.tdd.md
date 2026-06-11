# D · Director Globe — Technical Design Document

Generated from the shipped source (`d-director-globe.html`, 627 lines, counted via `wc -l` after review fixes) and verified in-browser. Single self-contained HTML file; Three.js 0.160.0 from the jsdelivr CDN is the only dependency. Citations name the owning function plus a line anchor; the function name is authoritative if later edits shift lines.

## 1. One-liner / executive summary

A Destiny 2 *Director orbit-view* study: a procedurally-shaded Europa-palette ice planet on a near-black window, lit by three "nearest stars" whose sprites feed the planet shader's light uniforms directly. The single most important structural fact: **the camera never moves — all rotation is applied to the planet mesh** (`planet.rotation.set` in `tick()`, `:607`), which keeps star-light vectors and the DOM/SVG label overlay in one fixed world frame.

## 2. Goals & non-goals

Goals (each verified in-browser via chrome-devtools on 2026-06-10):
- Click anywhere re-orients the globe with a smooth, interruptible snap; a 4°/s idle drift never stops.
- The visible stars are the actual light sources: their (rotating) positions are normalized into `uLightDir[3]` each frame, so the terminator tracks them (`:588-591`).
- Destination markers/labels track surface anchor points, fade at the limb, highlight gold on hover, and clicking one springs its site to face the camera.
- House conventions hold: CRT scanlines + vignette, corner HUD, `prefers-reduced-motion` → exactly one static frame **and no interaction wiring at all** — the scene-click, pointerdown, and marker click/hover listeners are never registered in reduced-motion mode.

Non-goals: postprocessing (no bloom pass — sprite-stacking illusion instead); textures or external assets (all surface detail is shader noise); drag-orbit controls (B2 owns drag; this piece is click-snap by design); mobile/touch layout.

## 3. System architecture

### Scene graph (7 draw calls)
| Object | Geometry / type | Material notes | Source |
|---|---|---|---|
| Planet | `SphereGeometry(1.6, 96, 64)` | custom `ShaderMaterial`, opaque | `:421` |
| Atmosphere halo | `SphereGeometry(1.6, 48, 32)` ×1.30 | `BackSide`, additive, `depthWrite:false` | halo block ending `:439` |
| Starfield | `Points` × 600 on radius-40 shell | additive, `sizeAttenuation:false` | `:211-228` |
| Star sprites ×3 | `THREE.Sprite`, procedural 128² canvas glow (radial gradient + diffraction cross) | additive | `makeGlowTexture` `:232` + sprite loop |
| Wide bloom sprite | scale-1.6 sprite stacked behind the amber star, opacity 0.15 | cheap bloom, no postprocessing | after sprite loop |

Planet surface lighting is **three terms plus ambient**, not Lambert alone: (1) wrap Lambert ×3 lights; (2) a Blinn-Phong specular on the key light only — `pow(N·H, 80)·0.5`, masked by a gloss factor `smoothstep(0.5, 0.8, fbm)·(1−crack)` so only smooth bright ice glints (`:390-393`); (3) a Fresnel limb-brightening term `pow(1−N·V, 2.5)` scaled by total Lambert so it follows the lit side (`:395-397`) — this is surface limb glow, distinct from the halo shell.

### The spine (per frame, `tick()` `:598`)
1. `baseLon += DRIFT·dt` (drift channel) and two spring integrations (snap channel) → `planet.rotation.set(snapLat.x, baseLon + snapLon.x, 0)` with Euler order `'YXZ'` (`:607`).
2. `starGroup.rotation.y += 0.01·dt`; each star position is quaternion-rotated and normalized into `uLightDir[i]` (`:610-613`) — distance is irrelevant (directional approximation).
3. `updateOverlay()` (`:543`) projects 4 anchors → screen px, sets marker/label transforms, leader-line endpoints, and limb-fade opacity; `pointer-events` writes are change-gated on the 0.4 opacity bucket.
4. One `renderer.render()`.

### Overlay subsystem
Anchors are lat/lon → unit vectors baked once (`ANCHORS`, `:444`). Per frame: rotate by `planet.quaternion`, scale by radius, project. Occlusion is `facing = dot(normalize(world), normalize(cam − world))` pushed through a smoothstep fade band `(0.02 → 0.18`, encoded as `(facing − 0.02)/0.16)` so labels dissolve at the limb instead of popping (inside `updateOverlay`). Pointer events are disabled below opacity 0.4. Lines live in one full-viewport SVG (dashed `3 3`, 1px); markers/labels are DOM divs — crisp 1px strokes and heavy letter-spacing at any dpr, and free hover hit-testing with zero raycasting.

### Light rig (film-set structure)
Key warm-gold `#fff3d6` ×1.0 sits **off-frame front-left** (the sun outside the window) and does the visible-face lighting; blue fill `#9fc4ff` ×0.5 and amber accent `#ff9a66` ×0.35 are **in frame** (verified by projection check) and tint their limbs, making the lighting causality readable (`:259-264`).

## 4. Key technical decisions (ADR style)

1. **Fixed camera, rotating mesh** — lighting/label math stays in world frame · *alternative*: OrbitControls camera (rejected: light vectors and occlusion math would need per-frame re-derivation, and B2 already owns drag).
2. **Two-channel rotation (drift accumulator + critically damped spring)** — re-clicks mid-flight retarget with continuous velocity; drift composes additively (constants block at `DRIFT`/`OMEGA`/`LON_PER_CLICK`, `:483-486`) · *alternative*: cubic ease (rejected: velocity pop on retarget, interruption bookkeeping).
3. **Backface halo shell, not Fresnel-only** — glow must extend *beyond* the limb into space; a surface Fresnel term can only brighten sphere pixels (the planet shader keeps a small Fresnel term for lit-limb brightening; the halo owns beyond-the-limb glow). Two-term falloff: `pow(rim,2.2) + pow(rim,0.8)·0.12` tight core + corona wash · *alternative*: postprocess bloom (rejected: cost and house no-build-step minimalism).
4. **Object-space value noise via fract-mul hash** — pattern glued to the rotating surface, no UV pole pinch, no `sin()` banding (`hash`, `:329`) · *alternative*: texture map (rejected: self-containment).
5. **DOM/SVG overlay over in-canvas text** — subpixel 1px lines, tracked small-caps type, free hit-testing · *alternative*: glyph-atlas canvas text (rejected: soft at small sizes; atlas work disproportionate).
6. **Wrap Lambert `(N·L + 0.12)/1.12` as the terminator softener** — one term does both lighting and twilight band; the key light's ndl is captured inside the loop and reused for the specular mask, so the wrap constants live in exactly one expression · *alternative*: separate smoothstep terminator (rejected: redundant).
7. **YXZ marker-focus solve** — `pitch = atan2(y,z)`, `yaw = atan2(−x, √(y²+z²))` brings an anchor exactly face-on under pitch-then-yaw composition; `wrapPI` picks the shortest spin (`focusAnchor`, `:512`). Verified empirically: a marker click centers its anchor, then drift carries it off — the Director feel.

## 5. Data model

No external data. Inline constant tables:
- `STARS[3]`: position, color, intensity (premultiplied into `uLightCol`), sprite scale (`:261-265`).
- `ANCHORS[4]`: name, type, lat, lon — lons 40/160/260/330 keep the max gap at 120°, under the ~160° visibility window, so ≥1 marker always faces the camera (`:444`). Counted from source: 4 anchors, 4 star-layer sprites (3 light-emitting stars + 1 bloom stacked on the amber star — only the 3 `STARS` entries feed `uLightDir`), 600 starfield points.

## 6. Performance & budgets

Measured (chrome-devtools, M-series MacBook, 1512×745 viewport): **121 fps** sustained via a 2-second rAF frame count; zero console errors. Budget reasoning, not invented figures: 7 draw calls; fragment cost ≈ 7 noise evaluations per planet fragment (5-octave fbm + 2-octave ridged — the dominant GPU cost; dropping fbm to 4 octaves is the knob if a mobile target appears); render loop is allocation-free (module-scope scratch vectors `_world/_toCam/_proj/_wn` above `updateOverlay`); `devicePixelRatio` capped at 2. Remaining plan: profile on an Intel/iGPU machine before claiming broad 60fps [OPEN].

## 7. Risks / unknowns

- **rAF throttling under heavy CDP/devtools load** stretched the spring settle in testing (~1.2s nominal → ~3s observed once); dt is clamped at 0.05s so simulation never explodes, only slows.
- **Sprite glows wash out at extreme aspect ratios** — star positions were tuned for ~2:1 landscape; portrait windows push the fill star off-frame [ASSUMED: acceptable for a desktop gallery piece].
- **Label collision** — two labels can overlap if their anchors project close together; no avoidance is implemented (accepted: with 4 anchors and limb fade, overlap windows are brief).
- **`starGroup` drift over very long sessions** slowly migrates the visible stars off their composed positions (0.01 rad/s ≈ full lap every ~10.5 min) — intentional, but the composition is best in the first minutes.

## 8. Open questions

- [OPEN] Should marker focus also pause the drift for a beat (Director-like "hold") before resuming?
- [OPEN] Is the −120° full-width click mapping the right sensitivity on trackpads? Needs a few human sessions.
- [OPEN] iGPU/60Hz verification (see §6).

## 9. Next steps

1. Commit the piece + gallery updates (`/commit`).
2. Spot-check on an external display / portrait window for star framing.
3. Run one human play session to tune click sensitivity (`LON_PER_CLICK = −2.094`, `:486` — tune as a pair with `LAT_MAX`).
4. Consider a `data-seed` URL param for varied lineae patterns (cheap: offset the noise domain).

## Appendix — Unreal/GAS extension

*(not applicable — browser piece, no Unreal project)*
