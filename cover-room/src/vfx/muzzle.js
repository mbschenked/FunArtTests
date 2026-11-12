// Muzzle flash: the muzzle-flash study's fifth pass, 5d (vfx-studies/u4-muzzle-flash.html, VERSION 9: the critic's "ready",
// Max's picks of 15 Oct), extracted as a pooled module. The sprite atlas generator, every shader, the layer emitters, the
// layouts, the schema and the four presets are COPIED from the study unchanged (cover-room must stand on its own), so with the
// 'U4 AK (base)' preset a flash is drawn as the study draws it.
//
// HOW IT IS DRAWN (full design: the study's header, kept below in the code comments)
//   A GPU-generated sprite atlas (our own gradient noise, no image files); flame sprites ADD heat into a full-resolution
//   RGBA16F buffer; two full-screen composites map the summed heat through the colour ramps (one dims the scene behind the
//   flame, one adds the colour and lowers the HDR alpha = the per-texel bloom weight, so the defined flames stay crisp);
//   glare layers (break-up glow, violet afterglow, halo, sparks) as a second instanced draw. 4 draw calls while any flash
//   is alive, 0 otherwise.
//
// CHANGES FROM THE STUDY (and why):
//   - Pool 4 -> 8 rounds and 720 / 320 -> 1200 / 560 sprite instances: every shooter's flash at once (8 asked for).
//   - Every round has its own muzzle: fire(Object3D) follows a live muzzle (local +Z down the barrel, the range's convention);
//     fire({pos, dir, obj}) follows `obj` with the muzzle at pos / dir expressed in obj's frame (any socket convention works);
//     fire({pos, dir}) stays where it was fired. The gun-attached parts (core, puff, lobes, jet) follow the live frame, the
//     parts in the air (column, break-up, glows) the frame at fire time, as in the study.
//   - weapon.size: one multiplier on every cm length (it scales the study's cm -> m factor per round), times opts.scale per
//     shot. The new 'Pistol' preset (the default here: our weapon is a pistol) is the AK base with size 0.65, every shot
//     burst-first, a rounder opening and scaled drift speeds; see the preset for the sources.
//   - The muzzle light: each round requests its light (stepped peak, plateau, off; light.ahead in front of ITS muzzle) from
//     the shared VFX light pool instead of driving the range's one muzzle light.
//   - The clock: the study's visible clock is kept (a round's first drawn frame shows age time.firstAge, 3.3 ms). The VFX
//     clock's explicit mode is the study's static mode (age = t - fire time).
//   - Panel values live in game.params under vfx.muzzle.* (preset: vfx.muzzle.preset); the study's localStorage / lil-gui /
//     copy-settings code is gone (params.js owns that). VFX randomness comes from the VFX rng, never game.rng.
//
// UNITS   metres in the world, cm in the panel; colours are sRGB hex SOURCE colours (before tone mapping) x a gain in
//   scene-referred radiance (1.0 = diffuse white, bloom starts at 1.0); light in three.js candela.
import * as THREE from 'three';
import { Pass, FullScreenQuad, FULLSCREEN_VERT } from '../core/render.js';

