# Uncharted 4 bullet tracer: visual spec from frames

Second capture pass, 11 Oct 2026. Every line has a tag. `[observed: file]` means I measured it in that frame file (paths are relative to this folder). `[text: source]` means a written source. `[inferred]` means my reading, not a measurement. Frame files live in `frames/`, which is gitignored and private. [inferred]

## Direction from Max (11 Oct 2026): read this first

- Confirmed: build this tracer, as one adjustable version (no per-moment or per-weapon variants), with every layer exposed as a control.
- **Moment 02 (`tracer-02-strip.png`) is the most accurate reference. Calibrate every default to it:** streak length and width at mid-distance, head/body/tail colours, halo, light on nearby surfaces and the start of the smoke trail.
- Moment 01 (`tracer-01-crop.png`) shows the front of the trace on a near pass. Treat it as the near-camera case, not as the default streak length.
- Max's note on the range's stand-in streak (`frames/_fix-look-night-shoulder.png`; that line is the placeholder, not the tracer): "the front has a nice contrast to the back, but the back is too much of a laser, the front needs to transition quicker to the back." Keep the bright, contrasty front. Hand the head over to the dimmer, tapering tail across a short distance. The streak must never read as a continuous beam trailing back toward the gun. This matches the observed anatomy below: a short velocity-stretched streak of about 1.5 frames of travel, with a tail that tapers to a point.
- Max on the trail: "look again at the lifespan of the tail and its behaviour because there is a mist which warps then dissipates, starting as a somewhat straight line", and "look again online for what happens to the trail for the duration of a bullet fired". So the part behind the bright head is mostly mist (lit smoke), not glow. It is born as a fairly straight thin line, then warps, then dissipates. The re-check of the trail's whole life is done: see "Trail re-check" at the end of this file. Where it disagrees with section 3, the re-check wins. It confirms the straight start and the fade, but at 1x it shows only a gentle bend, not much warping. Max's view on that is pending; the build defaults to the footage and has warp and drift sliders.
- Max reviews the work in stages: first the streak with its mist trail (core, rim, glow, mist), then the passing light, then the polished build. Each stage stops for their direction.
- **Max on the GIFs (11 Oct 2026, late evening):** "good work on the bullet trace", after watching it slowed and at normal speed, from the lens camera and from the side. The approved state is the page as of 22:21 that evening, kept as `frames/_progress/gif/tracer-snap.html`. [ASSUMED] Max saw the straight, fading mist from the side and didn't ask for more warp, so the footage-matching default stays, with the warp and drift sliders.
- **Max's picks (12 Oct 2026):** "do as you recommend E is good". So: (1) colour conversion E (a per-channel filmic curve, see `frames/_tm-compare.png`) on all three pages, with the body colour nudged toward the hero's lemon; (2) streak body width 3.0 cm, which matches the hero (`frames/_s1-tracer-width-question.png`); the rest of the approved look stays; (3) the mist stays straight, as in the footage, with the warp sliders kept; (4) the young streak starts detached from the muzzle, as in moment 01 (its first frame starts about 40 px ahead of the muzzle); ours touched the barrel for its first ~14 ms. Max also asked to see comparisons as normal-speed GIFs, not only stills: "images are good for detail, but i wont really know how itll feel until i see it as a gif".
- **Max on stage 2 (12 Oct 2026, ~10:50), after the moving-light GIFs (`frames/_progress/gif/tracer-s2-*.gif`):** "ok very very good work on the bullet trails im seriously impressed". The stage-2 look is approved; the approved state is `frames/_progress/gif/tracer4-snap.html` (light reach 2.0 m, the default B). The reach pick (A-D, Claude recommends C) is still open; keep B unless Max picks another.

## Symptom -> cause (grows with every review)

Before an edit, name the symptom, look it up here, and patch that one layer (scouting report, tactic 3). Add each new pair.

| Symptom | Cause, and the fix | Source |
|---|---|---|
| The back of the streak reads as a laser | Head-to-tail hand-off too long. Shorten it and taper the tail to a point. | Max, 11 Oct [observed: frames/_fix-look-night-shoulder.png] |
| The mist reads as glow | It is additive. The mist must be lit and alpha-blended. | scouting report, tactic 3 |
| The mist lingers or vanishes at the wrong time | Fix the fade shape first (plainly visible at about 0.25 s, gone by about 0.7 s), then the lifetime. | Trail re-check |
| The body reads pale gold, never lemon | ACES filmic's colour matrices bleed blue into bright yellow. Tone map E fixes it (12 Oct); retune the body colour under E. | Tone-map A/B, frames/_tm-compare.png |
| The streak is too wide at the lens pass | Body width 4.5 cm, from moment 01's estimate. 3.0 cm matches the hero (12 Oct). | frames/_s1-tracer-width-question.png |
| The young streak touches the barrel in slow motion | The tail was clamped to the muzzle. Clamp it to proj.detach (0.4 m) instead; the mist still starts at the muzzle. | moment 01, birth about 40 px ahead |
| The wall flares white as the round arrives | The moving point light gets within a few tenths of a metre of the hit surface. Dim it by distance to the hit plane (light.near). | stage-2 build log, 12 Oct |
| A one-frame event is missing from a 50 fps GIF | The GIF's frames fall either side of it. Shift the sampling phase (for the light at the block: 1, 21, 41 ms ...). | 12 Oct GIFs |
| The round's light draws a row of separate pools ("beads") and lights the shooter at birth | More than one light per round, spread along the streak, each faded by the head's distance. Keep one light at the head (the footage), and fade each light by its own distance from the muzzle. | stage-2 build log, round L3 |
| render() allocates a few bytes a frame on one branch only | Values computed before a branch but unused on it get boxed. Compute them where they are used. | stage-2 build log, fix E1 |
| The ground pool reads as a disc with an edge | Three.js's distance window (falloff to zero at `distance`) is steep near the cut-off, so a short reach at a high intensity draws a rim. A longer reach at a lower intensity softens it. Open question for Max (reach pick, 12 Oct). | frames/_s2-tracer-pick-light-reach.png |

