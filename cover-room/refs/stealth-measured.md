# U4 stealth, awareness and HUD: measured from gameplay footage

Pass of 2026-11-11 in the built-in browser pane. Frames were read in-page (video drawn to a canvas, pixel bboxes and luminance
profiles taken in JS), never downloaded. Time stamps are `video.currentTime` in seconds.
Tags: [MEASURED] read off footage here, [WIKI] guide or developer write-up, [INFERRED] reasoned from measured data,
[ASSUMED] my call. Reference crops are in `refs/frames/stealth-ref/` and `refs/frames/aim-ref/` (git-ignored).

Videos used:

| key | video id | what it is | HUD | used for |
|---|---|---|---|---|
| V1 | `m-RM25lpOCs` | U4 Remastered PS5, "Aggressive Stealth Kills: Island Jungle", 1080p | on, threat indicators on, NPC marking on | awareness indicator look, ledge pull, noticed grab |
| V2 | `6l50qycznmY` | U4 Crushing "pistols and melee only" run (has a streamer overlay top-left), 1080p | on | reticle, damage streaks, SP aim |
| V3 | `fJJcwud3A3A` | settings walkthrough, 1080p | menu | the Threat Indicators option |
| V4 | `_iXAuwVeMpI` | U4 multiplayer pistol-only, 720p | on (MP) | close OTS pistol aim |
| – | `TldgubMC5h8`, `DGdH2lLoo7Y`, `ZojyNTUPNWQ`, `Ih1vXL-xe5c` | U4 stealth/combat showcases | No-HUD or indicators off | rejected (no indicators) |
| – | `xS9j4-TWLWs` | TLOU Part II Remastered, pistol + melee | on | sampled 62–92 s and 331–378 s, no aimed frames found |

Caveat that matters for every number below: most U4 stealth showcases on YouTube are recorded with **No HUD Mode** or
**Threat Indicators off** (both are menu options, V3 15.4 s [MEASURED]). The pixel scan of V1 (0.5 s steps, 0–235 s) found
yellow diamonds only at takedown moments and no white stage at all, so the fill timings could not be measured this pass.

---

## Reticle

From V2 at 256.9–257.25 s (Drake aims from cover, fires once at ~257.0). 1080p source; luminance profiles through the dot
centre, horizontal and vertical. 720p values = 1080p × 0.667.

| name | value | unit | source | confidence |
|---|---|---|---|---|
| reticle position, x | 959–960 of 1920 (centred) | px | V2 256.9 / 257.25, dot centre from profile | [MEASURED] high |
| reticle position, y | 450–454 of 1080 = **0.418 from top** | frac | V2 256.9 (454), 257.25 (450) | [MEASURED] high (matches current `hud.reticle.y` 0.42) |
| dot core diameter | 5 @1080p = **3.3 @720p** | px | V2 256.9 row: 245,255,212,215,225; col: 186,246,255,255,230 | [MEASURED] high |
| dot outline | 1 @1080p (≈ 0.7, draw 1 px @720p), dark (L 34–68 on a ~115 grey background) | px | same profiles, the dark pixel each side of the core | [MEASURED] medium (codec softens it) |
| dot total (core + outline) | 7 @1080p = **4.7 @720p** | px | – | [MEASURED] |
| dot colour | pure white (255,255,255) | rgb | V2 256.9 centre pixel | [MEASURED] high |
| aim-in ring | 4 white arc segments (top, bottom, left, right), no full ring, no brackets otherwise | – | V2 256.9–257.1 | [MEASURED] high |
| ring radius | 39.5 @1080p (26 @720p) at 256.9 → 28 (19 @720p) at 257.1 → gone at 257.25 | px | profiles: arcs at ±39/40 then −28 | [MEASURED] medium (one aim-in) |
| arc length / stroke | ~16 px long (~33° of arc) / ~3 px bright stroke @1080p (2 @720p), faint dark edge | px | V2 257.1 column through the left arc | [MEASURED] medium |
| ring timing | shown on aim-in, contracts ~30% in ~0.2 s, gone by ~0.35 s; the dot stays | s | V2 256.9 → 257.25 | [MEASURED] low (one sample; could also be shot bloom) |
| dot during muzzle flash | dot dims or drops out for ~1 frame at the shot (257.1) | – | V2 257.1 | [MEASURED] low |
| over-enemy change | not seen (no frame had the dot on an enemy) | – | – | not measured |
| hit marker X | not seen in the frames sampled | – | – | not measured |
| what makes it pop | white core + 1 px dark outline: reads on both the dark marble and the bright snow/light sources in V2 | – | V2 257 context crop | [MEASURED] qualitative |