export function createMuzzle(game, shared) {
  const VERSION = 9;                // parameter-set version: v1 = the first pass's single-card flame, v2 = pass 2's billows, v3 = pass 3's flame licks, v4 = warm haze off, v5 = pass 4 (glowing opening flames, burst-first share, tearing, new colour stops, softer late glare; the puff chance is gone), v6 = pass 5 (the visible clock, each part on its own timing, a tall burst-first layout, flames that cool at their rims, new late-lick and torn-piece textures, re-tuned sizes and colours), v7 = pass 5b, the critic's fixes (a burst-first shot's ball sits on the muzzle and tears no pieces; a rounder puff with a violet and an orange side; a hot, opaque column base whose lowest rows cool; a warmer column glow; late licks as a broad tongue and a spiky leaf; lacier torn pieces held off the column; a cooling, shrinking left-lobe remnant; a lower left lobe), v8 = pass 5c, Max's picks (burst-first shots hold at 1x like the game pistol; the late licks show in the 4th 60 fps frame) and the critic's refinements (pointed torn pieces against the column's flank, an eroding remnant, the puff's violet fringe fading as it opens, a broad hot base mass, the column glow's hot-band share as a control) v9 = pass 5d, the critic's small fixes (the late licks fade over 0.18 of the life so the 4th 60 fps frame catches them fading, both licks on the shooter's right, crisp torn pieces drawn without the column glow) (stored older values are ignored, so they can't hide the new defaults; v6, v7 and v8 were never published)
  const POOL = 8;                   // simultaneous rounds (cover-room: 4 -> 8, every shooter's flash); oldest is recycled first
  const NRND = 16;                  // per-shot random numbers kept per round (0 burst-first or late, 1 scale, 2 roll, 3-7 lobes, 8 lean, 9 side, 10-11 seed)
  const DEG = Math.PI / 180;
  const CM0 = 0.01;
  let CM = CM0;                     // cm -> m for the round being evaluated (cover-room: CM0 x weapon.size x the shot's scale)
  const TAU = Math.PI * 2;
  const ATLAS_W = 2048, ATLAS_H = 2560;                 // 8 x 10 cells of 256 px (pass 5 added the bottom two rows)
  const CELL_BILLOW = 0, N_BILLOW = 8;                  // round billows: the hot core, the opening puff, the 02 fireball
  const CELL_LICK = 8, N_LICK = 8, LICK_FRAMES = 4;     // flame licks: 8 shapes x 4 flipbook frames (the defined flames)
  const CELL_FLECK = 40, N_FLECK = 8;                   // crisp star-shaped flecks
  const CELL_TORN = 48, N_TORN = 8;                     // torn flame pieces (the 02 jet's smoky tip)
  const CELL_CLUMP = 56, N_CLUMP = 8;                   // holed billows: the 02 orange cloud
  const CELL_LATE = 64, N_LATE = 8;                     // pass 5: late licks (the +6 break-up): ragged, forked, streaked, holed
  const CELL_SCRAP = 72, N_SCRAP = 8;                   // pass 5: torn pieces (the column's +4 / +5 flank): jagged, mottled
  const MAX_FLAME = 1200;           // flame sprite instances, all rounds together (cover-room: 720 -> 1200 for 8 rounds)
  const MAX_GLOW = 560;             // glow and spark instances (cover-room: 320 -> 560)
  const NG = 6;                     // glow types
  const GT_VIOLET = 0, GT_HAZE = 1, GT_HALO = 2, GT_GLITTER = 3, GT_SPARK_BLUE = 4, GT_SPARK_ORANGE = 5;

  // Sprite groups (the "Show only" control and the per-group counts in state()).
  const GROUPS = ['All', 'Hot core', 'Opening puff', 'Lobes', 'Sub-flames between the lobes', 'Lobe tongues', 'Forward jet',
    'Column body', 'Column tongues', 'Pale flecks', 'Orange licks', 'Sparks', 'Sparkly break-up glow', 'Violet afterglow',
    'Warm haze', 'Halo', 'Torn pieces'];
  const G_CORE = 1, G_PUFF = 2, G_LOBE = 3, G_FILL = 4, G_LTONGUE = 5, G_JET = 6, G_COL = 7, G_CTONGUE = 8, G_FLECK = 9,
    G_LICK = 10, G_SPARK = 11, G_GLITTER = 12, G_VIOLET = 13, G_HAZE = 14, G_HALO = 15, G_TEAR = 16;

  // ------------------------------------------------------------------------------------------------------------
  // Layouts: lobes in the rifle frame. [azimuth deg (0 = up, 90 = shooter's right, 180 = down, 270 = left),
  //   pitch deg from the barrel axis (0 = forward, 90 = at right angles), reach (x "Lobe length"; a lobe with pitch < 30 deg
  //   is a jet and takes "Forward jet length"), width at the base, width at the tip (x "Lobe width"; jets x "Forward jet
  //   width"), heat, base offset right, base offset up (both x "Lobe length")]. Unused slots stay empty (heat 0).
  const LAYOUTS = {
    'Two lobes (AK)': [
      // pass 4: the game's lobes are round puffs (01 +1 / +2): the left one reaches further (game 223 px left of the muzzle at
      // +2, ours was 172), the right one is a compact round mass (game 104 px right, ours was 133): wider tips, shorter reach.
      // Pass 5 takes pass 4's pick-board layout C (the critic: it keeps two round masses with a dip at the sight post) and hangs
      // the right lobe lower: it is AK 01's right-hand mass at +2 that keeps its low base and climbs into the column
      [282, 90, 0.82, 1.20, 1.38, 0.55, -0.41,  0.12],    // left lobe: a round mass out to the left over the gun; cooler (yellow)
      [ 22, 90, 0.58, 1.40, 1.33, 1.12,  0.14, -0.50],    // right lobe (the main lobe): a hot round mass from well below the muzzle line, up and right
      [  0,  6, 1.00, 0.50, 0.90, 0.80,  0.00,  0.00],    // short forward jet
      [  0,  0, 0.00, 0.00, 0.00, 0.00,  0.00,  0.00],
      [  0,  0, 0.00, 0.00, 0.00, 0.00,  0.00,  0.00],
    ],
    // pass 5, burst-first shots (AK 01's second shot, +14): the opening is one TALL flame rising up and a little right from below
    // the muzzle (252 px up, 414 px wide, height / width 0.61), a short wing to the left over the gun and a body hanging below
    'Burst tall (AK)': [
      [ 10, 90, 2.00, 1.15, 1.30, 1.15,  0.10, -0.45],    // the tall flame
      [282, 90, 0.62, 1.10, 1.25, 0.60, -0.30,  0.10],    // the short wing to the left
      [172, 90, 0.55, 1.20, 1.10, 0.80,  0.08, -0.10],    // the body hanging below the muzzle
      [  0,  6, 0.80, 0.50, 0.80, 0.70,  0.00,  0.00],    // short forward jet
      [  0,  0, 0.00, 0.00, 0.00, 0.00,  0.00,  0.00],
    ],
    'Forward jet': [
      [  0,  4, 1.00, 0.40, 1.35, 1.10,  0.00,  0.00],    // long fat jet, flaring toward its tip
      [212, 74, 0.70, 0.55, 0.85, 0.95,  0.00,  0.00],    // short wide lobe down and to the left
      [  0,  0, 0.00, 0.00, 0.00, 0.00,  0.00,  0.00],
      [  0,  0, 0.00, 0.00, 0.00, 0.00,  0.00,  0.00],
      [  0,  0, 0.00, 0.00, 0.00, 0.00,  0.00,  0.00],
    ],
    'X (four lobes)': [
      [ 22, 48, 1.00, 0.45, 0.95, 1.00,  0.00,  0.00],    // up and forward
      [158, 48, 1.00, 0.45, 0.95, 1.00,  0.00,  0.00],    // down and forward
      [  0,  2, 0.80, 0.45, 0.75, 0.90,  0.00,  0.00],    // forward
      [  0, 138, 0.45, 0.40, 0.60, 0.65,  0.00,  0.00],   // back over the optic
      [  0,  0, 0.00, 0.00, 0.00, 0.00,  0.00,  0.00],
    ],
    'Round puff': [
      [  0,  0, 0.00, 1.00, 1.00, 1.00,  0.00,  0.00],
      [  0,  0, 0.00, 0.00, 0.00, 0.00,  0.00,  0.00],
      [  0,  0, 0.00, 0.00, 0.00, 0.00,  0.00,  0.00],
      [  0,  0, 0.00, 0.00, 0.00, 0.00,  0.00,  0.00],
      [  0,  0, 0.00, 0.00, 0.00, 0.00,  0.00,  0.00],
    ],
    'Bow-tie': [
      [300, 78, 1.00, 0.30, 0.95, 1.00,  0.00,  0.00],    // up and to the left, narrow at the muzzle
      [ 96, 40, 0.90, 0.30, 0.85, 1.00,  0.00,  0.00],    // forward and right
      [  0,  0, 0.00, 0.00, 0.00, 0.00,  0.00,  0.00],
      [  0,  0, 0.00, 0.00, 0.00, 0.00,  0.00,  0.00],
      [  0,  0, 0.00, 0.00, 0.00, 0.00,  0.00,  0.00],
    ],
  };
  const LAYOUT_NAMES = Object.keys(LAYOUTS);

  // ------------------------------------------------------------------------------------------------------------
  // Panel schema. kind: n number, c colour, b toggle, s select. [key, kind, label, min, max, step] / options.
  const SCHEMA = [
    ['time', 'Timeline (fractions of the flash life)', [
      ['life', 'n', 'Flash life ms (66 = 4 frames)', 20, 300, 1],
      ['firstAge', 'n', 'First drawn frame shows age (ms)', 0, 16, 0.1],
      ['burstShare', 'n', 'Burst-first share of shots', 0, 1, 0.01],
      ['puffEnd', 'n', 'Late: puff opens into lobes by', 0.02, 0.5, 0.01],
      ['mainBirth', 'n', 'Late: main lobe (the column\'s root) from', 0, 0.6, 0.01],
      ['onsetPeak', 'n', 'Late: lobes largest at', 0.02, 0.6, 0.01],
      ['onsetEnd', 'n', 'Late: lobes gone by', 0.1, 0.95, 0.01],
      ['remnantEnd', 'n', 'Late: side-lobe remnant gone by', 0.1, 0.98, 0.01],
      ['columnStart', 'n', 'Late: column rises from', 0.0, 0.8, 0.01],
      ['columnPeak', 'n', 'Late: column tallest at', 0.05, 0.95, 0.01],
      ['columnEnd', 'n', 'Late: column gone by', 0.1, 0.98, 0.01],
      ['breakStart', 'n', 'Late: break-up starts', 0.1, 0.95, 0.01],
      ['breakEnd', 'n', 'Late: break-up ends', 0.2, 0.99, 0.01],
      ['licksStart', 'n', 'Late: orange licks appear at', 0.1, 0.95, 0.01],
      ['licksEnd', 'n', 'Late: orange licks gone by', 0.15, 0.99, 0.01],
      ['licksFade', 'n', 'Orange licks fade over (fraction of the life)', 0.01, 0.4, 0.01],
      ['afterglowStart', 'n', 'Violet afterglow rises from', 0.0, 0.95, 0.01],
      ['afterglowFull', 'n', 'Violet afterglow at full by', 0.05, 0.98, 0.01],
      ['staticFrame', 'n', 'Reduced-motion still frame at', 0.0, 0.99, 0.01],
    ]],
    // burst-first shots (the 1x pistol and SMG, AK 01's second shot): no puff, the lobes at full size in the first frame and
    // largest at once, then an earlier, smaller column; late shots (AK 01's first shot) use the "Late:" keys above
    ['burst', 'Timeline: burst-first shots', [
      ['layout', 's', 'Opening layout', LAYOUT_NAMES],
      ['onsetPeak', 'n', 'Lobes largest at', 0.0, 0.6, 0.01],
      ['onsetEnd', 'n', 'Lobes gone by', 0.05, 0.95, 0.01],
      ['startSize', 'n', 'Lobe size at birth (fraction)', 0, 1, 0.01],
      ['size', 'n', 'Opening size (x the late lobes)', 0.5, 2, 0.01],
      ['heat', 'n', 'Opening heat (x the late lobes)', 0.5, 3, 0.01],
      ['retract', 'n', 'Lobes shrink to (x)', 0, 1, 0.01],
      ['rimCool', 'n', 'Rims cool to orange (+, all its flames)', 0, 1, 0.01],
      ['columnStart', 'n', 'Column rises from', 0.0, 0.8, 0.01],
      ['columnPeak', 'n', 'Column tallest at', 0.02, 0.95, 0.01],
      ['columnEnd', 'n', 'Column gone by', 0.05, 0.98, 0.01],
      ['columnSize', 'n', 'Column size (x)', 0.2, 1.5, 0.01],
      ['columnHeight', 'n', 'Column height (x its size)', 0.2, 1.5, 0.01],
      ['columnDrop', 'n', 'Column reaches below the muzzle (cm)', -20, 40, 0.5],
      ['columnWarm', 'n', 'Column cools to orange (0..1)', 0, 1, 0.01],
      ['columnFadeFrom', 'n', 'Column breaks up from (its own; glare unchanged)', 0.05, 0.95, 0.01],
      ['tearCount', 'n', 'Torn pieces (count)', 0, 16, 1],
      ['columnHeat', 'n', 'Column heat (x)', 0.2, 1.5, 0.01],
      ['breakStart', 'n', 'Break-up starts', 0.05, 0.95, 0.01],
      ['breakEnd', 'n', 'Break-up ends', 0.1, 0.99, 0.01],
      ['licksStart', 'n', 'Orange licks appear at', 0.05, 0.95, 0.01],
      ['licksEnd', 'n', 'Orange licks gone by', 0.1, 0.99, 0.01],
    ]],
    ['onset', 'Flames: onset shapes', [
      ['on', 'b', 'Layer on'],
      ['layoutA', 's', 'Layout', LAYOUT_NAMES],
      ['layoutB', 's', 'Blend toward layout', LAYOUT_NAMES],
      ['blend', 'n', 'Blend amount', 0, 1, 0.01],
      ['lobeCount', 'n', 'Lobe count (0 = all of layout)', 0, 5, 1],
      ['lobeChance', 'n', 'Side lobe chance (% of shots)', 0, 100, 1],
      ['jetChance', 'n', 'Jet chance (% of shots)', 0, 100, 1],
      ['length', 'n', 'Lobe length, muzzle to tip (cm)', 4, 140, 1],
      ['width', 'n', 'Lobe width (cm)', 4, 120, 1],
      ['lickLength', 'n', 'Lick length (x lobe length)', 0.3, 1.8, 0.01],
      ['rootWidth', 'n', 'Lick root width (x lobe width)', 0.2, 1.6, 0.01],
      ['spread', 'n', 'Lick spread (+- deg)', 0, 80, 1],
      ['stretch', 'n', 'Stretch with age (+ x length)', 0, 2, 0.01],
      ['jetLength', 'n', 'Forward jet length (cm)', 0, 160, 1],
      ['jetWidth', 'n', 'Forward jet width (cm)', 2, 100, 1],
      ['jetTip', 'n', 'Jet tip cools to orange (0..1)', 0, 1, 0.01],
      ['raggedness', 'n', 'Raggedness (scatter, erosion)', 0, 1.5, 0.01],
      ['spritesPerLobe', 'n', 'Sprites per lobe', 1, 12, 1],
      ['fill', 'n', 'Sub-flames in the gaps (count)', 0, 32, 1],
      ['fillSize', 'n', 'Sub-flame size (x lobe width)', 0.1, 1.2, 0.01],
      ['tongues', 'n', 'Edge tongues (count)', 0, 24, 1],
      ['tongueLength', 'n', 'Tongue length (cm)', 2, 50, 0.5],
      ['heat', 'n', 'Heat (1 = calibrated)', 0, 3, 0.01],
      ['coreSize', 'n', 'Hot core at the muzzle (cm)', 0, 50, 0.5],
      ['coreHeat', 'n', 'Hot core heat', 0, 4, 0.01],
      ['startSize', 'n', 'Late: size at birth (fraction)', 0, 1, 0.01],
      ['retract', 'n', 'Late: lobes shrink to (x)', 0, 1, 0.01],
      ['remnant', 'n', 'Late: side lobes linger as a remnant (level)', 0, 1, 0.01],
      ['remnantCool', 'n', 'Late: the remnant cools to orange', 0, 1, 0.01],
      ['remnantHeat', 'n', 'Late: the remnant\'s heat (x)', 0.1, 1, 0.01],
      ['remnantErode', 'n', 'Late: the remnant erodes into holes (0..1)', 0, 1, 0.01],
      ['originAhead', 'n', 'Origin ahead of the tip (cm)', -5, 30, 0.5],
      ['boil', 'n', 'Boil (shape changes per life)', 0, 8, 0.1],
      ['rollJitter', 'n', 'Per-shot roll (+- deg)', 0, 180, 1],
      ['scaleJitter', 'n', 'Per-shot scale (+- %)', 0, 60, 1],
      ['latePuff', 'b', 'Late shots open with the puff'],
      ['puffSize', 'n', 'Puff diameter (cm)', 4, 80, 1],
      ['puffHeight', 'n', 'Puff height (x its width)', 0.5, 2.5, 0.01],
      ['puffDrop', 'n', 'Puff centre below the muzzle (cm)', -20, 40, 0.5],
      ['puffSink', 'n', 'Puff sinks by (cm, as it opens)', -20, 30, 0.5],
      ['puffTongue', 'n', 'Tongue licking up off the puff (cm)', 0, 40, 0.5],
      ['puffSprites', 'n', 'Puff sprites', 1, 12, 1],
      ['puffFringe', 'n', 'Violet fringe on the puff', 0, 1, 0.01],
      ['puffFringeShare', 'n', 'Share of the puff with the violet fringe', 0, 1, 0.01],
      ['puffFringeFade', 'n', 'Violet fringe fades as the puff opens (0..1)', 0, 1, 0.01],
      ['puffWarmFringe', 'n', 'Warm fringe on the rest of the puff', 0, 1, 0.01],
      ['puffWarmColor', 'c', 'Warm fringe colour'],
      ['puffHeat', 'n', 'Puff heat (x the lobes\' heat)', 0.3, 4, 0.01],
      ['puffRim', 'n', 'Warm rim on the puff (cools to orange)', 0, 2, 0.01],
    ]],
    ['lick', 'Flames: lick shape (every flame lick)', [
      ['taper', 'n', 'Taper (0 blunt .. 1 needle)', 0, 1, 0.01],
      ['tear', 'n', 'Tip tearing (0 .. 1 forked)', 0, 1, 0.01],
      ['detail', 'n', 'Streaks inside, along the flow', 0, 1, 0.01],
      ['tongueWidth', 'n', 'Edge tongue width (x length)', 0.2, 1.2, 0.01],
      ['flicker', 'n', 'Flicker (frames per life)', 0, 24, 0.5],
      // pass 5: the textures of the late flames (atlas rows 9 and 10), each with its own controls
      ['lateRag', 'n', 'Late licks: ragged, forked outline', 0, 1, 0.01],
      ['lateDetail', 'n', 'Late licks: streaks inside', 0, 1, 0.01],
      ['lateHoles', 'n', 'Late licks: holes', 0, 1, 0.01],
      ['lateHot', 'n', 'Late licks: hottest at (0 root .. 1 tip)', 0, 1, 0.01],
      ['lateSoft', 'n', 'Late licks: soft edge', 0, 1, 0.01],
      ['scrapPoints', 'n', 'Torn pieces: jagged points', 0, 2, 0.01],
      ['scrapDetail', 'n', 'Torn pieces: mottled inside', 0, 1, 0.01],
      ['scrapHoles', 'n', 'Torn pieces: holes', 0, 1, 0.01],
    ]],
    ['color', 'Flames: colour bands and edges', [
      ['outline', 'n', 'Outline at heat (the flame edge)', 0.02, 1.0, 0.01],
      ['hardness', 'n', 'Edge hardness (0 soft, 1 crisp)', 0, 1, 0.01],
      ['onsetSoft', 'n', 'Opening flames: edge softness', 0, 1, 0.01],
      ['onsetGlow', 'n', 'Opening flames: glow (bloom)', 0, 1, 0.005],
      ['onsetGlowBirth', 'n', 'Opening glow at birth (x)', 1, 8, 0.05],
      ['onsetGlowFade', 'n', 'Birth glow gone by (life)', 0.05, 0.8, 0.01],
      ['onsetCoreGlow', 'n', 'Opening glow: white core\'s share', 0, 1, 0.01],
      ['onsetBand', 'n', 'Opening flames: band width (x)', 0.3, 3, 0.01],
      ['bandFade', 'n', 'Fading opening: bands and edge tighten', 0, 1, 0.01],
      ['onsetRimCool', 'n', 'Opening flames: rim cools to orange', 0, 1, 0.01],
      ['columnSoft', 'n', 'Column + pieces: edge softness', 0, 1, 0.01],
      ['columnBand', 'n', 'Column + pieces: band width (x)', 0.3, 3, 0.01],
      ['bloom', 'n', 'Column + pieces: bloom', 0, 1, 0.005],
      ['columnGlow', 'n', 'Column: warm glow (its gold bands bloom)', 0, 1, 0.005],
      ['columnGlowHot', 'n', 'Column glow: hot band\'s share (0 = orange bands only)', 0, 1, 0.01],
      ['opacity', 'n', 'Flame opacity over the scene', 0, 1, 0.01],
      ['erodeFade', 'n', 'Fade by erosion (0 = dim)', 0, 1, 0.01],
      ['coreGain', 'n', 'Core intensity (x scene white)', 1, 80, 0.1],
      ['coreColor', 'c', 'Core colour'],
      ['hotGain', 'n', 'Hot band intensity', 0.5, 40, 0.1],
      ['hotColor', 'c', 'Hot band (shows #FFFFD3)'],
      ['midGain', 'n', 'Mid band intensity', 0.2, 20, 0.05],
      ['midColor', 'c', 'Mid band (shows #FFEFB2)'],
      ['edgeGain', 'n', 'Edge band intensity', 0.05, 10, 0.05],
      ['edgeColor', 'c', 'Edge band (shows #ECCC97)'],
      ['edgeAt', 'n', 'Edge band at heat', 0.02, 0.6, 0.01],
      ['midAt', 'n', 'Mid band at heat', 0.05, 1.5, 0.01],
      ['hotAt', 'n', 'Hot band at heat', 0.1, 3.0, 0.01],
      ['coreAt', 'n', 'White core from heat', 0.2, 5.0, 0.01],
      ['rim', 'n', 'Rim gradient, outline to edge', 0, 1, 0.01],
      ['tempShape', 'n', 'Sprite temperature shaping', 0, 1, 0.01],
    ]],
    ['column', 'Flames: fireball and column', [
      ['on', 'b', 'Layer on'],
      ['shape', 'n', 'Column 0 .. fireball 1', 0, 1, 0.01],
      ['width', 'n', 'Width (cm)', 8, 100, 1],
      ['height', 'n', 'Height at its tallest (cm)', 8, 160, 1],
      ['baseDrop', 'n', 'Reaches below the muzzle (cm)', -20, 40, 1],
      ['baseWidth', 'n', 'Base width (fraction of width)', 0.2, 1.2, 0.01],
      ['offsetRight', 'n', 'Offset to the shooter right (cm)', -30, 30, 0.5],
      ['sprites', 'n', 'Body licks (sprites)', 1, 24, 1],
      ['lickLength', 'n', 'Body lick length (x height)', 0.3, 1.5, 0.01],
      ['lickWidth', 'n', 'Body lick width (x width)', 0.2, 1.5, 0.01],
      ['spread', 'n', 'Lick spread (+- deg)', 0, 80, 1],
      ['stretch', 'n', 'Stretch with age (+ x length)', 0, 2, 0.01],
      ['tongues', 'n', 'Edge tongues (count)', 0, 24, 1],
      ['tongueLength', 'n', 'Tongue length (cm)', 2, 50, 0.5],
      ['startSize', 'n', 'Size when it starts (fraction)', 0.1, 1, 0.01],
      ['widthGrows', 'n', 'Width follows the growth (0 .. 1)', 0, 1, 0.01],
      ['driftForward', 'n', 'Forward drift over its life (cm)', -10, 40, 0.5],
      ['lean', 'n', 'Lean forward (deg)', -30, 60, 1],
      ['heat', 'n', 'Heat', 0, 3, 0.01],
      ['warmTint', 'n', 'Late warm shift (0..1)', 0, 1, 0.01],
      ['rimCoolStart', 'n', 'Rim and tips cool to orange: at its start', 0, 1, 0.01],
      ['rimCool', 'n', 'Rim and tips cool to orange: at its end', 0, 1, 0.01],
      ['baseCool', 'n', 'Base below the muzzle cools: at its start', 0, 1, 0.01],
      ['baseCoolEnd', 'n', 'Base below the muzzle cools: at its end', 0, 1, 0.01],
      ['baseCoolReach', 'n', 'Base cooling reaches up (x lick length)', 0.02, 0.6, 0.01],
      ['baseMass', 'n', 'Base: broad hot mass (sprites)', 0, 6, 1],
      ['baseMassSize', 'n', 'Base mass size (x width)', 0.2, 1.5, 0.01],
      ['flecks', 'n', 'Pale flecks thrown off (count)', 0, 20, 1],
      ['fleckSize', 'n', 'Fleck size (cm)', 1, 20, 0.5],
      ['fleckHeat', 'n', 'Fleck heat (0.5 = pale yellow)', 0, 2, 0.01],
    ]],
    // the game's +4 / +5: the column's right and lower side tears into hot white-yellow pieces that drift off and cool to orange
    ['tear', 'Flames: tearing (the column breaks up)', [
      ['on', 'b', 'Layer on'],
      ['count', 'n', 'Pieces torn off (count)', 0, 16, 1],
      ['size', 'n', 'Piece size (cm)', 2, 30, 0.5],
      ['start', 'n', 'Starts (fraction of column life)', 0, 1, 0.01],
      ['stagger', 'n', 'Next piece after (fraction of column)', 0, 0.6, 0.01],
      ['goneBy', 'n', 'Gone by (fraction of column life)', 0.2, 1.5, 0.01],
      ['coolBy', 'n', 'Orange by (fraction of column)', 0.1, 2, 0.01],
      ['heat', 'n', 'Heat (1 = white-yellow centre)', 0, 3, 0.01],
      ['drift', 'n', 'Drift outward (m/s)', 0, 15, 0.1],
      ['around', 'n', 'Around the column (0 right side)', 0, 1, 0.01],
      ['gap', 'n', 'Gap from the column\'s flank (cm)', 0, 30, 0.5],
      ['crisp', 'n', 'Crisp edge: no column glow on them (0..1)', 0, 1, 0.01],
      ['holes', 'n', 'Holes eaten into the column', 0, 1, 0.01],
    ]],
    ['breakup', 'Flames: break-up (clumps, licks, sparks)', [
      ['on', 'b', 'Layer on'],
      ['erosion', 'n', 'Erosion into clumps', 0, 1, 0.01],
      ['softness', 'n', 'Clump erosion edge softness', 0.02, 0.8, 0.01],
      ['softEdge', 'n', 'Cooled parts softer (0..1)', 0, 1, 0.01],
      ['expand', 'n', 'Size change during break-up (%)', -60, 150, 1],
      ['drift', 'n', 'Clumps drift forward (m/s)', -2, 10, 0.05],
      ['rise', 'n', 'Clumps drift up (m/s)', -2, 6, 0.05],
      ['coolColor', 'c', 'Cooled dim (#DD926D)'],
      ['coolGain', 'n', 'Cooled intensity, dim', 0, 6, 0.05],
      ['lickColor', 'c', 'Cooled bright (#F9A45B)'],
      ['lickGain', 'n', 'Cooled intensity, bright', 0, 8, 0.05],
      ['peachColor', 'c', 'Cooled hottest (#FEC492)'],
      ['peachGain', 'n', 'Cooled intensity, hottest', 0, 12, 0.05],
      ['licks', 'n', 'Detached orange licks (count)', 0, 16, 1],
      ['lickSize', 'n', 'Lick size (cm)', 1, 30, 0.5],
      ['lickRight', 'n', 'Licks to the shooter\'s right (share)', 0, 1, 0.01],
      ['lickReach', 'n', 'Lick distance (cm)', 0, 80, 1],
      ['lickDrift', 'n', 'Lick drift, forward and up (m/s)', 0, 8, 0.1],
      ['lickHeat', 'n', 'Lick heat', 0, 2, 0.01],
      ['sparks', 'n', 'Sparks (count)', 0, 64, 1],
      ['sparkSpeed', 'n', 'Spark speed (m/s)', 0, 30, 0.1],
      ['sparkLength', 'n', 'Spark streak (ms of motion)', 0, 10, 0.1],
      ['sparkColor', 'c', 'Spark colour (blue-white)'],
      ['sparkGain', 'n', 'Spark intensity', 0, 60, 0.5],
      ['sparkOrange', 'n', 'Share of orange sparks', 0, 1, 0.01],
    ]],
    ['glitter', 'Glare: sparkly blue-white break-up glow', [
      ['on', 'b', 'Layer on'],
      ['color', 'c', 'Colour (blue-white)'],
      ['gain', 'n', 'Intensity', 0, 10, 0.05],
      ['core', 'n', 'Hot core (x the body)', 0, 10, 0.05],
      ['length', 'n', 'Length along the barrel (cm)', 2, 120, 1],
      ['width', 'n', 'Width (cm)', 2, 80, 1],
      ['ahead', 'n', 'Starts ahead of muzzle (cm)', -10, 40, 0.5],
      ['pieces', 'n', 'Pieces (1 = one smooth)', 1, 8, 1],
      ['stretch', 'n', 'Screen stretch along barrel', 1, 4, 0.05],
      ['twinkle', 'n', 'Twinkle (0 steady .. 1)', 0, 1, 0.01],
      ['grain', 'n', 'Sparkle grain', 0, 2, 0.01],
    ]],
    ['violet', 'Glare: violet afterglow', [
      ['on', 'b', 'Layer on'],
      ['intensity', 'n', 'Intensity (master)', 0, 4, 0.01],
      ['centerColor', 'c', 'Centre colour'],
      ['coreGain', 'n', 'Centre intensity', 0, 8, 0.05],
      ['bodyColor', 'c', 'Body colour'],
      ['bodyGain', 'n', 'Body intensity', 0, 4, 0.02],
      ['rimColor', 'c', 'Skirt colour (bluish)'],
      ['skirtGain', 'n', 'Skirt intensity', 0, 2, 0.01],
      ['ahead', 'n', 'Centre ahead of the muzzle (cm)', -10, 40, 0.5],
      ['width', 'n', 'Width (cm)', 4, 80, 1],
      ['height', 'n', 'Height (cm)', 4, 100, 1],
      ['skirt', 'n', 'Skirt reach', 0, 1, 0.01],
      ['startLevel', 'n', 'Level at birth (fraction)', 0, 1, 0.01],
    ]],
    ['haze', 'Glare: warm haze', [
      ['on', 'b', 'Layer on'],
      ['intensity', 'n', 'Intensity', 0, 4, 0.01],
      ['color', 'c', 'Colour'],
      ['width', 'n', 'Width (cm)', 10, 400, 1],
      ['height', 'n', 'Height (cm)', 10, 400, 1],
      ['offRight', 'n', 'Offset to the shooter right (cm)', -150, 150, 1],
      ['offUp', 'n', 'Offset up (cm)', -150, 150, 1],
      ['offBack', 'n', 'Offset back (cm)', -150, 150, 1],
      ['skirt', 'n', 'Soft skirt (x core)', 0, 1, 0.01],
      ['skirtSize', 'n', 'Skirt size (x core size)', 1, 8, 0.1],
      ['start', 'n', 'Level at birth (fraction)', 0, 1, 0.01],
      ['late', 'n', 'Level at the end (fraction)', 0, 1, 0.01],
    ]],
    ['light', 'Muzzle light', [
      ['on', 'b', 'Layer on'],
      ['peak', 'n', 'Peak (candela)', 0, 2000, 1],
      ['plateau', 'n', 'Plateau (% of peak)', 0, 100, 1],
      ['peakColor', 'c', 'Peak colour'],
      ['plateauColor', 'c', 'Plateau colour'],
      ['peakEnd', 'n', 'Peak ends at (fraction of life)', 0.02, 0.9, 0.01],
      ['plateauEnd', 'n', 'Light off from', 0.05, 0.99, 0.01],
      ['ahead', 'n', 'Distance ahead of the tip (cm)', 35, 120, 1],
      ['reach', 'n', 'Reach (m, 0 = unlimited)', 0, 30, 0.5],
    ]],
    ['halo', 'Glare: halo around the flame', [
      ['on', 'b', 'Layer on'],
      ['intensity', 'n', 'Intensity', 0, 4, 0.01],
      ['color', 'c', 'Colour'],
      ['size', 'n', 'Size (cm)', 10, 400, 1],
      ['follow', 'n', 'Follows the column (0..1)', 0, 1, 0.01],
    ]],
    // cover-room: one size for the whole flash (it scales every cm length; the pistol preset sets 0.65 of the AK)
    ['weapon', 'Weapon', [
      ['size', 'n', 'Flash size (x the AK; pistol 0.65)', 0.2, 2.5, 0.01],
    ]],
    ['sprites', 'Sprite textures and debug', [
      ['seed', 'n', 'Texture seed', 0, 99, 1],
      ['lumps', 'n', 'Billow lumpiness', 0, 1, 0.01],
      ['grain', 'n', 'Edge grain', 0, 1, 0.01],
      ['crisp', 'n', 'Fleck edge crispness', 0, 1, 0.01],
      ['detail', 'n', 'Sharp detail on the silhouettes', 0, 1, 0.01],
      ['lateSharp', 'n', 'Late licks + torn pieces: sharper (mip levels)', 0, 2, 0.05],
      ['soft', 'n', 'Soft contact with geometry (cm)', 0.5, 30, 0.5],
      ['solo', 's', 'Show only', GROUPS],
      ['outlines', 'b', 'Show sprite outlines'],
      ['atlas', 'b', 'Show the sprite atlas'],
      ['heatView', 'b', 'Show heat (grey = heat / 8)'],
    ]],
  ];

  // ------------------------------------------------------------------------------------------------------------
  // Presets: plain data, flat "group.key" -> value. BASE is the calibrated AK (moment 01). The others are BASE with
  // parameters changed and nothing else, so each is listed as BASE plus a short diff.
  const BASE = {
    // pass 5: each part on its own timing, overlapping (Max, 12 Oct; AK 01 shot 1 measured tile by tile): the puff +0..+1, the
    // left (side) lobe +1..+3 lingering as a remnant to +5, the right (main) lobe from +2 flowing into the column +3..+5, the torn
    // pieces +4..+5, two orange licks at +6 only. Tile +k is at (k + 0.5) / 10 of the life.
    'time.life': 66, 'time.firstAge': 3.3, 'time.burstShare': 0.5, 'time.puffEnd': 0.18, 'time.mainBirth': 0.19, 'time.onsetPeak': 0.26,
    'time.onsetEnd': 0.4, 'time.remnantEnd': 0.6, 'time.columnStart': 0.26,
    'time.columnPeak': 0.57, 'time.columnEnd': 0.63, 'time.breakStart': 0.54, 'time.breakEnd': 0.76, 'time.licksStart': 0.6, 'time.licksEnd': 0.9, 'time.licksFade': 0.18,
    'time.afterglowStart': 0.6, 'time.afterglowFull': 0.8, 'time.staticFrame': 0.24,
    // burst-first (AK 01's second shot, +14 / +15): with the visible clock every shot's first frame shows the same age, so the
    // opening no longer has to hold through the first frame: it opens game-sized and TALL ("Burst tall (AK)"), then collapses
    // into a smaller ball one tile later (the game keeps 55 % of the area)
    'burst.layout': 'Burst tall (AK)',
    'burst.onsetPeak': 0.02, 'burst.onsetEnd': 0.22, 'burst.startSize': 1, 'burst.size': 1.08, 'burst.heat': 0.85, 'burst.retract': 0.25, 'burst.rimCool': 1.0,
    'burst.columnStart': 0.03, 'burst.columnPeak': 0.14, 'burst.columnEnd': 0.62, 'burst.columnSize': 1.55, 'burst.columnHeight': 0.26, 'burst.columnDrop': 16, 'burst.columnWarm': 0.45, 'burst.columnFadeFrom': 0.44, 'burst.tearCount': 0, 'burst.columnHeat': 0.75,
    'burst.breakStart': 0.6, 'burst.breakEnd': 0.82, 'burst.licksStart': 0.62, 'burst.licksEnd': 0.9,

    'onset.on': true, 'onset.layoutA': 'Two lobes (AK)', 'onset.layoutB': 'Round puff', 'onset.blend': 0,
    'onset.lobeCount': 0, 'onset.lobeChance': 100, 'onset.jetChance': 100, 'onset.length': 24, 'onset.width': 24,
    'onset.lickLength': 1.0, 'onset.rootWidth': 0.9, 'onset.spread': 8, 'onset.stretch': 0.15,
    'onset.jetLength': 16, 'onset.jetWidth': 10, 'onset.jetTip': 0.2,
    // density A (Max, 12 Oct): fill 6, lobe tongues 4, 3 sprites per lobe; column tongues 6 and flecks 3 below
    'onset.raggedness': 0.85, 'onset.spritesPerLobe': 3, 'onset.fill': 6, 'onset.fillSize': 0.3, 'onset.tongues': 4,
    'onset.tongueLength': 7, 'onset.heat': 0.95, 'onset.coreSize': 14, 'onset.coreHeat': 1.2,
    'onset.startSize': 0.55, 'onset.retract': 0.5, 'onset.remnant': 0.45, 'onset.remnantCool': 1, 'onset.remnantHeat': 0.55, 'onset.remnantErode': 0.2, 'onset.originAhead': 3, 'onset.boil': 2,
    'onset.rollJitter': 14, 'onset.scaleJitter': 18, 'onset.latePuff': true, 'onset.puffSize': 62, 'onset.puffHeight': 1.05, 'onset.puffDrop': 3, 'onset.puffSink': 7, 'onset.puffTongue': 6,
    'onset.puffSprites': 6, 'onset.puffFringe': 1, 'onset.puffFringeShare': 0.5, 'onset.puffFringeFade': 0.7, 'onset.puffWarmFringe': 1, 'onset.puffWarmColor': '#ff6444', 'onset.puffHeat': 1.1, 'onset.puffRim': 0.7,

    'lick.taper': 0.25, 'lick.tear': 0.8, 'lick.detail': 0.6, 'lick.tongueWidth': 0.6, 'lick.flicker': 6,
    'lick.lateRag': 0.5, 'lick.lateDetail': 1.0, 'lick.lateHoles': 0.5, 'lick.lateHot': 0.7, 'lick.lateSoft': 0.65,
    'lick.scrapPoints': 1.4, 'lick.scrapDetail': 1.0, 'lick.scrapHoles': 0.3,

    'color.outline': 0.12, 'color.hardness': 0.85, 'color.onsetSoft': 1, 'color.onsetGlow': 0.045, 'color.onsetGlowBirth': 2.5,
    'color.onsetGlowFade': 0.27, 'color.onsetCoreGlow': 0.3, 'color.onsetBand': 1.25, 'color.bandFade': 0.8, 'color.onsetRimCool': 0.3,
    'color.columnBand': 0.85, 'color.columnSoft': 0, 'color.bloom': 0.015, 'color.columnGlow': 0.12, 'color.columnGlowHot': 1, 'color.opacity': 0.8, 'color.erodeFade': 0.8,
    'color.coreGain': 20, 'color.coreColor': '#ffeac0', 'color.hotGain': 6, 'color.hotColor': '#ffec58',
    'color.midGain': 3.7, 'color.midColor': '#ff7044', 'color.edgeGain': 2.0, 'color.edgeColor': '#ff7850',
    'color.edgeAt': 0.22, 'color.midAt': 0.42, 'color.hotAt': 0.68, 'color.coreAt': 0.95, 'color.rim': 0.5, 'color.tempShape': 0.8,

    // pass 5: the tall flame hangs lower and is longer (AK 01: its base 120-126 px below the muzzle from +1 to +5, base to tip
    // 281 / 327 / 370 px at +3 / +4 / +5), white in the middle with rims, tips and base cooling to gold and orange
    'column.on': true, 'column.shape': 0, 'column.width': 38, 'column.height': 70, 'column.baseDrop': 23, 'column.baseWidth': 0.4,
    'column.offsetRight': 0, 'column.sprites': 6, 'column.lickLength': 0.9, 'column.lickWidth': 0.6, 'column.spread': 16, 'column.stretch': 0.4,
    'column.tongues': 4, 'column.tongueLength': 8,
    'column.startSize': 0.75, 'column.widthGrows': 0.3, 'column.driftForward': 6, 'column.lean': 4, 'column.heat': 0.5, 'column.warmTint': 0.5,
    'column.rimCoolStart': 0.25, 'column.rimCool': 0.5, 'column.baseCool': 1.0, 'column.baseCoolEnd': 0.55, 'column.baseCoolReach': 0.16, 'column.baseMass': 3, 'column.baseMassSize': 0.62,
    'column.flecks': 0, 'column.fleckSize': 7, 'column.fleckHeat': 0.55,

    // pass 5: one big piece tears off the lower right flank at +4, a second smaller one at +5, both gone by +6 (AK 01)
    'tear.on': true, 'tear.count': 2, 'tear.size': 24, 'tear.start': 0.38, 'tear.stagger': 0.2, 'tear.goneBy': 0.95, 'tear.coolBy': 1.4,
    'tear.heat': 0.88, 'tear.drift': 4, 'tear.around': 0.12, 'tear.gap': 2, 'tear.crisp': 1, 'tear.holes': 0.8,

    'breakup.on': true, 'breakup.erosion': 0.75, 'breakup.softness': 0.25, 'breakup.softEdge': 0.4, 'breakup.expand': -25, 'breakup.drift': 1.0, 'breakup.rise': 0.6,
    'breakup.coolColor': '#ff8a60', 'breakup.coolGain': 0.4, 'breakup.lickColor': '#ff7a48', 'breakup.lickGain': 0.7,
    'breakup.peachColor': '#ff8a4a', 'breakup.peachGain': 1.0,
    'breakup.licks': 2, 'breakup.lickSize': 10.5, 'breakup.lickRight': 1, 'breakup.lickReach': 24, 'breakup.lickDrift': 1.6, 'breakup.lickHeat': 1.1,
    'breakup.sparks': 12, 'breakup.sparkSpeed': 5, 'breakup.sparkLength': 1.2, 'breakup.sparkColor': '#dfe7ff', 'breakup.sparkGain': 6,
    'breakup.sparkOrange': 0.3,

    'glitter.on': true, 'glitter.color': '#ececff', 'glitter.gain': 3, 'glitter.core': 4.5, 'glitter.length': 30, 'glitter.width': 11, 'glitter.ahead': 4,
    'glitter.pieces': 4, 'glitter.stretch': 1.8, 'glitter.twinkle': 0.6, 'glitter.grain': 0.3,

    'violet.on': true, 'violet.intensity': 1.0, 'violet.centerColor': '#ece4ff', 'violet.coreGain': 2.4, 'violet.bodyColor': '#cfc0f0', 'violet.bodyGain': 0.6,
    'violet.rimColor': '#8fa0e8', 'violet.skirtGain': 0.05, 'violet.ahead': 9, 'violet.width': 20, 'violet.height': 30, 'violet.skirt': 0.15, 'violet.startLevel': 0.03,

    // Max, 12 Oct: "the little hazy lens flare ... try removing that" = this up-left warm glow; off by default, control kept
    'haze.on': false, 'haze.intensity': 2.4, 'haze.color': '#ffb359', 'haze.width': 34, 'haze.height': 38,
    'haze.offRight': -26.5, 'haze.offUp': 29, 'haze.offBack': 0, 'haze.skirt': 0.10, 'haze.skirtSize': 2.6, 'haze.start': 0.85, 'haze.late': 0.75,

    'light.on': true, 'light.peak': 32, 'light.plateau': 30, 'light.peakColor': '#ffba5a', 'light.plateauColor': '#ffb26a',
    'light.peakEnd': 0.25, 'light.plateauEnd': 0.5, 'light.ahead': 45, 'light.reach': 8,

    // pass 4: a wide, faint cream glow around the flame (the game's column sits in one), centred on the flame's origin
    'halo.on': true, 'halo.intensity': 0.5, 'halo.color': '#ffc890', 'halo.size': 80, 'halo.follow': 0,

    'weapon.size': 1,
    'sprites.seed': 7, 'sprites.lumps': 0.6, 'sprites.grain': 0.6, 'sprites.crisp': 0.7, 'sprites.detail': 0.35, 'sprites.lateSharp': 1.5, 'sprites.soft': 6,
    'sprites.solo': 'All', 'sprites.outlines': false, 'sprites.atlas': false, 'sprites.heatView': false,
  };
  const PRESETS = {
    'U4 AK (base)': BASE,
    // 02 (rifle in a dark pier): a long forward jet plus a lobe down-left in the first frame, a compact round fireball that
    // holds, then a billowing orange cloud, then the violet glow alone. Changes from the AK: layout, sizes, timing, the
    // fireball shape, a growing soft break-up; the jet is three long, narrow, blunt-tipped licks (one continuous tongue).
    'Rifle jet (02)': Object.assign({}, BASE, {
      'time.burstShare': 1, 'burst.layout': 'Forward jet',
      'burst.onsetPeak': 0.04, 'burst.onsetEnd': 0.18, 'burst.startSize': 0.85, 'burst.size': 1, 'burst.heat': 1,
      'burst.retract': 0.3,
      'burst.columnStart': 0.08, 'burst.columnPeak': 0.32, 'burst.columnEnd': 0.74, 'burst.columnSize': 1, 'burst.columnHeight': 1, 'burst.columnHeat': 1,
      'burst.columnDrop': 0, 'burst.tearCount': 2, 'tear.gap': 0,
      'burst.breakStart': 0.46, 'burst.breakEnd': 0.72, 'time.afterglowFull': 0.76,
      'onset.layoutA': 'Forward jet', 'onset.length': 34, 'onset.width': 34, 'onset.jetLength': 90, 'onset.jetWidth': 28, 'onset.jetTip': 0.5,
      'onset.spritesPerLobe': 3, 'onset.rootWidth': 1.5, 'onset.spread': 12, 'onset.heat': 1.25, 'onset.fill': 8, 'lick.taper': 0,
      'onset.rollJitter': 6, 'onset.tongues': 4,
      'column.shape': 1, 'column.widthGrows': 1, 'column.baseMass': 0, 'column.width': 34, 'column.baseDrop': 0, 'column.baseWidth': 0.75, 'column.offsetRight': 0, 'column.lean': 0, 'column.driftForward': 14,
      'column.tongues': 4, 'column.tongueLength': 6, 'column.flecks': 0, 'column.warmTint': 0.7,
      'breakup.expand': 45, 'breakup.erosion': 0.55, 'breakup.softness': 0.45, 'breakup.licks': 0, 'breakup.drift': 5, 'breakup.rise': 0.2,
      'breakup.softEdge': 0.9, 'glitter.gain': 1,
      'violet.width': 24, 'violet.height': 30, 'violet.ahead': 6,
      'haze.intensity': 0.35, 'haze.offRight': 0, 'haze.offUp': 20, 'haze.offBack': 40, 'haze.width': 40, 'haze.height': 36,
    }),
    // 03 (night jungle, close camera): a round ball first, then the X of four lobes at its largest, a plateau of ragged
    // flame with a crown, detached licks, the violet glow; a yellow flood over the whole scene. Changes from the AK:
    // layout, a certain puff, timing, bigger haze and halo.
    'X flash (03)': Object.assign({}, BASE, {
      'time.puffEnd': 0.10, 'time.onsetPeak': 0.17, 'time.onsetEnd': 0.34, 'time.columnStart': 0.14, 'time.columnPeak': 0.36,
      'time.columnEnd': 0.62, 'time.breakStart': 0.52, 'time.breakEnd': 0.72, 'time.afterglowFull': 0.74,
      'time.mainBirth': 0.05, 'onset.remnant': 0, 'time.licksStart': 0.5, 'time.licksEnd': 0.74,     // the X opens as one, no remnant
      'onset.puffHeight': 1, 'onset.puffDrop': 0, 'onset.puffSink': 0, 'onset.puffTongue': 0,         // 03 opens with a round ball (pass 5 keeps it)
      'tear.size': 12, 'tear.gap': 0, 'tear.count': 1,
      'onset.layoutA': 'X (four lobes)', 'onset.length': 46, 'onset.width': 36, 'onset.jetLength': 54, 'onset.jetWidth': 28,
      'time.burstShare': 0, 'onset.puffSize': 50, 'onset.puffFringe': 0.6, 'onset.rollJitter': 10, 'onset.tongues': 10,
      'onset.spritesPerLobe': 8, 'onset.fill': 8, 'color.coreColor': '#fff2a0', 'color.coreAt': 1.3,
      'column.shape': 0.7, 'column.widthGrows': 1, 'column.baseMass': 0, 'column.width': 36, 'column.height': 40, 'column.baseDrop': 8, 'column.baseWidth': 0.75, 'column.lean': 20, 'column.driftForward': 12,
      'column.tongues': 8, 'column.tongueLength': 10, 'column.flecks': 2,
      'breakup.expand': 10, 'breakup.erosion': 0.8, 'breakup.licks': 3, 'breakup.lickRight': 0.8, 'breakup.lickSize': 15, 'breakup.lickReach': 22, 'breakup.lickHeat': 1.4,
      'glitter.gain': 1,
      'violet.width': 26, 'violet.height': 30, 'violet.ahead': 6,
      'haze.intensity': 1.2, 'haze.color': '#d6b050', 'haze.width': 70, 'haze.height': 64, 'haze.offRight': 0, 'haze.late': 0.2,
      'haze.offUp': 0, 'haze.offBack': 0, 'haze.skirt': 0.25,
      'light.peak': 22,
      'halo.intensity': 0.4, 'halo.color': '#ffc040', 'halo.size': 160,
    }),
    // Cinematic (our own take, no reference): longer, hotter, bigger, more broken up, with a long forward jet blended into
    // the AK lobes, more licks and sparks.
    'Cinematic': Object.assign({}, BASE, {
      'time.life': 90, 'time.onsetPeak': 0.22, 'time.onsetEnd': 0.46,
      'time.mainBirth': 0, 'onset.remnant': 0, 'time.licksStart': 0.5, 'time.licksEnd': 0.8,
      'onset.layoutB': 'Forward jet', 'onset.blend': 0.4, 'onset.length': 30, 'onset.width': 30, 'onset.jetLength': 46, 'onset.jetWidth': 26,
      'onset.raggedness': 1.0, 'time.burstShare': 0, 'onset.latePuff': false, 'onset.startSize': 0.7, 'onset.fill': 20, 'onset.tongues': 14, 'onset.tongueLength': 16,
      'color.coreGain': 32, 'color.bloom': 0.1, 'color.hardness': 0.95,
      'column.width': 52, 'column.height': 84, 'column.driftForward': 14, 'column.tongues': 18, 'column.flecks': 12,
      'breakup.erosion': 0.85, 'breakup.licks': 3, 'breakup.lickRight': 0.8, 'breakup.lickSize': 16, 'breakup.lickReach': 34, 'breakup.sparks': 40, 'breakup.sparkSpeed': 8,
      'violet.intensity': 1.3, 'violet.width': 36, 'violet.height': 46,
      'haze.intensity': 2.8, 'haze.width': 44, 'haze.height': 50,
      'light.peak': 48, 'light.plateau': 40, 'light.reach': 12,
      'halo.intensity': 0.3, 'halo.size': 150,
    }),
    // cover-room: the game's PISTOL at 1x (muzzle-flash-spec.md sections 10-12; our weapon is a pistol, the studies were tuned
    // on the AK). [MEASURED] = a spec measurement, [INFERRED] = derived from them.
    'Pistol': Object.assign({}, BASE, {
      // every 1x pistol shot is biggest in its first frame (5 of 5) [MEASURED s10, s11], so all shots are burst-first; pass 5c
      // tuned those to hold like the pistol: 100 / 54 / 31 / 8 % of the frame-0 area (game pistol 100 / 52 / 29 / 23) [MEASURED]
      'time.burstShare': 1,
      // 4 lit 60 fps frames (67 ms), then a hard cut [MEASURED s10]: the AK's 66 ms life, unchanged
      'time.life': 66,
      // size: the pistol's frame-0 clipped area is a disc 19 % of the frame height [MEASURED s12]; the AK's is ~22 % (its blob is
      // 25-33 % of the height [MEASURED layer stack], 45 % of it clipped [MEASURED symptom table, pass 3 log]) and the pistol's muzzle sits ~0.4 m nearer the
      // over-the-shoulder camera (x1.25 on screen), so 0.85 / 1.3 = ~0.65 of the AK's world size [INFERRED]
      'weapon.size': 0.65,
      // "smaller and rounder than the rifle lobes" [MEASURED s12]: the tall burst opening blended a third of the way toward a
      // round puff [INFERRED]
      'onset.layoutB': 'Round puff', 'onset.blend': 0.35,
      // drift speeds (m/s) scaled with the size, so torn pieces, licks and sparks travel the same distance relative to the
      // flame [INFERRED]
      'tear.drift': 2.6, 'breakup.drift': 0.65, 'breakup.rise': 0.4, 'breakup.lickDrift': 1.05, 'breakup.sparkSpeed': 3.25,
      // fewer sparks for the smaller charge [INFERRED]; the light keeps the AK's 32 cd: the 1x SMG's frame 0 lifts a sunlit hand
      // from #5A5044 to #AD9C82 [MEASURED s6], as strong as the rifles'
      'breakup.sparks': 8,
    }),
  };
  const PRESET_NAMES = Object.keys(PRESETS);
  const PRESET_ALIASES = { base: 'U4 AK (base)', ak: 'U4 AK (base)', '01': 'U4 AK (base)', '02': 'Rifle jet (02)', jet: 'Rifle jet (02)',
    rifle: 'Rifle jet (02)', '03': 'X flash (03)', x: 'X flash (03)', cine: 'Cinematic', cinematic: 'Cinematic' };
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  function findPreset(name) {
    if (!name) return null;
    if (Object.prototype.hasOwnProperty.call(PRESETS, name)) return name;
    const s = slug(name);
    for (const k of PRESET_NAMES) if (slug(k) === s) return k;
    for (const k of Object.keys(PRESET_ALIASES)) if (slug(k) === s) return PRESET_ALIASES[k];
    return null;
  }

  // flat schema index: key -> [key, kind, label, min, max, step | options]
  const INDEX = {};
  for (const [gid, , items] of SCHEMA) for (const it of items) INDEX[gid + '.' + it[0]] = it;
  const KEYS = Object.keys(INDEX);
  for (const k of KEYS) if (!(k in BASE)) throw new Error('preset BASE misses ' + k);
  for (const k of Object.keys(BASE)) if (!(k in INDEX)) throw new Error('schema misses ' + k);
  const TEXTURE_KEYS = ['sprites.seed', 'sprites.lumps', 'sprites.grain', 'sprites.crisp', 'lick.taper', 'lick.tear', 'lick.detail',
    'lick.lateRag', 'lick.lateDetail', 'lick.lateHoles', 'lick.lateHot', 'lick.lateSoft', 'lick.scrapPoints', 'lick.scrapDetail', 'lick.scrapHoles'];

  function sanitize(key, v) {
    const it = INDEX[key];
    if (!it) return undefined;
    const kind = it[1];
    if (kind === 'n') { v = Number(v); return Number.isFinite(v) ? Math.min(Math.max(v, it[3]), it[4]) : undefined; }
    if (kind === 'b') return v === true || v === 1 || v === '1' || v === 'true' ? true : (v === false || v === 0 || v === '0' || v === 'false' ? false : undefined);
    if (kind === 'c') return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined;
    if (kind === 's') { if (it[3].indexOf(v) >= 0) return v; for (const o of it[3]) if (slug(o) === slug(v)) return o; return undefined; }
    return undefined;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Shaders
  // Atlas generator. Writes the whole 8 x 8 atlas in one full-screen pass. Uniforms (all unitless):
  //   uSeed   texture seed (0..99)                    uLumps  billow outline warp (0..1)
  //   uGrain  fine grain on the edges (0..1)          uCrisp  fleck edge crispness (0 soft .. 1 hard)
  //   uTaper  lick taper (0 blunt, rounded tip .. 1 long needle-like taper)
  //   uTear   lick tip tearing (0 one clean tip .. 1 forked into two or three tongues, holed near the end)
  //   uLickDetail  streaks inside the licks along the flow (0 smooth .. 1 strong)
  //   pass 5, the late licks (cells 64-71): uLateRag ragged, forked outline (0 a plain tongue .. 1 frayed, two branches),
  //   uLateDetail streaks inside, uLateHoles small holes through the body, uLateHot where it is hottest along its length
  //   (0 root .. 1 tip), uLateSoft the width of its soft edge; the torn pieces (cells 72-79): uScrapPoints jagged points,
  //   uScrapDetail mottling inside (hot white patches, cream between), uScrapHoles holes. All 0..1.
  // Output per texel: R = density (coverage, 0..1), G = erosion order (low dissolves first), B = temperature (0..1).
  // Cell space p is -1..1 with +y = the sprite's long axis ("up": a lick's tip). Cells (8 x 10 of 256 px): 0-7 billows, 8-39
  // licks (8 shapes x 4 flipbook frames), 40-47 star flecks, 48-55 torn break-up pieces, 56-63 holed clumps, 64-71 late licks,
  // 72-79 torn pieces of the column (pass 5).
  const GEN_FRAG = /* glsl */`
    precision highp float;
    uniform float uSeed;
    uniform float uLumps;
    uniform float uGrain;
    uniform float uCrisp;
    uniform float uTaper;
    uniform float uTear;
    uniform float uLickDetail;
    uniform float uLateRag;
    uniform float uLateDetail;
    uniform float uLateHoles;
    uniform float uLateHot;
    uniform float uLateSoft;
    uniform float uScrapPoints;
    uniform float uScrapDetail;
    uniform float uScrapHoles;
    varying vec2 vUv;
    vec3 hash33(vec3 p3) {
      p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
      p3 += dot(p3, p3.yxz + 33.33);
      return fract((p3.xxy + p3.yxx) * p3.zyx);
    }
    // gradient noise, about -1..1
    float gn(vec3 p) {
      vec3 i = floor(p), f = fract(p);
      vec3 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
      float n000 = dot(hash33(i) * 2.0 - 1.0, f);
      float n100 = dot(hash33(i + vec3(1.0, 0.0, 0.0)) * 2.0 - 1.0, f - vec3(1.0, 0.0, 0.0));
      float n010 = dot(hash33(i + vec3(0.0, 1.0, 0.0)) * 2.0 - 1.0, f - vec3(0.0, 1.0, 0.0));
      float n110 = dot(hash33(i + vec3(1.0, 1.0, 0.0)) * 2.0 - 1.0, f - vec3(1.0, 1.0, 0.0));
      float n001 = dot(hash33(i + vec3(0.0, 0.0, 1.0)) * 2.0 - 1.0, f - vec3(0.0, 0.0, 1.0));
      float n101 = dot(hash33(i + vec3(1.0, 0.0, 1.0)) * 2.0 - 1.0, f - vec3(1.0, 0.0, 1.0));
      float n011 = dot(hash33(i + vec3(0.0, 1.0, 1.0)) * 2.0 - 1.0, f - vec3(0.0, 1.0, 1.0));
      float n111 = dot(hash33(i + vec3(1.0, 1.0, 1.0)) * 2.0 - 1.0, f - vec3(1.0, 1.0, 1.0));
      return 1.7 * mix(mix(mix(n000, n100, w.x), mix(n010, n110, w.x), w.y),
                       mix(mix(n001, n101, w.x), mix(n011, n111, w.x), w.y), w.z);
    }
    float fbm(vec3 p, int oct) {
      float s = 0.0, a = 0.5;
      for (int i = 0; i < 6; i++) {
        if (i >= oct) break;
        s += a * gn(p);
        p = p * 2.03 + vec3(5.1, 1.7, 3.3);
        a *= 0.5;
      }
      return s;
    }
    float smax(float a, float b, float k) {
      float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
      return mix(a, b, h) + k * h * (1.0 - h);
    }
    // soft billow (cauliflower): a central puff ringed by smaller puffs, so the outline is scalloped; the outline is warped by
    // low-frequency noise and grained at the edge; temperature is highest in each puff's middle (darker crevices between)
    vec3 billow(vec2 p, float seed, float spread) {
      vec2 w = vec2(fbm(vec3(p * 1.9, seed), 4), fbm(vec3(p * 1.9 + 7.3, seed + 1.3), 4));
      vec2 q = p + w * (0.05 + 0.15 * uLumps);
      float f = 1.0 - dot(q, q) / (0.50 * 0.50);
      float sum = max(f, 0.0);
      float a0 = hash33(vec3(seed, 1.0, 2.0)).x * 6.2832;
      for (int i = 0; i < 9; i++) {
        vec3 h = hash33(vec3(seed * 1.31, float(i) * 2.17, 4.7));
        vec3 h2 = hash33(vec3(seed * 0.73, float(i) * 5.31, 1.9));
        float a = a0 + float(i) * 0.698 + (h.x - 0.5) * 1.3;          // uneven spacing: no regular scallops
        vec2 c = vec2(cos(a), sin(a)) * mix(0.28, 0.52, h.y) * spread;
        float rad = mix(0.10, 0.32, h2.x * h2.x) * (0.75 + 0.5 * uLumps * h.x);   // mostly small puffs, a few big ones
        float d = 1.0 - dot(q - c, q - c) / (rad * rad);
        f = smax(f, d, 0.22);
        sum += max(d, 0.0) * 0.6;
      }
      float g = uGrain * (0.16 * fbm(vec3(p * 8.0, seed + 11.0), 3) + 0.10 * fbm(vec3(p * 21.0, seed + 17.0), 2));
      float D = smoothstep(0.0, 0.65, f + g) * (0.82 + 0.18 * smoothstep(0.1, 0.9, sum));
      float T = smoothstep(-0.15, 0.95, f + 0.25 * fbm(vec3(p * 3.5, seed + 23.0), 3)) * (0.85 + 0.15 * smoothstep(0.2, 1.0, sum));
      float E = clamp(0.52 + 0.55 * fbm(vec3(p * 3.0, seed + 31.0), 4) - 0.32 * (1.0 - T), 0.0, 1.0);
      return vec3(D, E, T);
    }
    // FLAME LICK: a tongue of flame, root at the bottom (p.y = -0.84), tip at the top (p.y = +0.84), inside the cell's clear
    // margin. A rounded root and a belly just above it, then a taper (uTaper) to a pointed tip; the centre line bends to one
    // side and sways. Each side of the outline has its own lumps, a few along the length (lumpy but continuous, no
    // scallops). The tip is torn (uTear): on most variants a shorter side tongue branches off and licks out on its own, and
    // holes open near the end. Inside, temperature falls from the root and the centre line toward the tip and the edges,
    // streaked along the flow (uLickDetail). frame = flipbook time (the noise rises through the shape); v = variant (0..7).
    vec3 lick(vec2 p, float seed, float frame, float v) {
      vec3 hs = hash33(vec3(seed * 0.37, v * 1.93, 3.1));
      vec3 hs2 = hash33(vec3(v * 2.71, seed * 0.11, 8.3));
      float t = frame * 0.55;
      float s = (p.y + 0.84) / 1.68 * 1.06 - 0.06;            // -0.06 (root cap) .. 1 (tip)
      float sc = clamp(s, 0.0, 1.0);
      // the centre line bends to one side and sways, more toward the tip
      float bend = (hs.x - 0.5) * 0.30;
      float xc = bend * sc * sc + (0.10 + 0.12 * hs.z) * sc * sc * fbm(vec3(sc * 2.0 - t * 0.9, seed + v, 0.7), 3);
      float x = p.x - xc;
      float side = x < 0.0 ? -1.0 : 1.0;
      // half-width: rounded root cap, then a convex teardrop that bellies out and closes to the tip: uTaper 0 = a full,
      // round-ended tongue, 1 = a straight cone to a sharp point (the bulge k goes 1.6 -> 0)
      float rootW = mix(0.36, 0.50, hs.y);
      float a = mix(0.70, 0.95, hs2.x);
      float kb = mix(1.6, 0.0, uTaper);
      float prof = pow(max(1.0 - sc, 0.0), a) * (1.0 + kb * sc) / mix(1.0, 1.13, kb / 1.6);
      float cap = s < 0.10 ? sqrt(max(1.0 - pow((0.10 - s) / 0.16, 2.0), 0.0)) : 1.0;
      float hw = rootW * prof * cap;
      // wavy outline: each side its own lumps, a few along the length, stronger toward the tip; plus fine grain
      float amp = (0.08 + 0.10 * sc) * (0.6 + 0.8 * uTear);
      float e = amp * fbm(vec3(side * 3.1 + p.x * 0.8, p.y * 4.2 - t * 1.8, seed + 4.0 + v), 3)
              + 0.025 * fbm(vec3(p.x * 6.0, p.y * 5.0 - t * 2.0, seed + 6.0 + v), 2)
              + 0.025 * uGrain * fbm(vec3(p * 14.0, seed + 19.0), 2);
      float inside = hw - abs(x) + e;
      // torn tip: on 3 of 4 variants a shorter side tongue branches off the main one and curves out on its own
      float sb = mix(0.80, 0.45, uTear) + 0.12 * (hs2.y - 0.5);
      if (hs2.z < 0.75) {
        float bs = clamp((sc - sb) / max(1.0 - sb, 0.05), 0.0, 1.0);
        float bdir = hs2.z < 0.375 ? -1.0 : 1.0;
        float xb = bdir * (0.10 * bs + 0.30 * bs * bs) * (0.6 + 0.6 * uTear);
        float hwb = rootW * 0.42 * pow(max(1.0 - bs * 1.08, 0.0), 0.9) * smoothstep(sb, sb + 0.06, sc);
        inside = max(inside, hwb - abs(x - xb) + e * 0.8);
      }
      float D = smoothstep(0.0, 0.12, inside);
      // torn holes near the tip
      float hole = fbm(vec3(p.x * 2.8, p.y * 1.8 - t * 1.4, seed + 9.0 + v), 3);
      D *= smoothstep(-0.12, 0.18, hole + 1.1 - 1.2 * uTear * sc * sc * sc);
      // temperature: hottest at the root and along the centre line, streaked along the flow
      float xr = abs(x) / max(hw, 0.05);
      float streak = fbm(vec3(p.x * 4.5, p.y * 1.1 - t * 1.3, seed + 13.0 + v), 3);
      float T = clamp(1.02 - 0.45 * pow(sc, 1.3) - 0.45 * xr * xr + 0.22 * uLickDetail * streak, 0.0, 1.0);
      // erosion order: the tip, the edges and the holes dissolve first, the root last
      float E = clamp(0.28 + 0.40 * (fbm(vec3(p.x * 3.0, p.y * 1.7 - t, seed + 31.0 + v), 3) * 0.5 + 0.5)
                      + 0.38 * (1.0 - sc) - 0.18 * xr, 0.0, 1.0);
      return vec3(D, E, T);
    }
    // TORN PIECE (break-up): a scrap of flame torn off the dying column, ragged all round with several sharp tips that lean
    // upward (flames rise), holed inside: the frames' +6 orange pieces and the star-like flecks beside the +5 column.
    vec3 torn(vec2 p, float seed) {
      vec3 hs = hash33(vec3(seed, 7.0, 2.0));
      vec2 q = p * vec2(1.0, 0.85) + vec2(0.0, 0.08);
      float r = length(q);
      float ang = atan(q.y, q.x);
      float n = fbm(vec3(q * 2.2, seed), 4);
      float tips = floor(4.0 + 3.0 * hs.x);
      float spike = pow(0.5 + 0.5 * cos(ang * tips + hs.y * 6.2832 + 2.5 * n), 3.0);
      float up = 0.5 + 0.5 * sin(ang);
      float edge = 0.34 + 0.18 * n + (0.10 + 0.16 * up) * spike;
      float D = smoothstep(edge + 0.035, edge - 0.035, r);
      float hole = fbm(vec3(p * 3.0, seed + 5.0), 3);
      D *= smoothstep(-0.25, 0.05, hole + 0.25 - 0.5 * uTear * smoothstep(0.1, 0.5, r));
      float T = clamp(0.95 - 0.7 * r + 0.15 * fbm(vec3(p * 3.0, seed + 13.0), 2), 0.0, 1.0);
      float E = clamp(0.35 + 0.45 * (fbm(vec3(p * 3.2, seed + 31.0), 3) * 0.5 + 0.5) + 0.3 * (1.0 - r * 2.0), 0.0, 1.0);
      return vec3(D, E, T);
    }
    // fleck: a crisp, crumpled-leaf scrap of flame
    vec3 fleck(vec2 p, float seed) {
      float r = length(p);
      float n = fbm(vec3(p * 2.4, seed), 4);
      float n2 = fbm(vec3(p * 6.0, seed + 3.0), 3);
      vec3 hs = hash33(vec3(seed, 5.0, 9.0));
      float lobes = floor(5.0 + 3.0 * hs.x);
      float spike = pow(0.5 + 0.5 * cos(atan(p.y, p.x) * lobes + hs.y * 6.2832 + 2.0 * n), 2.5);
      float edge = 0.40 + 0.26 * n + 0.14 * n2 + 0.07 * spike;
      float w = mix(0.10, 0.012, uCrisp);
      float D = smoothstep(edge + w, edge - w, r);
      float T = 0.8 + 0.2 * smoothstep(edge, 0.0, r);
      float E = clamp(0.55 + 0.45 * fbm(vec3(p * 3.5, seed + 31.0), 3), 0.0, 1.0);
      return vec3(D, E, T);
    }
    // clump: a billow torn by holes, for the 02 break-up cloud
    vec3 clump(vec2 p, float seed) {
      vec3 b = billow(p * 1.06, seed, 1.15);
      float holes = fbm(vec3(p * 3.2, seed + 41.0), 4);
      float D = b.x * smoothstep(-0.40, 0.10, holes + 0.05);
      return vec3(D, clamp(b.y * 0.8 + 0.2 * (holes * 0.5 + 0.5), 0.0, 1.0), b.z);
    }
    // a tapered segment from a (radius ra) to b (radius rb), in cell units: > 0 inside
    float tongue(vec2 q, vec2 a, vec2 b, float ra, float rb) {
      vec2 ab = b - a;
      float h = clamp(dot(q - a, ab) / dot(ab, ab), 0.0, 1.0);
      return mix(ra, rb, h) - length(q - a - ab * h);
    }
    // LATE LICK (pass 5, reshaped in 5b; the game's +6 break-up licks in AK 01, and moments 02 / 03): variants 0-3 a broad
    // forked tongue, variants 4-7 a squat spiky leaf (AK 01 +6 has one of each). Pass 5's description below still holds per shape: A main tongue on a bent centre line with one or two side branches licking up and out, the whole outline wavered
    // and frayed at two scales (uLateRag: branching and notched like the game's, solidity ~0.75-0.8, not a convex teardrop);
    // inside, streaks along the flow (uLateDetail) and small holes (uLateHoles), so it is never flat; a soft edge (uLateSoft);
    // the temperature uneven: hottest at uLateHot along the length and in the streaks, cooler at the edges (never a smooth
    // fade from a lighter root). v = variant 0..7.
    vec3 lateLick(vec2 p, float seed, float v) {
      vec3 hs = hash33(vec3(seed * 0.53, v * 3.17, 5.9));
      vec3 hs2 = hash33(vec3(v * 1.37, seed * 0.29, 2.4));
      vec2 w1 = vec2(fbm(vec3(p * 1.6, seed + 3.0), 3), fbm(vec3(p * 1.6 + 5.2, seed + 7.0), 3));
      vec2 w2 = vec2(fbm(vec3(p * 4.2, seed + 11.0), 2), fbm(vec3(p * 4.2 + 2.7, seed + 13.0), 2));
      vec2 q = p + w1 * (0.06 + 0.10 * uLateRag) + w2 * (0.02 + 0.05 * uLateRag);
      float d, s;
      if (v < 3.5) {
        // a BROAD FORKED TONGUE (pass 5b: about twice pass 5's width): a wide rounded root low in the cell, a bent centre line,
        // a blunt tip, two side branches licking up and out
        float bend = (hs.x - 0.5) * 0.45;
        vec2 a = vec2((hs.y - 0.5) * 0.16, -0.70);
        vec2 m = vec2(0.45 * bend + (hs.z - 0.5) * 0.14, -0.10);
        vec2 b = vec2(bend, 0.72);
        float rw = mix(0.32, 0.40, hs2.x);
        d = max(tongue(q, a, m, rw * 0.80, rw), tongue(q, m, b, rw * 0.90, 0.04));
        float side0 = hs2.z < 0.5 ? -1.0 : 1.0;
        for (int i = 0; i < 2; i++) {
          vec3 hb = hash33(vec3(seed * 1.7 + float(i) * 3.1, v * 2.3, 9.1));
          float fr = 0.30 + 0.35 * hb.x;
          vec2 r0 = fr < 0.45 ? mix(a, m, fr / 0.45) : mix(m, b, (fr - 0.45) / 0.55);
          float sd = i == 0 ? side0 : -side0;
          vec2 r1 = r0 + vec2(sd * (0.20 + 0.12 * hb.y), 0.18 + 0.18 * hb.z);
          d = max(d, tongue(q, r0, r1, rw * (0.62 + 0.22 * hb.y), 0.03));
        }
        s = clamp((q.y + 0.70) / 1.42, 0.0, 1.0);
      } else {
        // a SQUAT SPIKY LEAF (pass 5b; the game's second +6 lick): a wide body sitting low in the cell, four to seven points of
        // uneven length fanning over its upper half (flames rise)
        vec2 c = q * vec2(1.0, 1.15) + vec2(0.0, 0.18);
        float r = length(c), ang = atan(c.y, c.x);
        float sp = 0.0;
        for (int i = 0; i < 7; i++) {
          vec3 h = hash33(vec3(seed * 0.9, float(i) * 2.3, 4.4 + v));
          if (h.z < 0.3) continue;
          float a0 = mix(0.30, 2.84, h.x);
          float da = abs(mod(ang - a0 + 3.14159, 6.2832) - 3.14159);
          float k = max(1.0 - da / (0.16 + 0.12 * h.y), 0.0);
          sp = max(sp, (0.12 + 0.30 * h.y) * (0.5 + 0.5 * uLateRag) * k * k);
        }
        d = 0.38 + 0.08 * fbm(vec3(c * 2.4, seed + 5.0), 3) + sp - r;
        s = clamp((q.y + 0.60) / 1.35, 0.0, 1.0);
      }
      // a frayed outline: fine, uneven notches and wisps, stronger toward the tip
      d += (0.025 + 0.05 * uLateRag) * (0.6 + 0.8 * s) * fbm(vec3(q * 7.0, seed + 17.0), 3);
      float sw = mix(0.05, 0.16, uLateSoft);
      float D = smoothstep(-0.2 * sw, sw, d);
      // holes as STREAKS along the flow (pass 5b): stretched noise, partly see-through instead of punched dots, not at the edge
      float hn = fbm(vec3(q.x * 10.0, q.y * 2.6, seed + 23.0), 3);
      D *= mix(1.0, 0.25 + 0.75 * smoothstep(-0.12, 0.12, hn + 0.62 - 0.95 * uLateHoles), smoothstep(0.03, 0.12, d));
      // temperature: hottest at uLateHot along the length and in streaks along the flow (light and dark), cooler at the edges
      float z = (s - uLateHot) / 0.32;
      float hot = exp(-z * z);
      float streak = 0.6 * fbm(vec3(q.x * 8.0, q.y * 1.8 - 0.3 * v, seed + 29.0), 3) + 0.4 * fbm(vec3(q.x * 18.0, q.y * 4.0, seed + 37.0), 2);
      float T = clamp(0.28 + 0.46 * hot + 0.75 * uLateDetail * streak + 0.16 * smoothstep(0.0, 0.18, d) * (0.4 + 0.6 * s), 0.0, 1.0);
      // erosion order: the edges, the streaks and the thin parts dissolve first, the thick middle last
      float E = clamp(0.20 + 0.40 * (fbm(vec3(q * 3.0, seed + 31.0), 3) * 0.5 + 0.5) + 1.6 * d - 0.10 * s, 0.0, 1.0);
      return vec3(D, E, T);
    }
    // TORN PIECE OF THE COLUMN (pass 5; AK 01 +4 / +5: the column's lower right flank breaks into big jagged scraps): a torn leaf
    // of flame with five to eight sharp points of uneven length, the longer ones leaning up (uScrapPoints), ragged at a fine
    // scale too; inside it is mottled, hot white patches with cooler cream between (uScrapDetail: the game's pieces are
    // textured, never flat), with a few holes (uScrapHoles); hottest a little off-centre.
    vec3 scrap(vec2 p, float seed) {
      vec3 hs = hash33(vec3(seed, 3.0, 8.0));
      vec2 w = vec2(fbm(vec3(p * 2.0, seed + 1.0), 3), fbm(vec3(p * 2.0 + 4.1, seed + 2.0), 3));
      vec2 q = (p + w * 0.10) * vec2(1.0, 0.92);
      float r = length(q), ang = atan(q.y, q.x);
      float n = fbm(vec3(q * 2.6, seed + 5.0), 3);
      float sp = 0.0;
      for (int i = 0; i < 8; i++) {
        vec3 h = hash33(vec3(seed * 0.7, float(i) * 1.9, 6.1));
        if (h.z < 0.25) continue;                                  // some points missing: uneven spacing
        float a0 = h.x * 6.2832;
        float da = abs(mod(ang - a0 + 3.14159, 6.2832) - 3.14159);
        float up = 0.65 + 0.35 * sin(a0);                          // points leaning up are longer (flames rise)
        float k = max(1.0 - da / (0.20 + 0.14 * h.y), 0.0);
        sp = max(sp, (0.14 + 0.40 * h.y) * up * uScrapPoints * k * k);
      }
      float d = 0.30 + 0.09 * n + sp + 0.035 * fbm(vec3(q * 11.0, seed + 9.0), 2) - r;
      float D = smoothstep(-0.01, 0.025, d);
      float hole = 0.6 * fbm(vec3(p * 7.0, seed + 13.0), 3) + 0.4 * fbm(vec3(p * 15.0, seed + 15.0), 2);
      D *= smoothstep(-0.10, 0.10, hole + 0.55 - 1.1 * uScrapHoles * smoothstep(0.03, 0.12, d));
      float mot = 0.35 * fbm(vec3(q * 6.0, seed + 17.0), 3) + 0.35 * fbm(vec3(q * 16.0, seed + 19.0), 2) + 0.3 * fbm(vec3(q * 34.0, seed + 21.0), 2);
      vec2 hc = (hs.xy - 0.5) * 0.24;
      float T = clamp(0.58 + 0.3 * (1.0 - 2.2 * length(q - hc)) + 1.15 * uScrapDetail * mot + 0.10 * smoothstep(0.0, 0.1, d), 0.0, 1.0);
      float E = clamp(0.25 + 0.40 * (fbm(vec3(q * 3.2, seed + 31.0), 3) * 0.5 + 0.5) + 1.4 * d, 0.0, 1.0);
      return vec3(D, E, T);
    }
    void main() {
      vec2 g = vUv * vec2(8.0, 10.0);
      vec2 cid = min(floor(g), vec2(7.0, 9.0));
      vec2 p = fract(g) * 2.0 - 1.0;
      float cell = cid.y * 8.0 + cid.x;
      float seed = uSeed * 17.0 + cell * 3.71 + 1.0;
      vec3 o;
      if (cell < 8.0) o = billow(p, seed, 1.0);
      else if (cell < 40.0) { float k = cell - 8.0; float v = floor(k / 4.0); o = lick(p, uSeed * 17.0 + v * 5.3 + 2.0, mod(k, 4.0), v); }
      else if (cell < 48.0) o = fleck(p, seed);
      else if (cell < 56.0) o = torn(p, seed);
      else if (cell < 64.0) o = clump(p, seed);
      else if (cell < 72.0) o = lateLick(p, seed, cell - 64.0);
      else o = scrap(p, seed);
      // keep a transparent margin so mip levels never bleed between cells
      float win = 1.0 - smoothstep(0.84, 0.97, max(abs(p.x), abs(p.y)));
      // A: fine, sharp detail (ridged noise, a few px on screen), used at the silhouette only (see uDetail)
      float fd = 1.0 - abs(gn(vec3(p * 13.0, seed + 51.0)));
      fd = 0.6 * fd * fd + 0.4 * (1.0 - abs(gn(vec3(p * 29.0, seed + 57.0))));
      gl_FragColor = vec4(o.x * win, o.y, o.z, clamp(fd, 0.0, 1.0));
    }`;

  // Shared vertex shader for both instanced sprite draws. A sprite is a quad in the view plane at iPos.
  //   iPos    world centre (m)
  //   iDir    xyz = world direction of the sprite's long axis (its +y), w = length along it (m). The long axis is the
  //           projection of that direction, foreshortened, and never shorter than the width (seen end-on it is round).
  //           Exception, flame sprites (FLAME_SPRITES defined): a lick lying across the view may be as short as 0.55 x its
  //           quad width, because its texture fills only ~45% of the quad's width; as it turns end-on (projected length
  //           fraction l below 0.3) the minimum goes back to the full width, so it never squashes into a sliver.
  //           A zero direction gives a square quad turned only by the roll.
  //   iShape  x = width (m), y = roll in the view plane (rad), z / w = per-draw data (atlas cells / glow kind and type)
  //   iA, iB, iC  per-draw data, passed through (iC: pass 5, flame sprites only, see FLAME_FRAG_BODY; glows leave it 0)
  const SPRITE_VERT = /* glsl */`
    attribute vec3 iPos;
    attribute vec4 iDir;
    attribute vec4 iShape;
    attribute vec4 iA;
    attribute vec4 iB;
    attribute vec4 iC;
    varying vec2 vUv;
    varying float vViewZ;
    varying vec4 vShape;
    varying vec4 vA;
    varying vec4 vB;
    varying vec4 vC;
    void main() {
      vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
      vec3 dv = (modelViewMatrix * vec4(iDir.xyz, 0.0)).xyz;
      float l = length(dv.xy);
      vec2 ay = l > 1e-6 ? dv.xy / l : vec2(0.0, 1.0);
      // iDir.w < 0 marks a glow ellipse: its axes are kept as given (not widened to round)
      float L = abs(iDir.w) * l;
      #ifdef FLAME_SPRITES
        float minL = iShape.x * mix(1.0, 0.55, smoothstep(0.3, 0.7, l));
      #else
        // a glow may ask for a minimum aspect along its projected direction (iB.x, e.g. the break-up glare along the barrel,
        // which our hero camera sees nearly end-on); it fades out as the direction turns end-on
        float minL = iShape.x * mix(1.0, max(iB.x, 1.0), smoothstep(0.02, 0.08, l));
      #endif
      float halfLen = 0.5 * (iDir.w < 0.0 ? max(L, 0.2 * iShape.x) : max(L, minL));
      float halfW = 0.5 * iShape.x;
      float c = cos(iShape.y), s = sin(iShape.y);
      ay = vec2(c * ay.x - s * ay.y, s * ay.x + c * ay.y);
      vec2 ax = vec2(ay.y, -ay.x);
      mv.xy += ax * (position.x * halfW) + ay * (position.y * halfLen);
      gl_Position = projectionMatrix * mv;
      vUv = position.xy;
      vViewZ = -mv.z;
      vShape = iShape;
      vA = iA;
      vB = iB;
      vC = iC;
    }`;

  // Soft contact, shared: 5 taps of the scene depth around the pixel, so the rifle's silhouette edge in front of the
  // flame is about 1 px soft instead of stair-stepped. zf = the sprite's depth at this pixel (m along the view axis).
  const SOFT_GLSL = /* glsl */`
    uniform highp sampler2D tSceneDepth;
    uniform vec2 uNearFar;        // camera near / far (m)
    uniform float uSoft;          // fade distance in front of a surface (m)
    float sceneFade(ivec2 q, ivec2 mx, float zf) {
      float zs = rangeViewDepth(texelFetch(tSceneDepth, clamp(q, ivec2(0), mx), 0).r, uNearFar);
      return smoothstep(0.0, uSoft, zs - zf);
    }
    float softFade(float zf) {
      ivec2 q = ivec2(gl_FragCoord.xy);
      ivec2 mx = textureSize(tSceneDepth, 0) - 1;
      return 0.4 * sceneFade(q, mx, zf)
           + 0.15 * (sceneFade(q + ivec2(1, 0), mx, zf) + sceneFade(q - ivec2(1, 0), mx, zf)
                   + sceneFade(q + ivec2(0, 1), mx, zf) + sceneFade(q - ivec2(0, 1), mx, zf));
    }`;

  // FLAME sprites -> heat buffer. Per instance: iShape.z / .w = atlas cells A and B, iA.x = heat (1 = one sprite's full
  // contribution), iA.y = blend A -> B, iA.z = erosion level (0 keeps all, 1 dissolves all), iA.w = erosion edge width,
  // iB.x = cooling (0 fresh .. 1 cooled orange), iB.y = fringe weight (+ violet, - warm orange: pass 5b), iB.z = horizontal flip (its sign) and layer
  // class (|iB.z| - 1: 1 = an opening flame (hot core, puff, lobes, sub-flames, tongues, jet), 0 = the column, its torn pieces
  // and the break-up; written to the heat buffer's alpha as heat x class, so the composite knows per pixel how much of the
  // heat is opening flame and gives that part its own edge softness and glow),
  // iB.w = depth bulge (m: the sprite is treated as a sphere this much nearer at its centre, for the soft contact).
  // iC (pass 5): x = rim cooling (cooling added where the sprite's own texture is cool: its rim, its tip, the streaks between
  // its hot ones; 0..1), y = root cooling (cooling added at the sprite's root end: the column's base below the muzzle, salmon in
  // the game), z = how far up the root cooling reaches (fraction of the lick's length; pass 5b: the lowest rows only, heat kept).
  // So a flame cools gradually at its edges, top and base instead of switching colour as a whole; where many sprites overlap
  // the summed heat keeps the core white.
  // Uniforms: tAtlas, uTempW = how much the texture's temperature channel shapes the heat, uOutline (debug).
  const FLAME_FRAG_BODY = /* glsl */`
    uniform sampler2D tAtlas;
    uniform float uTempW;
    uniform float uDetail;        // sharp detail on the silhouette: 0 off, 1 = full (calm body, crisp edge)
    uniform float uOutline;
    uniform float uLateSharp;     // pass 5b: mip bias (levels sharper) for the late-lick and torn-piece rows (cells >= 64)
    varying vec2 vUv;
    varying float vViewZ;
    varying vec4 vShape;
    varying vec4 vA;
    varying vec4 vB;
    varying vec4 vC;
    vec2 cellUv(float cell, vec2 uv) {
      float cy = floor(cell / 8.0 + 0.001);
      float cx = cell - cy * 8.0;
      return (vec2(cx, cy) + uv * 0.5 + 0.5) * vec2(0.125, 0.1);     // 8 x 10 cells
    }
    void main() {
      vec2 uv = vUv * vec2(sign(vB.z), 1.0);
      float lb = vShape.z > 63.5 ? -uLateSharp : 0.0;
      vec4 s = mix(texture2D(tAtlas, cellUv(vShape.z, uv), lb), texture2D(tAtlas, cellUv(vShape.w, uv), lb), vA.y);
      float mask = smoothstep(vA.z - vA.w, vA.z, s.g);
      float r2 = min(dot(vUv, vUv), 1.0);
      float zf = vViewZ - vB.w * sqrt(1.0 - r2);
      float sil = 1.0 - smoothstep(0.12, 0.7, s.r);                      // 1 at the sprite's silhouette, 0 inside
      // pass 5b: a root-cooled sprite (the column's base) frays its lowest part with extra silhouette detail: a ragged bottom edge
      float rootZ = step(0.001, vC.y) * (1.0 - smoothstep(-0.84, -0.84 + 3.36 * max(vC.z, 0.02), vUv.y));
      float det = mix(1.0, 0.25 + 1.5 * s.a, min(uDetail + 0.65 * rootZ, 1.0) * sil);
      // pass 5b: the root cooling reaches only the lowest rows (iC.z = its reach as a fraction of the lick's length) and keeps
      // the heat, so the column's base stays hot and opaque with salmon lowest rows (pass 5 dimmed it into see-through drips)
      float rootF = vC.y * (1.0 - smoothstep(-0.84, -0.84 + 1.68 * max(vC.z, 0.02), vUv.y));
      // the lowest rows are fully cooled (a hot pixel shows the white core unless its cooling is near 1) and lose a little heat,
      // staying the dominant heat there (a strongly dimmed sprite's cooling is outweighed by its neighbours'); the rest of the base
      // keeps its full heat and opacity
      float dep = s.r * det * mix(1.0, s.b, uTempW) * mask * vA.x * softFade(zf) * (1.0 - 0.35 * rootF);
      if (uOutline > 0.5) { vec2 e = abs(vUv); dep += 0.35 * step(0.965, max(e.x, e.y)); }
      float cl = clamp(vB.x + vC.x * (1.0 - s.b) + 2.0 * rootF, 0.0, 1.0);
      gl_FragColor = vec4(dep, dep * cl, dep * vB.y, dep * (abs(vB.z) - 1.0));
    }`;

  // COMPOSITE: summed heat -> radiance, added to the HDR image. The flame's OUTLINE is a narrow threshold on the summed heat
  // (the sprites' silhouette detail makes it ragged), so the flames read as defined shapes; a flame that cools shrinks
  // inside a crisp edge instead of fading. Alpha carries the bloom weight for the range's per-texel bloom prefilter
  // (dst alpha *= 1 - src alpha). The heat buffer's alpha says how much of a pixel's heat is OPENING flame (class 1): that
  // part blooms by uBloomW.x ("Opening flames: glow", raised at birth: the soft glowing edge of the game's opening puffs,
  // which hugs the outline because it is the flame's own light spread by the scene bloom), the column and its pieces by
  // uBloomW.y (nearly none: their edge stays crisp); the same fraction mixes the two layers' edge softness.
  // Two draws share this shader: PASS 0 dims the scene behind the flame by its opacity (multiply), PASS 1 adds the colour.
  // Uniforms (all radiance = linear colour x gain):
  //   uOutline x = heat at the outline, y = edge hardness (0 soft .. 1 crisp, at least ~1 px wide)
  //   uSoftCO  edge softness 0..1: x = opening flames, y = column and pieces
  //   uBloomW  bloom weight 0..1 (1 = blooms like any scene texel): x = opening flames NOW (set every frame), y = column, pieces
  //   uGlowBand pass 5: extra bloom weight of the column's colour bands (between its outline and its white core), 0..1: the
  //            game's column sits in a soft warm glow (gold + orange 84-86 % of the 10 px outside its white core), which is
  //            its gold bands' light, not its white core's
  //   uBand    colour band width (x, 1 = as the stops say): x = opening flames, y = column and pieces
  //   uOpacity how much the flame body hides the scene (0..1)
  //   uStops   heat at the edge / mid / hot / core stops      uRimP  exponent of the rise from the outline to the edge stop
  //   uEdge, uMid, uHot, uCore           the fresh ramp (gold edge -> mid -> pale yellow -> white core)
  //   uCoolLo, uCoolMid, uCoolHi         the cooled ramp (dim orange -> bright orange -> peach), same stops
  //   uFringe                            violet fringe of the opening puff
  //   uFringeWarm                        pass 5b: the warm (orange) fringe of the rest of the puff; the heat buffer's B channel is
  //                                      signed: + = violet fringe weight, - = warm fringe weight
  const COMPOSITE_FRAG = /* glsl */`
    uniform sampler2D tHeat;
    uniform vec4 uStops;
    uniform float uRimP;
    uniform vec3 uEdge;
    uniform vec3 uMid;
    uniform vec3 uHot;
    uniform vec3 uCore;
    uniform vec3 uCoolLo;
    uniform vec3 uCoolMid;
    uniform vec3 uCoolHi;
    uniform vec3 uFringe;
    uniform vec3 uFringeWarm;
    uniform vec3 uOutline;
    uniform vec2 uSoftCO;
    uniform vec2 uBloomW;
    uniform float uGlowBand;
    uniform float uGlowHot;      // pass 5c: the hot band's share of the column's glow (0..1)
    uniform float uCoreGlowO;     // pass 5: the opening flames' white core and hot band bloom by this share of their glow
    uniform vec2 uBand;
    uniform float uOpacity;       // how much the defined flame hides the scene behind it (0 = purely additive)
    uniform float uCoolSoft;      // cooled (break-up) parts: how much softer their edge and thinner their body are (0..1)
    uniform float uHeatView;      // debug: 1 writes heat / 8 as opaque grey instead of colour (calibration)
    varying vec2 vUv;
    vec3 lg(vec3 c) { return log(max(c, vec3(1e-4))); }
    float rimT(float h) { return clamp((h - uOutline.x) / max(uStops.x - uOutline.x, 1e-3), 0.0, 1.0); }
    vec3 rampHot(float h) {
      if (h < uStops.x) return uEdge * mix(0.35, 1.0, pow(rimT(h), uRimP));
      if (h < uStops.y) return exp(mix(lg(uEdge), lg(uMid), smoothstep(uStops.x, uStops.y, h)));
      if (h < uStops.z) return exp(mix(lg(uMid), lg(uHot), smoothstep(uStops.y, uStops.z, h)));
      return exp(mix(lg(uHot), lg(uCore), smoothstep(uStops.z, uStops.w, h)));
    }
    vec3 rampCool(float h) {
      if (h < uStops.x) return uCoolLo * mix(0.35, 1.0, pow(rimT(h), uRimP));
      if (h < uStops.y) return exp(mix(lg(uCoolLo), lg(uCoolMid), smoothstep(uStops.x, uStops.y, h)));
      return exp(mix(lg(uCoolMid), lg(uCoolHi), smoothstep(uStops.y, uStops.w, h)));
    }
    void main() {
      vec4 s = texelFetch(tHeat, ivec2(gl_FragCoord.xy), 0);
      float H = s.r;
      if (uHeatView > 0.5) { gl_FragColor = vec4(vec3(H * 0.125), 1.0); return; }
      if (H < 1e-4) discard;
      float cool = clamp(s.g / H, 0.0, 1.0);
      float ofr = clamp(s.a / H, 0.0, 1.0);                             // share of this pixel's heat that is opening flame
      float sft = mix(uSoftCO.y, uSoftCO.x, ofr);
      float vio = clamp(s.b / H, -1.0, 1.0);
      // the outline: a narrow step on the heat (never narrower than about one pixel of the heat gradient, so it stays
      // anti-aliased); soft (hardness 0) spreads it over the whole span below the outline heat
      float w = mix(uOutline.x * 0.95, 0.0, uOutline.y * (1.0 - max(sft, cool * cool * uCoolSoft))) + 0.75 * fwidth(H);
      float cov = smoothstep(uOutline.x - w, uOutline.x + w, H);
      if (cov <= 0.0) discard;
      #if PASS == 0
        // occlusion: the scene behind the flame is dimmed by its opacity (cooler, thinner parts hide less)
        float op = uOpacity * cov * smoothstep(uOutline.x, uStops.y, H) * (1.0 - 0.6 * cool * uCoolSoft);
        gl_FragColor = vec4(vec3(1.0 - op), 1.0);
        return;
      #endif
      // colour bands per layer: the heat above the outline is stretched (band width > 1: wider gold bands, less white core)
      // or squeezed (< 1: white nearer the outline) before the ramp; the outline itself stays where it is
      float Hc = uOutline.x + (H - uOutline.x) / max(mix(uBand.y, uBand.x, ofr), 0.05);
      // cooling recolours the edge and mid bands; the white core stays white until its own heat drops
      float k = cool * (1.0 - smoothstep(uStops.z, uStops.w, Hc) * (1.0 - cool));
      vec3 col = mix(rampHot(Hc), rampCool(Hc), k);
      float fv = abs(vio) * (1.0 - smoothstep(uStops.z, uStops.w, Hc));   // the fringe takes the rim, up into the hot band
      col = mix(col, vio >= 0.0 ? uFringe : uFringeWarm, fv);
      // the column's bands bloom by uGlowBand on top of its own bloom weight; its white core does not (a warm, not a white, glow).
      // Pass 5c: the yellow hot band takes part only by uGlowHot ("Column glow: hot band's share"; 0 = the orange edge and mid
      // bands only): its bloom showed as a gold fringe round the column (gold 15-20 % of the flame at +3..+5, the game's 5-6 %)
      float bandW = smoothstep(uOutline.x, uStops.x, Hc) * (1.0 - smoothstep(mix(uStops.y, uStops.z, uGlowHot), mix(uStops.z, uStops.w, uGlowHot), Hc));
      // the opening flames' glow comes from their orange rim bands (edge + mid); their hot band and white core bloom by
      // uCoreGlowO of it (the game's glow round its opening flames is orange and lavender, not pale gold)
      float rimB = 1.0 - smoothstep(uStops.y, uStops.z, Hc);
      float bO = uBloomW.x * mix(uCoreGlowO, 1.0, rimB);
      gl_FragColor = vec4(col * cov, (1.0 - mix(uBloomW.y + uGlowBand * bandW, bO, ofr)) * cov);
    }`;

  // GLOW sprites -> HDR colour. Per instance: iShape.z = kind (1 glow, 2 spark), iShape.w = glow type (index into the
  // uniform arrays), iA.x = intensity, iA.y = seed (sparkle pattern), iA.z = age (s, sparkle twinkle), iA.w = quad
  // half-extent in units of the nominal size (the profile below is in nominal units), iB.w = depth bulge (m).
  // Uniform arrays per type: uGCore / uGBody / uGSkirt = linear radiance of the centre, body and skirt,
  // uGProf = (centre tightness, body exponent, body falloff, skirt falloff), uGSpark = sparkle amount (x).
  const GLOW_FRAG_BODY = /* glsl */`
    uniform vec3 uGCore[NG];
    uniform vec3 uGBody[NG];
    uniform vec3 uGSkirt[NG];
    uniform vec4 uGProf[NG];
    uniform vec4 uGSpark[NG];
    uniform float uOutline;
    varying vec2 vUv;
    varying float vViewZ;
    varying vec4 vShape;
    varying vec4 vA;
    varying vec4 vB;
    float h12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    void main() {
      int ty = int(vShape.w + 0.5);
      float r = length(vUv);
      vec3 col;
      if (vShape.z > 1.5) {
        // spark: a short streak along the quad's long axis with a Gaussian cross-section (sigma >= 0.75 px)
        float pxu = max(fwidth(vUv.x), 1e-4);
        float sig = max(0.30, 0.75 * pxu);
        float across = exp(-0.5 * vUv.x * vUv.x / (sig * sig));
        float along = 1.0 - smoothstep(0.45, 1.0, abs(vUv.y));
        col = uGBody[ty] * (across * along * vA.x);
      } else {
        vec4 pr = uGProf[ty];
        float rn = r * vA.w;
        float core = exp(-rn * rn * pr.x);
        float body = exp(-pow(rn, pr.y) * pr.z);
        float skirt = exp(-rn * pr.w);
        col = (uGCore[ty] * core + uGBody[ty] * body + uGSkirt[ty] * skirt) * vA.x;
        float sp = uGSpark[ty].x;
        if (sp > 0.0) {
          // sparkle: a fine grain of glints fixed in the glow, cells about 4 screen pixels wide at any distance (so it never shows as
          // a grid up close), each glint at a random spot in its cell and twinkling on its own phase (smooth in slow motion)
          float cell = 4.0 * max(fwidth(vUv.x), 1e-4);
          vec2 g = vUv / cell;
          vec2 gi = floor(g);
          float hs = h12(gi + vA.y * 17.0);
          vec2 gc = fract(g) - 0.5 - (vec2(h12(gi + 3.1), h12(gi + 7.7)) - 0.5) * 0.8;
          float glint = exp(-dot(gc, gc) * 18.0) * step(0.7, hs);
          float tw = pow(max(sin(vA.z * (70.0 + 90.0 * hs) + hs * 40.0), 0.0), 4.0);
          col += uGCore[ty] * (sp * 4.0 * glint * tw * body * vA.x);
        }
        col *= 1.0 - smoothstep(0.80, 1.0, r);
      }
      float zf = vViewZ - vB.w * sqrt(1.0 - min(r * r, 1.0));
      col *= softFade(zf);
      if (uOutline > 0.5) { vec2 e = abs(vUv); col += vec3(0.15, 0.45, 1.0) * step(0.965, max(e.x, e.y)); }
      gl_FragColor = vec4(col, 0.0);
    }`;

  // Debug overlay: the sprite atlas, top left (R density as grey, B temperature as warmth, G erosion order as a blue tint).
  // 8 x 10 square cells; the two pass-5 rows (late licks, torn pieces of the column) are the top two rows of the overlay.
  const ATLAS_VIEW_FRAG = /* glsl */`
    uniform sampler2D tAtlas;
    uniform vec2 uRes;            // drawing-buffer size (px)
    varying vec2 vUv;
    void main() {
      float s = uRes.y * 0.62;
      vec2 p = vec2((gl_FragCoord.x - 12.0) / (0.8 * s), (uRes.y - 12.0 - gl_FragCoord.y) / s);
      if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) discard;
      vec4 a = texture2D(tAtlas, vec2(p.x, 1.0 - p.y));
      vec3 c = vec3(a.r) * mix(vec3(1.0, 0.45, 0.15), vec3(1.0, 0.95, 0.85), a.b) + vec3(0.0, 0.03, 0.10) * a.g;
      vec2 grid = abs(fract(p * vec2(8.0, 10.0) + 0.5) - 0.5);
      c = mix(c, vec3(0.25, 0.3, 0.4), step(min(grid.x, grid.y), 0.004));
      gl_FragColor = vec4(c * 0.9, 1.0);            // below the bloom threshold, so the overlay shows the texture as it is
    }`;

  // ------------------------------------------------------------------------------------------------------------
  // State
  let C = null;                          // range context
  let T3 = null;                         // THREE
  const P = Object.assign({}, BASE);     // live values (flat keys)
  let version = 1, derivedVersion = 0;
  let now = 0;                           // sim time of the last update()
  let solo = 0;
  const rounds = [];                     // pool
  const D = {};                          // derived linear colours, rebuilt when version changes
  let atlasRT = null, heatRT = null, genQuad = null, compQuad = null, occQuad = null, atlasQuad = null;
  let flameMat = null, glowMat = null, flameMesh = null, glowMesh = null, flameScene = null, glowScene = null;
  let FB = null, GB = null;              // instance buffers
  let removePass = null, flashPass = null;
  let texSig = '';
  const counts = new Int32Array(GROUPS.length);
  const savedClear = { color: null, alpha: 1 };

  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const smooth = (a, b, x) => { if (b <= a) return x >= b ? 1 : 0; const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;

  // Deterministic per-sprite random numbers: an integer hash of (round seed, key), 0..1. No allocation.
  function hr(seed, k) {
    let h = (seed ^ Math.imul(k + 0x632BE5AB, 0x9E3779B1)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B);
    h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function setHexLinear(out, hex, gain) { out.set(hex); out.r *= gain; out.g *= gain; out.b *= gain; }
  function setV3(v, hex, gain) { _c.set(hex); v.set(_c.r * gain, _c.g * gain, _c.b * gain); }
  let _c = null;

  function derive() {
    derivedVersion = version;
    solo = Math.max(0, GROUPS.indexOf(P['sprites.solo']));
    // composite ramp
    const cu = compQuad.material.uniforms;
    cu.uStops.value.set(P['color.edgeAt'], Math.max(P['color.midAt'], P['color.edgeAt'] + 0.01),
      Math.max(P['color.hotAt'], P['color.midAt'] + 0.02), Math.max(P['color.coreAt'], P['color.hotAt'] + 0.03));
    cu.uRimP.value = lerp(0.4, 3.0, P['color.rim']);
    setHexLinear(cu.uEdge.value, P['color.edgeColor'], P['color.edgeGain']);
    setHexLinear(cu.uMid.value, P['color.midColor'], P['color.midGain']);
    setHexLinear(cu.uHot.value, P['color.hotColor'], P['color.hotGain']);
    setHexLinear(cu.uCore.value, P['color.coreColor'], P['color.coreGain']);
    setHexLinear(cu.uCoolLo.value, P['breakup.coolColor'], P['breakup.coolGain']);
    setHexLinear(cu.uCoolMid.value, P['breakup.lickColor'], P['breakup.lickGain']);
    setHexLinear(cu.uCoolHi.value, P['breakup.peachColor'], P['breakup.peachGain']);
    setHexLinear(cu.uFringe.value, '#c87cff', 4.0);
    setHexLinear(cu.uFringeWarm.value, P['onset.puffWarmColor'], 2.6);
    cu.uHeatView.value = P['sprites.heatView'] ? 1 : 0;
    cu.uOutline.value.set(P['color.outline'], P['color.hardness'], 0);
    cu.uSoftCO.value.set(P['color.onsetSoft'], P['color.columnSoft']);
    cu.uBand.value.set(P['color.onsetBand'], P['color.columnBand']);
    cu.uBloomW.value.set(P['color.onsetGlow'], P['color.bloom']);     // .x is refreshed every frame by render()
    cu.uGlowBand.value = P['color.columnGlow'];
    cu.uGlowHot.value = P['color.columnGlowHot'];
    cu.uCoreGlowO.value = P['color.onsetCoreGlow'];
    cu.uOpacity.value = P['color.opacity'];
    cu.uCoolSoft.value = P['breakup.softEdge'];
    compQuad.material.blending = P['sprites.heatView'] ? T3.NoBlending : T3.CustomBlending;
    // glow types
    const gu = glowMat.uniforms;
    const gc = gu.uGCore.value, gb = gu.uGBody.value, gs = gu.uGSkirt.value, gp = gu.uGProf.value, gk = gu.uGSpark.value;
    setV3(gc[GT_VIOLET], P['violet.centerColor'], P['violet.coreGain']);
    setV3(gb[GT_VIOLET], P['violet.bodyColor'], P['violet.bodyGain']);
    setV3(gs[GT_VIOLET], P['violet.rimColor'], P['violet.skirtGain'] * P['violet.skirt'] * 2.5);
    gp[GT_VIOLET].set(6.0, 1.7, 1.7, 1.15); gk[GT_VIOLET].set(0, 0, 0, 0);
    gc[GT_HAZE].set(0, 0, 0);
    setV3(gb[GT_HAZE], P['haze.color'], 1);
    setV3(gs[GT_HAZE], P['haze.color'], P['haze.skirt']);
    gp[GT_HAZE].set(0.0, 2.0, 2.0, 2.4 / P['haze.skirtSize']); gk[GT_HAZE].set(0, 0, 0, 0);
    gc[GT_HALO].set(0, 0, 0);
    setV3(gb[GT_HALO], P['halo.color'], 0.65);
    setV3(gs[GT_HALO], P['halo.color'], 0.35);
    gp[GT_HALO].set(0.0, 2.0, 2.6, 1.8); gk[GT_HALO].set(0, 0, 0, 0);
    setV3(gc[GT_GLITTER], P['glitter.color'], P['glitter.core']);
    setV3(gb[GT_GLITTER], P['glitter.color'], 1.0);
    setV3(gs[GT_GLITTER], P['glitter.color'], 0.18);
    gp[GT_GLITTER].set(7.0, 1.6, 1.6, 1.4); gk[GT_GLITTER].set(P['glitter.grain'], 0, 0, 0);
    gc[GT_SPARK_BLUE].set(0, 0, 0); setV3(gb[GT_SPARK_BLUE], P['breakup.sparkColor'], 1); gs[GT_SPARK_BLUE].set(0, 0, 0);
    gc[GT_SPARK_ORANGE].set(0, 0, 0); setV3(gb[GT_SPARK_ORANGE], '#ffa040', 1); gs[GT_SPARK_ORANGE].set(0, 0, 0);
    gp[GT_SPARK_BLUE].set(1, 1, 1, 1); gp[GT_SPARK_ORANGE].set(1, 1, 1, 1);
    gk[GT_SPARK_BLUE].set(0, 0, 0, 0); gk[GT_SPARK_ORANGE].set(0, 0, 0, 0);
    // shared sprite uniforms
    const soft = P['sprites.soft'] * CM0, outl = P['sprites.outlines'] ? 1 : 0;
    flameMat.uniforms.uSoft.value = soft; glowMat.uniforms.uSoft.value = soft;
    flameMat.uniforms.uOutline.value = outl; glowMat.uniforms.uOutline.value = outl;
    flameMat.uniforms.uTempW.value = P['color.tempShape'];
    flameMat.uniforms.uDetail.value = P['sprites.detail'];
    flameMat.uniforms.uLateSharp.value = P['sprites.lateSharp'];
    D.lightPeak.set(P['light.peakColor']); D.lightPlateau.set(P['light.plateauColor']);
    // textures follow their own four controls
    const sig = TEXTURE_KEYS.map((k) => P[k]).join(',');
    if (sig !== texSig) genAtlas();
  }

  // ------------------------------------------------------------------------------------------------------------
  // GPU resources
  function genAtlas() {
    texSig = TEXTURE_KEYS.map((k) => P[k]).join(',');
    const u = genQuad.material.uniforms;
    u.uSeed.value = P['sprites.seed']; u.uLumps.value = P['sprites.lumps']; u.uGrain.value = P['sprites.grain']; u.uCrisp.value = P['sprites.crisp'];
    u.uTaper.value = P['lick.taper']; u.uTear.value = P['lick.tear']; u.uLickDetail.value = P['lick.detail'];
    u.uLateRag.value = P['lick.lateRag']; u.uLateDetail.value = P['lick.lateDetail']; u.uLateHoles.value = P['lick.lateHoles'];
    u.uLateHot.value = P['lick.lateHot']; u.uLateSoft.value = P['lick.lateSoft'];
    u.uScrapPoints.value = P['lick.scrapPoints']; u.uScrapDetail.value = P['lick.scrapDetail']; u.uScrapHoles.value = P['lick.scrapHoles'];
    const rd = C.renderer;
    const prev = rd.getRenderTarget();
    rd.setRenderTarget(atlasRT);
    genQuad.render(rd);                  // the renderer generates the mip chain right after (generateMipmaps on the target)
    rd.setRenderTarget(prev);
  }

  function makeBuffers(max) {
    const g = new T3.InstancedBufferGeometry();
    const base = new T3.PlaneGeometry(2, 2);
    g.setIndex(base.getIndex());
    g.setAttribute('position', base.getAttribute('position'));
    const b = { n: 0, max, g, base, attrs: [] };
    const add = (name, size) => {
      const a = new T3.InstancedBufferAttribute(new Float32Array(max * size), size);
      a.setUsage(T3.DynamicDrawUsage);
      g.setAttribute(name, a);
      b[name] = a.array; b.attrs.push(a);
    };
    add('iPos', 3); add('iDir', 4); add('iShape', 4); add('iA', 4); add('iB', 4); add('iC', 4);
    g.instanceCount = 0;
    return b;
  }

  // Class of the sprites being pushed (1 = opening flame, 0 = column, its torn pieces, break-up), set by each layer before it
  // pushes; carried in the sign-free part of the flip value (|flip| = 1 + class), so no extra attribute is needed. The
  // composite turns the per-pixel class share into the layer's edge softness and glow (see COMPOSITE_FRAG).
  let CLS = 0;
  // Pass 5: how much the sprites being pushed cool where their own texture is cool (RIMC: rim, tip, cool streaks) and toward
  // their root end (ROOTC), 0..1, set by each layer before it pushes (iC.x / iC.y, see FLAME_FRAG_BODY)
  let RIMC = 0, ROOTC = 0, ROOTR = 0.12;
  // one flame sprite into the heat buffer (see FLAME_FRAG_BODY for the meaning of each value)
  function pushFlame(group, x, y, z, dx, dy, dz, len, wid, roll, cellA, cellB, blend, heat, erode, edge, cool, vio, flip, bulge) {
    if (solo !== 0 && solo !== group) return;
    const b = FB;
    if (b.n >= b.max || heat <= 1e-4 || wid <= 1e-5) return;
    const i = b.n++;
    let o = i * 3;
    b.iPos[o] = x; b.iPos[o + 1] = y; b.iPos[o + 2] = z;
    o = i * 4;
    b.iDir[o] = dx; b.iDir[o + 1] = dy; b.iDir[o + 2] = dz; b.iDir[o + 3] = len;
    b.iShape[o] = wid; b.iShape[o + 1] = roll; b.iShape[o + 2] = cellA; b.iShape[o + 3] = cellB;
    b.iA[o] = heat; b.iA[o + 1] = blend; b.iA[o + 2] = erode; b.iA[o + 3] = edge;
    b.iB[o] = cool; b.iB[o + 1] = vio; b.iB[o + 2] = flip * (1 + CLS); b.iB[o + 3] = bulge;
    b.iC[o] = RIMC; b.iC[o + 1] = ROOTC; b.iC[o + 2] = ROOTR; b.iC[o + 3] = 0;
    counts[group]++;
  }
  // one glow or spark (kind 1 glow, 2 spark; type indexes the glow uniforms)
  function pushGlow(group, kind, type, x, y, z, dx, dy, dz, len, wid, roll, intensity, seed01, age, extent, bulge, aspect = 0) {
    if (solo !== 0 && solo !== group) return;
    const b = GB;
    if (b.n >= b.max || intensity <= 1e-5 || wid <= 1e-6) return;
    const i = b.n++;
    let o = i * 3;
    b.iPos[o] = x; b.iPos[o + 1] = y; b.iPos[o + 2] = z;
    o = i * 4;
    b.iDir[o] = dx; b.iDir[o + 1] = dy; b.iDir[o + 2] = dz; b.iDir[o + 3] = len;
    b.iShape[o] = wid; b.iShape[o + 1] = roll; b.iShape[o + 2] = kind; b.iShape[o + 3] = type;
    b.iA[o] = intensity; b.iA[o + 1] = seed01; b.iA[o + 2] = age; b.iA[o + 3] = extent;
    b.iB[o] = aspect; b.iB[o + 1] = 0; b.iB[o + 2] = 0; b.iB[o + 3] = bulge;
    counts[group]++;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Frames (module-level scratch: nothing is allocated per frame)
  const S = { px: 0, py: 0, pz: 0, dx: 0, dy: 0, dz: 0, ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 };   // rifle frame
  const O = { x: 0, y: 0, z: 0 };        // flame origin (muzzle tip + originAhead)
  const VD = { x: 0, y: 0, z: 0 }, E1 = { x: 0, y: 0, z: 0 }, E2 = { x: 0, y: 0, z: 0 }, VT = { x: 0, y: 0, z: 0 };
  const AX = { x: 0, y: 0, z: 0 }, F1 = { x: 0, y: 0, z: 0 }, F2 = { x: 0, y: 0, z: 0 };
  // the onset lobes of the round being evaluated (for the sub-flames and tongues that hang off them)
  const LB = new Float64Array(5 * 3), LD = new Float64Array(5 * 3), LE1 = new Float64Array(5 * 3), LE2 = new Float64Array(5 * 3);
  const LLEN = new Float64Array(5), LW0 = new Float64Array(5), LW1 = new Float64Array(5), LH = new Float64Array(5);
  let nLobe = 0;
  // the column of the round being evaluated (base point, axis, height, width), for the tongues and flecks
  const CB = { x: 0, y: 0, z: 0 };
  let colH = 0, colW = 0;
  // the column's middle and axis this frame (colOk = the column layer ran for this round), for the halo that follows it
  const CC = { x: 0, y: 0, z: 0 }, CAX = { x: 0, y: 1, z: 0 }, CVT = { x: 1, y: 0, z: 0 }, CVD = { x: 0, y: 0, z: 1 };
  let colOk = false;

  // Gun-attached parts (core, puff, lobes, jet) follow the muzzle as drawn; the parts that stay in the air once they
  // are out (column, break-up, licks, sparks, glows) use the muzzle frame captured when the round was fired (r.F).
  const SL = { px: 0, py: 0, pz: 0, dx: 0, dy: 0, dz: 0, ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 };
  const FRAME_KEYS = ['px', 'py', 'pz', 'dx', 'dy', 'dz', 'ux', 'uy', 'uz', 'rx', 'ry', 'rz'];
  function copyFrame(dst, src) { for (let i = 0; i < 12; i++) dst[FRAME_KEYS[i]] = src[FRAME_KEYS[i]]; }
  function frameToArray(src, arr) { for (let i = 0; i < 12; i++) arr[i] = src[FRAME_KEYS[i]]; }
  function frameFromArray(dst, arr) { for (let i = 0; i < 12; i++) dst[FRAME_KEYS[i]] = arr[i]; }
  // cover-room: the range had ONE muzzle (ctx.muzzle); here every round keeps its own. setFrame() is the range's readFrames()
  // on given numbers: S = position, barrel direction, up (world up made perpendicular to the barrel; fu when firing straight up
  // or down) and right (barrel x up). liveFrame(r) evaluates the round's muzzle as drawn now: a followed Object3D (r.obj) with
  // the muzzle at local point r.lp, barrel along local direction r.ld, or (no object) the fixed world pos / dir in r.lp / r.ld.
  function setFrame(px, py, pz, dx, dy, dz, fux, fuy, fuz) {
    S.px = px; S.py = py; S.pz = pz;
    const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
    let ux = -dy * dx, uy = 1 - dy * dy, uz = -dy * dz;
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-3) { ux = fux; uy = fuy; uz = fuz; ul = Math.hypot(ux, uy, uz) || 1; }
    ux /= ul; uy /= ul; uz /= ul;
    S.dx = dx; S.dy = dy; S.dz = dz; S.ux = ux; S.uy = uy; S.uz = uz;
    S.rx = dy * uz - dz * uy; S.ry = dz * ux - dx * uz; S.rz = dx * uy - dy * ux;
  }
  function liveFrame(r) {
    const o = r.obj, p = r.lp, d = r.ld;
    if (!o) { setFrame(p.x, p.y, p.z, d.x, d.y, d.z, 0, 0, -1); return; }
    const e = o.matrixWorld.elements;
    setFrame(e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12], e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13], e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14],
      e[0] * d.x + e[4] * d.y + e[8] * d.z, e[1] * d.x + e[5] * d.y + e[9] * d.z, e[2] * d.x + e[6] * d.y + e[10] * d.z, e[4], e[5], e[6]);
  }


  // world direction from azimuth / pitch in the rifle frame (phi: 0 up, +90 deg right; th: 0 forward, 90 deg at right angles)
  function dirAP(phi, th, out) {
    const st = Math.sin(th), ct = Math.cos(th), cp = Math.cos(phi), sp = Math.sin(phi);
    out.x = ct * S.dx + st * (cp * S.ux + sp * S.rx);
    out.y = ct * S.dy + st * (cp * S.uy + sp * S.ry);
    out.z = ct * S.dz + st * (cp * S.uz + sp * S.rz);
  }
  // two unit vectors perpendicular to the unit vector v
  function perp(v, e1, e2) {
    let ax = 0, ay = 1, az = 0;
    if (Math.abs(v.y) > 0.8) { ax = 1; ay = 0; }
    let x = v.y * az - v.z * ay, y = v.z * ax - v.x * az, z = v.x * ay - v.y * ax;
    const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
    e1.x = x; e1.y = y; e1.z = z;
    e2.x = v.y * z - v.z * y; e2.y = v.z * x - v.x * z; e2.z = v.x * y - v.y * x;
  }
  function norm(v) { const l = Math.hypot(v.x, v.y, v.z) || 1; v.x /= l; v.y /= l; v.z /= l; }
  const billowCell = (seed, k) => CELL_BILLOW + ((hr(seed, k) * N_BILLOW) | 0);
  const clumpCell = (seed, k) => CELL_CLUMP + ((hr(seed, k) * N_CLUMP) | 0);
  const fleckCell = (seed, k) => CELL_FLECK + ((hr(seed, k) * N_FLECK) | 0);
  const tornCell = (seed, k) => CELL_TORN + ((hr(seed, k) * N_TORN) | 0);
  const lateCell = (seed, k) => CELL_LATE + ((hr(seed, k) * N_LATE) | 0);
  // pass 5b: the n-th late lick alternates the shapes: even = a broad forked tongue (cells 64-67), odd = a squat spiky leaf (68-71)
  const lateCellK = (seed, k, n) => CELL_LATE + ((n & 1) * 4) + ((hr(seed, k) * 4) | 0);
  const scrapCell = (seed, k) => CELL_SCRAP + ((hr(seed, k) * N_SCRAP) | 0);
  // ping-pong boil between two cells: smooth at any playback speed
  const boilBlend = (u, rate, ph) => 0.5 - 0.5 * Math.cos(TAU * (u * rate + ph));
  // flipbook of one lick variant: cell A = the frame at phase ph, cell B = the next one, blend = the fraction between them
  // (smooth at any playback speed). Results in LC, so nothing is allocated.
  const LC = { a: 0, b: 0, t: 0 };
  function lickCells(seed, k, ph) {
    const v = (hr(seed, k) * N_LICK) | 0;
    const fr = Math.floor(ph);
    LC.a = CELL_LICK + v * LICK_FRAMES + (fr % LICK_FRAMES);
    LC.b = CELL_LICK + v * LICK_FRAMES + ((fr + 1) % LICK_FRAMES);
    LC.t = ph - fr;
  }
  // One flame lick placed by its ROOT point, pointing along the unit direction (dx, dy, dz). len and wid are the lick's
  // VISIBLE length (root to tip) and belly width in metres: in the texture the lick spans 84% of the cell's length and about
  // 45% of its width, so the quad is len / 0.84 by wid / 0.45, centred half the length out from the root.
  function pushLick(group, rx, ry, rz, dx, dy, dz, len, wid, seed, k, ph, heat, erode, edge, cool, vio) {
    lickCells(seed, k, ph);
    const c = 0.5 * len, wq = wid / 0.45;
    pushFlame(group, rx + dx * c, ry + dy * c, rz + dz * c, dx, dy, dz, len / 0.84, wq, 0, LC.a, LC.b, LC.t, heat, erode, edge, cool, vio,
      hr(seed, k + 1) < 0.5 ? -1 : 1, wq * 0.4);
  }

  // ------------------------------------------------------------------------------------------------------------
  // The round's own timeline (fractions of the life): a burst-first shot uses the "Timeline: burst-first shots" keys, a late
  // shot the "Late:" keys of the Timeline folder. Filled per round before its layers are evaluated (no allocation).
  const TL = { puffEnd: 0, onsetPeak: 0, onsetEnd: 0, startSize: 1, onsetSize: 1, onsetHeat: 1, retract: 1, columnStart: 0,
    columnPeak: 0, columnEnd: 0, colSize: 1, colHt: 1, colDrop: 0, colWarm: 0, colFadeFrom: 0, tearN: 0, colHeat: 1, breakStart: 0, breakEnd: 0, layout: null, mainBirth: 0, remnant: 0,
    remnantEnd: 1, licksStart: 0, licksEnd: 0, rimAdd: 0 };
  function timeline(r) {
    const b = r.burst;
    TL.layout = LAYOUTS[b ? P['burst.layout'] : P['onset.layoutA']];
    TL.rimAdd = b ? P['burst.rimCool'] : 0;
    TL.mainBirth = b ? 0 : P['time.mainBirth'];
    TL.remnant = b ? 0 : P['onset.remnant'];
    TL.remnantEnd = P['time.remnantEnd'];
    TL.licksStart = b ? P['burst.licksStart'] : P['time.licksStart'];
    TL.licksEnd = Math.max(b ? P['burst.licksEnd'] : P['time.licksEnd'], TL.licksStart + 0.02);
    TL.puffEnd = P['time.puffEnd'];
    TL.onsetPeak = b ? P['burst.onsetPeak'] : P['time.onsetPeak'];
    TL.onsetEnd = Math.max(b ? P['burst.onsetEnd'] : P['time.onsetEnd'], TL.onsetPeak + 0.01);
    TL.startSize = b ? P['burst.startSize'] : P['onset.startSize'];
    TL.onsetSize = b ? P['burst.size'] : 1;
    TL.onsetHeat = b ? P['burst.heat'] : 1;
    TL.retract = b ? P['burst.retract'] : P['onset.retract'];
    TL.columnStart = b ? P['burst.columnStart'] : P['time.columnStart'];
    TL.columnPeak = b ? P['burst.columnPeak'] : P['time.columnPeak'];
    TL.columnEnd = b ? P['burst.columnEnd'] : P['time.columnEnd'];
    TL.colSize = b ? P['burst.columnSize'] : 1;
    TL.colHt = b ? P['burst.columnHeight'] : 1;
    // pass 5b: a burst-first shot's column (the ball left after its opening collapses) has its own depth below the muzzle (the
    // game's +15 is a white ball ON the muzzle; the late column's 23 cm x the burst size hung it under the barrel), its own
    // cooling and its own torn-piece count (0: on burst shots the pieces popped in beside the gun, floating)
    TL.colDrop = b ? P['burst.columnDrop'] : P['column.baseDrop'];
    TL.colWarm = b ? P['burst.columnWarm'] : 0;
    // pass 5c (Max: burst-first shots hold at 1x like the game pistol): the burst column breaks up (thins, erodes, cools) from its
    // own moment, so its fall can be shaped without moving the break-up glare and sparks (which keep "Break-up starts")
    TL.colFadeFrom = b ? Math.min(P['burst.columnFadeFrom'], P['burst.breakStart']) : P['time.breakStart'];
    TL.tearN = b ? P['burst.tearCount'] | 0 : P['tear.count'] | 0;
    TL.colHeat = b ? P['burst.columnHeat'] : 1;
    TL.breakStart = b ? P['burst.breakStart'] : P['time.breakStart'];
    TL.breakEnd = Math.max(b ? P['burst.breakEnd'] : P['time.breakEnd'], TL.breakStart + 0.02);
  }

  // Envelopes shared by the layers (fractions of the life). Pass 5: the opening lobes no longer share one envelope (Max: parts
  // fade in and out at their own times). The MAIN lobe (the hottest side lobe of the layout, AK: the right one) and the jet are
  // the forward mass that becomes the column: on late shots they appear at "main lobe from" (AK 01: no right mass at +1, 24k px
  // at +2) and hand over to the column. The other (SIDE) lobes open with the puff, peak, then fall to a remnant that lingers
  // ("side lobes linger as a remnant", AK 01's left lobe: 21k -> 2.6k -> 1.1k -> 1.1k px over +2..+5) and is gone by
  // "remnant gone by". Burst-first shots open everything at once and keep no remnant.
  const ENV = { onset: 0, side: 0, sideSize: 0, sideFall: 0, main: 0, mainSize: 0, column: 0, bk: 0, bkCol: 0, flame: 0, puff: 0 };
  function envelopes(r, u) {
    const tPuff = TL.puffEnd, tPeak = TL.onsetPeak, tEnd = TL.onsetEnd;
    const t0 = r.puff ? tPuff * 0.5 : 0;
    const g0 = TL.startSize;
    const on = P['onset.on'];
    const grow = g0 + (1 - g0) * smooth(t0, Math.max(tPeak, t0 + 0.02), u);
    const fall = smooth(tPeak, tEnd, u);
    const birth = r.puff ? smooth(t0 - 0.02, t0 + 0.04, u) : 1;
    // side lobes: peak, then down to the remnant level, held, gone by remnantEnd
    const rem = TL.remnant;
    let side = lerp(1, rem, fall);
    if (rem > 0) side *= 1 - smooth(TL.remnantEnd - 0.05, TL.remnantEnd, u);
    ENV.side = on ? side * birth : 0;
    ENV.sideFall = fall;
    ENV.sideSize = grow * lerp(1, TL.retract, fall) * r.scale * TL.onsetSize;
    // the main lobe: appears at mainBirth (late shots), largest at the lobes' peak, gone by onsetEnd as the column takes over
    const mb = TL.mainBirth;
    const mBirth = mb > 0 ? smooth(mb - 0.03, mb + 0.04, u) : birth;
    const mGrow = mb > 0 ? g0 + (1 - g0) * smooth(mb, Math.max(tPeak, mb + 0.02), u) : grow;
    ENV.main = on ? (1 - fall) * mBirth : 0;
    ENV.mainSize = mGrow * lerp(1, TL.retract, fall) * r.scale * TL.onsetSize;
    // the opening's presence (core, glow, halo, band width): its full lobes, not the lingering remnant
    ENV.onset = on ? Math.max((1 - fall) * birth, ENV.main) : 0;
    const tC0 = TL.columnStart, tCE = TL.columnEnd;
    const cIn = smooth(tC0, tC0 + 0.05, u);
    const cOut = 1 - smooth(Math.max(tCE - 0.08, tC0), tCE, u);
    ENV.column = P['column.on'] ? cIn * cOut : 0;
    ENV.bk = P['breakup.on'] ? smooth(TL.breakStart, TL.breakEnd, u) : 0;
    ENV.bkCol = P['breakup.on'] ? smooth(TL.colFadeFrom, TL.breakEnd, u) : 0;      // the column's own break-up (5c)
    const puffA = r.puff && P['onset.on'] ? 1 - smooth(tPuff * 0.6, tPuff * 1.5, u) : 0;
    ENV.puff = puffA;
    ENV.flame = Math.max(ENV.onset, ENV.column * (1 - 0.6 * ENV.bk), puffA);
  }

  // The opening flames' glow (their bloom weight) for the frame being drawn: raised at birth ("Opening glow at birth"), down to
  // "Opening flames: glow" by "Birth glow gone by", and back to the column's bloom as the opening flames go. One value per frame
  // (a uniform), taken from the round whose opening flames are most present (rounds' openings never overlap at <= 1500 rpm).
  // Pass 5: the same presence also sets the opening flames' colour band width and edge softness for the frame: as they fade
  // ("Fading opening: bands and edge tighten") both move toward the column's, so a fading opening flame erodes inside a crisp
  // edge instead of leaving wide, flat, translucent sheets (the critic's "faceted sheets" at 16-22 ms).
  let glowNow = 0, glowPres = 0, bandNow = 1, softNow = 1;
  function resetOnsetLevels() {
    const f = P['color.bandFade'];
    glowNow = P['color.bloom']; glowPres = 0;
    bandNow = lerp(P['color.onsetBand'], P['color.columnBand'], f);
    softNow = lerp(P['color.onsetSoft'], P['color.columnSoft'], f);
  }
  function onsetGlowLevel(u) {
    const fade = P['color.onsetGlowFade'];
    const og = P['color.onsetGlow'] * (1 + (P['color.onsetGlowBirth'] - 1) * (1 - smooth(0.5 * fade, fade, u)));
    const pres = Math.max(ENV.onset, ENV.puff);
    if (pres > glowPres) {
      glowPres = pres; glowNow = lerp(P['color.bloom'], og, pres);
      const f = P['color.bandFade'] * (1 - pres);
      bandNow = lerp(P['color.onsetBand'], P['color.columnBand'], f);
      softNow = lerp(P['color.onsetSoft'], P['color.columnSoft'], f);
    }
  }

  // Fading a defined flame: with "Fade by erosion" at 1 a flame keeps its heat and is eaten from its edges and holes as its
  // envelope falls (crisp shrinking, the alpha-erosion trick for flipbook fire); at 0 it dims instead. FH = heat factor,
  // FE = erosion level added to the sprite's own.
  let FH = 1, FE = 0;
  function fadeOut(env) {
    const ef = P['color.erodeFade'];
    const e = clamp01(env);
    FH = Math.pow(e, 1 - ef);
    FE = ef * (1 - e) * 0.95;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Layers. Each reads the round (r), the life fraction u, the age (s) and writes sprites.
  function emitCore(r, u) {
    CLS = 1; RIMC = Math.min(P['color.onsetRimCool'] + TL.rimAdd, 1); ROOTC = 0;
    const cs = P['onset.coreSize'] * CM * r.scale;
    const ce = Math.max(ENV.onset, ENV.column * (1 - ENV.bk));
    if (cs <= 0 || ce <= 0.002) return;
    fadeOut(ce);
    const h = P['onset.coreHeat'] * TL.onsetHeat * FH;
    const seed = r.seed;
    for (let k = 0; k < 2; k++) {
      const a = (k + 1) * 0.025;
      const w = cs * (k === 0 ? 1 : 0.7);
      pushFlame(G_CORE, O.x + S.dx * a, O.y + S.dy * a, O.z + S.dz * a, 0, 0, 0, 0, w, hr(seed, 50 + k) * TAU,
        billowCell(seed, 52 + k), billowCell(seed, 54 + k), boilBlend(u, P['onset.boil'], hr(seed, 56 + k)),
        h * (k === 0 ? 1 : 0.8), FE, 0.12, 0, 0, hr(seed, 58 + k) < 0.5 ? -1 : 1, w * 0.5);
    }
  }

  // The opening puff (late shots, AK 01 +0 / +1). Pass 5: taller than wide ("Puff height", the game's +0 puff reaches 145 px
  // above and 110 below the muzzle) and hung a little below the muzzle ("Puff centre below the muzzle"); its billows are
  // stretched along the rifle's up axis (kept upright: only a small roll).
  function emitPuff(r, u) {
    if (!r.puff || !P['onset.on']) return;
    CLS = 1; RIMC = P['onset.puffRim']; ROOTC = 0;     // the game's +0 puff: a red-orange rim beside its lavender one
    const tPuff = TL.puffEnd;
    const pa = 1 - smooth(tPuff * 0.45, tPuff * 1.5, u);
    if (pa <= 0.002) return;
    const seed = r.seed;
    // pass 5: full size from its first frame (the game's puff is largest at +0, 90 % of that at +1), sinking as it opens
    // (relative to the muzzle: AK 01's puff centre moves from 17 px above the muzzle at +0 to 19 px below at +1)
    const pr = P['onset.puffSize'] * 0.5 * CM * lerp(1, r.scale, 0.5);
    const ph = P['onset.puffHeight'], pd = (P['onset.puffDrop'] + P['onset.puffSink'] * smooth(0, tPuff, u)) * CM;
    const K = P['onset.puffSprites'] | 0;
    fadeOut(pa);
    const heat = P['onset.heat'] * P['onset.puffHeat'] * FH;
    const fShare = P['onset.puffFringeShare'];
    // pass 5c: the violet fringe belongs to the puff's first moment (AK 01: lavender 21 % of the flame at +0, 6 % at +1)
    const vFade = 1 - P['onset.puffFringeFade'] * smooth(tPuff * 0.2, tPuff * 0.8, u);
    const cx = O.x + S.dx * pr * 0.1 - S.ux * pd, cy = O.y + S.dy * pr * 0.1 - S.uy * pd, cz = O.z + S.dz * pr * 0.1 - S.uz * pd;
    for (let j = 0; j < K; j++) {
      const k = 600 + j * 8;
      const a1 = hr(seed, k) * TAU, z1 = hr(seed, k + 1) * 2 - 1, rr = Math.cbrt(hr(seed, k + 2)) * 0.3 * pr;
      const s1 = Math.sqrt(Math.max(1 - z1 * z1, 0));
      // an ellipsoid of sprite centres: the rifle's up axis stretched by the puff height
      const oR = s1 * Math.cos(a1) * rr, oU = s1 * Math.sin(a1) * rr * ph, oF = z1 * rr;
      // pass 5b: the violet fringe on the billows of the right side, the warm fringe on the rest (signed sums of overlapping
      // billows cancel, so a side split keeps both colours visible); the share moves the boundary
      const violet = oR + 0.12 * pr * (hr(seed, k + 9) - 0.5) > (0.5 - fShare) * 0.4 * pr;
      const x = cx + S.rx * oR + S.ux * oU + S.dx * oF, y = cy + S.ry * oR + S.uy * oU + S.dy * oF, z = cz + S.rz * oR + S.uz * oU + S.dz * oF;
      const w = pr * (1.05 + 0.45 * hr(seed, k + 3));
      pushFlame(G_PUFF, x, y, z, S.ux, S.uy, S.uz, w * ph, w, (hr(seed, k + 4) - 0.5) * 0.5, billowCell(seed, k + 5), billowCell(seed, k + 6),
        boilBlend(u, P['onset.boil'], hr(seed, k + 7)), heat, FE, 0.12, 0, violet ? P['onset.puffFringe'] * vFade : -P['onset.puffWarmFringe'],
        hr(seed, k + 3) < 0.5 ? -1 : 1, w * 0.45);
    }
    // a tongue licking up off the puff's top in its first moment (AK 01 +0: a narrow flame above the ball, gone by +1)
    const tg = P['onset.puffTongue'] * CM * lerp(1, r.scale, 0.5) * (1 - smooth(tPuff * 0.25, tPuff * 0.6, u));
    if (tg > 0.005) {
      const rb = pr * ph * 0.30;
      pushLick(G_PUFF, cx + S.ux * rb, cy + S.uy * rb, cz + S.uz * rb, S.ux, S.uy, S.uz, tg, tg * 0.4, seed, 680,
        u * P['lick.flicker'] + hr(seed, 681) * 4, heat * 0.8, FE, 0.12, 0, P['onset.puffFringe'] * 0.5);
    }
  }

  // per-lobe fade values of the round being evaluated (pass 5: each lobe has its own envelope), for its sub-flames and tongues
  const LFH = new Float64Array(5), LFE = new Float64Array(5), LSZ = new Float64Array(5), LCL = new Float64Array(5);
  function emitOnset(r, u) {
    nLobe = 0;
    CLS = 1; ROOTC = 0;
    if (ENV.main <= 0.002 && ENV.side <= 0.002) return;
    const seed = r.seed;
    const rag = P['onset.raggedness'];
    const heat = P['onset.heat'] * TL.onsetHeat;
    const L = P['onset.length'] * CM, W = P['onset.width'] * CM, J = P['onset.jetLength'] * CM, JW = P['onset.jetWidth'] * CM;
    const A = TL.layout, B = LAYOUTS[P['onset.layoutB']], bl = P['onset.blend'];
    const count = P['onset.lobeCount'] | 0;
    const N = Math.max(1, P['onset.spritesPerLobe'] | 0);
    const nNorm = Math.sqrt(5 / N);
    const spread = P['onset.spread'] * DEG;
    const flick = P['lick.flicker'];
    const rim0 = Math.min(P['color.onsetRimCool'] + TL.rimAdd, 1);
    // the side lobes' remnant cools to orange as they fall (AK 01's left-lobe scrap at 23 ms: see-through and orange). Pass 5b:
    // the cooling is complete by the middle of the fall, so it reaches the remnant's core (with partial cooling the composite
    // keeps a hot core white), and the remnant loses heat ("the remnant's heat"), so it shrinks into a small scrap
    const fallMid = smooth(TL.onsetPeak, lerp(TL.onsetPeak, TL.onsetEnd, 0.5), u);
    const remCool = TL.remnant > 0 ? P['onset.remnantCool'] * fallMid : 0;
    const remHeat = TL.remnant > 0 ? lerp(1, P['onset.remnantHeat'], fallMid) : 1;
    // stretch with age: the licks lengthen from birth until the onset lobes are gone, the longer (faster) ones the most
    const st = P['onset.stretch'] * clamp01(u / Math.max(TL.onsetEnd, 0.05));
    // the hottest side lobe always shows (the MAIN lobe: on late shots it is the forward mass that becomes the column); the
    // others appear on "lobe chance" % of shots, the jet on "jet chance" %
    let main = -1, mainH = 0;
    for (let i = 0; i < 5; i++) {
      const th = lerp(A[i][1], B[i][1], bl), lh = lerp(A[i][5], B[i][5], bl);
      if (th >= 30 && lh > mainH && !(count > 0 && i >= count)) { mainH = lh; main = i; }
    }
    for (let i = 0; i < 5; i++) {
      const a = A[i], b = B[i];
      const lh = lerp(a[5], b[5], bl);
      if (lh <= 0.001 || (count > 0 && i >= count)) continue;
      const phi = lerp(a[0], b[0], bl) * DEG + r.roll, th = lerp(a[1], b[1], bl) * DEG;
      const isJet = th < 30 * DEG;
      if (i !== main && hr(seed, 40 + i) * 100 >= (isJet ? P['onset.jetChance'] : P['onset.lobeChance'])) continue;
      const own = i === main || isJet;                          // the main lobe and the jet: the forward mass
      const env = own ? ENV.main : ENV.side;
      if (env <= 0.002) continue;
      const size = own ? ENV.mainSize : ENV.sideSize;
      fadeOut(env);
      // pass 5c: the side lobes' remnant also erodes into holes as it fades (it read as a flat, even sheet)
      const erode0 = 0.10 * rag + FE + (own || TL.remnant <= 0 ? 0 : P['onset.remnantErode'] * fallMid);
      const envH = FH * (own ? 1 : remHeat);
      const cool0 = own ? 0 : remCool;
      RIMC = rim0;
      const lj = 1 + (r.rnd[3 + i] * 2 - 1) * P['onset.scaleJitter'] / 100 * 0.6;
      const len = lerp(a[2], b[2], bl) * (isJet ? J : L) * size * lj;
      const wb = (isJet ? JW : W) * size * lj;
      const w0 = lerp(a[3], b[3], bl) * wb, w1 = lerp(a[4], b[4], bl) * wb;
      dirAP(phi, th, VD);
      perp(VD, E1, E2);
      const oR = lerp(a[6], b[6], bl) * L * size, oU = lerp(a[7], b[7], bl) * L * size;
      const bx = O.x + S.rx * oR + S.ux * oU, by = O.y + S.ry * oR + S.uy * oU, bz = O.z + S.rz * oR + S.uz * oU;
      const li = nLobe++;
      LB[li * 3] = bx; LB[li * 3 + 1] = by; LB[li * 3 + 2] = bz;
      LD[li * 3] = VD.x; LD[li * 3 + 1] = VD.y; LD[li * 3 + 2] = VD.z;
      LE1[li * 3] = E1.x; LE1[li * 3 + 1] = E1.y; LE1[li * 3 + 2] = E1.z;
      LE2[li * 3] = E2.x; LE2[li * 3 + 1] = E2.y; LE2[li * 3 + 2] = E2.z;
      LLEN[li] = len; LW0[li] = w0; LW1[li] = w1; LH[li] = lh * (isJet ? 0.6 : 1);
      LFH[li] = envH; LFE[li] = FE; LSZ[li] = size; LCL[li] = cool0;
      // the fan plane: the licks of a side lobe open about the (barrel x lobe) axis, so seen from behind they spread up and down
      // across the screen; a jet (along the barrel) fans about its own perpendicular
      let tx = S.dy * VD.z - S.dz * VD.y, ty = S.dz * VD.x - S.dx * VD.z, tz = S.dx * VD.y - S.dy * VD.x;
      const tn = Math.hypot(tx, ty, tz);
      if (tn < 0.2) { tx = E1.x; ty = E1.y; tz = E1.z; } else { tx /= tn; ty /= tn; tz /= tn; }
      const group = isJet ? G_JET : G_LOBE;
      const lw = lerp(w0, w1, 0.4) * P['onset.rootWidth'];
      const ll = len * P['onset.lickLength'];
      const sp = isJet ? spread * 0.4 : spread;
      for (let j = 0; j < N; j++) {
        const k = 100 + i * 97 + j * 9;
        // lick j: placed evenly across the fan (jittered), tipped a little forward or back, length varied (the longer, faster
        // licks stretch the most with age), its root spread across the lobe's base
        const fan = (N === 1 ? 0 : (j / (N - 1)) * 2 - 1) * 0.75 + (hr(seed, k) - 0.5) * 0.5;
        const ta = Math.tan(fan * sp), fw = (hr(seed, k + 2) - 0.4) * 0.35 * Math.sin(th);
        let dx = VD.x + tx * ta + S.dx * fw, dy = VD.y + ty * ta + S.dy * fw, dz = VD.z + tz * ta + S.dz * fw;
        const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
        const f = 0.62 + 0.4 * hr(seed, k + 3);
        const lk = ll * f * (1 + st * f);
        const wj = lw * (0.75 + 0.35 * hr(seed, k + 4));
        const ro = fan * 0.22 * lw * (0.5 + 0.6 * rag);
        const hm = heat * lh * envH * nNorm * (0.9 + 0.2 * hr(seed, k + 5));
        // the jet's longest licks cool toward orange at their tips (02's smoky ring); a side lobe's remnant cools as it falls
        const cool = isJet ? P['onset.jetTip'] * smooth(0.75, 1.0, f) : cool0;
        pushLick(group, bx + tx * ro, by + ty * ro, bz + tz * ro, dx, dy, dz, lk, wj, seed, k + 6, u * flick + hr(seed, k + 7) * 4,
          hm, erode0, 0.12, cool, 0);
      }
      // the jet's smoky tip (02's orange-brown ring): a torn piece at the end of the jet, already cooled to orange, scaled by
      // "Jet tip cools" (the licks' own cooling can't show there: their overlapping roots keep the jet's body white)
      if (isJet && P['onset.jetTip'] > 0.01) {
        const k = 100 + i * 97 + 80;
        const e = 1.08 * ll * (1 + st);                    // just past the longest lick's tip (f <= 1.02, stretched by 1 + st)
        pushFlame(group, bx + VD.x * e, by + VD.y * e, bz + VD.z * e, VD.x, VD.y, VD.z, 0.4 * ll, 1.2 * lw, 0,
          tornCell(seed, k), tornCell(seed, k + 1), 0.3, heat * lh * envH * nNorm * 0.6 * P['onset.jetTip'], erode0, 0.12, 1, 0,
          hr(seed, k + 2) < 0.5 ? -1 : 1, 0.4 * lw);
      }
    }
    if (nLobe === 0) return;
    // sub-flames: smaller licks hugging the lobes' edges and bridging the gaps between them near the muzzle, pointing out of the
    // muzzle (the flow); every fifth is a small star-shaped scrap partly torn off the lobe's edge
    const F = P['onset.fill'] | 0;
    for (let f = 0; f < F; f++) {
      const k = 1000 + f * 9;
      const li = Math.min(nLobe - 1, (hr(seed, k) * nLobe) | 0);
      const hs = hr(seed, k + 1);
      const s = 0.02 + 0.9 * hs * hs;                     // more of them near the lobe bases, where the lobes meet
      const w = lerp(LW0[li], LW1[li], s);
      const ang = hr(seed, k + 2) * TAU, ca = Math.cos(ang), sa = Math.sin(ang);
      const detached = f % 5 === 4;
      const off = (detached ? 0.5 + 0.25 * hr(seed, k + 3) : 0.30 + 0.30 * hr(seed, k + 3)) * w * (0.6 + 0.6 * rag);
      const o3 = li * 3, ln = LLEN[li] * s;
      const x = LB[o3] + LD[o3] * ln + (LE1[o3] * ca + LE2[o3] * sa) * off;
      const y = LB[o3 + 1] + LD[o3 + 1] * ln + (LE1[o3 + 1] * ca + LE2[o3 + 1] * sa) * off;
      const z = LB[o3 + 2] + LD[o3 + 2] * ln + (LE1[o3 + 2] * ca + LE2[o3 + 2] * sa) * off;
      // (each hangs off its lobe and fades with that lobe's own envelope)
      const fh = heat * LH[li] * LFH[li] * (detached ? 0.7 : 0.8) * (1.1 - 0.4 * s);
      if (detached) {
        const fw = P['onset.fillSize'] * w * (0.6 + 0.7 * hr(seed, k + 4)) * 0.4;
        pushFlame(G_FILL, x, y, z, 0, 0, 0, 0, fw, hr(seed, k + 5) * TAU, fleckCell(seed, k + 6), fleckCell(seed, k + 7), 0,
          fh, 0.12 * rag + LFE[li], 0.12, Math.max(0.15, LCL[li]), 0, hr(seed, k + 3) < 0.5 ? -1 : 1, fw * 0.45);
        continue;
      }
      // the flow here: out of the muzzle through this point, rising a little; the root sits back toward the muzzle, inside the
      // lobe body, so the lick grows out of it
      VT.x = x - O.x; VT.y = y - O.y + 0.25 * w; VT.z = z - O.z;
      norm(VT);
      const fl = P['onset.fillSize'] * w * (1.1 + 1.0 * hr(seed, k + 4)) * (1 + st);
      const back = 0.3 * fl;
      pushLick(G_FILL, x - VT.x * back, y - VT.y * back, z - VT.z * back, VT.x, VT.y, VT.z, fl, fl * 0.55, seed, k + 5,
        u * flick + hr(seed, k + 8) * 4, fh, 0.12 * rag + LFE[li], 0.12, Math.max(0.05, LCL[li]), 0);
    }
    // edge tongues: licks rooted inside the lobes' outer halves that lick out through the outline (outward and up: flames rise)
    const T = P['onset.tongues'] | 0;
    for (let t = 0; t < T; t++) {
      const k = 1500 + t * 11;
      const li = Math.min(nLobe - 1, (hr(seed, k) * nLobe) | 0);
      const s = 0.45 + 0.55 * hr(seed, k + 1);
      const w = lerp(LW0[li], LW1[li], Math.min(s, 1));
      const ang = hr(seed, k + 2) * TAU, ca = Math.cos(ang), sa = Math.sin(ang);
      const o3 = li * 3, ln = LLEN[li] * Math.min(s, 1);
      VT.x = LE1[o3] * ca + LE2[o3] * sa; VT.y = LE1[o3 + 1] * ca + LE2[o3 + 1] * sa; VT.z = LE1[o3 + 2] * ca + LE2[o3 + 2] * sa;
      const bx = LB[o3] + LD[o3] * ln + VT.x * 0.15 * w, by = LB[o3 + 1] + LD[o3 + 1] * ln + VT.y * 0.15 * w, bz = LB[o3 + 2] + LD[o3 + 2] * ln + VT.z * 0.15 * w;
      AX.x = LD[o3] * 0.55 + VT.x * 0.6; AX.y = LD[o3 + 1] * 0.55 + VT.y * 0.6 + 0.35; AX.z = LD[o3 + 2] * 0.55 + VT.z * 0.6;
      norm(AX);
      const tl = P['onset.tongueLength'] * CM * LSZ[li] * (0.65 + 0.7 * hr(seed, k + 3)) * (0.6 + 0.5 * rag) * (1 + st);
      pushLick(G_LTONGUE, bx, by, bz, AX.x, AX.y, AX.z, tl, tl * P['lick.tongueWidth'], seed, k + 4,
        u * flick + hr(seed, k + 5) * 4, heat * LH[li] * LFH[li] * 0.85, 0.06 * rag + LFE[li], 0.12, Math.max(0.12, LCL[li]), 0);
    }
  }

  function emitColumn(r, u, life) {
    const env = ENV.column;
    CLS = 0;
    if (!P['column.on']) return;
    const seed = r.seed;
    const bk = ENV.bkCol;
    const rag = P['onset.raggedness'];
    const tC0 = TL.columnStart, tCP = TL.columnPeak, tCE = TL.columnEnd, tB0 = TL.breakStart;
    const g0 = P['column.startSize'];
    const grow = (g0 + (1 - g0) * smooth(tC0, tCP, u)) * (1 + P['breakup.expand'] / 100 * bk) * TL.colSize;
    // pass 5: the width follows the growth only by "Width follows the growth" (AK 01's tall flame keeps its width, ~120 px, and
    // gets LONGER from +3 to +5: 281 / 327 / 370 px)
    const gw = Math.pow(Math.max(g0 + (1 - g0) * smooth(tC0, tCP, u), 1e-3), P['column.widthGrows']) * (1 + P['breakup.expand'] / 100 * bk) * TL.colSize;
    const Wd = P['column.width'] * CM * gw * r.scale;
    const Ht = P['column.height'] * CM * grow * r.scale * TL.colHt;
    const shape = P['column.shape'];
    // pass 5: the base hangs at its full depth from the start (AK 01: 120-126 px below the muzzle from +1 to +5, the right-hand
    // mass at +2 keeps its low base and climbs into the column), so a growing column gets LONGER, its tip rising
    const drop = TL.colDrop * CM * r.scale;
    const lean = P['column.lean'] * DEG + (r.rnd[8] * 2 - 1) * 0.12;
    // axis: world up leaning toward the barrel direction
    AX.x = Math.sin(lean) * S.dx; AX.y = Math.cos(lean) + Math.sin(lean) * S.dy; AX.z = Math.sin(lean) * S.dz;
    norm(AX);
    perp(AX, F1, F2);
    const tb = Math.max(u - tB0, 0) * life;
    const fwd = P['column.driftForward'] * CM * clamp01((u - tC0) / Math.max(1 - tC0, 0.05)) + P['breakup.drift'] * tb;
    const rise = P['breakup.rise'] * tb;
    const offR = P['column.offsetRight'] * CM;
    // column base point (below the muzzle line) and the fireball centre (ahead of the muzzle)
    const bx = O.x + S.rx * offR + S.dx * fwd, by = O.y - drop + S.ry * offR + S.dy * fwd + rise, bz = O.z + S.rz * offR + S.dz * fwd;
    const cxb = O.x + S.rx * offR + S.dx * (fwd + Wd * 0.45), cyb = O.y + S.ry * offR + S.dy * (fwd + Wd * 0.45) + rise, czb = O.z + S.rz * offR + S.dz * (fwd + Wd * 0.45);
    CB.x = lerp(bx, cxb, shape); CB.y = lerp(by, cyb - Wd * 0.45, shape); CB.z = lerp(bz, czb, shape);
    colH = lerp(Ht, Wd * 0.9, shape); colW = Wd;
    CC.x = CB.x + AX.x * colH * 0.45; CC.y = CB.y + AX.y * colH * 0.45; CC.z = CB.z + AX.z * colH * 0.45;
    // the column licks fan across the screen seen from behind: the barrel's right vector made perpendicular to the axis (VT),
    // and the depth direction AX x VT (VD)
    const rd = S.rx * AX.x + S.ry * AX.y + S.rz * AX.z;
    VT.x = S.rx - AX.x * rd; VT.y = S.ry - AX.y * rd; VT.z = S.rz - AX.z * rd;
    norm(VT);
    VD.x = AX.y * VT.z - AX.z * VT.y; VD.y = AX.z * VT.x - AX.x * VT.z; VD.z = AX.x * VT.y - AX.y * VT.x;
    // the frame stays known after the column is gone, for the torn pieces (emitTear) and the halo
    CAX.x = AX.x; CAX.y = AX.y; CAX.z = AX.z; CVT.x = VT.x; CVT.y = VT.y; CVT.z = VT.z; CVD.x = VD.x; CVD.y = VD.y; CVD.z = VD.z;
    colOk = true;
    if (env <= 0.002) return;
    fadeOut(env);
    const heat = P['column.heat'] * TL.colHeat * FH * (1 - 0.65 * bk);
    const warm = P['column.warmTint'] * smooth(tC0, tCE, u);
    // pass 5: the column cools gradually at its rims and tips (more as it ages: its top warms #FFE1A4 -> #FBD093 -> #F1C48B in
    // AK 01) and at its base below the muzzle (salmon), while its summed core stays white
    const rimC = Math.min(lerp(P['column.rimCoolStart'], P['column.rimCool'], smooth(tC0, tCE, u)) + TL.rimAdd, 1);
    RIMC = rimC; ROOTC = 0;
    const erode = Math.min(bk * P['breakup.erosion'] + 0.08 * rag + FE, 1);
    const edge = P['breakup.softness'];
    const N = Math.max(1, P['column.sprites'] | 0);
    const nNorm = Math.sqrt(10 / N);
    const flick = P['lick.flicker'];
    const cs = P['column.spread'] * DEG;
    // stretch with age: the body licks lengthen from the column's start to its end
    const st = P['column.stretch'] * clamp01((u - tC0) / Math.max(tCE - tC0, 0.05));
    // holes: from the tearing's start, the licks on the column's right and lower side are eaten away (their holes, edges and
    // tips first): a ragged, holed flank where the pieces tear off
    const tT0 = tC0 + P['tear.start'] * Math.max(tCE - tC0, 0.05);
    const holes = P['tear.on'] ? P['tear.holes'] * smooth(tT0, tT0 + 0.12, u) : 0;
    for (let j = 0; j < N; j++) {
      const k = 2000 + j * 9;
      const s = (j + 0.3 + 0.4 * hr(seed, k)) / N;                    // across the base (licks) / up the body (fireball)
      if (shape < 0.5) {
        // a body lick. The roots climb the stem (h = 0 at the base .. 0.5 of the height) and alternate sides; the low ones
        // are narrow ("Base width"), the high ones wide, and every lick rises along the axis tilted out by up to +-spread,
        // reaching the column's top (lick length): together one tall column, narrow at the muzzle and widest about two
        // thirds up, crowned by the licks' torn tips (AK +3..+5)
        const h = 0.5 * s;
        const side = (j & 1) ? 1 : -1;
        const across = side * (0.25 + 0.75 * hr(seed, k + 1));
        const wf = lerp(P['column.baseWidth'], 1, smooth(0.05, 0.35, h));
        const ro = across * 0.18 * Wd * wf, rdp = (hr(seed, k + 2) - 0.5) * 0.15 * Wd;
        const ta = Math.tan(across * cs);
        let dx = AX.x + VT.x * ta, dy = AX.y + VT.y * ta, dz = AX.z + VT.z * ta;
        const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
        const f = 0.8 + 0.2 * hr(seed, k + 3);
        const len = Math.max(Ht * (1 - h) * P['column.lickLength'] * f * (1 + st * f) - 0.25 * Ht * Math.abs(across) * (1 - h), 0.02);
        const w = Wd * P['column.lickWidth'] * wf * (0.8 + 0.3 * hr(seed, k + 4));
        const cool = Math.max(warm * (0.35 + 0.4 * hr(seed, k + 7)), bk, TL.colWarm * (0.6 + 0.4 * hr(seed, k + 7)));
        const eh = holes * clamp01(0.4 + across) * (1 - 0.6 * smooth(0.15, 0.5, h)) * smooth(0.02, 0.12, h);    // the right flank the most, not the base (5b)
        ROOTC = lerp(P['column.baseCool'], P['column.baseCoolEnd'], smooth(tC0, tCE, u)) * (1 - smooth(0.04, 0.2, h));   // the low licks' roots: the base
        ROOTR = P['column.baseCoolReach'];
        pushLick(G_COL, bx + AX.x * h * Ht + VT.x * ro + VD.x * rdp, by + AX.y * h * Ht + VT.y * ro + VD.y * rdp,
          bz + AX.z * h * Ht + VT.z * ro + VD.z * rdp, dx, dy, dz, len, w,
          seed, k + 5, u * flick + hr(seed, k + 6) * 4, heat * 1.1 * nNorm * (1 - 0.35 * eh), Math.min(erode + 0.8 * eh, 1), edge, cool, 0);
        continue;
      }
      // the fireball (shape 1, the 02 jet's): round billows packed into a ball ahead of the muzzle, tearing into clumps
      const prof = lerp(P['column.baseWidth'], 1, smooth(0, 0.35, s)) * (1 - 0.3 * smooth(0.7, 1.0, s));
      const w = Wd * lerp(prof, 0.78, shape) * (0.75 + 0.5 * hr(seed, k + 1));
      const sc = 0.2 * Wd * (0.5 + rag);
      const ox = (hr(seed, k + 2) - 0.5) * 2 * sc, oy = (hr(seed, k + 3) - 0.5) * 2 * sc;
      const hgt = Math.max(Ht - w * 0.6, 0) * s + w * 0.3;
      let x = bx + AX.x * hgt + F1.x * ox + F2.x * oy, y = by + AX.y * hgt + F1.y * ox + F2.y * oy, z = bz + AX.z * hgt + F1.z * ox + F2.z * oy;
      const a1 = hr(seed, k + 4) * TAU, z1 = hr(seed, k + 5) * 2 - 1, rr = Math.cbrt(hr(seed, k + 6)) * 0.36 * Wd;
      const s1 = Math.sqrt(Math.max(1 - z1 * z1, 0));
      x = lerp(x, cxb + s1 * Math.cos(a1) * rr, shape); y = lerp(y, cyb + s1 * Math.sin(a1) * rr, shape); z = lerp(z, czb + z1 * rr, shape);
      const cool = Math.max(warm * (0.25 + 0.75 * s), bk);
      pushFlame(G_COL, x, y, z, 0, 0, 0, 0, w, hr(seed, k + 7) * TAU, billowCell(seed, k + 8), clumpCell(seed, k + 9),
        Math.max(0.35 * boilBlend(u, P['onset.boil'], hr(seed, k + 4)), bk), heat * (1.2 - 0.75 * s * (1 - shape)) * nNorm,
        erode, edge, cool, 0, hr(seed, k + 2) < 0.5 ? -1 : 1, w * 0.45);
    }
    // pass 5c: the BASE below the muzzle is one broad, ragged, hot mass (AK 01 +3..+5: near-white, its lowest rows salmon), not
    // the rounded root caps of two low licks: a few wide, lumpy billows packed along the stem's lower part, up axis = the column's
    // (so their root end is the bottom: the base cooling and fraying act on their lowest rows)
    const nBM = shape < 0.5 && !r.burst ? P['column.baseMass'] | 0 : 0;     // late shots (a burst shot's ball has no hanging base)
    if (nBM > 0) {
      ROOTC = Math.max(P['column.baseCool'], P['column.baseCoolEnd']); ROOTR = P['column.baseCoolReach'] * 2.2;
      for (let m = 0; m < nBM; m++) {
        const k = 2400 + m * 7;
        const fm = nBM === 1 ? 0.5 : m / (nBM - 1);
        const bw = Wd * P['column.baseMassSize'] * (0.85 + 0.3 * hr(seed, k));
        const hb = drop * (0.3 + 0.45 * fm) + 0.1 * bw;                   // from near the bottom up toward the muzzle
        const ac = (hr(seed, k + 1) - 0.5) * 0.35 * Wd * lerp(P['column.baseWidth'], 1, 0.4);
        pushFlame(G_COL, bx + AX.x * hb + VT.x * ac, by + AX.y * hb + VT.y * ac, bz + AX.z * hb + VT.z * ac, AX.x, AX.y, AX.z, bw * 1.15, bw,
          (hr(seed, k + 2) - 0.5) * 0.4, billowCell(seed, k + 3), billowCell(seed, k + 4), boilBlend(u, P['onset.boil'], hr(seed, k + 5)),
          heat * 1.0 * nNorm, erode, edge, Math.max(warm * 0.3, bk), 0, hr(seed, k + 6) < 0.5 ? -1 : 1, bw * 0.4);
      }
    }
    // edge tongues: licks rooted inside the upper half and the crown, licking up and out (around the ball for the fireball)
    ROOTC = 0;
    const T = P['column.tongues'] | 0;
    for (let t = 0; t < T; t++) {
      const k = 2600 + t * 11;
      const s = 0.4 + 0.6 * hr(seed, k);
      const ang = hr(seed, k + 1) * TAU, ca = Math.cos(ang), sa = Math.sin(ang);
      const ex = F1.x * ca + F2.x * sa, ey = F1.y * ca + F2.y * sa, ez = F1.z * ca + F2.z * sa;
      const hgt = colH * s * 0.92;
      const rad = 0.16 * colW * (1 - 0.35 * smooth(0.75, 1.0, s) * (1 - shape));
      const up = lerp(0.55 + 0.45 * s, 0.6, shape);
      let dx = AX.x * up + ex * 0.6, dy = AX.y * up + ey * 0.6, dz = AX.z * up + ez * 0.6;
      const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
      const tl = P['column.tongueLength'] * CM * grow * (0.6 + 0.8 * hr(seed, k + 2)) * (0.5 + 0.6 * rag) * (1 + st);
      pushLick(G_CTONGUE, CB.x + AX.x * hgt + ex * rad, CB.y + AX.y * hgt + ey * rad, CB.z + AX.z * hgt + ez * rad, dx, dy, dz,
        tl, tl * P['lick.tongueWidth'], seed, k + 4, u * flick + hr(seed, k + 3) * 4, heat * 0.85, erode, edge, Math.max(0.2 + 0.5 * warm, bk), 0);
    }
    // pale flecks thrown off the column's forward edge (AK +4 / +5)
    const nF = P['column.flecks'] | 0;
    const fe = smooth(tC0 + 0.04, lerp(tC0, tCP, 0.6), u) * (1 - smooth(tB0 - 0.02, tB0 + 0.1, u));
    if (nF > 0 && fe > 0.002) {
      const ta = Math.max(u - tC0, 0) * life;
      for (let f = 0; f < nF; f++) {
        const k = 3200 + f * 9;
        const sr = 0.30 + 0.25 * hr(seed, k), sd = 0.05 + 0.3 * hr(seed, k + 1), su = -0.2 + 0.7 * hr(seed, k + 2);
        const sp = 0.8 + 1.4 * hr(seed, k + 3);
        const x = O.x + S.rx * (offR + sr * colW) + S.dx * (sd * colW + sp * 0.5 * ta) + S.ux * (su * colH * 0.55 + sp * 0.3 * ta);
        const y = O.y + S.ry * (offR + sr * colW) + S.dy * (sd * colW + sp * 0.5 * ta) + S.uy * (su * colH * 0.55 + sp * 0.3 * ta);
        const z = O.z + S.rz * (offR + sr * colW) + S.dz * (sd * colW + sp * 0.5 * ta) + S.uz * (su * colH * 0.55 + sp * 0.3 * ta);
        const w = P['column.fleckSize'] * CM * (0.6 + 0.8 * hr(seed, k + 4));
        pushFlame(G_FLECK, x, y, z, 0, 0, 0, 0, w, hr(seed, k + 5) * TAU, fleckCell(seed, k + 6), fleckCell(seed, k + 7), 0,
          P['column.fleckHeat'] * fe * (0.75 + 0.5 * hr(seed, k + 8)), 0, 0.1, 0.12, 0, 1, w * 0.3);
      }
    }
  }

  // TEARING (the game's +4 / +5). Pass 5, after AK 01 measured tile by tile: ONE big jagged piece tears off the column's lower
  // right flank at +4 (6.1k px), a second, smaller one follows at +5 ("Next piece after"), both white-yellow and textured, and
  // both are gone by +6 ("Gone by"), where the two orange licks take over. Times are fractions of the column's life, so
  // burst-first and late shots both tear while their column stands. The pieces drift outward and a little up; with "Orange
  // by" inside their life they cool and shrink. Each later piece is smaller. The holes in the column itself are in emitColumn
  // ("Holes eaten into the column").
  function emitTear(r, u, life) {
    const nT = P['tear.on'] && colOk ? TL.tearN : 0;
    if (nT <= 0) return;
    // pass 5d: "Crisp edge" draws them with the opening flames' class, whose glow is the scene bloom's minimum once the opening
    // has gone: the column's warm glow (its bands blooming) no longer spreads round them (their edge measured 10.7 px, the game's 3-4.5)
    CLS = P['tear.crisp']; RIMC = 0.25; ROOTC = 0;
    const seed = r.seed;
    const tC0 = TL.columnStart, span = Math.max(TL.columnEnd - tC0, 0.05);
    const tT0 = tC0 + P['tear.start'] * span, tCool = tC0 + P['tear.coolBy'] * span;
    const tGone = tC0 + Math.max(P['tear.goneBy'], P['tear.start'] + 0.05) * span;
    if (u < tT0 || u >= tGone) return;
    const around = P['tear.around'];
    const sz0 = P['tear.size'] * CM * r.scale;
    for (let i = 0; i < nT; i++) {
      const k = 7000 + i * 13;
      const tb = tT0 + span * (P['tear.stagger'] * i + 0.03 * hr(seed, k));   // one after another, not all at once
      if (u < tb) continue;
      const ta = (u - tb) * life;                                    // seconds since this piece tore off
      const h = 0.18 + 0.15 * i + 0.08 * hr(seed, k + 1);            // the lower flank; each later piece a little higher (5b: no stacking)
      // around the axis: the shooter's right (CVT) +- 45 deg, up to all round with "Around the column" at 1
      const ang = (hr(seed, k + 2) - 0.5) * lerp(1.6, TAU, around);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const ox = CVT.x * ca + CVD.x * sa, oy = CVT.y * ca + CVD.y * sa, oz = CVT.z * ca + CVD.z * sa;
      const wf = lerp(P['column.baseWidth'], 1, smooth(0.05, 0.35, h));
      const v = P['tear.drift'] * (0.6 + 0.8 * hr(seed, k + 3));
      const cl = smooth(tb, Math.max(tCool, tb + 0.03), u);         // 0 hot white-yellow .. 1 cooled orange
      // each burns out by "Gone by" (a little staggered), eroding from its edges and holes
      const tDie = tGone - 0.03 * hr(seed, k + 12);
      const gone = smooth(tDie - 0.07, tDie, u);
      if (gone >= 0.999) continue;
      const born = smooth(tb, tb + 0.03, u);                          // grows out of the flank over 2 ms: no pop at 0.05x
      const big = 1 - 0.35 * (nT > 1 ? i / (nT - 1) : 0);            // the first piece is the bigger one
      const vis = sz0 * big * (0.85 + 0.3 * hr(seed, k + 6)) * (1 - 0.45 * cl) * (0.35 + 0.65 * born);   // its visible size
      const sz = vis / 0.6;                                          // quad: the piece (points included) fills ~60 % of it
      // it sits against the column's flank, not inside it (a torn piece hanging off the side), then drifts out and a little up
      // pass 5c: the first piece sits against the flank (it overlaps the outline a little so the two touch, as in AK 01 +4 / +5),
      // each later one "Gap from the column's flank" further out
      const out = 0.5 * colW * wf * (0.7 + 0.15 * hr(seed, k + 4)) + 0.22 * vis + P['tear.gap'] * CM * i + v * ta;
      const up = h * colH + v * ta * (0.15 + 0.35 * hr(seed, k + 5));
      const x = CB.x + CAX.x * up + ox * out, y = CB.y + CAX.y * up + oy * out, z = CB.z + CAX.z * up + oz * out;
      const hh = P['tear.heat'] * (1 - 0.5 * cl) * (0.85 + 0.3 * hr(seed, k + 7)) * born;
      pushFlame(G_TEAR, x, y, z, CAX.x, CAX.y, CAX.z, sz, sz, (hr(seed, k + 8) - 0.5) * 1.0,
        scrapCell(seed, k + 9), scrapCell(seed, k + 10), 0.3 * cl,
        hh, Math.min(0.45 * cl + 0.9 * gone, 1), 0.12, cl, 0, hr(seed, k + 11) < 0.5 ? -1 : 1, sz * 0.3);
    }
  }

  function emitBreakup(r, u, life) {
    if (!P['breakup.on']) return;
    CLS = 0; RIMC = 0; ROOTC = 0;
    const seed = r.seed;
    const tB0 = TL.breakStart;
    // detached orange licks drifting forward and up, dissolving. Pass 5: on their own timing ("orange licks appear at / gone
    // by": AK 01 has two at +6 and none at +5 or +7), drawn with the late-lick cells (ragged, forked, streaked, holed, hottest
    // along the middle or the tip), boiling slowly between two variants
    const nL = P['breakup.licks'] | 0;
    const tL0 = TL.licksStart, tL1 = TL.licksEnd;
    // pass 5d: they fade over "Orange licks fade over" (0.18 of the life), so the 4th 60 fps frame (53.3 ms) catches them past
    // their peak, eroding (Max's pick 2); in slow motion they still peak at +6
    const lt = smooth(tL0 - 0.03, tL0 + 0.02, u) * (1 - smooth(tL1 - Math.max(P['time.licksFade'], 0.01), tL1, u));
    if (nL > 0 && lt > 0.002) {
      const reach = P['breakup.lickReach'] * CM * r.scale;
      const dt = Math.max(u - (tL0 - 0.03), 0) * life;
      fadeOut(lt);
      const er = Math.min(0.35 * smooth(tL0, tL1, u) + FE, 1);
      const lh = FH;
      for (let l = 0; l < nL; l++) {
        const k = 4000 + l * 11;
        const side = (hr(seed, k) < P['breakup.lickRight'] ? 1 : -1) * (0.35 + 0.65 * hr(seed, k + 1));   // AK 01 +6: both right
        const riseF = 0.15 + 0.6 * hr(seed, k + 2);
        const sp = P['breakup.lickDrift'] * (0.6 + 0.8 * hr(seed, k + 3));
        const aR = reach * side, aU = reach * riseF + sp * 0.6 * dt, aF = reach * 0.3 * hr(seed, k + 4) + sp * dt;
        const x = O.x + S.rx * aR + S.ux * aU + S.dx * aF, y = O.y + S.ry * aR + S.uy * aU + S.dy * aF, z = O.z + S.rz * aR + S.uz * aU + S.dz * aF;
        VD.x = S.dx * 0.25 + S.rx * side * 0.15; VD.y = 1 + S.dy * 0.25 + S.ry * side * 0.15; VD.z = S.dz * 0.25 + S.rz * side * 0.15;
        norm(VD);
        const tl = P['breakup.lickSize'] * CM * (0.7 + 0.6 * hr(seed, k + 5));
        const lhh = P['breakup.lickHeat'] * lh * (0.75 + 0.5 * hr(seed, k + 9));
        // the lick spans ~75 % of its cell's length (root to tip) and ~half its width: the quad is centred on (x, y, z)
        pushFlame(G_LICK, x, y, z, VD.x, VD.y, VD.z, tl / 0.75, tl * 1.1, (hr(seed, k + 8) - 0.5) * 0.4,
          lateCellK(seed, k + 11, l), lateCellK(seed, k + 12, l), boilBlend(u, 1.5, hr(seed, k + 6)) * 0.35, lhh, er, 0.12, 1, 0,
          hr(seed, k + 10) < 0.5 ? -1 : 1, tl * 0.15);
      }
    }
    // sparks: tiny short streaks thrown out sideways and forward, slowing down (drag), fading
    const nS = P['breakup.sparks'] | 0;
    if (nS > 0) {
      const t0 = tB0 - 0.12;
      const kd = 9;                                          // drag rate (1/s)
      for (let s = 0; s < nS; s++) {
        const k = 4600 + s * 11;
        const te = t0 + 0.16 * hr(seed, k);
        const tau = (u - te) * life;
        const sl = life * (0.16 + 0.14 * hr(seed, k + 1));
        if (tau < 0 || tau > sl) continue;
        const ang = hr(seed, k + 2) * TAU, ca = Math.cos(ang), sa = Math.sin(ang);
        const fw = 0.25 + 0.9 * hr(seed, k + 3);
        VD.x = S.ux * ca + S.rx * sa + S.dx * fw; VD.y = S.uy * ca + S.ry * sa + S.dy * fw + 0.15; VD.z = S.uz * ca + S.rz * sa + S.dz * fw;
        norm(VD);
        const v0 = P['breakup.sparkSpeed'] * (0.5 + 0.8 * hr(seed, k + 4));
        const dist = v0 / kd * (1 - Math.exp(-kd * tau)) + 0.04 + 0.08 * hr(seed, k + 5);
        const vNow = v0 * Math.exp(-kd * tau);
        const streak = Math.max(vNow * P['breakup.sparkLength'] / 1000, 0.004);
        const x = O.x + VD.x * (dist - streak * 0.5), y = O.y + VD.y * (dist - streak * 0.5), z = O.z + VD.z * (dist - streak * 0.5);
        const fade = Math.pow(1 - tau / sl, 1.5);
        const type = hr(seed, k + 6) < P['breakup.sparkOrange'] ? GT_SPARK_ORANGE : GT_SPARK_BLUE;
        pushGlow(G_SPARK, 2, type, x, y, z, VD.x, VD.y, VD.z, streak, 0.0035, 0, P['breakup.sparkGain'] * fade * (0.6 + 0.8 * hr(seed, k + 7)), 0, 0, 1, 0);
      }
    }
  }

  function emitGlows(r, u, age) {
    const seed01 = hr(r.seed, 77);
    const tB0 = TL.breakStart;
    // break-up glare: sparkly blue-white light along the barrel that flares as the column breaks up, then settles into the
    // violet afterglow. Built from a few pieces strung along the barrel (the first, at the muzzle, the biggest), each a little
    // off the axis, with its own size, sparkle pattern and twinkle, and stretched along the barrel on screen: an irregular,
    // broken glare instead of one smooth ball (the camera-glare kind of element: soft, no defined edge).
    if (P['glitter.on'] && P['glitter.gain'] > 0) {
      const ge = smooth(tB0 - 0.01, tB0 + 0.09, u) * (1 - 0.8 * smooth(tB0 + 0.12, 1.0, u));
      if (ge > 0.002) {
        const gl = P['glitter.length'] * CM, gw = P['glitter.width'] * CM, ah = P['glitter.ahead'] * CM;
        const np = Math.max(1, P['glitter.pieces'] | 0), tw = P['glitter.twinkle'], asp = P['glitter.stretch'];
        for (let i = 0; i < np; i++) {
          const k = 5000 + i * 7;
          const along = ah + (np === 1 ? 0 : (i / (np - 1)) * gl * (0.75 + 0.25 * hr(r.seed, k)));
          const offR = (hr(r.seed, k + 1) - 0.5) * 0.6 * gw, offU = (hr(r.seed, k + 2) - 0.5) * 0.5 * gw;
          const sz = gw * (i === 0 ? 1 : 0.45 + 0.4 * hr(r.seed, k + 3));
          const flick = 1 - 0.5 * tw * (1 + Math.sin(age * (180 + 220 * hr(r.seed, k + 4)) + hr(r.seed, k + 5) * TAU));
          pushGlow(G_GLITTER, 1, GT_GLITTER, O.x + S.dx * along + S.rx * offR + S.ux * offU, O.y + S.dy * along + S.ry * offR + S.uy * offU,
            O.z + S.dz * along + S.rz * offR + S.uz * offU, S.dx, S.dy, S.dz, sz * 1.6, sz * 1.6, 0,
            P['glitter.gain'] * ge * flick * (i === 0 ? 1 : 0.55), hr(r.seed, k + 6), age, 1.6, sz * 0.4, asp);
        }
      }
    }
    // violet afterglow: compact and static, faintly there behind the flame, alone at the end
    if (P['violet.on']) {
      const ve = P['violet.intensity'] * lerp(P['violet.startLevel'], 1, smooth(P['time.afterglowStart'], P['time.afterglowFull'], u));
      if (ve > 0.001) {
        const va = P['violet.ahead'] * CM;
        const vw = P['violet.width'] * CM, vh = P['violet.height'] * CM;
        const ext = 2.0 + 2.2 * P['violet.skirt'];
        pushGlow(G_VIOLET, 1, GT_VIOLET, O.x + S.dx * va, O.y + S.dy * va, O.z + S.dz * va, 0, 1, 0, -vh * ext, vw * ext, 0, ve, seed01, age, ext, vw * 0.4);
      }
    }
    // warm haze: large soft glow, offset up and to the left over the shooter, alive for the whole flash
    if (P['haze.on']) {
      const hz = P['haze.intensity'] * (u < 0.3 ? lerp(P['haze.start'], 1, u / 0.3) : lerp(1, P['haze.late'], (u - 0.3) / 0.7));
      if (hz > 0.001) {
        const hw = P['haze.width'] * CM, hh = P['haze.height'] * CM;
        const offR = P['haze.offRight'] * CM, offU = P['haze.offUp'] * CM, offB = P['haze.offBack'] * CM;
        const ext = Math.max(2.4, P['haze.skirtSize'] * 1.5);
        pushGlow(G_HAZE, 1, GT_HAZE, S.px + S.rx * offR + S.ux * offU - S.dx * offB, S.py + S.ry * offR + S.uy * offU - S.dy * offB,
          S.pz + S.rz * offR + S.uz * offU - S.dz * offB, 0, 1, 0, -hh * ext, hw * ext, 0, hz, seed01, age, ext, Math.max(hw, hh) * 0.5);
      }
    }
    // halo: a faint, wide glow around the flame body while it burns (the game's column sits in a soft cream glow that fades
    // over 6-7 px outside its outline). It hugs the flame: centred on the muzzle for the opening flames, then moving up to the
    // column's middle and stretching along it (by the column's height / width) as the column takes over, never beside it.
    if (P['halo.on']) {
      const he = P['halo.intensity'] * ENV.flame;
      if (he > 0.001) {
        const hs = P['halo.size'] * CM;
        const wc = colOk ? P['halo.follow'] * ENV.column / Math.max(ENV.column + ENV.onset + ENV.puff, 1e-3) : 0;
        const hx = lerp(O.x, CC.x, wc), hy = lerp(O.y, CC.y, wc), hz = lerp(O.z, CC.z, wc);
        const hl = hs * lerp(1, Math.max(1, colH / Math.max(colW, 1e-3)), wc);
        if (wc > 0.01) pushGlow(G_HALO, 1, GT_HALO, hx, hy, hz, CAX.x, CAX.y, CAX.z, -hl * 2.2, hs * 2.2, 0, he, seed01, age, 2.2, hs * 0.3);
        else pushGlow(G_HALO, 1, GT_HALO, hx, hy, hz, 0, 0, 0, 0, hs * 2.2, 0, he, seed01, age, 2.2, hs * 0.3);
      }
    }
  }

  // Evaluate one round at age (s): all its sprites, and its light level. Pure presentation.
  function setOrigin() {
    const ahead = P['onset.originAhead'] * CM;
    O.x = S.px + S.dx * ahead; O.y = S.py + S.dy * ahead; O.z = S.pz + S.dz * ahead;
  }
  function evalRound(r, age) {
    colOk = false;
    const life = P['time.life'] / 1000;
    const u = age / life;
    timeline(r);
    envelopes(r, u);
    onsetGlowLevel(u);
    copyFrame(SL, S);                    // S = the live muzzle frame (readFrames)
    setOrigin();
    emitCore(r, u);
    emitPuff(r, u);
    emitOnset(r, u);
    frameFromArray(S, r.F);              // the frame at fire time, for the parts that stay in the air
    setOrigin();
    emitColumn(r, u, life);
    emitTear(r, u, life);
    emitBreakup(r, u, life);
    emitGlows(r, u, age);
    copyFrame(S, SL);
    if (P['light.on']) {
      if (u < P['light.peakEnd']) { r.lightLevel = 1; r.lightStep = 0; }
      else if (u < P['light.plateauEnd']) { r.lightLevel = P['light.plateau'] / 100; r.lightStep = 1; }
      else { r.lightLevel = 0; r.lightStep = 2; }
    } else { r.lightLevel = 0; r.lightStep = 2; }
  }

  // Burst-first or late, per shot and deterministic: the shot's first random number (rng(n)) against the share. With the
  // share at 0.5 the late shots are exactly the shots that opened with the puff before (puff chance 50 %), so shot 0 is late.
  function shotKind(r) {
    r.burst = r.rnd[0] >= 1 - P['time.burstShare'];
    r.puff = !r.burst && P['onset.latePuff'];
  }

  // The longest-lived layer decides how long a round stays alive (stage 2 adds smoke and embers that outlive the flash).
  function roundLife() { return P['time.life'] / 1000; }

  // THE VISIBLE CLOCK (pass 5; the pass-4 critic's design). A round's clock starts at the first frame that draws it, as a game
  // spawning its effect on the frame would: render() stamps r.v0 = renderTime at the round's first drawn frame (the frame
  // number fire() was given), and from then on every layer's age (flames, light, sparks, torn-piece motion) and the pool life
  // run from that stamp: age = "First drawn frame shows age" + (renderTime - r.v0). So every shot's first frame shows the
  // same moment whatever the 1/240 s substep it fired on (the trigger-time clock showed a shot 0..16.7 ms old), and every shot
  // shows exactly 4 lit 60 fps frames at the default 3.3 ms (3.3 / 20 / 36.6 / 53.3 ms; 70 ms is past the 66 ms cut).
  // Nothing advances before the first draw: update() keeps an undrawn round alive and only retires a drawn one.
  // Static modes (?preflight, reduced motion) keep explicit ages: the visible start is the fire time and &t= IS the age, so
  // tile +k renders at t = (k + 0.5) * 6.6 ms as before and boards / measure5 stay valid. Live and preflight show the same
  // picture for the same age; live shows it up to one display frame after the trigger (the visible start waits for the
  // next drawn frame), and its first frame is age "firstAge" where preflight starts from t = 0.
  let staticClock = false;
  function firstAge() { return staticClock ? 0 : P['time.firstAge'] / 1000; }
  function visibleAge(r, t) { return r.v0 < 0 ? -1 : firstAge() + (t - r.v0); }


  // The effect's own pass (inserted before bloom): heat sprites -> heat buffer, composite onto the HDR image, then the
  // glows and sparks on top. Draws nothing (0 calls) while no round is alive.
  class FxFlashPass extends Pass {
    constructor() { super(); this.needsSwap = false; }
    setSize(w, h) { if (heatRT) heatRT.setSize(w, h); }
    render(rd, writeBuffer, readBuffer) {
      const heatView = P['sprites.heatView'];
      const doFlame = FB.n > 0 || heatView, doGlow = GB.n > 0 && !heatView, doAtlas = P['sprites.atlas'];
      if (!doFlame && !doGlow && !doAtlas) return;
      const prevAuto = rd.autoClear;
      rd.getClearColor(savedClear.color); savedClear.alpha = rd.getClearAlpha();
      rd.autoClear = false;
      if (doFlame) {
        rd.setRenderTarget(heatRT);
        rd.setClearColor(0x000000, 0);
        rd.clear(true, false, false);
        if (FB.n > 0) rd.render(flameScene, C.camera);
        rd.setClearColor(savedClear.color, savedClear.alpha);
      }
      rd.setRenderTarget(readBuffer);
      if (doFlame && !heatView && P['color.opacity'] > 0) occQuad.render(rd);
      if (doFlame) compQuad.render(rd);
      if (doGlow) rd.render(glowScene, C.camera);
      if (doAtlas) { atlasQuad.material.uniforms.uRes.value.set(readBuffer.width, readBuffer.height); atlasQuad.render(rd); }
      rd.autoClear = prevAuto;
    }
  }

  function buildGpu() {
    const R = C.renderer;
    atlasRT = new T3.WebGLRenderTarget(ATLAS_W, ATLAS_H, {
      type: T3.UnsignedByteType, format: T3.RGBAFormat, depthBuffer: false, generateMipmaps: true,
      minFilter: T3.LinearMipmapLinearFilter, magFilter: T3.LinearFilter, colorSpace: T3.NoColorSpace,
    });
    const size = R.getDrawingBufferSize(new T3.Vector2());
    heatRT = new T3.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      type: T3.HalfFloatType, format: T3.RGBAFormat, depthBuffer: false, minFilter: T3.NearestFilter, magFilter: T3.NearestFilter,
    });
    const addBlend = { blending: T3.CustomBlending, blendEquation: T3.AddEquation, blendSrc: T3.OneFactor, blendDst: T3.OneFactor,
      blendEquationAlpha: T3.AddEquation, blendSrcAlpha: T3.OneFactor, blendDstAlpha: T3.OneFactor };
    genQuad = new FullScreenQuad(new T3.ShaderMaterial({
      uniforms: { uSeed: { value: 7 }, uLumps: { value: 0.6 }, uGrain: { value: 0.6 }, uCrisp: { value: 0.7 },
        uTaper: { value: 0.5 }, uTear: { value: 0.5 }, uLickDetail: { value: 0.5 },
        uLateRag: { value: 0.7 }, uLateDetail: { value: 0.7 }, uLateHoles: { value: 0.5 }, uLateHot: { value: 0.6 }, uLateSoft: { value: 0.6 },
        uScrapPoints: { value: 0.7 }, uScrapDetail: { value: 0.8 }, uScrapHoles: { value: 0.4 } },
      vertexShader: FULLSCREEN_VERT, fragmentShader: GEN_FRAG, depthTest: false, depthWrite: false, blending: T3.NoBlending,
    }));
    const depthU = () => ({ tSceneDepth: { value: C.sceneDepth }, uNearFar: { value: new T3.Vector2(C.camera.near, C.camera.far) }, uSoft: { value: 0.06 } });
    flameMat = new T3.ShaderMaterial({
      uniforms: Object.assign(depthU(), { tAtlas: { value: atlasRT.texture }, uTempW: { value: 0.6 }, uDetail: { value: 0.5 }, uOutline: { value: 0 }, uLateSharp: { value: 1 } }),
      defines: { FLAME_SPRITES: 1 },
      vertexShader: SPRITE_VERT, fragmentShader: C.sceneDepthGLSL + SOFT_GLSL + FLAME_FRAG_BODY,
      transparent: true, depthTest: false, depthWrite: false, side: T3.DoubleSide, ...addBlend,
    });
    const arr = (mk) => Array.from({ length: NG }, mk);
    glowMat = new T3.ShaderMaterial({
      uniforms: Object.assign(depthU(), {
        uGCore: { value: arr(() => new T3.Vector3()) }, uGBody: { value: arr(() => new T3.Vector3()) }, uGSkirt: { value: arr(() => new T3.Vector3()) },
        uGProf: { value: arr(() => new T3.Vector4(1, 1, 1, 1)) }, uGSpark: { value: arr(() => new T3.Vector4()) }, uOutline: { value: 0 },
      }),
      defines: { NG },
      vertexShader: SPRITE_VERT, fragmentShader: C.sceneDepthGLSL + SOFT_GLSL + GLOW_FRAG_BODY,
      transparent: true, depthTest: false, depthWrite: false, side: T3.DoubleSide, ...addBlend,
    });
    const compUniforms = {
        tHeat: { value: heatRT.texture }, uStops: { value: new T3.Vector4(0.12, 0.32, 0.62, 1.1) }, uRimP: { value: 1.5 },
        uEdge: { value: new T3.Color() }, uMid: { value: new T3.Color() }, uHot: { value: new T3.Color() }, uCore: { value: new T3.Color() },
        uCoolLo: { value: new T3.Color() }, uCoolMid: { value: new T3.Color() }, uCoolHi: { value: new T3.Color() }, uFringe: { value: new T3.Color() }, uFringeWarm: { value: new T3.Color() },
        uHeatView: { value: 0 }, uOutline: { value: new T3.Vector3(0.15, 0.85, 0) }, uOpacity: { value: 0.8 }, uCoolSoft: { value: 0.7 },
        uSoftCO: { value: new T3.Vector2(1, 0) }, uBloomW: { value: new T3.Vector2(0.035, 0.015) }, uBand: { value: new T3.Vector2(1, 1) },
        uGlowBand: { value: 0 }, uGlowHot: { value: 1 }, uCoreGlowO: { value: 1 },
    };
    compQuad = new FullScreenQuad(new T3.ShaderMaterial({
      uniforms: compUniforms, defines: { PASS: 1 },
      vertexShader: FULLSCREEN_VERT, fragmentShader: COMPOSITE_FRAG, transparent: true, depthTest: false, depthWrite: false, ...addBlend,
      blendSrcAlpha: T3.ZeroFactor, blendDstAlpha: T3.OneMinusSrcAlphaFactor,      // alpha: bloom weight *= 1 - cut
    }));
    occQuad = new FullScreenQuad(new T3.ShaderMaterial({
      uniforms: compUniforms, defines: { PASS: 0 },
      vertexShader: FULLSCREEN_VERT, fragmentShader: COMPOSITE_FRAG, transparent: true, depthTest: false, depthWrite: false,
      blending: T3.CustomBlending, blendEquation: T3.AddEquation, blendSrc: T3.ZeroFactor, blendDst: T3.SrcColorFactor,   // scene *= 1 - opacity
      blendEquationAlpha: T3.AddEquation, blendSrcAlpha: T3.ZeroFactor, blendDstAlpha: T3.OneFactor,
    }));
    atlasQuad = new FullScreenQuad(new T3.ShaderMaterial({
      uniforms: { tAtlas: { value: atlasRT.texture }, uRes: { value: new T3.Vector2(1, 1) } },
      vertexShader: FULLSCREEN_VERT, fragmentShader: ATLAS_VIEW_FRAG, depthTest: false, depthWrite: false, blending: T3.NoBlending,
    }));
    FB = makeBuffers(MAX_FLAME);
    GB = makeBuffers(MAX_GLOW);
    flameMesh = new T3.Mesh(FB.g, flameMat); flameMesh.frustumCulled = false; flameMesh.name = 'muzzleFlashFlameSprites';
    glowMesh = new T3.Mesh(GB.g, glowMat); glowMesh.frustumCulled = false; glowMesh.name = 'muzzleFlashGlowSprites';
    flameScene = new T3.Scene(); flameScene.add(flameMesh);
    glowScene = new T3.Scene(); glowScene.add(glowMesh);
    flashPass = new FxFlashPass();
    removePass = C.addPass(flashPass);
    savedClear.color = new T3.Color();
  }

  // ------------------------------------------------------------------------------------------------------------
  // cover-room: build and API (the study's init / fire / update / render / state, on the game's VFX clock)
  const render = game.render;
  const clockS = shared.clock;
  C = { renderer: render.renderer, camera: render.camera, sceneDepth: render.sceneDepth, sceneDepthGLSL: render.sceneDepthGLSL,
    addPass: (p) => render.addPass(p), redraw: null };
  T3 = THREE;
  _c = new T3.Color();
  for (const k of ['lightPeak', 'lightPlateau']) D[k] = new T3.Color();
  shared.bindParams('vfx.muzzle.', SCHEMA, PRESETS, 'Pistol', P, () => { version++; });
  for (let i = 0; i < POOL; i++) {
    rounds.push({ active: false, t0: 0, v0: -1, f0: -1, shot: -1, seed: 0, rnd: new Float32Array(NRND), burst: false, puff: false, scale: 1, roll: 0,
      F: new Float64Array(12),           // muzzle frame at fire time (position, barrel, up, right)
      obj: null, lp: new T3.Vector3(), ld: new T3.Vector3(0, 0, 1), sizeMul: 1,
      lightLevel: 0, lightStep: 2,
      ext: {} });
  }
  buildGpu();
  derive();
  let shotCount = 0;
  const _inv = new T3.Matrix4();

  // A flash at a muzzle. target: Object3D (live; local +Z down the barrel), or {pos, dir, obj?} (world muzzle point and barrel
  // direction at the shot; with obj, the flash follows obj as it moves). opts.scale: size multiplier for this shot.
  function fire(target, opts) {
    if (!target) return;
    staticClock = clockS.explicit;
    let r = null;
    for (let i = 0; i < rounds.length; i++) if (!rounds[i].active) { r = rounds[i]; break; }
    if (!r) { r = rounds[0]; for (let i = 1; i < rounds.length; i++) if (rounds[i].t0 < r.t0) r = rounds[i]; }   // oldest first
    const rng = shared.rng;
    for (let i = 0; i < NRND; i++) r.rnd[i] = rng();
    const t = shared.now();
    r.active = true; r.t0 = t; r.shot = shotCount++;
    // the visible clock: live, it starts at the first frame that draws this round (stamped in render()); explicit clock: the
    // fire time
    r.f0 = clockS.frame;
    r.v0 = staticClock ? t : -1;
    r.seed = ((r.rnd[10] * 4294967296) ^ Math.imul((r.rnd[11] * 65536) | 0, 0x10001)) >>> 0;
    shotKind(r);
    r.scale = 1 + (r.rnd[1] * 2 - 1) * P['onset.scaleJitter'] / 100;
    r.roll = (r.rnd[2] * 2 - 1) * P['onset.rollJitter'] * DEG;
    r.sizeMul = opts && opts.scale > 0 ? opts.scale : 1;
    if (target.isObject3D) {
      r.obj = target; target.updateWorldMatrix(true, false);
      r.lp.set(0, 0, 0); r.ld.set(0, 0, 1);
    } else {
      const o = target.obj && target.obj.isObject3D ? target.obj : null;
      r.obj = o;
      if (o) {
        o.updateWorldMatrix(true, false);
        _inv.copy(o.matrixWorld).invert();
        r.lp.copy(target.pos).applyMatrix4(_inv);
        r.ld.copy(target.dir).transformDirection(_inv);
      } else { r.lp.copy(target.pos); r.ld.copy(target.dir).normalize(); }
    }
    liveFrame(r);
    frameToArray(S, r.F);
  }

  function update(t) {
    now = t;
    const life = roundLife();
    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i];
      // a round not drawn yet stays alive (its clock has not started); a drawn one retires at the life
      if (r.active && r.v0 >= 0 && visibleAge(r, t) >= life) r.active = false;
    }
  }

  function renderFrame(renderTime, frame) {
    staticClock = clockS.explicit;
    if (derivedVersion !== version) derive();
    FB.n = 0; GB.n = 0; counts.fill(0);
    resetOnsetLevels();
    const life = P['time.life'] / 1000;
    const size = P['weapon.size'];
    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i];
      if (!r.active) continue;
      if (r.v0 < 0) {
        if (r.f0 >= 0 && frame < r.f0) continue;
        r.v0 = renderTime;
      }
      // per-shot values that follow the panel live
      shotKind(r);
      r.scale = 1 + (r.rnd[1] * 2 - 1) * P['onset.scaleJitter'] / 100;
      r.roll = (r.rnd[2] * 2 - 1) * P['onset.rollJitter'] * DEG;
      let age = visibleAge(r, renderTime);
      if (age < 0) age = 0;
      if (age >= life) { r.lightLevel = 0; continue; }       // hard cut: nothing fades out
      if (r.obj) r.obj.updateWorldMatrix(true, false);
      liveFrame(r);                                          // S = this round's muzzle as drawn now
      CM = CM0 * size * r.sizeMul;
      evalRound(r, age);
      if (r.lightLevel > 0) {
        const a = P['light.ahead'] * 0.01;                   // >= 0.35 m ahead of the tip (a point light near a surface blows it out)
        const lc = r.lightStep === 0 ? D.lightPeak : D.lightPlateau;
        shared.lights.request(S.px + S.dx * a, S.py + S.dy * a, S.pz + S.dz * a, P['light.peak'] * r.lightLevel, P['light.reach'], lc.r, lc.g, lc.b);
      }
    }
    CM = CM0;
    compQuad.material.uniforms.uBloomW.value.x = glowNow;
    compQuad.material.uniforms.uBand.value.x = bandNow;
    compQuad.material.uniforms.uSoftCO.value.x = softNow;
    FB.g.instanceCount = FB.n; GB.g.instanceCount = GB.n;
    if (FB.n > 0) for (let i = 0; i < FB.attrs.length; i++) FB.attrs[i].needsUpdate = true;
    if (GB.n > 0) for (let i = 0; i < GB.attrs.length; i++) GB.attrs[i].needsUpdate = true;
    flameMat.uniforms.uNearFar.value.set(C.camera.near, C.camera.far);
    glowMat.uniforms.uNearFar.value.set(C.camera.near, C.camera.far);
  }

  function clear() { for (const r of rounds) { r.active = false; r.lightLevel = 0; } }

  function state() {
    const alive = rounds.filter((r) => r.active);
    const groups = {};
    for (let g = 1; g < GROUPS.length; g++) if (counts[g]) groups[GROUPS[g]] = counts[g];
    return {
      preset: game.params.get('vfx.muzzle.preset'),
      rounds: alive.map((r) => ({ shot: r.shot, age: +visibleAge(r, now).toFixed(5), sinceFire: +(now - r.t0).toFixed(5),
        drawn: r.v0 >= 0, burst: r.burst, puff: r.puff, light: r.lightLevel })),
      sprites: { flame: FB ? FB.n : 0, glow: GB ? GB.n : 0, groups },
    };
  }

  function dispose() {
    if (removePass) removePass();
    removePass = null; flashPass = null;
    for (const b of [FB, GB]) if (b) { b.g.dispose(); b.base.dispose(); }
    for (const m of [flameMat, glowMat]) if (m) m.dispose();
    for (const q of [genQuad, compQuad, occQuad, atlasQuad]) if (q) { q.material.dispose(); q.dispose(); }
    if (atlasRT) atlasRT.dispose();
    if (heatRT) heatRT.dispose();
    rounds.length = 0;
  }

  return { P, SCHEMA, PRESETS, fire, update, render: renderFrame, clear, state, dispose };
}
