# U4 grenade danger indicator: measured from gameplay footage

Pass of 2026-11-12. Videos were downloaded with yt-dlp into the session scratchpad; frames were decoded with ffmpeg and
measured with numpy/scipy (colour masks, connected components, ray profiles). Time stamps are seconds from the start of
the video. All three sources are 29.97 fps, so every time is ±1 frame (±0.033 s). Single-frame seeks into the partial V2
file land one frame later than a sequential decode; intervals are always taken from one decode.
Tags: [MEASURED] read off footage here, [WIKI] guide or other spec, [INFERRED] reasoned from measured data, [ASSUMED] my call.
Sizes: px at the source resolution, then px at 720p (our HUD unit, `REF_H = 720`), then H = fraction of screen height.
Reference crops are in `refs/frames/grenade-ref/` (git-ignored).

Videos used:

| key | video id | what it is | HUD | used for |
|---|---|---|---|---|
| V1 | `MK_TUFNajFw` | "Grenade Spam - Uncharted 4 (Crushing)", 21 s, 720p, complete | on, SP | 4 enemy grenades landing behind a wall next to Drake: timing ×4, occluded dimming, pointer angle, outline size |
| V2 | `ZZklwtTnkaY` | "Watch Nathan Drake die over and over [Uncharted 4]", 720p, first ~10 MB only (YouTube 403 after that) | on, SP, most neutral grade | FILLED state, outline → filled switch, cylinder glyph, colours, pointer lag |
| V3 | `p35vQeFe-SY` | "UNCHARTED 4: A Thief's End - Grenade close call", 1080p, first 23 % only (403) | on, SP, warm orange grade | 1080p sizes, pointer straight up, Drake's own grenade |
| – | `ToDygYpyZws` | roll-dodge clip | – | rejected: Uncharted 2 (Nathan Drake Collection), not U4 |
| – | `8I8I1oaPbBo`, `ObB_dmpZg38`, `nodQwPATRP4`, `rOYskNGh7RM`, `uXziSiPO3QI`, `vbRs4rf6fAs`, `3pw-Ka6sHbo`, `S6L571Qy48c`, `bxGkAbLoncc`, `qC-KoDjU0QA` | short U4 grenade clips | multiplayer / Survival HUD | rejected: the brief is single player |
| – | `CfrmZThcDQk`, `FAchzmucQJw`, `KbZ_EQ2lzF0`, `XANZCTMooAU`, `lwPIflvC3c` | U4 SP (close call, Crushing ch. 18, funny deaths, courtyard) | on | partial downloads screened at 1 fps plus a red-diamond scan: no indicator in the part we got (hits were laser sights and red props) |
| – | `EC7sXKtBCiM`, `feePpJz_Ru4`, `IiNZhKKKsck`, `Ru0mYT9jEBE` | long U4 Crushing encounter videos | – | YouTube 403 on download, also with `--download-sections`; not worked around |

Caveat: three usable videos, nine grenades in all, two of them partial downloads. Every number below rests on those, so
read "high" confidence as "consistent across what we have", not as a large sample.

---

## 1. Look