Crops: `stealth-ref/u4_6l50qycznmY_256.9-257.25_reticle-x2.5-strip.png` (nearest-neighbour ×2.5, four steps), `stealth-ref/u4_6l50qycznmY_257.0-257.75_reticle-context.jpg`.

---

## 1. Awareness indicator: look

| name | value | unit | source | confidence |
|---|---|---|---|---|
| shape | **solid diamond / kite**, taller than wide, the lower point longer than the upper (points down at the head); not an arc | – | V1 148.9–149.5 (`stealth-ref/u4_mRM25lpOCs_149.0_yellow-diamond.png`); Prima calls it "diamond-shaped" | [MEASURED] high, [WIKI] agrees |
| size (enemy ~1.5 m from camera) | 39–42 × 50 @1080p = **26–28 × 33 @720p**; height = 4.6% of screen height | px | V1 149.0–149.2 pixel bbox | [MEASURED] medium (one close enemy; scaling with distance not checked) |
| gap head-top → diamond bottom | 40 @1080p (27 @720p) ≈ 0.42 head heights ≈ **0.10 m** at that range | px / m | V1 149.0: diamond y 274–323, head top 363, head ~95 px tall | [MEASURED] low–medium |
| diamond centre above head top | ≈ 0.16 m (at ~1.5 m range) | m | derived from the two rows above | [INFERRED] |
| yellow colour (as encoded) | ≈ (200,190,25), flat fill, slightly darker rim | rgb | V1 149.0–149.2 bbox mean | [MEASURED] |
| colour order | white → yellow → orange | – | Chou (C) and Prima | [WIKI] / [DEV] |
| fill behaviour | "fills progressively" (Prima). Direction of fill not seen | – | Prima | [WIKI] |
| fade in | ≤ 0.1 s (full in the first sampled frame); the victim's yellow highlight ramps in over ~0.2 s | s | V1 148.9 (0.1 s steps); V1 130.97→131.17 (1/30 s trace) | [MEASURED] medium |
| hide on takedown/death | **snaps off** within one 0.1 s step as the victim is grabbed/killed | s | V1 149.5 → 149.6 | [MEASURED] medium |
| fade on drain (no takedown) | not seen | – | – | not measured |
| in full combat | **no indicator** ("if no threat indicator is seen ... you are either in full stealth or in full combat") | – | Prima | [WIKI] medium |
| NPC marking | marked enemies get a thin yellow rim outline, separate from the diamond; it was on before the enemy noticed (V1 148.4) | – | V1 131.0, 148.4 | [MEASURED] high |
| off-screen / through walls | not seen | – | – | not measured |
| menu option | "Threat Indicators On/Off" and "NPC Marking On/Off" in Gameplay settings | – | V3 15.4 | [MEASURED] |

## 2. Fill timing: not measured

No clip with the threat indicator on showed an enemy filling white → yellow → orange from distance; see the caveat at the top.
What the footage does show:

| name | value | unit | source | confidence |
|---|---|---|---|---|
| point-blank notice (enemy turns, Drake ~1.5 m away and lunging) | yellow diamond in ≤ 0.1 s, no white stage seen | s | V1 148.8 → 148.9 | [MEASURED] low (the takedown may force it) |
| ledge pull victim | yellow diamond appears in the same 1/30 s as the grab | s | V1 130.967 | [MEASURED] (takedown-driven, not perception) |
| white stage behaviour | enemy stops patrolling and looks; reaching cover before it fills stops it | – | Prima | [WIKI] |
| yellow stage behaviour | enemy investigates (paired investigator + watcher) | – | Chou, Prima | [DEV] / [WIKI] |
| orange | full awareness; loud stinger; buzzing bed while threat builds | – | Chou | [DEV] |

## 3. Spreading: not measured

