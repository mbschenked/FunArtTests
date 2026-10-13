# Uncharted 4 muzzle flash: visual spec from frames

Capture pass, 11 Oct 2026. It replaces the earlier partial muzzle-flash picture with four moments where the whole flash is in view, plus a real-speed check. [inferred]

Every line has a tag. `[observed: file]` means I measured it in that frame file (paths are relative to this folder). `[text: source]` means a written source. `[inferred]` means my reading, not a measurement. Frame files live in `frames/`, which is gitignored and private. [inferred]

## Direction from Max (11 Oct 2026): read this first

- After seeing the 02 strip and the 01, 02 and 03 crops, Max said: "make the base version the ak one: the others are identically made i think, just with the base modified".
- **The AK-47, moment 01 (`muzzle-flash-01-*`), is the base.** Calibrate every default to it: the onset puff, the two flame lobes, the tall flame column, the orange licks, the violet afterglow, the warm haze and the hard cut. Moment 04 is the same AK over snow; use it as the AK's second reference for the onset puff and the sooty rim.
- **The other moments are the same effect with the base settings changed.** No separate builds. The 02 forward jet and the 03 X flash should be reachable by changing parameters only, and each ships as a preset made from the base.
- Violet afterglow: [ASSUMED] kept as observed, because it appears in every moment, including the AK strip at +6..+9. Max was asked but didn't pick; it is a panel layer with its own on/off toggle and intensity.
- Max reviews the work in stages: first the flash itself (shapes, colours, timing, light), then the secondary layers, then the polished build. Each stage stops for their direction.
- **First-look review (11 Oct 2026, evening).** Max saw the stage-1 board (AK base and the 02 jet preset against the game) and said: "add more sprites tho those aren't enough (like fill in between unless that's how many should be there". So the flash is built from too few pieces. The first pass drew the whole flame as one analytic card, a heat field from a few noise-warped capsules, which reads as one or two smooth blobs. The game's flash has many smaller flames, licks, flecks and sparks filling the gaps between the main lobes. Build it from more layered sprites, with the density checked against the frames for each phase.
- **Sprites are our own.** Max asked whether we could cut the flash out of the game frames, make fire sprites ourselves or find them online. Then: "yeah, you dont need to cut those sprites". Nothing cut from the game frames ships: it is Naughty Dog's art and the repo is public. Using the frames privately for measurement (shape masks, colour bands, counts) is fine. Make our own flame textures (baked flipbooks from our own simulation or noise, or generated when the page loads). Downloaded packs only if their licence allows redistribution in a public repo. This replaces the first pass's "procedural, no texture files" rule.
- **Simulated flipbooks: optional, later.** Max has a Windows PC with an NVIDIA card, but the build sessions run on a MacBook (11 Oct 2026: "i do have a windows pc with nvidia, but this is on a macbook right now", "as in this session"). So the builds keep baking their own sprites in the page and never wait on the PC. A flipbook simulated and baked at that PC (EmberGen, or Unreal's free Niagara Baker) is an optional upgrade, weighed at stage 2 when smoke arrives, after Max has judged the self-baked sprites.
- **Colour and detail gaps seen on the stage-1 board:**
  - The flame reads milky white. The game has a white-hot core with yellow and orange bands and orange licks at the edges.
  - The break-up should be sparkly blue-white with orange flecks. The first pass's floating orange teardrops are wrong.
  - The 02 preset doesn't make a forward jet at +0, and its break-up has hard, paper-cut edges.
  - The timing and the overall silhouettes per phase are right; keep them.
- **Defined flames and soft glare (11 Oct 2026, late evening).** After the normal-speed GIFs, Max said: "the muzzle flash looks pretty good, but less defined whereas the uncharted version was more defined and the edges were easier to see of the main flames (i think there's two types, the blurry ones which are like camera glare and the defined flames". So the flash has two kinds of element. The soft glare (the warm haze and the glows, like light blooming in a camera lens) stays soft. The defined flames (the main lobes and the column, +1 to +5) need crisp, readable edges against the background. The second pass made everything soft. Keep the two as separate panel groups, and score edge definition against the frames.
- **Max's picks (12 Oct 2026):** "do as you recommend E is good". So: colour conversion E on all pages (the flash barely changes); density A, the sparsest of the four (`frames/_s1b-muzzle-flash-pick.png`: fill 6, lobe tongues 4, 3 sprites per lobe, column tongues 6, flecks 3). [ASSUMED] Claude had said "A, or between A and B" and took A, because the next pass stretches each piece into a longer flame lick that fills more; revisit at that pass's pick board. Defaults kept: the AK slow-motion order at 1x, the +6/+7 blue-white glare toned down to the game's level (ours covers 31-32% of the flash, the game 9-21%), the violet afterglow. Next pass: reshape the round billows and white shard spikes into stretched flame licks with defined edges, warm the cream core toward gold, and turn the smooth white-violet break-up ball into a sparkly scatter with orange flecks. Max wants comparisons as normal-speed GIFs as well as stills: "images are good for detail, but i wont really know how itll feel until i see it as a gif".
- **Max on pass 3 (12 Oct 2026, ~11:00), after the GIFs and the live page:** "muzzle flash needs some work, its close but not quite right, especially the little hazy lens flare i think it is, try removing that". That is the "Glare: warm haze" layer (a round glow 26.5 cm to the shooter's left and 29 cm up, placed to match the game's glow from the hero camera; from the shoulder camera it floats beside the head). It is now off by default (settings VERSION 4). Then: "maybe the glare off to the side and not part of the muzzle flash is the issue, maybe its just the alignment, test it out". Test GIFs `frames/_progress/gif/muzzle-glow-*.gif`: A as built, B off, C half the offset (touching the flame), D centred. Claude recommends C: the game's glow is continuous with its left flame, not a separate orb. Pending Max's pick. Max also asked for an independent review: "the flame is the right color but the edges and time scale might be different, im not sure". Review done (12 Oct, ~12:35; board `frames/_review-muzzle-board.png`, GIFs `frames/_review-muzzle-1x-burst.gif`, `-ak-slow12x.gif`, `-f-proof-24x.gif`, tools in `frames/_review-muzzle/tools/`). Edges: partly the same. The column's edge width matches; the opening lobes are crisp cut-outs where the game's are soft, glowing puffs (new symptom rows below). Time scale: the length is right (f is about 0.40, see Timing), the shape over time is not: every one of our shots swells for 1-2 frames, while all 14 real-speed game shots are biggest in their first frame. Removing the warm haze made the +2 lobes whiter and harder, so the game's glow belongs on the flame's edge, which supports C over a separate orb.
- **Pass 4 go-ahead (12 Oct 2026, ~13:00):** Claude proposed, and Max answered "continue": (1) soft, glowing, rounder opening flames, the opening puff held a frame longer, the column crisp with a faint wide glow; (2) a per-shot mix at 1x: some shots open at full size and shrink, the rest keep the grow-then-peak order, half and half to start, with a slider; (3) the column tears into hot white pieces before it fades; (4) a peach rim and a softer late glare. The glow fix replaces the alignment pick: the offset warm haze stays off and the flame gets its own edge glow. Dropped from the plan: "longer rifle". The range's placeholder rifle is already about 20 % longer forward of the receiver than a real AK (receiver front to muzzle 0.575 m vs about 0.47 m), so the on-screen gap the review measured comes from camera geometry, and changing the range would also change the approved tracer page. Brief: the session scratchpad's `muzzle-pass4-prompt.txt`; work in `frames/_scratch-muzzle-flash/s1d/`.
- **Pass 4 built (12 Oct 2026, ~21:10; settings VERSION 5; snapshot `frames/_progress/gif/muzzle6-snap.html`; log `frames/_scratch-muzzle-flash/s1d/log.md`; boards `frames/_s1d-muzzle-flash-*.png`; GIFs `frames/_progress/gif/muzzle-pass4-1x.gif`, `-shoulder.gif`, `-hero-slow.gif`).** Builder's numbers: opening edges +1 21.0 px / +90, +2 15.5 / +64 (game 26.5 / +91, 13.5 / +61); column 13.0 / 13.5 / 10.5 px with +76 / +61 / +55 glow; rim cream (#F8E7BF..#F7E5B7); late glare 7.2k / 7.2k px; burst-first shots biggest in their first 1x frame at every phase. Burst-first shots are 1, 2, 5, 7, 8, 9, 10, 11 of 0-11 at the default share 0.5. To punch at late phases, they open at 1.25x the late lobes' size and 1.5x their heat and hold through the first frame. That puts them at about 1.4x the game's one burst-first tile, and in the close view they look blown out (Claude's look at the GIFs). The warm haze stays off; the game's broad up-left warm light is still missing. Waiting on the independent critic, then Max. Open questions: lobe roundness, burst-first share, burst-first size, the up-left warm light.
- **Max on pass 4 (12 Oct 2026, ~21:55), after the pass-4 GIFs:** "one note you got lightly wrong on the muzzle flash: parsts of the muzzle flash disspate at different times, like on the ak the initial tall flame grows much longer than you had it and its the top part of the entire flash while our flame changes universally (excepting the glare) otherwise this is pretty good", then "having overlapping parts fade in and out is key". Pass 4 is broadly right; the next pass is about timing per part. Each part of the flash (the opening flames, the tall flame on top, the column, the torn pieces, the glare) gets its own fade-in, hold and fade-out, overlapping the others, instead of the whole flame swelling and fading as one. On AK 01 the tall flame on top of the flash grows much longer than ours. Before building, measure in the AK 01 strip when each part appears, peaks and goes, and whether "much longer" means its life, its height or both. This leads pass 5; the pass-4 questions above stay open.
- **Pass 4 critic (12 Oct 2026; measured 21:15-21:51, before Max's note; board `frames/_critic-pass4-board.png`, work `frames/_critic-pass4/`): ready with small fixes.**
  - **Re-measured with the review's tools:** T1, T2, T3 (at 4.2 and 12.5 ms), T5 and T6 all match the builder's numbers.
  - **Better than pass 3:** soft, round opening lobes, tearing, cream-peach rims, deeper orange.
  - **Fix first, the burst-first opening.** It's 8 of the first 12 shots at share 0.5, though only 16 of the first 40.
    - It's 0.9-2.2x the game's one burst-first tile; shot 1, the one in the GIFs, is 2.2x.
    - It holds 76 % of its area at 16 ms, where the game keeps 33 % after 6.7 ms.
    - It washes out the rifle: luma 171, game 78-94.
  - **Design question:** start each round's visible clock at its first drawn frame. That's a slot-only change, tens of lines plus a re-tune.
  - **Taste calls left for Max:**
    - Lobe roundness, B or C; it recommends C.
    - Burst-first share; 0.5 is fine once fixed.
    - The up-left warm light: keep the haze off, maybe a centred lift at stage 2.
  - **Not taste calls:** burst-first size (about the game's tile) and column whiteness (62-74 % clipped).
  - **Fixes:** in the symptom table (rows dated 12 Oct, critic).
  - **Proposed pass-5 scope, not yet approved by Max:**
    - Max's per-part timing note (above).
    - The visible clock.
    - The critic's five fixes.
  - **A lead for the per-part timing:** the board's section 6 shows game tile +3 with a tall flame still reaching up and out of the crop, where ours (20.8 ms) has already shrunk to a compact shape.

## Symptom -> cause (grows with every review)

Before an edit, name the symptom, look it up here, and patch that one layer (scouting report, tactic 3). Add each new pair.

| Symptom | Cause, and the fix | Source |
|---|---|---|
| The flash reads as one or two smooth, milky blobs | Too few pieces. Add licks and flecks between the lobes and more sprite variants per phase; check density per phase against the frames. | Max, 11 Oct; pass 1 |
| The main flames look soft, with no readable edge | The whole flame blooms. Keep the defined flames crisp (heat-threshold outline, erosion fade, per-texel bloom weight) and put the softness in separate glare layers. | Max, 11 Oct; pass 2 |
| The flames read as popcorn: round billows plus white needle spikes | Round sprites and thin shards. Use stretched licks along the flow, wide at the root, tapering to torn tips, overlapping into one lumpy outline. | critic, 12 Oct |
| The body reads cream, not gold | ACES filmic's colour matrices desaturate bright yellows. Tone map E (12 Oct), then aim the bands at the spec's values. Under E each channel has its own shoulder, so a pale gold on screen comes from a strongly saturated orange at high gain: invert E per channel to get the ramp stops (pass 3: mid #ff8a3c x5 shows #FBEEB8). | Tone-map A/B, frames/_tm-compare.png; pass 3 step 5 |
| The +2 blob is too small, with too little clipped core | Too few overlapping pieces sum to less heat (density A: 17.2 x 30.6 % of the frame vs the game's 20.5 x 33.2 %, clipped 35 % vs 45 %). Lengthen the licks or raise the density toward B. | pass 3 log, 12 Oct |
| The break-up is a smooth white-violet ball | One soft glow. It should be a sparkly, broken scatter with orange flecks: pass 3 builds it from 4 twinkling glare pieces stretched along the barrel on screen, 28 sparks, and torn orange pieces. | critic, 12 Oct; pass 3 step 4 |
| Blue-white glare dominates +6/+7 | Not the glare: switching layers off one at a time showed the violet afterglow's lavender body made the 31-32 % (game 9-21 %). Start the afterglow later (from 60 % of the life) with a smaller body. Isolate layers before blaming one. | critic, 12 Oct; pass 3 step 4 |
| Slimmer lobes lose the clipped white core | The core is the summed heat of overlapping licks; less overlap means less heat. Raise the heat when you thin the overlap. | pass 3 step 8 (s17, s18 rolled back) |
| "Edge hardness" barely moves the measured edge width | edges.py follows the colour rim inside the outline, which heat sets. Use the per-layer edge softness or "Flame bloom" instead. | pass 3 step 9 |
| The detached orange licks read pale peach | They are semi-transparent, and our backdrop there is bright sky where the game's is a dark stone wall. Judge them over a dark backdrop before changing the colour. | pass 3 step 6 |
| A shape measure counts the game's tracer and ejected brass as flame tips | The measure takes every bright edge. Mask the tracer and brass, or use outline.py (cusps and bump aspect along the flame outline). | pass 3 (lickshape.py dropped) |
| The lobes end in pointed, wing-like tips at +1/+2 where the game's are rounder puffs | Not mainly the lick taper and tearing: the review tried taper 0.05 / tear 0.4 and the silhouette barely changed. The points come from the lobe layout and lick fans (AK right-lobe reach 1.00, tip width 1.15, onset.stretch 0.4), and the opening puff is gone by 0.15 of the life (puffEnd 0.10). Shorten the right lobe's reach and stretch, use wider round tips, and keep the puff into +1 (puffEnd about 0.15-0.2). | critic, 12 Oct, frames/_s1c-muzzle-flash-licks.png; independent review, 12 Oct, frames/_review-muzzle/v-variants-edges.png |
| The opening lobes (+1/+2) read as crisp cut-outs; the game's are soft, glowing puffs | One global "Flame bloom" (0.015) and the same hard heat-threshold outline on every layer (outline 0.12, hardness 0.85); the lobes' edge softness is already at its maximum. Game edge width at +1/+2: 26.5 / 13.5 px at 1080p with +91 / +61 luma of glow 7-20 px outside; ours 10.0 / 10.5 px, +40 / +39. One global bloom cannot match both phases (0.03 fixes +2 but blurs the column to 15.5-17.5 px, where the game's is 10-11.5). Give the onset lobes their own glow weight (about bloom 0.03 at +2, more at +1) and keep the column crisp. | independent review, 12 Oct, board section 1 |
| At 1x the flash swells instead of punching | Every shot uses the AK reference shot's late order (lobes born at 60 %, peak at 0.27 of the life, column peak at 0.54). All 14 real-speed game shots (pistol 5, SMG 9) are biggest in frame 0; ours reach 118-233 % of frame 0 one or two frames later. The AK's slow-motion shots are split (2 of 3 swell). Make it a per-shot choice: puff-opening shots keep the late order; the rest open at full size, peak by 0.02-0.05 of the life, with an earlier, smaller column. | independent review, 12 Oct, frames/_review-muzzle-1x-burst.gif |
| The column's edge is a gold rim with a hard outside, and its top has horn-like spikes | A wide gold band inside the outline (color.rim 0.5, edgeAt 0.22, midAt 0.42) and no wide glow outside (halo.intensity 0.15). The game stays white to 2.5-3 px inside the outline, then fades over 6-7.5 px into a glow (+55..+72 luma; ours +40..+43). Narrow the inner rim and add a wide, faint cream halo (0.6 at 60 cm measured 11.5-14.5 px, +47..+59) rather than more bloom. The spikes are crown tongues and lick tips (column.tongues 6, lick.tear 0.8): fewer or shorter tongues round the top. | independent review, 12 Oct, board section 1 |
| The column stays one solid body at +4/+5 | Erosion and torn pieces start only at breakStart 0.54, and the detached pieces are already cooled orange. The game's column tears into 5-8 white-yellow pieces on its right and lower side at +4/+5. From about 0.35-0.4 of the life, tear 4-8 hot pieces (6-15 cm) off the column, eat holes into it, and cool them to orange by +6. | independent review, 12 Oct, frames/_review-muzzle/v-close-4-6.png |
| The column's rim reads lemon, not cream-peach | The edge stop (#ffa058 x1.4) shows lemon under tone map E: game just inside the outline #FBEDC1 / #FCEEBF / #FCE8B7 (blue/red 0.70), ours #F8E4A2 / #F7E09A / #F5DC9A (0.61). Push the edge stop toward peach. | independent review, 12 Oct |
| With the warm haze off, the +2 lobes read whiter and harder | The haze was filling the gold edge band. +2 clipped white / gold band: haze off 66 % / 6 %, haze on 50 % / 22 %, game 48 % / 19 %. The game's glow sits on the flame's edge, not beside it: replace the floating orb with glow on the lobes (row above), or move it against the flame (alignment C). | independent review, 12 Oct; Max's glow test, frames/_progress/gif/muzzle-glow-*.gif |
| The late glare (+6..+8) is too bright and streaky | glitter.gain 5 at stretch 2.2 and 28 sparks at gain 14 (bright area at +7/+8: ours 11.4k / 11.3k px, game 8.4k / 6.3k). The game shows a soft lavender-white glow with a few deep-orange licks. Glitter gain about 3 and softer; fewer, dimmer sparks or glints instead of streaks; deeper orange licks, judged over a dark backdrop. | independent review, 12 Oct, board section 3 |
| The flash looks big next to the gun | Not the flash: its screen size matches the game within 10 %. The range's placeholder rifle is about 19 % shorter on screen (flame width / rifle at +2: game 0.83x, ours 0.98x). Lengthen the rifle; don't shrink the flash. | independent review, 12 Oct, frames/_review-muzzle/v-rifle-length.png |
| Shots meant to punch look smaller than before at real speed | A shot's first drawn frame lands 0-16.7 ms after it (the live page fires on 1/240 s substeps: 0, 4.2, 8.3 or 12.5 ms, and the phase stays the same for a whole 600 rpm burst). An opening that peaks for about 3 ms is gone by then. Either hold the opening through the first frame (pass 4; this costs an oversized opening) or start each round's visible clock at the first frame it is drawn, as a game that spawns its effect on the frame does. Test the 1x rhythm at several first-frame phases, in absolute area too, never at one phase only. | orchestrator, 12 Oct, frames/_progress/gif/muzzle-wip1-*.gif; pass 4 log |
| The violet afterglow flickers or drifts | It is built as flame. It must be a static, soft sprite with its own lifetime. | scouting report, tactic 3 |
| The whole flame swells and fades as one; only the glare keeps its own timing | Not yet measured. The game's parts dissipate at different times: on AK 01 the tall initial flame on top of the flash grows much longer than ours while other parts fade. Give each part its own fade-in, hold and fade-out, overlapping the others; first measure each part's birth, peak and end per tile in the AK 01 strip. | Max, 12 Oct ~21:55 |
| Burst-first openings are too big, too white, hold still, and wash out the rifle | burst.size 1.25, burst.heat 1.5 and color.onsetGlowBirth 3.4 (not the halo; halo.on:0 leaves the rifle at luma 171), chosen so a trigger-time clock still punches at late first-frame phases. Preview `&set=burst.size:1,burst.heat:1,color.onsetGlowBirth:1.5`: 36.8k tile px (game 36.3k), rifle luma 101, outline readable. T3 then also needs a smaller burst column. Better: the visible clock (row on frame phases above), so the opening can be game-sized and drop like AK 01 shot 2 (33 % one tile later). | critic, 12 Oct, frames/_critic-pass4-board.png sections 2-4 |
| The column at +4/+5 is bigger and whiter than the game's | Clipped share 86 / 84 % (game 68 / 62, pass 3 76 / 78); clipped area 36k / 39k tile px (game 25k / 27k). color.columnBand 0.8 gives 79 / 75 %; column.heat 0.55 gives 83 / 78 %. In the game the flank itself breaks up with holes; ours stays one solid body with pieces beside it (tear.holes, tear.count). | critic, 12 Oct, board section 5 |
| The fading opening flames turn into faceted, translucent sheets at 16-22 ms (1x frame 1 of every late single shot) | The onset band stays wide while the lobes' envelope falls. Erode inside a crisp edge instead: tie the onset band width to the envelope (slot change). color.erodeFade 1, color.onsetBand 1 and color.onsetSoft 0.5 each reduce it; none removes it. | critic, 12 Oct, board section 6 |
| The late glare is a narrow white streak | The white core matches (7.2k vs 7.5k px at +7), but the game's soft lavender-white glow around it is about 3x broader, and the game has 2 textured orange licks where ours has 5-6 flat scraps. Try glitter.stretch about 1.3, glitter.width about 16 cm, a wider violet body, fewer textured scraps (untested). | critic, 12 Oct, board section 7 |
| At +2 the two lobes merge into one flat, pale cloud | The game keeps two round masses with a dip at the sight post; the pick board's lobe layout C keeps that best. The +2 mid and edge bands are 16 levels bluer than the game's, so the gold reads cream: warm those stops. | critic, 12 Oct, board section 1 |

## Check the direction yourself (best links)

qqi_N6M8bgY plays slowed twice: the in-game Slow Motion cheat, then the uploader's 60% playback. Watch it at YouTube speed 0.25 and step with `.` and `,` while paused. [observed: repeated-frame pattern in frames/_work/mf/m01-seq.json]

1. https://www.youtube.com/watch?v=qqi_N6M8bgY&t=84s (84.95-85.39 s). One rifle shot in a dark, foggy pier: forward flame jet, round fireball, orange break-up, violet afterglow, hard cut. This is the cleanest full anatomy. [observed: frames/muzzle-flash-02-strip.png]
2. https://www.youtube.com/watch?v=qqi_N6M8bgY&t=186s (186.25-186.70 s). Night jungle: the X-shaped flash and the muzzle light on Drake's face, hands, the rock and the ground. [observed: frames/muzzle-flash-03-strip.png]
3. https://www.youtube.com/watch?v=qqi_N6M8bgY&t=171s (171.04-171.52 s). AK-47 in daylight: two flame lobes, then the violet afterglow, then nothing until the next shot 14 frames later. [observed: frames/muzzle-flash-01-strip.png]
4. Real speed: https://www.youtube.com/watch?v=TDpsY0crUjE&t=47s (47.55-48.45 s). Pistol at 1x and 60 fps with the HUD on. Every shot is visible for exactly 4 frames. [observed: frames/muzzle-flash-rt-check.png]

## Kept moments

All four are the player's own fire in qqi_N6M8bgY, a PS5 remaster capture. I confirmed a 3840x2160 stream (`videoWidth` 3840, quality `hd2160`), no HUD, 60 fps game footage. [observed: frames/muzzle-flash-01-full.png]

| # | Video time | Weapon, light, view | What it shows | Files |
|---|---|---|---|---|
| 01 | 171.137 s (strip +0 = 171.087) | AK-47, shaded forest pool in daylight, over the shoulder | Two big flame lobes either side of the muzzle, warm haze glow, violet afterglow, hard cut, next shot at +14 | `muzzle-flash-01-full.png`, `-crop.png` (x500-1900, y450-1450), `-strip.png` (18 tiles) [observed: frames/muzzle-flash-01-*.png] |
| 02 | 84.985 s (= strip +0) | Rifle with red-dot sight, dark foggy pier | Long forward jet plus a downward lobe, then fireball, orange cloud, violet glow, hard cut, next shot at +13 | `muzzle-flash-02-full.png`, `-crop.png` (x800-2200, y950-1850), `-strip.png` (17 tiles) [observed: frames/muzzle-flash-02-*.png] |
| 03 | 186.302 s (strip +0 = 186.286) | Green rifle with optic, night jungle, camera close to Drake | X-shaped four-lobe flash, yellow bloom, light on face, hands, rock and ground, a few embers | `muzzle-flash-03-full.png`, `-crop.png` (x300-1800, y300-1500), `-strip.png` (17 tiles) [observed: frames/muzzle-flash-03-*.png] |
| 04 | 66.250 s (= strip +0) | AK-47 over sunlit snow | The first flash frame has a dark blue-black ragged rim, which only shows against a bright background. A white cloud lingers afterwards. | `muzzle-flash-04-full.png`, `-crop.png` (x700-1900, y950-1800), `-strip.png` (19 tiles) [observed: frames/muzzle-flash-04-*.png] |
| rt | TDpsY0crUjE 47.55-48.27 s and 18.52-18.80 s | Pistol and SMG at 1x, 60 fps, 1080p, HUD on | Real-time frame counts, every video frame shown | `muzzle-flash-rt-check.png` [observed: frames/muzzle-flash-rt-check.png] |

- `-full.png` is the native 3840x2160 frame. `-crop.png` is cut from that same frame at native resolution. [observed: frames/muzzle-flash-01-crop.png to frames/muzzle-flash-04-crop.png]
- Strip tiles show 4K x/y 2000x1250 areas (printed in each strip header) scaled to 960 px. Each tile is one unique game frame, with the uploader's repeated frames removed. `+0` is the first flash frame. The tile outlined in cyan is the `-full`/`-crop` frame. [observed: frames/muzzle-flash-01-strip.png]
- Each strip runs from before the shot to the hard cut and on to the start of the next shot. [observed: frames/muzzle-flash-01-strip.png to frames/muzzle-flash-04-strip.png]
- Not kept: a jeep-mounted machine gun at 172.74 s, because its left lobe runs into Drake's head. It is still used below as a weapon-class data point. [observed: frames/_work/mf/mg-172-strip.jpg]

## Timing: converting what you see to real game time

- qqi shows 3 new frames for every 5 video frames (36 new frames per second of video). That is a 60 fps game capture played at 60%. [observed: frames/_work/mf/m01-seq.json, m02-seq.json, m03-seq.json]
- The Slow Motion cheat was on during the capture. [text: YouTube description of qqi_N6M8bgY, via tracer-spec.md]
- TDpsY0crUjE is a 1x reference: 1080p at 60 fps. In my frame-by-frame captures (74, 58 and 59 consecutive frames) every frame differs from the one before, so each video frame is a new game frame. [observed: frames/_work/mf/tdp-1x-2.4.json, tdp-1x-18.5.json, tdp-1x-pistol-47.5.json]
- 1x pistol: 5 shots exactly 12 frames apart. Each flash is visible in exactly 4 frames (67 ms), then gone. [observed: frames/muzzle-flash-rt-check.png, rows 1-2]
- 1x SMG: shots 5-6 frames apart (about 650 rpm). Each flash shows 2 bright frames, then 1-2 violet/orange frames, then nothing until the next shot. [observed: frames/muzzle-flash-rt-check.png, row 3]
- Slow-motion rifles: every flash is visible for 10 unique frames (+0 to +9) and gone at +10 in 01, 02 and 03. The next shot comes 13-14 unique frames after the first. [observed: frames/muzzle-flash-01-strip.png, frames/muzzle-flash-02-strip.png, frames/muzzle-flash-03-strip.png]
- The flash fills about 60-80% of the gap between shots both at 1x (SMG, 3-4 of 5-6 frames) and in slow motion (rifles, 10 of 13-14 frames). [observed: frames/muzzle-flash-rt-check.png, frames/muzzle-flash-01-strip.png to frames/muzzle-flash-03-strip.png]
- Slow-motion factor `f` (game time per rendered frame, relative to 1x), estimate 1: matching the 10-frame rifle flash to the 4-frame 1x flash gives f ≈ 0.4. This holds only if rifle flashes last as long as pistol/SMG flashes. [inferred]
- Estimate 2: matching the 13-14 frame rifle shot spacing to the SMG's 5-6 frames gives f ≈ 0.36-0.46. This assumes the same fire rate. [inferred]
- Estimate 3: the tracer pass's falling-can gravity estimate gives f ≈ 0.52-0.66. [text: tracer-spec.md, Timing section]
- Estimate 4 (independent review, 12 Oct 2026): the same kind of flash seen at both speeds. A pistol at 1x (TDp 47.5 s, 5 shots) is lit exactly 4 frames, shrinking 100 / 52 / 29 / 23 / 0 %. A pistol in slow motion (qqi 77 s, a different model, also a round white ball) is lit exactly 10 frames, shrinking 100 / 80 / 63 / 51 / 43 / 36 / 32 / 28 / 25 / 23 % and then a hard cut. Re-timing the slow-motion curve fits best at f = 0.33-0.42 (rms 1.5-4.6 points); from f = 0.45 a 5th lit 1x frame appears, which no 1x shot has; at 0.55 the rms error is 18. All four slow-motion weapons last exactly 10 tiles and both 1x weapons exactly 4 frames. The AK fires every 14 tiles: 643 rpm at f = 0.40 (a real AK: about 600), 468 rpm at 0.55. A tracked brass casing leans against 0.55 but cannot pin f. [observed: frames/_review-muzzle-board.png section 2, frames/_review-muzzle-f-proof-24x.gif, frames/_review-muzzle/v-p77-muzzle.png]
- Estimate 3 is weaker than it looks: the can's size was guessed, and a 5-6 cm can would make it agree with estimate 4. [inferred, independent review]
- Verdict (12 Oct 2026): f ≈ 0.40 (0.33-0.42). One slow-motion tile ≈ 6.7 ms of game time, so the 10-tile flash lasts 55-70 ms. The build's 66 ms (6.6 ms per tile) is right; 60 ms would be the middle of the range, with no visible difference at 60 fps. The 92 ms that f = 0.55 would give is ruled out. Keep the slow-motion strips for the order and relative length of the phases. [inferred from estimate 4]
- Effects run on game time, not wall-clock time: a rifle flash lasts 10 rendered frames in slow motion, against 4 for the pistol and SMG at 1x. Slow-motion footage is therefore a valid stretched view of the effect. [inferred]
- On the 30 fps PS4 original, a 4-frame (60 fps) flash would be 2 frames. Not measured: the PS4 clip I found (QDg9x7YleT4, 720p) is in Bullet Time. [inferred]
- Below, "slow-mo frames" means unique frames in qqi. "1x frames" means frames at 60 fps and normal speed. [inferred]

## Layer stack at a glance

| Layer | Look | Colour (sampled sRGB) | Size (4K, over the shoulder) | Visible |
|---|---|---|---|---|
| Onset flame shape | Ragged flame lobes from the muzzle: forward jet, two side lobes, or an X-shaped star | Clipped `#FFFFFF` core, then `#FFFFD3`…`#FFFFC6`, then `#FFEFB2`/`#FFECD3`, edge `#ECCC97`/`#ECC9B2`/`#EECD7E` | Blob 690-940 px wide and 550-720 px tall (25-33% of frame height), about 0.75-0.9× the on-screen length of the visible rifle | Slow-mo +0..+1 (+2 for the AK). 1x frame 0 is the largest frame [observed: frames/muzzle-flash-01-crop.png, frames/muzzle-flash-02-crop.png, frames/muzzle-flash-03-crop.png] |
| Fireball / flame column | Compact ball or upright column at the muzzle with licking edges; shrinks and warms | White core, edges yellow `#FFC895` and peach `#FEC492` late on | 290-320 px across for the rifles (13-15% of frame height); AK column 350-465 px (equivalent discs of the clipped area) | Slow-mo +1..+5. 1x frame 1 (about 53% of frame 0's clipped area) [observed: frames/muzzle-flash-02-strip.png, frames/muzzle-flash-rt-check.png] |
| Break-up and orange fragments | Fireball tears into a ragged orange cloud. Small flame licks detach and drift forward/up | `#DD926D`, `#F3A77B`, `#E2975A` (bright `#F9A45B`), `#FFBC7E` | Cloud about the fireball's size; licks 40-80 px | Slow-mo +5..+6. 1x frame 2 [observed: frames/_work/mf/m02-late.jpg, frames/_work/mf/sparks.jpg] |
| Violet afterglow | Soft, static lavender/blue-white glow hugging the muzzle after the flame | Body `#BAADCF`…`#C7B1D4`, bright centre `#E0DAF9`…`#E9DCF7`; bluer at 1x `#A2AACA` | Core 220-270 × 230-360 px (11-17% of frame height), centred on the muzzle | Slow-mo +6..+9, then a hard cut. 1x frames 2-3 [observed: frames/muzzle-flash-02-strip.png, frames/muzzle-flash-rt-check.png] |
| Warm haze glow / bloom | Large soft warm glow around and above the gun; a yellow wash over much of the frame at night | Daylight haze `#373433` → `#AB8E68`; night halo `#C2A65C` | About 2-3× the onset size | Whole flash life in 01/02, cut with the violet glow [observed: frames/muzzle-flash-01-strip.png, frames/muzzle-flash-03-full.png] |
| Muzzle light | Lights face, hands, gun, rock and ground | Peak on near skin pale warm `#FFEABF`…`#FFF8BF`; on far surfaces `#FFB347`/`#FFBD40`, then `#FF8045`/`#FF883B` | Reaches surfaces several metres off (depth not measurable) | Slow-mo peak +1, about 25-50% from +2 to +5, off at +6. 1x: spike in frame 0, 10-50% in frame 1 [observed: frames/_work/mf/m03-grid.jpg, frames/muzzle-flash-rt-check.png] |
| Dark rim | Ragged blue-black edge around the first puff | `#2C2E3D`…`#363B53`, fringe `#5B5E84` | Band 20-60 px around a puff about 290 px across | Slow-mo +0, red-black edge at +1..+2. Only visible on bright backgrounds [observed: frames/muzzle-flash-04-crop.png, frames/_work/mf/ring-zoom.jpg] |
| Smoke | Not seen in dark scenes within the flash life. Lingering white cloud in sunlit snow; faint grey haze at 1x | White cloud near-clipped on snow | About the fireball's size | ≥16 slow-mo frames after the flame in 04; 1-2 frames at 1x [observed: frames/muzzle-flash-04-strip.png, frames/muzzle-flash-rt-check.png] |
| Embers | A few tiny orange-yellow specks near the flash | Orange-yellow | 2-5 px each, 3-6 per shot | Slow-mo +1..+2, dark scenes only [observed: frames/_work/mf/m03-specks.jpg] |
| Distortion / heat haze | Not seen | n/a | n/a | n/a [observed: frames/muzzle-flash-01-strip.png +6..+9, frames/muzzle-flash-02-strip.png +7..+9] |

## 1. Onset flame shape (first one or two slow-mo frames)

- The biggest, most structured shape comes first: +0 for the rifle jet (02) and the machine gun, +1 for the jungle X (03), +2 for the AK lobes (01). At 1x, frame 0 is the largest in every pistol and SMG shot. [observed: frames/muzzle-flash-02-strip.png, frames/muzzle-flash-03-strip.png, frames/muzzle-flash-01-strip.png, frames/muzzle-flash-rt-check.png]
- 02 onset: a forward jet whose clipped core starts at the muzzle (about x1260, y1330) and runs about 350 px forward. The soft edge reaches 500 px. A second lobe points down-left to about 400 px below the muzzle. [observed: frames/muzzle-flash-02-full.png, profiles along y1340 and x1450]
- 02 tip: the front of the jet ends in an orange-brown smoky ring, median `#916E5E` against the deck's `#48403E`. [observed: frames/muzzle-flash-02-crop.png]
- 01 onset: two broad lobes, one to the left of the muzzle and one to the right, with the tracer leaving between them. The blob is 941 × 718 px. [observed: frames/muzzle-flash-01-crop.png]
- 03 onset: four lobes in an X: up-right, down-right, forward, and back over the optic. The blob is 758 × 651 px, reaching about 590 px forward and 160 px back from the muzzle. [observed: frames/muzzle-flash-03-crop.png]
- Machine gun onset (not kept): a bow-tie, with one lobe up-left toward Drake's face and one forward-right, narrow at the muzzle. The blob is 858 × 718 px. [observed: frames/_work/mf/mg-172-strip.jpg]
- Reading across moments: the lobes sit roughly at right angles to the barrel, as from a vented muzzle device. From behind they spread sideways on screen while the forward jet is foreshortened. [inferred]
- Edges are ragged and flame-textured. They are not clean thin petals or a geometric star. [observed: frames/muzzle-flash-01-crop.png, frames/muzzle-flash-03-crop.png]
- Colour bands inside the onset blob, from the core out (01 / 02 / 03): clipped `#FFFFFF` over 48% / 84% / 49% of the blob area. [observed: frames/muzzle-flash-01-full.png, frames/muzzle-flash-02-full.png, frames/muzzle-flash-03-full.png]
- Next band (L 245-254): `#FFFFD3` / `#FFFFF0` / `#FFFFC6`. [observed: same files]
- Mid band (L 230-245): `#FFEFB2` / `#FFECD3` / `#FFEF9D`. [observed: same files]
- Edge band (L 200-230): `#F4DDA4`…`#ECCC97` / `#F9DAC0`…`#ECC9B2` / `#FCDD8F`…`#EECD7E`. [observed: same files]
- Just outside the blob (0-12 px): `#CDAD86` / `#B6937E` / `#DFBF6E`. [observed: same files]
- So the edge is lemon-to-gold in 01 and 03 and peach in the dark pier (02). Red only appears in the 04 rim. [inferred]
- Sometimes the first frame is a round puff rather than lobes: AK 01 at +0 (with a violet fringe, 16K violet pixels), 03 at +0 (a round ball about 300 px), and the snow AK 04 at +0 (clipped 286 × 292 px). [observed: frames/muzzle-flash-01-strip.png, frames/muzzle-flash-03-strip.png, frames/muzzle-flash-04-crop.png]
- HDR: the core clips to 255 in every moment, daylight included. Peak brightness cannot be recovered from SDR video. [observed: frames/muzzle-flash-01-full.png to frames/muzzle-flash-04-full.png]

## 2. Fireball and flame column (slow-mo +1..+5)

- 02: the jet collapses into a round fireball at the muzzle. Its clipped area stays flat from +1 to +4 (72K, 67K, 74K, 79K px), about 51-56% of the onset's 142K. [observed: frames/muzzle-flash-02-strip.png; pixel counts from frames/_work/mf/m02-seq.json]
- 03: the same plateau, 66-77K px from +2 to +5 after a 176K peak at +1. [observed: frames/muzzle-flash-03-strip.png; frames/_work/mf/m03-seq.json]
- 01 (AK): a tall flame column instead of a ball. It grows to its largest area at +5 (170K px), then collapses at +6. [observed: frames/muzzle-flash-01-strip.png; frames/_work/mf/m01-seq.json]
- Edges lick and flicker with small flame tongues, and the ball drifts slightly forward from the muzzle. [observed: frames/_work/mf/m02-late.jpg]
- Colour warms over the phase. At +5 in 02 the non-white edge is yellow `#FFC895` and peach `#FEC492`. [observed: frames/_work/mf/m02-seq.json at 85.135]
- 1x equivalent: frame 1. Pistol clipped area is 53% of frame 0 on average over 5 shots (50-59%). [observed: frames/muzzle-flash-rt-check.png]

## 3. Break-up and orange fragments (slow-mo +5..+6)

- The fireball tears into ragged, semi-transparent orange clumps that drift forward and dissolve within one or two slow-mo frames. [observed: frames/_work/mf/m02-late.jpg]
- 02 at +6: orange `#DD926D` (brightest `#F0A47B`), peach `#F3A77B`; clipped area down to 12K px. [observed: frames/_work/mf/m02-seq.json at 85.152]
- 03 at +6: detached orange licks `#E2975A` (brightest `#F9A45B`) and yellow-peach `#FFBC7E`. [observed: frames/_work/mf/m03-seq.json at 186.453]
- 01 at +6: three or four small orange flame licks float above and right of the muzzle as the column dies. [observed: frames/_work/mf/sparks.jpg, left]
- 1x equivalent: frame 2. SMG frame 2 shows small yellow/orange remnants (up to 6K px) next to the violet glow. [observed: frames/muzzle-flash-rt-check.png, row 3 +2]

## 4. Violet afterglow (slow-mo +6..+9, then a hard cut)

- After the flame, a soft violet/lavender glow sits on the muzzle. It does not move and has no flame texture. It is present in 01-03 and in the 1x pistol and SMG shots; over the snow in 04 it cannot be told apart from the white cloud. This colour was not predicted by the research cues. [observed: frames/muzzle-flash-01-strip.png, frames/muzzle-flash-02-strip.png, frames/muzzle-flash-03-strip.png, frames/muzzle-flash-rt-check.png]
- Colour: body `#BAADCF` (02), `#C7B1D4` (03), `#C4B8D9` (01); bright centre `#E0DAF9`…`#E9DCF7`; 1x SMG a bluer `#A2AACA`. [observed: frames/_work/mf/m02-seq.json at 85.219, m03-seq.json at 186.503, m01-seq.json at 171.304, tdp-1x-18.5.json at 18.585]
- Size: core 269 × 342 px (02), 217 × 229 px (03), 247 × 356 px (01), centred on the muzzle (02 centroid 1241, 1340). At 1x and 1080p: 103 × 92 px. [observed: same files]
- It already appears at +1..+5 behind the flame and has the stage to itself from +6 or +7. Its size and colour stay steady until it vanishes. [observed: frames/_work/mf/m02-seq.json, violet pixel counts 2.8K → 25K]
- End: everything vanishes between +9 and +10 with no fade-out. Region brightness drops straight back to the pre-shot level. [observed: frames/muzzle-flash-02-strip.png +9/+10, frames/muzzle-flash-01-strip.png +9/+10]
- The 1x pistol ends the same way: 7.6K clipped px in frame 3, background level (0.3K) in frame 4. [observed: frames/muzzle-flash-rt-check.png]
- Likely a separate glow sprite with a fixed lifetime, not lens bloom: it outlives the flame and has its own cool colour. [inferred]

## 5. Warm haze glow and bloom

- 01 (daylight, hazy forest): a broad warm glow fills the air above and left of the gun, over and around Drake's head. It switches on at +0 and stays until +9. Sample region (x600-900, y550-850): `#373433` → `#A1835F` (+0) → `#AC9069` (+3) → `#987A59` (+9) → `#3A3635` (+10). [observed: frames/muzzle-flash-01-strip.png]
- 02 (dark pier with fog): the haze above the gun goes `#29282D` → `#55463E` at +0, rising to `#624F44` by +9, and is back to `#2C2B31` at +10. [observed: frames/muzzle-flash-02-strip.png]
- 03 (night jungle): a yellow halo floods much of the frame. 30-60 px outside the flash it measures `#C2A65C`. [observed: frames/muzzle-flash-03-full.png]
- In the daylight and pier scenes the haze stays lit for the whole flash life, violet phase included. That points to lit volumetric fog or a large glow card, rather than bloom from the core alone. [inferred]
- No lens flare streaks or anamorphic lines were seen. [observed: frames/muzzle-flash-01-crop.png to frames/muzzle-flash-04-crop.png]

## 6. Muzzle light

- 03 night jungle: rock face (x1500-1800, y450-650) `#2A3221` → `#3F3E2B` (+0) → `#5F5730` (+1, peak) → `#484129` (+2..+5) → `#2F3422` (+6) → back to base. [observed: frames/_work/mf/m03-grid.jpg; frames/_work/mf/m03-seq.json]
- Ground beyond the muzzle (x1400-1800, y1150-1350): `#1E241E` → `#343126` → `#736333` (+1) → `#433726`…`#3E3022` (+2..+5) → `#25261F` (+6). [observed: same]
- Drake's cheek: `#3A2615` → `#4C3925` (+0) → `#503D27` (+1) → `#4C3B27` (+2..+4) → `#3B2615` (+5). Forearm: `#92623A` → `#A4774B` (+1), with a faint tail to +9. [observed: same]
- Shape over time: on at +0, peak at +1, a plateau of about 25-50% of the peak lift until +5, off at +6. That is earlier than the violet glow, which lasts to +9. [observed: same]
- Light colour, as the lift over the unlit surface: at the peak `#FFB347` (rock) and `#FFBD40` (ground); on the plateau `#FF8045` and `#FF883B`. Warm yellow that turns orange. [inferred from the observed samples above]
- 1x SMG, the hand in sunlight: frame 0 lifts it from about `#5A5044` to `#AD9C82` or `#B0A383`, a pale warm-white light (`#FFEABF`…`#FFF8BF`). Frame 1 keeps only about 10-50% of that lift. [observed: frames/muzzle-flash-rt-check.png row 3; frames/_work/mf/tdp-1x-18.5.json]
- Reach: in 03 it lights the face, hands, gun top, a rock face and the ground well beyond the muzzle. Distances could not be measured. [observed: frames/_work/mf/m03-grid.jpg]
- 02: Drake's hand takes a violet tint during the violet phase (`#221D20` → `#62505A`). The violet glow either lights it or overlaps it. [observed: frames/muzzle-flash-02-strip.png]

## 7. Dark rim (bright backgrounds only)

- Over snow the first puff (+0) is outlined by a ragged blue-black band, about 20-60 px thick at 4K: `#2C2E3D`…`#363B53`, with a blue fringe `#5B5E84`. The band traces the puff's outline, about 340 px across including the band, and is open at the bottom where the gun is. [observed: frames/muzzle-flash-04-crop.png, frames/_work/mf/ring-zoom.jpg]
- At +1 and +2 the same edge turns red-black along the top of the flame. [observed: frames/_work/mf/ring-zoom.jpg]
- Profile across the rim at y1330: clipped 254 → 201 → 60-88 (rim) → 160 (snow). [observed: frames/muzzle-flash-04-full.png]
- In dark scenes the same edge would vanish into the background. 02's orange-brown tip ring is probably the same feature seen warmer. [inferred]
- So the onset frames contain alpha-blended dark, sooty edges, not purely additive light. This matters when compositing over bright skies or snow. [inferred]
- This is not a compression artefact: the band follows the cloud's ragged outline and is far wider than block ringing. [inferred]

## 8. Smoke

- Dark scenes (02, 03): no smoke is visible during the flash life or in the 3-4 frames after the cut. [observed: frames/muzzle-flash-02-strip.png +10..+12, frames/muzzle-flash-03-strip.png +10..+13]
- Sunlit snow (04): after the flame a soft white cloud stays in front of the muzzle for at least 16 slow-mo frames, to the end of the capture. Its clipped area shrinks from 58K to 29K px, and small orange puffs drift up through it from +8 to +15. [observed: frames/muzzle-flash-04-strip.png, frames/_work/mf/snow-66-late.jpg]
- At 1x a faint grey haze sits in front of the SMG for 1-2 frames after the violet glow. Contrast is low. [observed: frames/muzzle-flash-rt-check.png row 3, +4/+5]
- Reading: the smoke is lit, not glowing. It only reads in strong light, so it shows white on sunny snow and is invisible at night. [inferred]
- Bullet smoke trails behind tracers are a separate effect, covered in tracer-spec.md. [text: tracer-spec.md]

## 9. Embers and sparks

- In the night jungle, 3-6 tiny orange-yellow specks (2-5 px at 4K) scatter right of and below the flash for about 2 slow-mo frames. [observed: frames/_work/mf/m03-specks.jpg]
- None were clearly visible in the daylight moments. No long spark streaks were seen at any muzzle. [observed: frames/muzzle-flash-01-strip.png, frames/muzzle-flash-04-strip.png]
- The detached orange flame licks (section 3) are more prominent than sparks. [observed: frames/_work/mf/sparks.jpg]

## 10. Timing in 1x frames (60 fps), per layer

Built from the 1x pistol and SMG counts, with the slow-mo phases spread over the 4-frame life (about 2.5 slow-mo frames per 1x frame if f = 0.4). [inferred]

| 1x frame | What is on screen | Clipped area vs frame 0 (pistol, mean of 5 shots) | Light | Tag |
|---|---|---|---|---|
| 0 | Onset lobes or puff at full size; haze glow on; sometimes a faint violet fringe | 100% | 100% spike | [inferred] |
| 1 | Compact fireball or flame column, white to yellow; violet glow growing behind it | 53% | 10-50% | [inferred] |
| 2 | Break-up: orange fragments and a small white remnant; violet glow at full size | 32% | 0-20% | [inferred] |
| 3 | Violet glow only (the pistol keeps a small white-violet remnant) | 24% | off | [inferred] |
| 4 | Nothing: hard cut | 0% | off | [inferred] |

- Table source: pistol clipped area 100 / 53 / 32 / 24 / 0% (mean of 5 shots); SMG 2 bright frames, then 2 violet frames; slow-mo phase order from 01-03. [observed: frames/muzzle-flash-rt-check.png, frames/muzzle-flash-02-strip.png]
- Fade shape: a stepped decay followed by a hard cut. Nothing eases out to zero. [observed: frames/muzzle-flash-rt-check.png]
- Sustained fire: at about 650 rpm (every 5-6 frames) the flash is lit in about 4 of every 5-6 frames, with 1-2 dark frames between shots, so it strobes. [observed: frames/muzzle-flash-rt-check.png row 3]

## 11. Shot-to-shot variation

- The same gun gives different shapes from shot to shot. AK 01's first shot opens as a round puff with a violet fringe. Its next shot (+14) opens as a big flame burst leaning up-left. [observed: frames/muzzle-flash-01-strip.png +0 and +14]
- 1x pistol: frame-0 clipped area 20.5K-45.2K px over 5 shots (linear size ratio about 1.5). Shapes alternate between spiky and round. [observed: frames/muzzle-flash-rt-check.png rows 1-2; frames/_work/mf/tdp-1x-pistol-47.5.json]
- 1x SMG: frame-0 area 21K-34K px over 7 shots (CV 13%, linear ratio 1.27). [observed: frames/_work/mf/tdp-1x-18.5.json]
- A second SMG burst varied more (6K-45K px), but the gun was moving behind foliage, so it is not a clean measure. [observed: frames/_work/mf/tdp-1x-2.4.jpg]
- The variety of onset silhouettes (jet, two lobes, X, bow-tie, round puff) suggests several flipbook variants with random roll and scale per shot. [inferred]
- Phase timing barely varies: 10 slow-mo frames in all three rifle moments, 4 frames for every 1x pistol shot, 3-4 for the SMG. [observed: frames/muzzle-flash-01-strip.png to frames/muzzle-flash-03-strip.png, frames/muzzle-flash-rt-check.png]

## 12. Weapon class

- Rifles (01-03, slow-mo): onset 25-33% of frame height, life 10 slow-mo frames, shots every 13-14 frames. [observed: frames/muzzle-flash-01-strip.png to frames/muzzle-flash-03-strip.png]
- Jeep-mounted machine gun (not kept): onset 33% of frame height (bow-tie), a shot every 11 slow-mo frames. Fire is continuous: an orange-yellow remnant and violet glow bridge the gap until the next shot. [observed: frames/_work/mf/mg-172-strip.jpg]
- Pistol (1x, 1080p): frame-0 clipped area equals a disc about 205 px across (mean of 5 shots), about 19% of frame height. Smaller and rounder than the rifle lobes. [observed: frames/muzzle-flash-rt-check.png]
- SMG (1x): similar in size to the pistol, about 18% of frame height. [observed: frames/muzzle-flash-rt-check.png]
- Outlier: a large pistol in qqi at 48.2 s makes a giant white ball, about 700 × 760 px (35% of frame height; its top merges with the bright sky), that shrinks over about 22 slow-mo frames. This was not seen at 1x, so the weapon or setup is unclear. [observed: frames/_work/mf/pistol-48-strip.jpg, frames/_work/mf/pistol-view.jpg]
- Enemy fire seen from the front (jeep gunner, qqi 218.90-219.05 s): a clipped blob 130 × 155 px (about 7% of frame height) with pink-white edges `#FFE9E0`. It holds its size for at least 6 slow-mo frames (it was already lit when the capture began), then vanishes. No lobes are visible at that distance. [observed: frames/_work/mf/enemy-front-219.png]
- Not captured: shotgun, revolver, grenade launcher, Flintlock. [inferred]

## 13. Camera and context

- All four kept moments are the player's own fire, from a third-person camera over Drake's right shoulder. The barrel points into the screen and the flash sits at x 25-33%, y 38-62% of the frame. [observed: frames/muzzle-flash-01-full.png to frames/muzzle-flash-04-full.png]
- Drake's head and shoulder fill the left edge. In close shots the flash is larger than his head. [observed: frames/muzzle-flash-03-full.png, frames/_work/mf/mg-172-strip.jpg]
- The tracer leaves the muzzle in the frame after the onset. [observed: frames/muzzle-flash-01-strip.png +1] [text: tracer-spec.md, "Birth"]
- Ejected brass flies out on every shot and passes in front of the flash. It is not part of the flash. [observed: frames/muzzle-flash-01-crop.png]
- All kept moments come from the PS5 remaster. The PS4 original (QDg9x7YleT4, 720p) reads the same way: white core, warm edge, heavy bloom at night. Its fine shape cannot be resolved at 720p. [observed: frames/_work/mf/qdg-view.jpg]

## Starting values for the build

Starting points only. Check final numbers against the strips. [inferred]

- Lifetime: 4 frames at 60 fps (0.067 s) on game time; at 30 fps, 2 frames. Re-trigger on every shot and cut hard at the end. [inferred]
- Onset sprite (frame 0): pick one of 4-6 flame-lobe variants (jet, two-lobe, X, bow-tie, round puff). Use random roll (±180° for the symmetric ones, ±20° for the jet) and ±15-25% scale. [inferred]
- Onset size: about 0.75-0.9× the gun's on-screen length from the over-the-shoulder camera. My guess for world size is 40-70 cm across the lobes, which is stylised and far larger than a real flash. [inferred]
- Orient the lobes at right angles to the barrel, plus a short forward jet, so they spread sideways when seen from behind. [inferred]
- Onset colour: HDR additive white core (start around 20-40× scene white), ramping through `#FFFFD3`/`#FFEFB2` to gold `#ECCC97` at the edges. Add a thin alpha-blended sooty edge (`#2C2E3D`) that only reads over bright backgrounds. [inferred]
- Frame 1: compact fireball at about 50% of the onset area, white to yellow, with a slight forward drift. [inferred]
- Frame 2: break-up. Orange clumps `#DD926D`…`#F3A77B` at about 30% area, plus the violet glow at full size. [inferred]
- Frame 3: violet glow only. Soft radial sprite, body `#C0B2D6`, centre `#E6DFFA`, about 0.3× the onset size, centred on the muzzle. [inferred]
- Light: point light, colour (1.0, 0.70, 0.28) at the peak shifting to (1.0, 0.50, 0.25). 100% in frame 0, about 30% in frame 1, off from frame 2 (a faint tail into frame 2 is fine). Give it a few metres of range so walls and ground pick it up. [inferred]
- Haze: a large soft additive warm card (about 2-3× the onset size, `#AB8E68`-ish), or volumetric-fog lighting, alive for the whole 4 frames. [inferred]
- Bloom: a scene-wide bloom, so the halo grows in dark scenes. [inferred]
- Smoke: a lit (not emissive) soft grey-white puff that starts on frame 2-3, drifts up and forward and lasts at least 0.3 s. Keep it subtle except in strong light. [inferred]
- Embers: optional, 3-6 tiny orange specks in frames 0-1. [inferred]
- No heat distortion. [inferred]

## Research cues: verdict from the frames

- Radial starburst / petals with a forward cone: partly confirmed. Onsets are 2-4 broad ragged flame lobes (jet, two lobes, X, bow-tie), not thin petals, and the forward jet is foreshortened from behind. [observed: frames/muzzle-flash-01-crop.png to frames/muzzle-flash-03-crop.png]
- White-hot core fading through yellow to orange/red with bloom: confirmed, with two corrections. Orange arrives late, in the break-up rather than as a fixed outer rim. A violet afterglow follows the flame. [observed: frames/muzzle-flash-02-strip.png]
- Size scales with weapon class: partly confirmed. Rifle and machine-gun onsets are bigger than pistol and SMG onsets, but sources and cameras differ, and shotguns were not captured. [observed: frames/muzzle-flash-01-crop.png, frames/muzzle-flash-rt-check.png, frames/_work/mf/mg-172-strip.jpg]
- Lifetime of 1-3 frames at 30 fps: confirmed as 4 frames at 60 fps (2 at 30 fps) for the pistol and SMG at 1x. Not measured at 1x for rifles. [observed: frames/muzzle-flash-rt-check.png]
- Per-shot variation: confirmed for shape and size; timing is fixed. [observed: frames/muzzle-flash-01-strip.png, frames/muzzle-flash-rt-check.png]
- Warm dynamic light: confirmed. It spikes in the first frame and dies before the violet glow does. [observed: frames/_work/mf/m03-grid.jpg]
- Per-shot smoke puff: weak. Smoke only shows in strong light. [observed: frames/muzzle-flash-04-strip.png]
- Sparks/embers: weak. A few tiny specks at night. [observed: frames/_work/mf/m03-specks.jpg]
- Environment reaction to the blast (foliage, dust): not seen and not checked frame by frame. [inferred]

## Still open

- The slow-motion factor `f`: settled at about 0.40 (0.33-0.42) by the independent review (Timing, estimate 4). [observed: frames/_review-muzzle-board.png section 2]
- Rifle flash life at 1x has not been measured directly; the review rebuilt the AK at 1x from its slow-motion tiles at f = 0.40. A 1x rifle clip would confirm it, and would show whether the AK at 1x opens biggest (like the pistol and SMG) or swells (like 2 of its 3 slow-motion shots). [inferred]
- Whether the haze glow is volumetric-fog lighting or a glow card, and whether the violet glow is a sprite or a post effect. [inferred]
- Shotgun, revolver, grenade launcher and Flintlock flashes. [inferred]
- The giant qqi pistol ball at 48.2 s is unexplained. [inferred]
- True HDR intensity (the footage clips). [inferred]
- Colours come from compressed YouTube video with 4:2:0 chroma, so thin coloured edges are smeared and hex values are approximate. [inferred]
- Work files (scan logs and raw frame dumps, about 0.7 GB) are in `frames/_work/mf/` and can be deleted once this spec is accepted. [inferred]