| name | value | unit | source | confidence |
|---|---|---|---|---|
| parts | a red **diamond** (square turned 45°) with a red **grenade glyph** inside, plus a small **white outline triangle** (pointer) just outside it. No text, distance number, timer ring or arc | – | V1, V2, V3 all frames | [MEASURED] high |
| states | **OUTLINE**: thin red diamond outline, solid red glyph. **FILLED**: solid red diamond, glyph knocked out dark | – | V1 (outline), V2 (both) | [MEASURED] high |
| outline diamond, full diagonal | 55–57 px @720p (half-diagonals 28/29/28/29 at V1 1.383; up+down 55, left+right 55 at V2 1.40) = **0.076–0.079 H**. V3: bbox 75–80 px, ray 70 px @1080p (47–53 @720p) = 0.065–0.074 H | px | V1 1.383, V2 1.40, V3 37.30 | [MEASURED] medium (codec blur; V3 grade lowers the mask) |
| outline stroke | ≈ 2 px @720p (0.003 H); peaks are ~4 px wide along an axis ray, ÷√2 for the 45° edge | px | V1 1.383, V2 1.40 ray profiles | [MEASURED] low |
| filled diamond, full diagonal | 76–80 px @720p (half-diagonal 38–40; bbox 80 × 80 at V2 0.267) = **0.106–0.111 H**, so ≈ 1.4–1.5 × the outline diamond | px | V2 0.0–0.87 (G_a), 0.827–0.868 (G_b) | [MEASURED] medium |
| frag glyph | upright grenade silhouette (round body, small cap/lever on top), solid; bbox ≈ 20 × 32 px @720p (0.028 × 0.044 H) | px | V1 ×4, V3 | [MEASURED] medium |
| cylinder glyph | narrow capsule ≈ 7 × 20–28 px @720p (0.010 × 0.03–0.04 H), tilted ≈ 20° with the top to the left | px | V2 G_a and G_b (1.40: 7.1 × 28.2, tilt 19.6°; 1.80: 5.5 × 20.2, 21.5°) | [MEASURED] medium |
| which glyph when | V1 and V3 show the frag glyph; both V2 grenades show the cylinder. Grenade type, encounter or game version could explain it; not determined | – | – | not measured |
| glyph colour, outline state | median (180, 2, 20), p90 (233–245, 23, 32); V1 first frame (187, 0, 9), p90 (224, 6, 21); V2 cylinder (201, 0, 14) | rgb | V2 0.53–0.79, 1.2–1.9; V1 1.383 | [MEASURED] high (hue), medium (level) |
| diamond outline colour | reads darker and bluer, (113, 18, 44), because the 2 px stroke blends with the dark background; most likely drawn in the glyph red | rgb | V2 1.40 | [MEASURED] / [INFERRED] same red |
| filled diamond colour | median (154–176, 0, 4); glyph inside is dark (near-black) | rgb | V2 0.0–0.87 | [MEASURED] medium |
| V3 colours | (240–255, 40, 0): the video is graded warm, so don't use them for colour | rgb | V3 | [MEASURED], excluded |
| pointer | white outline isosceles triangle with a dark centre, apex pointing away from the diamond. ≈ 17 × 16 px @720p (V1); 18 × 33 px @1080p = 12 × 22 @720p (V3, longer). White (233, 235, 237), stroke ≈ 2 px | px | V1 2.30, V3 37.30, V2 | [MEASURED] medium (shape), low (exact size) |
| pointer distance, glyph centre → triangle centre | OUTLINE 41–48 px @720p (**0.057–0.067 H**); V3 57 px @1080p (38 @720p, 0.053 H). FILLED 50–53 px @720p (**0.069–0.074 H**) | px | V1 G1, V2 G_a/G_b, V3 37.30 | [MEASURED] medium |
| pulse / blink | none. Brightness steady within ±10 %, no scale pulse, no flashing over the whole life | – | V1 ×4 full lives, V2, V3 | [MEASURED] high |
| occluded look | in V1 (grenades behind a wall) each icon is bright for exactly **one** frame (glyph r 234–245), then dims to r 100–115 for the rest of its life; the pointer dims 233 → ~170. Ratios: red × 0.45, white × 0.73. Visible grenades (V2, V3) stay full bright | – | V1 1.383, 4.684, 10.583, 14.434 + next frames | [MEASURED] high (4/4) |
| occluded alpha | ≈ 0.35–0.45 on the diamond and glyph, ≈ 0.7 on the pointer. The one bright frame looks like a one-frame lag on an occlusion test | – | from the ratios above over a ~(40, 40, 45) background | [INFERRED] |

## 2. Placement