| name | value | unit | source | confidence |
|---|---|---|---|---|
| full orange alerts nearby enemies | yes | – | Prima (in ai-spec) | [WIKI] |
| killing an enemy who is talking to others | the nearest enemy comes to investigate | – | Prima | [WIKI] |
| audio | buzzing tension bed while meters rise, loud stinger at full awareness | – | Chou | [DEV] (videos were watched muted per the brief) |

## 4. Takedowns

| name | value | unit | source | confidence |
|---|---|---|---|---|
| prompt | no on-screen button icon seen; Drake's arm lifts ("reach") when a stealth takedown is available; button Square | – | Prima, Gamer Guides | [WIKI] |
| available from | behind a wall, tall grass, low crate, or hanging below the enemy on a ledge | – | Prima | [WIKI] |
| ledge pull-down | grab 130.97 → victim over the edge and highlight gone 132.03–132.3 (**~1.1–1.3 s**); Drake settled back on the ledge by ~132.5–132.8 (~1.6–1.8 s total) | s | V1, 1/30 s yellow-pixel trace + 0.33 s sheet (`u4_mRM25lpOCs_129.5-134.5_ledge-pull-sheet.jpg`) | [MEASURED] medium |
| noticed front grab (enemy turned first) | contact 148.9 → punches 149.9–150.9 → victim down ~151.2–151.4 (**~2.3–2.5 s**) | s | V1 0.25 s sheet (`u4_mRM25lpOCs_148.4-152.2_noticed-grab-sheet.jpg`) | [MEASURED] medium; this is a brawl, not the silent rear takedown |
| silent rear takedown press → limp | not isolated | – | – | not measured |
| cover pull-over | not found | – | – | not measured |
| ledge-kill body | a body that lands where others can see it breaks stealth | – | Prima | [WIKI] |

---

## Compare with Cover Room and recommended changes (no code edited)

Current values: `src/ai/tuning.js` 35–46 (`ai.notice.*`), `src/hud/hud.js` 72–83 (`hud.reticle.*`) and 105–116 (`hud.awareness.*`).