## Check the direction yourself (best links)

The 4K source plays slowed twice (in-game Slow Motion cheat plus the uploader's 60% playback). Watch at YouTube speed 0.25 and step frames with `.` and `,`. [observed: frame-difference log, see Timing]

1. https://www.youtube.com/watch?v=qqi_N6M8bgY&t=53s (53.6-53.9 s). An enemy rifle round crosses the market side-on, from a gunman far right to the left foreground. This is the cleanest full anatomy. [observed: frames/tracer-01-strip.png]
2. https://www.youtube.com/watch?v=qqi_N6M8bgY&t=183s (183.5-183.8 s). A jungle round whizzes past the lens. Shows the warm halo, the orange light it throws on the rock, and its smoke trail. [observed: frames/tracer-02-strip.png]
3. https://www.youtube.com/watch?v=qqi_N6M8bgY&t=217s (217.75-218.05 s). Vehicle chase: the player's outgoing tracer hits the jeep wheel while an enemy round comes at the camera. [observed: frames/tracer-03-strip.png]
4. https://www.youtube.com/watch?v=qqi_N6M8bgY&t=251s (251.9-253.3 s). Truck turret fire heads straight at the camera. Every round leaves a smoke trail that lingers for over a second of video. [observed: frames/tracer-04-strip.png, frames/tracer-04-trail.png]

Real-time check (1x speed, 60 fps, HUD on): https://www.youtube.com/watch?v=TDpsY0crUjE&t=3s (3.90-4.21 s). [observed: frames/tracer-rt-check.png]

## Kept moments

All four come from qqi_N6M8bgY, a PS5 remaster capture: 3840x2160 stream, no HUD, 60 fps game footage. [observed: frames/tracer-01-full.png]

| # | Video time | What it shows | Files |
|---|---|---|---|
| 01 | 53.770 s (strip +0 = 53.670) | Enemy round crossing the near field side-on. White-hot head, yellow body, orange tail, tapered ends. | `tracer-01-full.png`, `-crop.png` (x120-2000, y880-1880), `-strip.png` (11 tiles) [observed: frames/tracer-01-*.png] |
| 02 | 183.700 s (strip +0 = 183.500) | Enemy round over its whole 9-frame flight, ending in a pass at the lens. Shows the halo, the light on cover and the start of the smoke trail. The red line is a sniper laser. | `tracer-02-full.png`, `-crop.png` (x560-2400, y540-1460), `-strip.png` (12 tiles), `-light.png` (3 frames) [observed: frames/tracer-02-*.png] |
| 03 | 217.801 s (strip +0 = 217.784) | Player tracer seen from behind (more orange, short) hitting the jeep wheel. An enemy round heads for the camera in the same frames. | `tracer-03-full.png`, `-crop.png` (x900-2900, y380-1900), `-strip.png` (11 tiles) [observed: frames/tracer-03-*.png] |
| 04 | 252.836 s (strip +0 = 252.786) | Head-on turret round, white core, lingering pale smoke trails. The turret fires every 10 source frames. | `tracer-04-full.png`, `-crop.png` (x1000-2900, y760-1720), `-strip.png` (16 tiles), `-trail.png` (17 samples, 2.7 s) [observed: frames/tracer-04-*.png] |

- Each strip tile is one unique game frame, with the uploader's repeated frames removed. `+0` is the first frame in which that round's streak is visible. [observed: titles of frames/tracer-01-strip.png to frames/tracer-04-strip.png]
- Crops are at native stream resolution, cut from the same frame as `-full.png`. [observed: frames/tracer-01-crop.png to frames/tracer-04-crop.png]

## Timing: converting what you see to real game time

- The qqi stream shows 3 new frames for every 5 video frames (36 new frames per second of video), which fits a 60 fps game capture played at 60%. [observed: frame-difference values stored in frames/_work/t2/m01-strip.json]
- Its description says the Slow Motion cheat was on and the 60 fps clips were slowed to 60%. [text: YouTube description of qqi_N6M8bgY, per research pass]
- No source gives the Uncharted 4 Slow Motion factor `f` (game seconds per real second). [text: web search 11 Oct 2026, no U4 figure found]
- The Last of Us Part II, from the same studio, uses 50% for Slow Motion and 25% for Bullet Speed. That is a different game and does not prove the U4 value. [text: thelastofus.fandom.com/wiki/Gameplay_modifier]
- A falling can at 52.85-53.42 s accelerates at about 1.3 px per frame² at 4K. With the can about 10-16 cm across and normal gravity, that gives f ≈ 0.52-0.66 (a 9 cm can would give 0.49). [observed: frames/_work/t2/can/*.png]
- The turret fires exactly every 10 source frames. That is 720 rpm if f = 0.5, or 600 rpm if f = 0.6. Both are plausible for a mounted MG. [observed: frames/tracer-04-strip.png; frames/_work/t2/m04-flash.json]
- Working assumption: f ≈ 0.5 (range 0.5-0.66). One source frame in a strip ≈ 0.5-0.66 of a game frame at 1x and 60 fps. [inferred]
- **Revised by the muzzle flash's independent review (12 Oct 2026): f ≈ 0.40 (0.33-0.42).** A pistol flash seen at 1x (4 lit frames) and in this same slow-motion video (10 lit frames) fits only at f = 0.33-0.42; the AK's 14-tile shot spacing gives 643 rpm at 0.40 (a real AK: about 600) and 468 rpm at 0.55. The can estimate above rests on a guessed can size; a 5-6 cm can would make it agree. At 0.40 the turret's 10-frame spacing is 900 rpm. [observed: muzzle-flash-spec.md, Timing, estimate 4; frames/_review-muzzle-board.png section 2]
- What this means for the build: the tracer's 1x conversions use 0.55 (for example the streak `length` 0.85 = 1.5 source frames x 0.55), so its slow-motion-derived timings may run about 25-35 % long at 1x (x0.40 would make the streak 0.6 frames). Max approved stage 2 by eye at normal speed (12 Oct), so nothing was changed; an A/B at x0.40 is open for Max. [inferred]
- A/B made (12 Oct 2026, ~19:25; `frames/_progress/gif/tracer-timing-ab.gif` normal speed, `-slow.gif` 10x; scripts and the full timing table in `frames/_scratch-tracer-timing/`). Only two values came from the 0.55 conversion: `proj.speed` 400 -> 550 m/s (the M1 gunman's guessed 28 m crossed in 7.5 tiles; speeds take the inverse factor) and `proj.length` 0.85 -> 0.62 frames (keeps the streak 5.7 m long). The light's timing follows the speed; the mist values, `end.frames`, `proj.detach` and the light's reach and strength come from 1x footage or distances and stay. B = `&set=proj.speed:550,proj.length:0.62` on the approved snapshot. By eye at normal speed B is a quicker flick: the round crosses the range in 21 ms instead of 29, so each shot shows one frame less of streak and the moving light on the block is caught less often; the streak's look, its length on screen and the mist are unchanged. Pending Max's pick. [observed: frames/_progress/gif/tracer-timing-ab.gif]
- In the 1x footage (TDp, 60 fps, every frame unique), near-camera enemy streaks last 1-2 frames, then leave a smoke trail. This fits the converted slow-mo numbers. [observed: frames/tracer-rt-check.png]
- Below, "1x frames" means frames at 60 fps and normal speed, computed as source frames × 0.5-0.66. [inferred]

## Layer stack at a glance

| Layer | Look | Colour (sampled sRGB from 4K frames) | Size | Visible at 1x, 60 fps |
|---|---|---|---|---|
| Core streak | Straight, additive-looking, over-exposed. Hottest at the front. | head `#FFFFFF` → body `#FFE452`…`#FFFF7F` → tail `#FFEB74`/`#FF955F` | Mid-distance body 12-30 px FWHM at 4K. Up to 55 px on the closest passes. | The round's whole flight: about 2-6 frames. Gone 1 frame after impact or exit. [observed: frames/tracer-01-crop.png, frames/tracer-02-crop.png, frames/tracer-04-crop.png] |
| Edge fringe | Thin orange rim on the core | `#DC8642` / `#C1714B` | 2-6 px at 4K | Same as core [observed: frames/tracer-01-crop.png] |
| Halo / bloom | Warm haze around the core. Strong in dark scenes, almost absent in daylight. | `#8D4022` → background | About 100-300 px at 4K on a near pass in the dark | Same as core [observed: frames/tracer-02-crop.png] |
| Smoke trail | Pale filament along the path. Starts as a thin beaded line, then widens, wavers and fades. | About `#F3CCB8` at roughly 40% opacity in warm light | 2-4 px at birth, 25-50 px later (4K) | At least 20-27 frames (0.34-0.45 s); the end was not seen [observed: frames/tracer-04-trail.png] |
| Dynamic light | Orange light that travels with the round and lights nearby surfaces | Lit rock went `#333313` → `#84652A`, peak `#C58E59` | Reaches surfaces about 150-250 px (4K) from the streak | About 1 frame per surface it passes [observed: frames/tracer-02-light.png] |
| Distortion / heat haze | Not seen | n/a | n/a | n/a [observed: frames/tracer-01-crop.png, frames/tracer-04-crop.png] |
| Sparks on the streak | Not seen. Sparks belong to impacts and muzzles. | n/a | n/a | n/a [observed: frames/tracer-03-crop.png] |

## 1. Core streak

- Shape: a straight line segment with no wobble or curve. The front end (direction of travel) is widest, brightest and rounded. The back end tapers to a point. [observed: frames/tracer-01-crop.png, frames/tracer-04-crop.png]
- The very front fades in over about 5% of the length. The first sample (#B98066) is only a little above background, and by 6% in the core is #FFF0BE. [observed: frames/tracer-01-full.png, profile at x200,y1780]
- Head colour: clipped white `#FFFFFF` over the front 25-35% of the length (M1: 6-31%; M2: 6-25%; M3 enemy: 6-31%). [observed: frames/tracer-01-full.png, frames/tracer-02-full.png, frames/tracer-03-full.png]
- In the bright daylight turret shot the white part runs to about 57% of the length. That suggests the colour is an HDR intensity ramp rather than painted colours. [observed: frames/tracer-04-full.png]
- Body colour: R and G clip at 255 and B sits at 60-160, so it reads as lemon-to-gold yellow. The most saturated sample, `#FFDA4B`, sits just behind the white part. [observed: frames/tracer-01-full.png]
- Body samples elsewhere: `#FFF762`, `#FFFF90`, `#FFFFA3` (M1), and `#FFFF39` … `#FFFF8E` (M2). [observed: frames/tracer-01-full.png, frames/tracer-02-full.png]
- Tail colour goes from `#FFEB74` (M1) and `#FFD15B` (M2) to `#FF955F`, with `#E17963` at the far end of the incoming M3 round. Past that it drops toward the background. [observed: frames/tracer-01-full.png, frames/tracer-02-full.png, frames/tracer-03-full.png]
- Cross-section: a hard-edged saturated core with only a 2-6 px orange rim before the background. Example, M1 at 45% along: `#C1714B` · `#F5B94B` · `#FFE452` · `#FFD64E` · `#FFBC41` · `#DC8642` in 4 px steps. [observed: frames/tracer-01-full.png]
- HDR: the core clips to 255 in every moment, including the daylight market and turret shots. Emission is well above SDR white, but SDR footage cannot tell how far. [observed: frames/tracer-01-full.png, frames/tracer-04-full.png]
- Width, FWHM at 4K: about 7-9 px a few frames out from the shooter (M2 +3/+4). Mid-distance body 12-30 px. Head 22-42 px on the hero frames, 42-55 px on the closest passes. [observed: frames/tracer-02-strip.png, frames/tracer-01-full.png, frames/tracer-03-full.png]
- As a fraction of frame height: mid-distance body about 0.6-1.1%, closest head about 2-2.5%. Halve the pixel counts for 1080p. [observed: frames/tracer-01-full.png, frames/tracer-03-full.png]
- Width shrinks with distance, so the streak behaves like a world-space ribbon or billboard, not a constant screen-space line. [observed: frames/tracer-02-strip.png]
- My guess at world width: the M1 body is about 20 px where 1 cm ≈ 4-5 px (from Drake's head size), so roughly 4-5 cm FWHM. [inferred]
- Screen length on the hero frames: M1 1248 px (32% of frame width), M2 about 1180-1345 px (31-35%), M4 bright part about 730 px (19%), M3 player round 363 px (9.5%), M2 at +0 near the shooter about 96 px. [observed: frames/tracer-01-full.png, frames/tracer-02-full.png, frames/tracer-04-full.png, frames/tracer-03-full.png]
- Length in terms of motion: in slow-mo each streak's back end sits between where its head was 1 and 2 frames earlier. So a streak covers about 1.2-1.8 frames of its own travel. [observed: frames/tracer-01-strip.png head positions 94→204→416→790→1779 px along the path]
- At 1x (TDp 4.171 to 4.188 s) the streak also covers more than one frame of travel. [observed: frames/tracer-rt-check.png row B]
- Model that fits both speeds: the streak runs from the bullet's current position back about 1.5 frames of travel. That is a velocity-stretched streak, not a fixed world length. [inferred]
- Consequence of that model: on the original PS4 (30 fps) the same rule would make streaks twice as long in world space. This was not verified. [inferred]
- Intensity over time: full brightness for the whole flight with no fade-in or fade-out while moving. [observed: frames/tracer-01-strip.png +0..+5, frames/tracer-02-strip.png +0..+8]
- End of life: the frame after impact or exit, a dimmer, oranger leftover remains for 1 frame, then it is gone. TDp at 4.188 s shows `#FFE25E`→`#F8C843`→`#E3A26B` after `#FFF582` the frame before. [observed: frames/tracer-rt-check.png, frames/tracer-01-strip.png +6]
- Birth: the M1 streak appears 1 source frame after the muzzle-flash frame, starting about 40 px from the muzzle. [observed: frames/tracer-01-strip.png -1..+1]
- The turret streak first shows 4 source frames after its muzzle-flash spike. The flash and smoke may hide the first frames, or the tracer may spawn late. [observed: frames/tracer-04-strip.png; frames/_work/t2/m04-flash.json]
- Flight time = visible lifetime. M1: 7 source frames (≈ 3.5-4.6 1x frames, about 60-77 ms). M2: 9 source frames (≈ 4.5-6, 75-99 ms). M3 enemy: 4 (≈ 2-2.6). M4: 4 (≈ 2-2.6). M3 player round: 3 frames to impact (≈ 1.5-2). [observed: frames/tracer-01-strip.png to frames/tracer-04-strip.png]
- Rough visual bullet speed: about 250-500 m/s. This rests on guessed distances: the M1 gunman about 28 m from his on-screen height, crossed in 7-8 source frames, with f = 0.5-0.66. [inferred]

## 2. Edge fringe and halo (glow)

- The rim is part of the core falloff: 2-6 px of orange (`#DC8642`, `#C1714B`, `#E88B34`, `#DCB03A`) between the yellow core and the scene. [observed: frames/tracer-01-full.png, frames/tracer-02-full.png, frames/tracer-03-full.png]
- Daylight: almost no halo. The background lifts by only about +20-30 levels within about 20 px. [observed: frames/tracer-01-full.png]
- Dark jungle, near pass: a warm brown-orange haze (`#8D4022` 40 px out). Median luminance is 94 at 15 px, 76 at 60 px, 64 at 150 px and about 47 by 400 px. [observed: frames/tracer-02-full.png]
- On the lens pass one frame later, the halo fills a large area around the streak. [observed: frames/tracer-02-strip.png +8]
- Halo strength follows how bright the core is against the scene, which points to a scene-wide bloom rather than a glow sprite built into the effect. [inferred]
- No lens flare, starburst or anamorphic streak was seen. [observed: frames/tracer-02-crop.png]

## 3. Smoke trail (lingering)

This contradicts the research pass, which assumed small arms leave no smoke. Enemy rounds leave a visible smoke trail. [observed: frames/tracer-02-crop.png, frames/tracer-04-trail.png, frames/tracer-rt-check.png]

- Birth: a thin, beaded or dotted grey line, 2-4 px at 4K, starts right behind the streak's tail on the same line. [observed: frames/tracer-02-crop.png, right of the tail at about x1510-1840 in the crop]
- Later: it widens into a soft pale band, 25-50 px FWHM at 4K, with a wavy, wind-stirred path. [observed: frames/tracer-04-trail.png, frames/_work/t2/trailcol.png]
- Colour: semi-transparent and lit by the scene, not glowing. Over red dirt `#957467` the trail measures `#BB9889`, and over grass `#61593A` it measures `#9C886F`. [observed: frames/_work/t2/trailcol/tc-0252.486.png]
- Solving for both backgrounds gives a smoke colour of about `#F3CCB8` at about 40% opacity at the band's centre, in warm late-day light. [inferred]
- Lifetime: a round that hit the ground near the camera at about 251.985 s left a trail that is still clearly visible 41 source frames later (253.136 s), wavier and softer by then. [observed: frames/tracer-04-trail.png]
- An explosion fills that area from 253.29 s, so I could not see when the trail actually ends. [observed: frames/tracer-04-trail.png]
- That converts to at least about 20-27 frames at 1x (0.34-0.45 s). The upper limit is unknown. [inferred]
- Caveat: if the trail ages in real time rather than game time, the 1x lifetime is up to twice as long. This was not measured directly at 1x. [inferred]
- At 1x the trail is clearly there the frame after the streak leaves. [observed: frames/tracer-rt-check.png row B, right tile]
- Visibility: obvious against darker or shaded backgrounds (jungle, grass, dusk). In the bright market (M1), nothing was measurable along the path 2-3 frames after the round. [observed: frames/tracer-01-strip.png +7/+8]
- The thin dotted line ahead of the M2 head lies on the same line as an earlier round from the same shooter. It is probably that round's young trail. [observed: frames/tracer-02-crop.png; inferred interpretation]
- Lifespan, fade and warp are re-measured at 1x in "Trail re-check: the whole life of the mist" at the end of this file. Where they disagree, that section replaces this one. [inferred]

## 4. Dynamic light

- As the M2 round passes about 1 m above the rock cover, the rock top lights up orange. The lit area follows the rock's geometry, not the streak's shape. One frame earlier and one frame later it is unlit. [observed: frames/tracer-02-light.png]
- Lit rock median `#84652A` against `#333313` the frame before. Brightest lit pixels `#C58E59`. The streak was about 150-250 px away on screen. [observed: frames/tracer-02-light.png]
- The original PS4 game seems to do the same: in one frame a red display case looks lit orange-red along its edges as a round passes just above it. That is a single frame, so it is suggestive only. [observed: frames/_work/keep-qdg-122.937.png, a browser screenshot from the previous pass]
- The light colour looks warm orange, about `#FF9A40`, reaching roughly 1-1.5 m. This is an estimate from lit-surface colour only. [inferred]

## 5. Distortion and sparks

- No refraction or heat haze was seen along any path at 4K. Subtle distortion is not ruled out. [observed: frames/tracer-01-crop.png, frames/tracer-04-crop.png]
- No sparks or embers ride along with the streak. The orange specks near the M4 path are scattered and look like muzzle or impact embers. [observed: frames/tracer-04-crop.png]

## 6. Hand-off to impact

- The M3 player round runs straight to the jeep's front wheel and stops there with no overshoot. [observed: frames/tracer-03-strip.png +0..+3]
- The next source frame shows an orange flash and glow on the wheel, plus short radiating spark streaks that last several frames. [observed: frames/tracer-03-strip.png +3..+6, frames/tracer-03-crop.png]
- Rounds that reach Drake (M4 round A at +3) simply end, with no impact effect on the player character. [observed: frames/tracer-04-strip.png +3/+4]
- Impacts on rock cover show white dust puffs and debris chunks. They were seen in the jungle sequence but not frame-stepped for the hand-off. [observed: frames/tracer-02-full.png]

## 7. Frequency (streaks per shot)

- Turret: each muzzle-flash spike (every 10 source frames) is followed by one streak. Two rounds were checked frame by frame, more in the sampled frames. [observed: frames/tracer-04-strip.png, frames/tracer-04-trail.png]
- Market gunman: 2 separate streaks during 4 frames of muzzle flash. [observed: frames/tracer-01-strip.png -2..+1]
- Player rifle (M3): the muzzle flash is lit in almost every source frame, but only 2 outgoing tracers appear in 11 frames (+0 and +8). Shots could not be counted, so it is unknown whether every player round gets a tracer. [observed: frames/tracer-03-strip.png]
- Working read: enemy fire looks like every round has a tracer, and the player's tracers are intermittent or unknown. [inferred]

## 8. Shot-to-shot variation

- Every round I looked at follows the same head→tail ramp (white → yellow → orange). The visible differences come from distance and viewing angle. [observed: frames/tracer-01-crop.png to frames/tracer-04-crop.png, frames/tracer-rt-check.png]
- Rounds seen from behind (player fire) look more orange because the cool tail is nearest the camera, and the hot head is a small yellow-white dot far away. [observed: frames/tracer-03-crop.png; inferred interpretation]
- No sign of a separate player colour. [inferred]
- Paths are straight. Enemy rounds spread around the player: some hit the ground near the camera, some pass by the lens, some hit cover. [observed: frames/tracer-04-trail.png, frames/tracer-02-strip.png]
- Smoke trails vary in waviness and brightness with age and lighting. [observed: frames/tracer-04-trail.png]

## 9. Camera and context

- Third-person over-the-shoulder camera. The four views cover side-on crossing (01), a lens pass (02), outgoing fire from behind (03) and head-on incoming fire (04). [observed: frames/tracer-01-full.png to frames/tracer-04-full.png]
- A round passing the lens stays at full brightness right to the frame edge. No near-plane fade was visible at this frame rate. [observed: frames/tracer-02-strip.png +8]
- The red screen-edge "luck" UI could not be checked: qqi has the HUD removed, and the TDp sample showed no red vignette in the frames looked at. [observed: frames/tracer-rt-check.png]
- Not a tracer: the steady red beaded line in the jungle is a sniper laser sight. [observed: frames/tracer-02-strip.png]
- Not a tracer: the red clouds in the market are shot spice sacks. [observed: frames/tracer-01-crop.png]
- 01-04 are from the PS5 remaster. The single original-PS4 frame from the previous pass looks the same: orange-yellow streak, white head, surface lighting. [observed: frames/_work/keep-qdg-122.937.png]

## Starting values for the build

These are starting points only. Final numbers should be checked against the strips. [inferred]

- Projectile: a moving point at about 250-500 m/s. The streak is a camera-facing ribbon from the current position back 1.5 × (velocity × frame dt), with world width about 4-5 cm. [inferred]
- Colour ramp in linear HDR, head to tail: roughly (8,7,5) → (4,3,0.8) → (1.5,0.5,0.15), additive, so filmic tonemapping clips the head white and the body yellow. [inferred]
- Rounded front end fading in over the first 5% of the length; the tail tapers to zero width and alpha. [inferred]
- Death: keep one extra frame at about 50% intensity, shifted toward orange, then remove. Spawn the impact effect on the next frame at the hit point. [inferred]
- Smoke: a lit, alpha-blended (not additive) trail along the path. Width about 1 cm → 5-20 cm (from 2-4 px → 25-50 px at guessed depths of 5-10 m). Opacity about 0.4 → 0 over at least 0.35-0.45 s; the true end is unknown, so start with about 0.75 s. Add noise displacement that grows with age. [inferred]
- Light: a warm orange point light, about 1-1.5 m reach, moving with the projectile. [inferred]
- Bloom: a scene-wide bloom pass, so the halo shows mainly in dark scenes. [inferred]

## Still open

- The exact Slow Motion factor `f`. Every 1x number above scales with it. [inferred]
- Whether the smoke trail ages in game time or real time (affects the 1x trail lifetime by up to 2×), and how long it lasts in total. [inferred]
- Whether every player round gets a tracer. [inferred]
- The streak's true HDR intensity (the footage clips). [inferred]
- Whether 30 fps original-PS4 streaks are longer in world space. [inferred]
- The game's internal render resolution in this 60 fps capture was not checked. Pixel widths here are sizes in the 4K stream. [inferred]
- Colours come from compressed YouTube video with 4:2:0 chroma, so thin coloured edges are smeared and the hex values are approximate. [inferred]

## Trail re-check: the whole life of the mist (Max's note, 11 Oct 2026)

Third capture pass. Question: what does one round's trail do from the moment it is fired until it is completely gone? Tags as above. Ages are in 1x frames (60 fps) and ms since the round's first streak frame. The round crosses the visible path in 1-2 frames, so "time since fired" and "time since the round passed that point" differ by 33 ms at most. [inferred]

### Short answer

- The mist is born whole. Within 1-2 frames (17-33 ms) of the streak passing, a continuous, almost straight pale line runs the whole visible path, starting right at the muzzle. [observed: frames/tracer-trail-01-strip.png +1/+2, frames/tracer-trail-02-strip.png +1/+2]
- Then it fades in place. Strength halves about every 11-13 frames (180-220 ms). Width stays about the same, the line moves 10 px or less (1080p), and it turns patchy as it fades. [observed: frames/_work/trail/meas-RA.json, frames/_work/trail/meas-RB.json]
- Plainly visible for about 0.2 s, faint by about 0.3 s, measurable until about 0.6 s, and gone by about 0.7 s at 1x game speed. [observed: frames/tracer-trail-01-strip.png, frames/_work/trail/meas-RA.json]
- The warp is subtle. A gentle low-frequency bend and fibrous edges are there from birth. It does not curl, puff up or drift away. [observed: frames/tracer-trail-01-crop-033ms.png, frames/tracer-trail-02-crop-033ms.png]

### Check it yourself (best links)

1. https://www.youtube.com/watch?v=TDpsY0crUjE&t=99s (99.85-100.62 s). 1x speed, 60 fps, HUD on, 1080p max. Drake is in cover with a pistol. One enemy at frame centre fires three rounds toward the camera across shaded ruins, at 99.85, 99.93 and 100.12 s. The camera holds still until 100.62 s. Watch at speed 0.25 and step with `.`. [observed: frames/tracer-trail-01-strip.png, frames/tracer-trail-02-strip.png]
2. https://www.youtube.com/watch?v=qqi_N6M8bgY&t=235s (235.3-237.1 s). 4K slow motion, no HUD. Sustained enemy fire into a dark jungle ravine leaves a fan of straight pale trails. The camera pans away at 237.2 s. [observed: frames/_work/trail/qqi-235-sustained.png]
3. Already in this file: qqi 251.9-253.3 s (turret), for the close-up slow-motion look. [observed: frames/tracer-04-trail.png]
4. Other 1x streaks in TDp where the camera holds for at least 0.25-0.5 s afterwards, not analysed: 7.99, 23.76, 37.74, 55.49, 83.38 and 96.13 s. [observed: frames/_work/trail/tdp-cands.png]

### Kept rounds

| # | Source and time | What it shows | Files |
|---|---|---|---|
| 01 | TDp, fired 99.933 s (+0 = first streak frame) | Enemy round on a near-horizontal path, from the muzzle (about x1065, y459) to the right frame edge (about x1920, y500-540). About 860 px long, over shaded stone and a dark doorway. Its whole life happens inside the still shot (to +41 f). | `tracer-trail-01-strip.png` (20 tiles, +0 to +41 f), `-crop-017ms.png`, `-crop-033ms.png`, `-crop-133ms.png`, `-crop-333ms.png`, `-crop-533ms.png`, `-full.png` [observed: frames/tracer-trail-01-*.png] |
| 02 | TDp, fired 100.116 s | Same shooter. Diagonal path about 30° down-right from the muzzle (about x1065, y512) to the bottom-right corner, over dark stone and then bright grass. The camera holds still until +30 f (500 ms), so the end is extrapolated. | `tracer-trail-02-strip.png` (20 tiles, +0 to +30 f), `-crop-033ms.png`, `-crop-133ms.png`, `-crop-333ms.png`, `-full.png` [observed: frames/tracer-trail-02-*.png] |

- Each strip tile has two halves. The top is the frame itself (a native 1080p crop, shown at 0.75 or 0.6 scale). The bottom is the frame minus the pre-shot frame, registered and amplified ×4 around mid-grey, so faint mist shows white and fading older mist shows dark. [observed: titles of frames/tracer-trail-01-strip.png and frames/tracer-trail-02-strip.png]
- A third round, R0 (fired at 99.849 s), crosses the same shot on a steep diagonal. Its trail shows in both full frames, and as the dark fading diagonal in strip 02's difference panels, because it was already in that strip's reference frame. It was not measured, because the camera was still settling when it was fired. [observed: frames/tracer-trail-01-full.png, frames/tracer-trail-02-strip.png]
- Method: each frame was shifted onto the frame just before the shot (phase correlation on a 256 px window). The luma difference was then sampled across the path at stations every 80 px, taking the median over ±30 px along the path. "Lift" is the brightness added, in 8-bit levels. Width is the full width at half maximum (FWHM). [observed: frames/_work/trail/measure.py]
- Camera: still to within about 1 px from 99.93 to 100.0 s. It shifts about 5 px by 100.2 s, holds still to 100.60 s and moves from 100.63 s on. [observed: phase-correlation log in frames/_work/trail]

### Timeline by age (1x, 60 fps; widths at 1080p, doubled for 4K)

| Age | Shape | Width (FWHM) | Lift and opacity | Warp (centre-line motion) | Colour | Tag |
|---|---|---|---|---|---|---|
| +0 f, 0 ms | Only the head streak, about 65 px, just leaving the muzzle. No mist yet. | n/a | n/a | n/a | n/a | [observed: frames/tracer-trail-01-strip.png +0] |
| +1 f, 17 ms | The streak covers the near half of the path. Behind it, from the muzzle, a thin, faint, continuous line. | 11 px (22 px at 4K, 1.0% of frame height) at the muzzle end | Lift 17 (it is 37 a frame later) | Straight | Pale grey | [observed: frames/_work/trail/meas-RA.json station s=60; frames/tracer-trail-01-crop-017ms.png] |
| +2 f, 33 ms | Complete along the whole path. Continuous and almost straight, with one gentle bend and fibrous edges. Thin at the shooter end, wider toward the camera. | Median 25 px for RA and 20 px for RB. Ranges from 13-14 px near the muzzle to 26-38 px near the camera (26-76 px at 4K, 1.2-3.5% of frame height). About 1.1× the streak's own width. | Lift 53 (RA), 43 (RB). Opacity about 0.35 | The bend is already there at birth | Trail `#777466` over `#3F4131` (RA) and `#817E6C` over `#4F5040` (RB). R, G and B rise almost equally, so near-neutral and slightly warm. | [observed: frames/_work/trail/meas-RA.json, frames/_work/trail/meas-RB.json, frames/tracer-trail-01-crop-033ms.png, frames/tracer-trail-02-crop-033ms.png] |
| +4 f, 67 ms | Same line, slightly dimmer | Unchanged (25, 20 px) | Lift 47 / 41. Opacity about 0.3 | Moved 2 px or less | As above | [observed: frames/_work/trail/meas-RA.json, frames/_work/trail/meas-RB.json] |
| +8 f, 133 ms | Softer. Starts to turn patchy; the near-camera end over bright grass breaks into beads. | 26 / 20 px | Lift 31 / 27. Opacity about 0.2 | 3 px or less | Greyer, sinking into the background | [observed: frames/tracer-trail-01-crop-133ms.png, frames/tracer-trail-02-crop-133ms.png] |
| +12 f, 200 ms | Faint. Still continuous over dark stone, broken into segments elsewhere. | 26 / 20 px | Lift 22 / 20. Opacity about 0.14 | 5 px or less | as above | [observed: frames/tracer-trail-01-strip.png, frames/tracer-trail-02-strip.png] |
| +16-20 f, 267-333 ms | Hard to see in the plain frame. A soft band in the difference image. | 25-28 / 20 px | Lift 16-17 / 14-15. Opacity about 0.09 | 5-10 px in total since birth, in no consistent direction: RA sank 2-4 px; RB rose up to about 10 px in places. | as above | [observed: frames/tracer-trail-01-crop-333ms.png, frames/tracer-trail-02-crop-333ms.png, frames/_work/trail/meas-*.json offsets] |
| +24-30 f, 400-500 ms | Invisible in the plain frame. Patches in the ×4 difference only. | 22-24 px | Lift 8-12. Opacity about 0.05 | as above | n/a | [observed: frames/tracer-trail-01-crop-533ms.png, frames/_work/trail/meas-RA.json] |
| +36-41 f, 600-684 ms | At the noise floor at most stations, with one patch left on RA | (too faint to measure) | Lift 3-6 (10% → 6% of the +2 f value) | n/a | n/a | [observed: frames/_work/trail/meas-RA.json] |

- Opacity is estimated as the lift divided by (smoke minus background), assuming the smoke colour given under "Starting values" below. The ratios between ages are measured, but the absolute level depends on that assumption. [inferred]

### Lifespan

- RA: half its +2 f strength at +10 f (167 ms), 25% at +23 f (383 ms), 15% at +32 f (533 ms), 10% at +37 f (616 ms), and at the noise floor by +41 f (684 ms). [observed: frames/_work/trail/meas-RA.json]
- RB: half at +11 f (183 ms), 25% at +27 f (451 ms), and still about 20% at +30 f (500 ms) when the camera moves. Its fit reaches 10% at about +44 f (730 ms). [observed: frames/_work/trail/meas-RB.json; extrapolation inferred]
- Exponential fits from +2 f: RA τ ≈ 15 f (257 ms), half-life ≈ 11 f (178 ms); RB τ ≈ 19 f (316 ms), half-life ≈ 13 f (219 ms). [observed: fits to frames/_work/trail/meas-*.json]
- **Lifespan at 1x, until completely gone: about 0.7 s (range 0.6-0.8 s). To the eye on this background: about 0.25-0.35 s.** Confidence is medium-high for the 0.6-0.8 s range: two rounds in one daylight 1080p shot. The tail is exponential, so the exact "gone" point depends on where you cut it. [inferred]
- Game time or real time: in the slow-motion turret shot, a trail was still clearly visible 41 source frames after its round. That is 0.68 s of real time but only 0.34-0.45 s of game time. With real-time ageing it would be down to 6-10% strength by then, which is almost gone. With game-time ageing it would be at 15-25%, which fits "clearly visible". So the trail most likely ages in game time. Confidence is moderate, because that was a different scene with the trail close to the camera. [inferred from frames/tracer-04-trail.png and frames/_work/trail/meas-*.json]
- This replaces section 3's lifetime line ("at least 20-27 frames … start with about 0.75 s"). [inferred]

### Fade and dissipation pattern

- Opacity falls roughly exponentially from the start. There is no hold at full strength and no late collapse. [observed: frames/_work/trail/meas-RA.json, frames/_work/trail/meas-RB.json]
- The width stays almost constant: RA 25 → 26-28 → 24 px, RB 20 → 20 → 22 px. The slight late narrowing is only the faint edges sinking into noise. At 1x the trail does not widen into a broad cloud. [observed: frames/_work/trail/meas-*.json]
- Break-up: from about +8-12 f the line turns patchy along its length. The near-camera end (wider, over bright ground) breaks into beads and fades first. The stretch near the shooter, over dark stone, lasts longest. [observed: frames/tracer-trail-02-strip.png +8 to +30, frames/tracer-trail-01-strip.png +12 to +24]
- In the still shot, faint mist changes in steps every 2-4 frames (several frames in a row measure identically). That is probably the YouTube encoder holding static detail, not the game. Over about 0.1 s the fade is smooth. [observed: frames/_work/trail/meas-RA.json; cause inferred]

### Distortion

- No refraction is visible along either trail. In the difference panels, background edges along the path don't double or shift beyond the residual seen across the whole frame. A shift under about 1 px at 1080p can't be ruled out. [observed: difference panels of frames/tracer-trail-01-strip.png and frames/tracer-trail-02-strip.png]
- The only warp is the gentle bend in the mist's own shape. [observed: frames/tracer-trail-01-crop-033ms.png]

### Near the shooter, near the target, and many rounds

- Near the shooter (far from the camera) the line is thin (13-14 px at 1080p) and lasts longest. Near the camera end it is wider (26-38 px) and fibrous, and it fades and breaks up first. In world terms most of that width difference is perspective. [observed: frames/_work/trail/meas-RA.json; world reading inferred]
- The mist starts right at the muzzle, with no gap. [observed: frames/tracer-trail-01-crop-033ms.png]
- Odd detail: the mist line and the streak's line are not quite the same line. At the near-camera end the streak sits about 25-50 px (1080p) off the mist line: lower for RA, further down-left for RB. The camera did not move between those frames. The cause is unknown; perhaps the tracer is drawn on a slightly offset near-miss path. The build does not need to copy this. [observed: frames/tracer-trail-01-crop-017ms.png vs frames/tracer-trail-01-crop-033ms.png, frames/_work/trail/meas-*.json offsets; cause inferred]
- Sustained fire (qqi ravine): 5-10 trails are visible at once as a fan of straight pale lines converging on the shooters. Each fades on its own clock. They overlap but never build up into a fog bank, and the older ones look softer and slightly bent. [observed: frames/_work/trail/qqi-235-sustained.png]
- TDp: three rounds from one shooter in 0.27 s leave three separate lines at slightly different angles (spread), each on its own fade. [observed: frames/tracer-trail-01-full.png, frames/tracer-trail-02-full.png]

### Verdict on Max's description

- "Starting as a somewhat straight line": confirmed. The mist appears along the whole path within 1-2 frames, almost straight with a gentle bend. [observed: frames/tracer-trail-01-crop-033ms.png]
- "A mist": confirmed. It is pale, near-neutral grey smoke lit by the scene and blended over it, not glowing. [observed: colour samples above]
- "Which warps": partly. At 1x the line hardly moves (10 px or less over its life) and never curls or puffs. What reads as warping is the bend it is born with, plus the patchy break-up as it fades. The slow-motion close-ups look wavier because you watch one trail for longer, and the turret trails are near the lens. [observed: frames/_work/trail/meas-*.json; frames/tracer-04-trail.png; reading inferred]
- "Then dissipates": confirmed. It fades smoothly and roughly exponentially, breaks into patches, and is gone by about 0.7 s. [observed: frames/_work/trail/meas-RA.json]

### Starting values for the build

- Lifetime: 0.7 s (control range 0.4-1.0 s). Remove the ribbon once its opacity falls below 0.02. Age it in game time. [inferred]
- Birth: lay the ribbon along the path behind the head as the round flies, starting at the muzzle. Ramp each segment to full strength over 2 frames (about 30 ms). One frame in, it is about 80% of its final width and about half its strength. [observed: frames/_work/trail/meas-RA.json +1 f; values inferred]
- Straight phase: none. The line starts almost straight and stays that way. Default warp onset 0 s, exposed as a control. [inferred]
- Warp: low-frequency sideways noise along the line, with a wavelength of 0.3-0.5 of the visible path. Amplitude at birth about 0.5% of frame height at mid-distance (about 5 px at 1080p), rising slowly to about ×1.5 by end of life. Add fine fibrous edge noise at about the ribbon-width scale. [inferred from frames/tracer-trail-01-strip.png, frames/tracer-trail-02-strip.png]
- Width: about 1.1× the streak's width at birth. With the streak at about 4-5 cm, that makes the mist about 5-6 cm. On screen that is about 2% of frame height near the camera and about 1.2% near the shooter. Grow it only 10-20% over its life. [observed: frames/_work/trail/meas-RA.json; world width inferred]
- Opacity: `alpha(t) = 0.38 · ramp(t / 0.03 s) · exp(−t / 0.28 s)` (half-life about 0.19 s). Peak 0.3-0.45. [observed fits; values inferred]
- Break-up: multiply alpha along the ribbon by slowly changing noise, about 1/8 of the path length in scale. Raise its contrast with age, so the line turns patchy after about 0.15 s and the near-camera end goes first. [inferred]
- Drift: none needed. At most 0.5% of frame height in a random direction over the trail's life. [observed: frames/_work/trail/meas-*.json offsets; value inferred]
- Colour: light, slightly warm grey lit by the scene, alpha-blended, never additive. Start with `#D8CFC0` in daylight and shade, which solves to `#CBC3AD`-`#DED4C9` at α 0.35-0.4. Section 3's warmer `#F3CCB8` came from the low-sun turret scene, so treat it as a lighting variant. [inferred from colour samples above]
- Many rounds: each trail is its own ribbon with its own clock. No merging and no shared smoke volume. [observed: frames/_work/trail/qqi-235-sustained.png; build choice inferred]

### Gaps and caveats

- Both measured rounds come from one daylight 1080p shot (TDp), one shooter, over shaded stone. Brighter backgrounds hide the mist sooner, and darker scenes may show it for longer. [inferred]
- RB's end of life is extrapolated, because the camera moves at +30 f. RA's end was observed. [observed: frames/tracer-trail-02-strip.png]
- Both kept rounds are enemy fire. Player rounds were not checked for the same mist. [inferred]
- The 4K slow-motion birth detail from section 3 (a thin beaded line just behind the tail) was not re-measured. At 1x that stage lasts at most one frame. [inferred]
- Source compression: TDp is YouTube 1080p, and faint detail updates in steps. Lifts below about 5 levels are not reliable. The analysis frames were read from the player canvas as JPEG q0.95; the kept files are PNG. [inferred]
- The streak and mist not sharing one line is unexplained. [inferred]
<!-- trail-recheck: done -->