| name | value | unit | source | confidence |
|---|---|---|---|---|
| anchor | drawn at the grenade's projected screen position and follows it through flight, bounces and rolls (V1 G1 moves 304 → 541 px between 1.38 and 2.3 s; G4 437 → 573 px between 14.43 and 15.8 s) | – | V1 | [MEASURED] high |
| vertical offset | none visible: the icon sits over the grenade (the grenade can't be resolved under it) | – | V1, V2 | [MEASURED] low |
| size vs distance | constant in screen space: the same size at ≈ 1 m (V2) and ≈ 5–10 m (V1) | – | V1, V2 | [MEASURED] high |
| pointer direction | angle of (icon − screen centre), so the triangle sits on the far side of the icon and points away from the screen centre. V1 G1 within ±7° over its life (2.381: 136.1° vs 141.4°); V2 G_a +2–5°; V3 icon above centre → pointer straight up | deg | V1, V2, V3 | [MEASURED] medium. Screen centre vs the reticle point (0.42 H) not distinguished |
| pointer turn rate | V2 G_b appeared ≈ 35 px from screen centre. Pointer started at 161° against a target of ≈ 9° and turned 10–12° per frame (≈ 350°/s) until it converged at 0.827 | deg/s | V2 0.527–0.827 | [MEASURED] one case; smoothing or rate limit [INFERRED] |
| off-screen / behind-camera clamp | never seen: every grenade in the footage was on screen | – | – | not measured |

## 3. Timing

| name | value | unit | source | confidence |
|---|---|---|---|---|
| appears | **while the grenade is in flight**, not on landing: V1 G1 visible ≈ 0.55 s before coming to rest, G4 ≈ 1 s; V2 G_b appears falling from above. Thrower off screen, so time since the throw is unknown | – | V1, V2 | [MEASURED] high |
| fade-in | none: full brightness on the first frame | – | V1 ×4, V2 G_b | [MEASURED] high |
| first icon frame → first explosion frame | V1: **2.433, 2.433, 2.433, 2.433** (G1 1.383 → 3.817, G2 4.684 → 7.117, G3 10.583 → 13.017, G4 14.434 → 16.867). V2 G_b: 0.527 → ≈ 1.968 = **1.44**. V3 (Drake's own grenade): 36.867 → 38.300 = **1.433** | s | V1, V2, V3 | [MEASURED] high per value (±0.033) |
| disappears | on the explosion frame: shown through the last frame before the flash, never hidden early, no fade-out (V1 last frames 3.784, 7.083, 12.983, 16.833) | – | V1 ×4, V2 G_a | [MEASURED] high |
| change over the fuse | none: no countdown, colour ramp, size change or blink. The only change is the distance-driven OUTLINE ↔ FILLED switch | – | V1 ×4 full lives, V2 | [MEASURED] medium–high |
| OUTLINE → FILLED | V2 G_b: OUTLINE 0.527–0.794 while falling, **FILLED from 0.827** (switches within one frame) as it reaches Drake's feet (≈ 1 m); back to OUTLINE 1.2–1.934 after G_a's blast throws Drake several metres away. V2 G_a: FILLED 0.0–0.87 at ≈ 1–2 m | – | V2 | [MEASURED] high (switch), low (distances, judged from the picture) |
| filled frame in flight | V1 G4 shows one FILLED-size frame (dim, bbox 70 × 71 px = 0.097 H) at 14.530 mid-flight, then OUTLINE again. Probably passed briefly near Drake | – | V1 14.530 | [MEASURED] one frame, cause [INFERRED] |
| FILLED radius | between ≈ 2 m (always FILLED) and ≈ 5 m (V1 and V3 grenades stay OUTLINE) | m | V1, V2, V3 | [INFERRED] |
| show radius | icons shown for grenades ≈ 5–10 m away, even behind a wall. No live grenade was ever seen without an icon | m | V1 | [INFERRED] ≥ 10 m; threshold not measured |
| Drake's own grenade | does show the indicator (V3). Release ≈ 36.15–36.2 → explosion 38.300 = 2.10–2.15 s. A red glow/splash at 36.434–36.567 (probably first contact) comes 0.3–0.43 s before the icon | s | V3 | [MEASURED] low (release frame judged by eye) |
| enemy fuse | ≥ 2.43 s from the icon's first frame (V1 ×4, icon already in flight). With a short flight before the icon, ≈ 2.5 s from the throw fits; V2 G_b's 1.44 s does not. Explanations not ruled out: a shorter fuse for the cylinder type, the icon appearing late, or difficulty. Note 2.433 − 1.433 is exactly 1.000 s | s | V1, V2 | [INFERRED], unresolved |
| blinking light on the grenade | not resolvable: the grenade is under the icon and a few px wide. V3 shows a red glow around Drake's grenade at 36.43–36.57 (player-spec has "a thrown grenade gives off a red glow" [WIKI]) | – | V3 | not measured |

---

## Build spec

Sizes are fractions of screen height H, with px at 720p in brackets.

- **What:** one icon for each live grenade, enemy or Drake's own, within `warnRadius`. It lives in screen space at a
  fixed size and is drawn at the grenade's projected position with no vertical offset. [MEASURED]
- **OUTLINE state:** red diamond outline, diagonal **0.075 H** (54), stroke 0.003 H (2), with a solid red glyph centred
  inside, 0.028 × 0.044 H (20 × 32). [MEASURED]
- **FILLED state:** solid red diamond, diagonal **0.108 H** (78), with the glyph cut out in near-black. [MEASURED]
- **Glyph:** use the upright frag silhouette (V1/V3). The tilted cylinder is a second glyph seen in V2; only add it if we
  get a second grenade type. [MEASURED look, ASSUMED choice]
- **Colours:**
  - Red **#E40C18**, about (228, 12, 24), for the glyph, outline and fill. This is the p90 of the clean frames; medians
    read darker because of blur. [INFERRED from MEASURED]
  - Pointer white **#EBEBED**. [MEASURED]
- **Pointer:** a hollow white isosceles triangle, base 0.022 H (16), length 0.024 H (17), stroke 2 px, apex outward.
  - Its centre sits 0.062 H (45) from the icon centre in OUTLINE and 0.072 H (52) in FILLED. [MEASURED]
  - Angle: θ = atan2(icon − screen centre), screen y down. [MEASURED]
  - It turns toward θ along the shorter arc at up to **350°/s**. [MEASURED once]
  - Within ~0.05 H of the centre it keeps its last angle. [ASSUMED]
- **State rule:** FILLED while dist(grenade, player) ≤ `dangerRadius` = `grenade.blast.killRadius` (3.0 m), otherwise
  OUTLINE. The switch is instant, with no tween. [INFERRED radius, MEASURED instant switch]
- **Occlusion:** when the camera → grenade ray is blocked, set alpha to 0.45 on the diamond and glyph and 0.7 on the
  pointer. A one-frame lag is fine and matches U4. [INFERRED]
- **Show and hide:**
  - Show from the first frame the grenade is live and in flight (an enemy grenade from release), at full alpha with no
    fade-in. [MEASURED]
  - For Drake's own grenade, show it from first contact. [ASSUMED; V3 has it ≈ 0.3–0.4 s after the glow]
  - `warnRadius` 12 m. [ASSUMED ≥ the 10 m seen]
  - Hide on the explosion frame with no fade-out. [MEASURED]
  - No pulse, no countdown. [MEASURED]
- **Off-screen and behind the camera (never seen):** [ASSUMED]
  - Clamp the icon to an ellipse around the screen centre with half-axes (0.5 W − 0.07 H, 0.5 H − 0.07 H). Keep the
    pointer pointing outward, toward the grenade.
  - If the grenade is behind the camera (clip w ≤ 0), negate the projected direction before clamping, so the icon goes
    to the edge on the grenade's side.
- **Fuses (not the HUD's job, but they set how long the icon is up):** keep `grenade.ai.fuse` 2.5 s from the throw,
  since V1 shows the icon up for 2.433 s and it appears in flight. The player's release → explosion measured
  2.10–2.15 s (V3), consistent with `grenade.fuse` 2.0 s after contact plus flight. [INFERRED]

## Compare with Cover Room (no code edited)

- `src/hud/hud.js` has no grenade warning. Its grenade API is `setGrenades(n)` (the carried count) plus the 'grenade'
  reticle mode.
- `src/weapons/grenades.js` already exposes what the indicator needs:
  - a `live` list with `pos`, `fuseLeft` and `owner`
  - `grenade:throw` and `grenade:explode` events
  - `grenade.blast.killRadius` 3.0 m, to use as `dangerRadius`
- Suggested params, following the `hud.*` style:

  | param | value |
  |---|---|
  | `hud.grenadeWarn.size` | 54 (outline diagonal, px @720p) |
  | `hud.grenadeWarn.filledSize` | 78 |
  | `hud.grenadeWarn.stroke` | 2 |
  | `hud.grenadeWarn.glyphW` / `glyphH` | 20 / 32 |
  | `hud.grenadeWarn.pointerR` | 45 / 52 (outline / filled) |
  | `hud.grenadeWarn.pointerW` / `pointerL` | 16 / 17 |
  | `hud.grenadeWarn.pointerTurn` | 350 (deg/s) |
  | `hud.grenadeWarn.color` | `#E40C18` |
  | `hud.grenadeWarn.occludedAlpha` | 0.45 |
  | `hud.grenadeWarn.occludedPointerAlpha` | 0.7 |
  | `hud.grenadeWarn.warnRadius` | 12 [ASSUMED] |
  | `hud.grenadeWarn.dangerRadius` | link to `grenade.blast.killRadius` |
  | `hud.grenadeWarn.edgeInset` | 0.07 H [ASSUMED] |

- `refs/stealth-measured.md` "HUD indicators" lists "grenade warning icon: not captured". This doc covers it.

## Not measured, and why

- **Off-screen and behind-camera clamp:** every grenade in usable footage was on screen. Values above are [ASSUMED].
  Next pass: find a clip where a grenade lands behind Drake. The long encounter videos that might have one returned 403.
- **Exact show radius and danger (FILLED) radius:** distances were judged from the picture, not measured in the world.
  Bounds: FILLED at ≤ 2 m, OUTLINE at ≥ 5 m, shown at ≥ 10 m.
- **When the icon appears relative to the throw:** the thrower was always off screen. For Drake's own grenade (V3) it
  appeared ≈ 0.7 s after release, so it is not tied to release.
- **True enemy fuse and why V1 (2.43 s) and V2 (1.44 s) differ:** grenade type, difficulty or a late icon. Not separable
  from three videos.
- **Which glyph goes with which grenade:** the frag shape (V1, V3) vs the tilted cylinder (V2).
- **A blinking light or beep on the grenade:** the grenade is too small and sits under the icon; audio not analysed.
- **Whether the pointer aims from the screen centre or from the reticle point (0.42 H):** the ±7° scatter hides the
  difference.
- **Behaviour with several grenades at once:** V2 had two (G_a and G_b), each with its own icon and pointer. Stacking and
  overlap rules were not studied.

## Reference crops (`refs/frames/grenade-ref/`)

| file | shows |
|---|---|
| `u4_ZZklwtTnkaY_0.27_filled-near.png` | FILLED state, cylinder glyph cut out, pointer below (720p, ×3) |
| `u4_ZZklwtTnkaY_0.27_filled-context.jpg` | full frame, FILLED icon at Drake's feet |
| `u4_ZZklwtTnkaY_0.53-0.87_outline-to-filled-strip.png` | G_b falling (OUTLINE) → FILLED at 0.80–0.83 with pointer swing, G_a FILLED below, flash at the end |
| `u4_ZZklwtTnkaY_1.30-1.90_outline-cylinder-glyph.png` | OUTLINE state, cylinder glyph, pointer outward (×3) |
| `u4_ZZklwtTnkaY_1.40_outline-context.jpg` | full frame, OUTLINE icon lower right |
| `u4_MK_TUFNajFw_spawn-bright-then-dim_4grenades.png` | rows G1–G4, columns = first four icon frames: one bright frame, then occluded dim (G4 col 4 = the one FILLED-size frame) |
| `u4_MK_TUFNajFw_2.30_outline-occluded-dim.png` | OUTLINE, frag glyph, occluded (dim), pointer lower-left |
| `u4_MK_TUFNajFw_2.30_context.jpg` | full frame |
| `u4_MK_TUFNajFw_last-icon-vs-flash_4grenades.jpg` | last icon frame vs first explosion frame, ×4 |
| `u4_p35vQeFe-SY_37.30_outline-1080p-pointer.png` | 1080p OUTLINE, frag glyph, pointer straight up (warm grade) |
| `u4_p35vQeFe-SY_36.85-38.25_outline-strip-1080p.jpg` | Drake's own grenade from icon appearance to explosion, 15 fps |
| `u4_p35vQeFe-SY_37.30_context.jpg` | full frame (scaled to 1280 × 720) |

## Sources

- Videos: see the table at the top (YouTube ids).
- Cover Room specs: `refs/player-spec.md` §6 (fuse, red glow, blast radii), `refs/ai-spec.md` §6 (enemy fuse 2.5 s
  [INFERRED]), `src/weapons/grenades.js` (read only).