| param | current | recommended | why | confidence |
|---|---|---|---|---|
| `hud.reticle.y` | 0.42 | keep 0.42 | measured 0.418 | high |
| `hud.reticle.dot` | 6 px @720p | **4.5–5** total (core 3.3 + 1 px dark outline) | measured 7 px @1080p total | high |
| dot style | – | white core, 1 px near-black outline; no glow needed | measured | high |
| `hud.reticle.ringMax` / `ringMin` | 80 / 8 [ASSUMED] | pistol aim-in arcs: **26 → 19 px @720p**, 4 arcs of ~33°, 2 px stroke; hide after ~0.35 s | V2 256.9–257.25 | medium–low |
| awareness shape | white/yellow arc ring | **diamond (kite) icon**, ~26–28 × 33 px @720p, lower point longer | V1 | high (shape), medium (size) |
| `hud.awareness.size` | 26 | 26 is right for the width; set the height to ~1.27 × width | V1 | medium |
| `hud.awareness.lift` | 0.32 m | **~0.15 m** to the diamond centre (≈0.10 m gap to its bottom) | V1 at ~1.5 m | low–medium |
| `hud.awareness.fadeIn` | 0.15 | keep (≤0.1–0.2 measured) | V1 | medium |
| `hud.awareness.fadeOut` | 0.45 | keep for drain; add an instant hide (0) when the NPC is taken down/killed | V1 149.5→149.6 | medium |
| `hud.awareness.combatPersist` | true | **false**, with `combatHold` ~1–1.5 s: show orange at the moment of full awareness, then no indicator in full combat | Prima | medium |
| `ai.notice.*` | acqNear 0.5, acqFar 3.0, confirm 0.3/1.5 | **no change yet**: nothing measured. Keep the white stage non-trivial ("not alerted immediately" agrees with Prima's white = stops and looks, and cover cancels the fill) | – | – |
| `ai.notice.instantRange/instantTime` | 2.5 m / 0.3 s | consistent with V1 (~1.5 m, yellow in ≤0.1 s) | V1 148.9 | low |
| NPC marking | – | optional yellow rim outline on tagged enemies, separate from the diamond | V1 | high (look) |

## HUD indicators

| name | value | unit | source | confidence |
|---|---|---|---|---|
| damage streaks | soft, blurred red wedges hanging down from the **top edge**, upper-centre to upper-right (~55–95% of width), ~25–35% of screen height long | – | V2 243.5–247.0 (`stealth-ref/u4_6l50qycznmY_243.5-247.0_damage-streaks-top.jpg`) | [MEASURED] medium |
| streak lifetime | still visible 3.5 s after the first sampled hit while fire continued; single-hit fade not isolated | s | V2 243.5–247.0 | [MEASURED] low |
| does the streak face the shooter | not verified (shooter positions not traced) | – | – | not measured |
| separate arrow/chevron | none seen alongside the streaks | – | V2 243.5–247.0 | [MEASURED] medium |
| low-health look | strong desaturation at the same time as the streaks | – | V2 241–262 | [MEASURED] qualitative |
| grenade warning icon | not captured (no enemy grenade in the sampled stretches) | – | – | not measured |
| off-screen awareness clamp | not captured | – | – | not measured |

## Pistol aim pose (partial)

Only U4 was sampled. In TLOU Part II (`xS9j4-TWLWs`, 62–92 s and 331–378 s) no aimed frames turned up; TLOU Part I was not reached.

| name | value | unit | source | confidence |
|---|---|---|---|---|
| gun height | at the eye / hat-brim line, just left of the head (toward the screen centre), in the over-the-shoulder view | – | V4 312.2–313.4 (`aim-ref/u4_mp__iXAuwVeMpI_312.2-313.4_pistol-aim.jpg`); V2 248.5–257.5 (`aim-ref/u4_sp_6l50qycznmY_241-263_aim-sheet.jpg`) | [MEASURED] low (MP camera very close) |
| gun arm | forearm and upper arm close to one line, roughly 150–165° at the elbow | deg | V4 312.6, 313.4 by eye | [MEASURED] low |
| two-handed | yes, the gun is held well forward of the face (more than a forearm length) | – | V4 | [MEASURED] low |
| support elbow, head cant, stance, walk-aim, recoil | not measured | – | – | – |

Current: `anim.aim.gunDist` 0.60, `gunDrop` 0.06, `gunRight` 0.03 (from the neck, `src/character/animator.js` 101/887).
Recommendation [INFERRED, low]: raise the gun and push it out. Try `gunDist` ≈ 0.66–0.70 and `gunDrop` ≈ 0.0–0.03, so the
grip lands near the eye/chin line, and keep `gunRight` ≈ 0. Pick `gunDist` so that the right shoulder → grip distance is about
0.96 × the arm's reach: that gives ~160° at the gun-arm elbow, and the support arm ends a little more bent (~145–155°). Check
this in the rig against the reference crops; it was not measured from footage.

## Not measured, and why

- White → yellow → orange fill times at several distances, drain rate and stage behaviour: no indicator-on footage of a
  gradual detection found in the time box; showcases are mostly No HUD or indicators off. Next pass: scan V1 and similar
  "aggressive stealth" PS5 videos with a white-diamond detector (the white stage did not pass a >235 RGB threshold; it may be
  translucent), or find "stealth fail" clips with HUD on.
- Off-screen clamp, through-wall behaviour, spreading, audio: not seen, or audio deliberately muted.
- Silent rear takedown and cover pull-over durations, the prompt icon: not isolated.
- Grenade warning, streak-to-shooter direction, single-hit streak fade, reticle over enemies, hit marker: not in the sampled stretches.
- TLOU Part I/II aim pose: no aimed frames found before the time box ran out.

## Sources

- Videos: see the table at the top (YouTube ids).
- Prima U4 eGuide, Basics > Combat (via search excerpts; the page returns 403): https://primagames.com/eguides/uncharted-4-a-thiefs-end-eguide/basics/combat
- Ming-Lun "Allen" Chou, U4 AI brain dump (repost): https://80.lv/articles/behind-the-scenes-ai-of-uncharted-4
- Gamer Guides U4 walkthrough (Square for takedowns, ledge pulls): https://gamerguides.com/uncharted-4-a-thiefs-end/guide/walkthrough/chapter-7-2847
