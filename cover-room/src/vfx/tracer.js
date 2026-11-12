// Bullet tracer: the approved stage-2 study (vfx-studies/u4-tracer.html, VERSION 2, "U4 reference"; Max, 12 Oct 2026:
// "ok very very good work on the bullet trails im seriously impressed"), extracted as a pooled module. The shaders, the panel
// schema, the presets and the per-frame placement are COPIED from the study unchanged (cover-room must stand on its own).
//
// WHAT IT DRAWS (per round; see the study header for the full design):
//   PROJECTILE  32 pooled camera-facing capsule impostors in one draw call, additive HDR: bulbous white head, gold body, orange
//               tapering tail, edge fringe and an effect-side glow; Gaussian cross-section never thinner than 0.7 px.
//   MIST        32 pooled lit ribbons (96 segments) in one draw call, alpha-blended, lit by the level's key + fill light, soft
//               against the scene depth; ramps in behind the head, fades exponentially (0.7 s life), breaks into patches.
//   MOVING LIGHT  up to 3 light requests a frame (newest rounds first) to the shared VFX light pool (index.js): a warm light
//               travels with each round's head, dimmed near the hit surface; one leftover-frame light by the hit.
//   IMPACT FLASH  the study's placeholder, off by default (vfx/impact.js draws the impacts).
//
// CHANGES FROM THE STUDY (and why):
//   - fire(from, to, {hit, normal}) instead of the range's muzzle + raycast: the shooter supplies the hit (the 'shot' event).
//   - The visible clock (as the muzzle-flash study's pass 5): a round's clock starts on the first frame that draws it, which
//     shows age "time.firstAge" (2.1 ms: the study's live page showed 0..4.2 ms). The game's sim steps are 1/60 s, so without it
//     a round's first frame would be 0..17 ms old and its streak already 7 m out.
//   - The 3 own PointLights became requests to the shared pool of 4 (the scene's light count stays fixed for every effect).
//   - Panel values live in game.params under vfx.tracer.* (the study's localStorage / lil-gui code is gone: params.js owns that).
//   - VFX randomness comes from the VFX rng, never game.rng (gameplay runs repeat with effects on or off).
//   - Round pool NR = 32 (>= 16 concurrent tracers asked for); no allocation per shot or per frame.
//
// UNITS  metres in the world, cm and ms in the panel; colours sRGB hex x an HDR intensity (scene-referred: 1.0 = diffuse
//   white, bloom starts at 1.0); light intensity in three.js candela (decay 2).
import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';

const NR = 32;                  // round records = projectile quads = mist ribbons (one slot of each per round)
const SEG = 96;                 // mist ribbon segments
const NRND = 8;                 // random numbers kept per round: 0 brightness, 1 width, 2 mist seed, 3 mist width
const FRAME = 1 / 60;           // s: "frames" in the panel are 60 fps game frames
const NL = 3;                   // light requests per frame, at most (the study's pool size)

// ------------------------------------------------------------------------------------------------------------
// Panel schema (copied): [folder id, title, items]; item = [key, kind, label, min, max, step]. kind: n number, c colour
// (sRGB hex), b toggle. Keys are "<folder>.<key>" under vfx.tracer.

const SCHEMA = [
  ['proj', 'Projectile streak', [
    ['on', 'b', 'Layer on'],
    ['speed', 'n', 'Speed (m/s)', 50, 1200, 5],
    ['length', 'n', 'Streak length (frames of travel, 60 fps)', 0.1, 3, 0.01],
    ['detach', 'n', 'Streak starts this far ahead of the muzzle (m)', 0, 5, 0.05],
    ['width', 'n', 'Body width (cm)', 0.5, 15, 0.1],
    ['headWidth', 'n', 'Head width (x body)', 0.5, 4, 0.01],
    ['headLen', 'n', 'Head bulb length (% of streak)', 1, 70, 0.5],
    ['neck', 'n', 'Bulb-to-body narrowing (% of streak)', 1, 40, 0.5],
    ['taperStart', 'n', 'Tail taper starts (% from front)', 10, 100, 1],
    ['tipWidth', 'n', 'Tail tip width (x body)', 0, 1, 0.01],
    ['nose', 'n', 'Rounded nose length (% of streak)', 0, 40, 0.5],
    ['frontFade', 'n', 'Front fade-in (% of streak)', 0, 30, 0.5],
    ['headCol', 'c', 'Head colour'],
    ['headInt', 'n', 'Head intensity (HDR)', 0, 80, 0.1],
    ['headEnd', 'n', 'Head zone ends (% from front)', 2, 80, 0.5],
    ['handover', 'n', 'Head-to-body hand-over (% of streak)', 1, 40, 0.5],
    ['tongue', 'n', 'Hot centre runs on past the edges (% of streak)', 0, 30, 0.5],
    ['neckDip', 'n', 'Saturated neck behind the head (dip)', 0, 0.95, 0.01],
    ['neckLen', 'n', 'Neck length (% of streak)', 2, 60, 0.5],
    ['bodyCol', 'c', 'Body colour'],
    ['bodyInt', 'n', 'Body intensity (HDR)', 0, 40, 0.05],
    ['bodyEnd', 'n', 'Body ends, tail starts (% from front)', 10, 100, 0.5],
    ['tailCol', 'c', 'Tail colour'],
    ['tailInt', 'n', 'Tail intensity (HDR)', 0, 20, 0.05],
    ['tailFade', 'n', 'Tail fades out over (% of streak)', 1, 90, 0.5],
    ['hardness', 'n', 'Core edge hardness', 0, 1, 0.01],
    ['minSigma', 'n', 'Thin-line floor, sigma (px)', 0.5, 2, 0.05],
  ]],
  ['rim', 'Edge fringe', [
    ['on', 'b', 'Layer on'],
    ['col', 'c', 'Rim colour'],
    ['int', 'n', 'Rim intensity (HDR)', 0, 20, 0.05],
    ['width', 'n', 'Rim width (share of the falloff)', 0.02, 1, 0.01],
  ]],
  ['halo', 'Halo', [
    ['on', 'b', 'Effect glow on (the scene bloom always applies)'],
    ['col', 'c', 'Glow colour'],
    ['int', 'n', 'Glow intensity (HDR)', 0, 3, 0.005],
    ['radius', 'n', 'Glow radius (cm)', 1, 200, 0.5],
    ['headBias', 'n', 'Glow gathered at the head', 0, 1, 0.01],
  ]],
  ['end', 'End of flight', [
    ['on', 'b', 'Leftover frame on'],
    ['frames', 'n', 'Leftover (frames at 60 fps; 1 = 16.7 ms)', 0.1, 4, 0.1],
    ['level', 'n', 'Leftover brightness (%)', 0, 100, 1],
    ['orange', 'n', 'Leftover shift to the tail colour', 0, 1, 0.01],
    ['maxRange', 'n', 'Range when nothing is hit (m)', 20, 600, 5],
  ]],
  ['mist', 'Mist trail', [
    ['on', 'b', 'Layer on'],
    ['col', 'c', 'Colour (lit by the scene)'],
    ['bright', 'n', 'Brightness (response to the scene light)', 0, 6, 0.01],
    ['aniso', 'n', 'Forward scattering toward the key light', 0, 0.9, 0.01],
    ['opacity', 'n', 'Opacity at peak', 0, 1, 0.01],
    ['rampIn', 'n', 'Ramp-in after the head passes (ms)', 0, 200, 1],
    ['life', 'n', 'Lifetime (ms; 700 = 42 frames)', 100, 4000, 10],
    ['halfLife', 'n', 'Fade half-life (ms)', 20, 3000, 5],
    ['fadeShape', 'n', 'Fade shape: exponential .. linear', 0, 1, 0.01],
    ['w0', 'n', 'Birth width, FWHM (cm)', 0.5, 40, 0.1],
    ['w1', 'n', 'Late width, FWHM (cm)', 0.5, 120, 0.1],
    ['straight', 'n', 'Straight phase (ms)', 0, 2000, 5],
    ['onset', 'n', 'Warp onset, grows in over (ms)', 0, 4000, 10],
    ['warpAmp', 'n', 'Warp amplitude at birth (cm)', 0, 60, 0.1],
    ['warpGrow', 'n', 'Warp growth over life (x)', 1, 30, 0.05],
    ['warpScale', 'n', 'Warp wavelength (m)', 0.2, 20, 0.05],
    ['curl', 'n', 'Curl: warp shape change speed (1/s)', 0, 12, 0.05],
    ['drift', 'n', 'Drift speed (cm/s)', 0, 300, 0.5],
    ['driftUp', 'n', 'Drift direction: random .. up', 0, 1, 0.01],
    ['fibre', 'n', 'Fibrous edges', 0, 1, 0.01],
    ['breakup', 'n', 'Break-up into patches', 0, 1, 0.01],
    ['breakScale', 'n', 'Break-up patch length (m)', 0.1, 10, 0.05],
    ['breakOnset', 'n', 'Break-up starts (ms)', 0, 3000, 5],
    ['beads', 'n', 'Beaded line at birth', 0, 1, 0.01],
    ['soft', 'n', 'Soft edge against surfaces (m)', 0.01, 2, 0.01],
  ]],
  ['light', 'Moving light', [
    ['on', 'b', 'Layer on'],
    ['col', 'c', 'Colour'],
    ['int', 'n', 'Intensity (candela, per light)', 0, 1000, 1],
    ['reach', 'n', 'Reach: fades to nothing at (m)', 0.3, 8, 0.05],
    ['at', 'n', 'Sits behind the head (% of streak)', 0, 100, 1],
    ['perRound', 'n', 'Lights per round (pool of 3)', 1, 3, 1],
    ['spread', 'n', 'Extra lights spread over (% streak)', 0, 100, 1],
    ['ramp', 'n', 'Fades in over first (m) of flight', 0, 5, 0.05],
    ['leftover', 'n', 'Leftover frame brightness (%)', 0, 100, 1],
    ['standoff', 'n', 'Stays this far off the hit (m)', 0.05, 1.5, 0.01],
    ['near', 'n', 'Dims within (m) of the hit surface', 0, 3, 0.05],
  ]],
  ['impact', 'Impact flash (placeholder)', [
    ['on', 'b', 'Layer on'],
    ['col', 'c', 'Colour'],
    ['int', 'n', 'Light intensity (candela)', 0, 2000, 1],
    ['reach', 'n', 'Light reach (m)', 0.3, 8, 0.05],
    ['glow', 'n', 'Glow brightness (HDR)', 0, 40, 0.1],
    ['size', 'n', 'Glow radius (cm)', 1, 100, 0.5],
    ['dur', 'n', 'Duration (ms)', 10, 500, 5],
    ['offset', 'n', 'Off the surface (m)', 0.02, 1, 0.01],
  ]],
  ['freq', 'Frequency', [
    ['every', 'n', 'Tracer every Nth round', 1, 10, 1],
    ['mistUntraced', 'b', 'Untraced rounds still leave mist'],
  ]],
  ['vary', 'Shot-to-shot variation', [
    ['bright', 'n', 'Brightness jitter (+-%)', 0, 50, 0.5],
    ['width', 'n', 'Width jitter (+-%)', 0, 50, 0.5],
    ['warpPhase', 'b', 'Mist warp phase differs per round'],
  ]],
  // cover-room: the visible clock (see the header)
  ['time', 'Clock', [
    ['firstAge', 'n', 'First drawn frame shows age (ms)', 0, 16, 0.1],
  ]],
];

const U4 = {
  'proj.on': true, 'proj.speed': 400, 'proj.length': 0.85, 'proj.detach': 0.4, 'proj.width': 3, 'proj.headWidth': 1.15,
  'proj.headLen': 27, 'proj.neck': 9, 'proj.taperStart': 60, 'proj.tipWidth': 0.3, 'proj.nose': 8, 'proj.frontFade': 4,
  'proj.headCol': '#ffe0c0', 'proj.headInt': 2, 'proj.headEnd': 20, 'proj.handover': 6,
  'proj.tongue': 7, 'proj.neckDip': 0.25, 'proj.neckLen': 18,
  'proj.bodyCol': '#ffe030', 'proj.bodyInt': 1.9, 'proj.bodyEnd': 86,
  'proj.tailCol': '#ff6a24', 'proj.tailInt': 1.6, 'proj.tailFade': 12,
  'proj.hardness': 0.9, 'proj.minSigma': 0.7,
  'rim.on': true, 'rim.col': '#ff8e49', 'rim.int': 0.6, 'rim.width': 0.5,
  'halo.on': true, 'halo.col': '#ff8a3a', 'halo.int': 0.06, 'halo.radius': 60, 'halo.headBias': 0.3,
  'end.on': true, 'end.frames': 1, 'end.level': 50, 'end.orange': 0.6, 'end.maxRange': 150,
  'mist.on': true, 'mist.col': '#d8cfc0', 'mist.bright': 2.4, 'mist.aniso': 0.35, 'mist.opacity': 0.38,
  'mist.rampIn': 30, 'mist.life': 700, 'mist.halfLife': 160, 'mist.fadeShape': 0,
  'mist.w0': 5.5, 'mist.w1': 6.5, 'mist.straight': 0, 'mist.onset': 700,
  'mist.warpAmp': 3.5, 'mist.warpGrow': 1.5, 'mist.warpScale': 4.5, 'mist.curl': 0.3,
  'mist.drift': 0, 'mist.driftUp': 0.5, 'mist.fibre': 0.5, 'mist.breakup': 0.6, 'mist.breakScale': 1.4,
  'mist.breakOnset': 120, 'mist.beads': 0.5, 'mist.soft': 0.3,
  'light.on': true, 'light.col': '#ff9a40', 'light.int': 40, 'light.reach': 2, 'light.at': 0,
  'light.perRound': 1, 'light.spread': 60, 'light.ramp': 1, 'light.leftover': 50, 'light.standoff': 0.3,
  'light.near': 1.5,
  'impact.on': false, 'impact.col': '#ff8a3a', 'impact.int': 4, 'impact.reach': 1.5, 'impact.glow': 3,
  'impact.size': 5, 'impact.dur': 80, 'impact.offset': 0.08,
  'freq.every': 1, 'freq.mistUntraced': false,
  'vary.bright': 8, 'vary.width': 8, 'vary.warpPhase': true,
  // the study's live page fired on the newest 1/240 s substep, so a shot's first frame showed age 0..4.2 ms (mean 2.1)
  'time.firstAge': 2.1,
};
const CINEMATIC = Object.assign({}, U4, {
  'proj.speed': 330, 'proj.length': 1.2, 'proj.width': 6, 'proj.headWidth': 1.8, 'proj.headInt': 20,
  'proj.bodyInt': 4.5, 'proj.tailInt': 2.8,
  'halo.on': true, 'halo.int': 0.12, 'halo.radius': 35,
  'mist.opacity': 0.5, 'mist.life': 1600, 'mist.halfLife': 450, 'mist.w1': 16, 'mist.warpGrow': 4,
  'mist.curl': 1.2, 'mist.drift': 8, 'mist.driftUp': 0.7, 'mist.breakup': 0.8, 'mist.bright': 1.3,
  'light.int': 80, 'light.reach': 2.5, 'impact.on': true,
});
const PRESETS = { 'U4 reference': U4, 'Cinematic': CINEMATIC };
const PRESET_NAMES = Object.keys(PRESETS);
// eslint-disable-next-line no-unused-vars
const PRESET_ALIASES = { u4: 'U4 reference', reference: 'U4 reference', ref: 'U4 reference', cinematic: 'Cinematic' };

// ------------------------------------------------------------------------------------------------------------
// Shaders.
// PROJECTILE vertex. Per-slot uniforms (world space, metres):
//   uPA[i] = head xyz, brightness multiplier (0 = slot off)
//   uPB[i] = tail-end xyz, width multiplier (shot jitter)
//   uPC[i] = leftover shift 0..1 (toward the tail colour), glow multiplier, s at the tail end (0 = full length,
//            > 0 while the young streak is still growing out of the muzzle), unused
// Globals: uViewport = drawing buffer (px); uZMin = near clip for the streak ends (m); uMaxWidth = widest FWHM on
//   the streak (m, the head bulb), bounds the quad; uMinSigma (px); uGlowR = glow radius (m, 0 = off);
//   uMaxPx = cap on the quad half-width (px).
// Varyings are constant over a quad (gl_Position has w = 1, so they interpolate exactly).
const PROJ_VERT = /* glsl */`
  #define NR ${NR}
  attribute vec2 aCorner;            // x: 0 = tail end, 1 = head end; y: -1 / +1 across
  attribute float aSlot;
  uniform vec4 uPA[NR];
  uniform vec4 uPB[NR];
  uniform vec4 uPC[NR];
  uniform vec2 uViewport;
  uniform float uZMin;
  uniform float uMaxWidth;
  uniform float uMinSigma;
  uniform float uGlowR;
  uniform float uMaxPx;
  varying vec4 vEnds;                // tail end px (xy), head end px (zw), after near clipping
  varying vec4 vZS;                  // view depth at the tail / head end (m), s at the tail / head end (0 tail tip .. 1 head tip)
  varying vec4 vInfo;                // brightness, width multiplier, leftover shift, glow multiplier
  varying float vFocal;              // px per metre at 1 m of view depth
  void main() {
    int i = int(aSlot + 0.5);
    vec4 A = uPA[i];
    vec4 B = uPB[i];
    vec4 K = uPC[i];
    vInfo = vec4(A.w, B.w, K.x, K.y);
    vEnds = vec4(0.0); vZS = vec4(1.0, 1.0, 0.0, 1.0); vFocal = 1.0;
    if (A.w <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }      // slot off: outside the clip volume
    vec3 vh = (viewMatrix * vec4(A.xyz, 1.0)).xyz;
    vec3 vt = (viewMatrix * vec4(B.xyz, 1.0)).xyz;
    float dh = -vh.z;
    float dt = -vt.z;
    float sH = 1.0;
    float sT = K.z;
    if (dh < uZMin && dt < uZMin) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    if (dh < uZMin) { float k = (uZMin - dt) / (dh - dt); vh = mix(vt, vh, k); sH = mix(sT, 1.0, k); dh = uZMin; }
    if (dt < uZMin) { float k = (uZMin - dh) / (dt - dh); vt = mix(vh, vt, k); sT = mix(sH, sT, k); dt = uZMin; }
    vec4 ch = projectionMatrix * vec4(vh, 1.0);
    vec4 ct = projectionMatrix * vec4(vt, 1.0);
    vec2 ph = (ch.xy / ch.w * 0.5 + 0.5) * uViewport;
    vec2 pt = (ct.xy / ct.w * 0.5 + 0.5) * uViewport;
    float focal = projectionMatrix[1][1] * 0.5 * uViewport.y;
    // half extent at each end: 3.3 sigma of the widest profile, or 4 glow radii, plus a pixel
    float sigH = max(uMaxWidth * B.w * focal / dh / 2.355, uMinSigma);
    float sigT = max(uMaxWidth * B.w * focal / dt / 2.355, uMinSigma);
    float rH = min(max(3.3 * sigH, 4.0 * uGlowR * focal / dh) + 1.0, uMaxPx);
    float rT = min(max(3.3 * sigT, 4.0 * uGlowR * focal / dt) + 1.0, uMaxPx);
    vec2 ax = ph - pt;
    float l = length(ax);
    ax = l > 1e-3 ? ax / l : vec2(1.0, 0.0);
    vec2 nr = vec2(-ax.y, ax.x);
    vec2 p = aCorner.x > 0.5 ? ph + ax * rH + nr * (aCorner.y * rH) : pt - ax * rT + nr * (aCorner.y * rT);
    vEnds = vec4(pt, ph);
    vZS = vec4(dt, dh, sT, sH);
    vFocal = focal;
    gl_Position = vec4(p / uViewport * 2.0 - 1.0, 0.0, 1.0);
  }`;

// PROJECTILE fragment. Uniforms (u = position along the streak from the FRONT, 0 = head tip .. 1 = tail tip):
//   uWidth = body FWHM (m); uHeadMul = head bulb width / body; uHeadLen, uNeck = bulb length and its narrowing (u);
//   uTaperStart, uTipWidth = where the tail taper starts (u) and the width left at the tip (x body);
//   uFrontFade = front fade-in length (u); uHeadCol / uBodyCol / uTailCol = linear HDR colour x intensity;
//   uHeadEnd, uHandover = head-zone end and the width of the hand-over (u); uTongue = how much later (u) the hot
//   centre hands over than the edges; uNeckDip, uNeckLen = dimmer, more
//   saturated stretch behind the head; uBodyEnd = where the body turns into the tail (u); uTailFade = fade-out
//   length at the tip (u); uHardness 0..1 = Gaussian .. flat core with a crisp edge (exponent 2 .. 8; only when sigma
//   > 1.5 px, thin lines stay Gaussian). A bright Gaussian looks about twice its FWHM after tone mapping; the hard
//   edge keeps the visible width at the set width, as in the footage (hard core, 2-6 px rim at 4K);
//   uMinSigma (px); uRimCol = linear HDR rim colour, uRimWidth = share of the falloff it covers (0 = off);
//   uGlowCol = linear HDR glow colour, uGlowR = glow radius (m, 0 = off), uGlowHead = glow gathered at the head;
//   uFogDensity = the scene's FogExp2 density (1/m); tSceneDepth / uNearFar / uOccSoft = soft occlusion against
//   the opaque scene (uOccSoft in m).
const projFrag = (depthGLSL) => /* glsl */`
  uniform highp sampler2D tSceneDepth;
  uniform vec2 uNearFar;
  uniform float uOccSoft;
  uniform float uWidth;
  uniform float uHeadMul;
  uniform float uHeadLen;
  uniform float uNeck;
  uniform float uTaperStart;
  uniform float uTipWidth;
  uniform float uFrontFade;
  uniform float uNose;
  uniform vec3 uHeadCol;
  uniform vec3 uBodyCol;
  uniform vec3 uTailCol;
  uniform float uHeadEnd;
  uniform float uHandover;
  uniform float uTongue;
  uniform float uNeckDip;
  uniform float uNeckLen;
  uniform float uBodyEnd;
  uniform float uTailFade;
  uniform float uHardness;
  uniform float uMinSigma;
  uniform vec3 uRimCol;
  uniform float uRimWidth;
  uniform vec3 uGlowCol;
  uniform float uGlowR;
  uniform float uGlowHead;
  uniform float uFogDensity;
  uniform float uDebug;              // 1 = tint the quad (geometry view), 0 = off
  varying vec4 vEnds;
  varying vec4 vZS;
  varying vec4 vInfo;
  varying float vFocal;
  ${depthGLSL}
  void main() {
    vec2 p = gl_FragCoord.xy;
    vec2 a = vEnds.xy;
    vec2 ab = vEnds.zw - a;
    float L2 = dot(ab, ab);
    float sg = L2 > 1e-6 ? clamp(dot(p - a, ab) / L2, 0.0, 1.0) : 1.0;     // screen-linear, 0 tail end .. 1 head end
    float dpx = length(p - (a + ab * sg));                                   // px from the axis (round caps)
    float iz = mix(1.0 / vZS.x, 1.0 / vZS.y, sg);                            // 1/depth is linear on screen
    float z = 1.0 / iz;
    float wl = (sg / vZS.y) / iz;                                            // the same point, linear in the world
    float u = 1.0 - mix(vZS.z, vZS.w, wl);                                   // from the front: 0 head tip .. 1 tail tip
    float pxPerM = vFocal * iz;

    // side-on vs head-on: a streak foreshortened to about its own width is seen down its axis, so its nose and
    // front fade (which run along the axis) must not eat the round head disc
    float lenPx = sqrt(L2);
    float headPx = max(uWidth * vInfo.y * uHeadMul * vFocal / vZS.y, 1.0);
    float sideOn = smoothstep(1.0, 4.0, lenPx / headPx);
    // world-space width profile: rounded nose, bulb at the head, body, taper toward the tail tip
    float bulb = 1.0 - smoothstep(uHeadLen - 0.5 * uNeck, uHeadLen + 0.5 * uNeck, u);
    float taper = mix(1.0, uTipWidth, smoothstep(uTaperStart, 1.0, u));
    float nq = clamp(u / max(uNose, 1e-4), 0.0, 1.0);
    float nose = mix(1.0, sqrt(nq * (2.0 - nq)), sideOn);                    // quarter-circle nose
    float fwhmPx = uWidth * vInfo.y * mix(1.0, uHeadMul, bulb) * taper * nose * pxPerM;
    float sigW = fwhmPx / 2.355;
    float sigma = max(sigW, uMinSigma);
    float gain = clamp(sigW / sigma, 0.05, 1.0);                             // a widened sub-pixel line keeps its energy
    float pw = 2.0 + 6.0 * uHardness * smoothstep(1.5, 4.0, sigma);           // Gaussian .. flat core with a crisp edge, same FWHM
    float cd = sigma * 1.1774 / pow(1.3863, 1.0 / pw);
    float g = exp(-0.5 * pow(dpx / cd, pw));

    // HDR colour ramp along the streak
    // zones blend per channel in LOG intensity, so the visible white-to-yellow edge sits inside the hand-over
    // instead of at its far end (a linear blend of x40 and x2 stays clipped white almost all the way)
    // the hot centre hands over later than the edges (by uTongue at the axis), so the white runs on as a tongue
    // inside the yellow and the edges turn orange first toward the tail
    float uc = u - uTongue * (g - 0.5);
    float hb = smoothstep(uHeadEnd - 0.5 * uHandover, uHeadEnd + 0.5 * uHandover, uc);  // 0 head .. 1 body
    float bt = smoothstep(uBodyEnd, uBodyEnd + 0.6 * (1.0 - uBodyEnd), uc);             // 0 body .. 1 tail
    vec3 lh = log(max(uHeadCol, vec3(1e-4)));
    vec3 lb = log(max(uBodyCol, vec3(1e-4)));
    vec3 lt = log(max(uTailCol, vec3(1e-4)));
    vec3 col = exp(mix(mix(lh, lb, hb), lt, bt));
    float neckEnd = uHeadEnd + 0.5 * uHandover + uNeckLen;
    col *= 1.0 - uNeckDip * hb * (1.0 - smoothstep(uHeadEnd + 0.5 * uHandover, neckEnd, u));
    col = mix(col, uTailCol, vInfo.z);                                                  // leftover frame: oranger

    // ends: the front fades in (not when the streak is foreshortened to a head-on disc), the tail fades out
    float ends = mix(1.0, smoothstep(0.0, max(uFrontFade, 1e-4), u), sideOn) * (1.0 - smoothstep(1.0 - uTailFade, 1.0, u));

    // edge fringe: the outer part of the falloff turns to the rim colour
    float rim = uRimWidth > 0.0 ? 1.0 - smoothstep(0.06, 0.06 + 0.9 * uRimWidth, g) : 0.0;
    vec3 rgb = mix(col, uRimCol, rim) * (g * gain * ends);

    // effect-side glow (world-space radius, so it shrinks with distance like the core). Its own envelope: it wraps
    // round both ends through the distance to the segment, so it must not take the core's end fades (that cut it
    // off square at the ends); it is strongest at the head (uGlowHead) and dies out toward the tail tip.
    if (uGlowR > 0.0) {
      float env = mix(1.0, 1.0 - hb, uGlowHead) * (1.0 - smoothstep(0.55, 1.0, u));
      // broad, flat-topped falloff (the hero's halo lift fits 1 / (1 + (d/R)^2)^p closely), cut to 0 at 4 radii (the quad edge)
      float q = (dpx / pxPerM) / uGlowR;
      float glo = max(pow(1.0 + q * q, -1.25) - 0.029, 0.0) * 1.03 * env;
      rgb += uGlowCol * (glo * vInfo.w);
    }
    rgb *= vInfo.x;

    // soft occlusion by the opaque scene, and the scene fog
    float sceneZ = rangeViewDepth(texelFetch(tSceneDepth, ivec2(gl_FragCoord.xy), 0).r, uNearFar);
    float occ = smoothstep(0.0, uOccSoft, sceneZ - z);
    float fog = exp(-uFogDensity * uFogDensity * z * z);
    gl_FragColor = vec4(rgb * (occ * fog) + uDebug * vec3(0.0, 0.035, 0.06), 1.0);
  }`;

// MIST vertex. Per-slot uniforms:
//   uMA[i] = muzzle (path origin) xyz, the round's age (s; <= 0 = nothing yet)
//   uMB[i] = path direction xyz (unit), path length (m, to the hit or the max range)
//   uMC[i] = speed (m/s), seed 0..1 (warp phase), width multiplier, opacity multiplier (0 = slot off)
// Globals: uLife (s); uRamp (s) ramp-in after the head passes; uWidths = birth / late FWHM (m);
//   uStraight (s) = straight phase, uOnset (s) = the warp then grows in over this long; uWarpAmp (m) = bend at birth,
//   uWarpGrow (x) = amplitude reached after the onset; uWarpScale (m) = wavelength; uCurl (1/s) = how fast the bend
//   changes shape; uDrift (m/s) and uDriftUp (0 random direction .. 1 up); uViewport (px); uMinPx = thinnest drawn
//   FWHM (px; thinner mist is widened and made fainter by the same factor).
const MIST_VERT = /* glsl */`
  #define NR ${NR}
  attribute float aSlot;
  attribute float aU;                // 0 at the muzzle .. 1 at the far end of the path
  attribute float aSide;             // -1 / +1 across
  uniform vec4 uMA[NR];
  uniform vec4 uMB[NR];
  uniform vec4 uMC[NR];
  uniform float uLife;
  uniform float uRamp;
  uniform vec2 uWidths;
  uniform float uStraight;
  uniform float uOnset;
  uniform float uWarpAmp;
  uniform float uWarpGrow;
  uniform float uWarpScale;
  uniform float uCurl;
  uniform float uDrift;
  uniform float uDriftUp;
  uniform vec2 uViewport;
  uniform float uMinPx;
  varying vec2 vUA;                  // across (-1 .. 1 at the quad edge), distance from the muzzle (m)
  varying vec4 vM;                   // age of this point (s), seed, opacity multiplier, FWHM (m)
  varying float vViewZ;
  varying vec3 vWorld;
  float hash11(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
  float vn1(float x) { float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash11(i), hash11(i + 1.0), f) * 2.0 - 1.0; }
  float fbm1(float x) { return 0.72 * vn1(x) + 0.28 * vn1(x * 2.31 + 13.7); }
  // centre of the mist at distance d from the muzzle for a point of age 'age'
  vec3 centreAt(vec3 o, vec3 dir, float d, float age, float seed, vec3 e1, vec3 e2, vec3 driftDir) {
    float x = d / uWarpScale + seed * 61.0;
    float ev = max(age, 0.0) * uCurl;
    vec2 w = vec2(fbm1(x + ev), fbm1(x * 0.87 + 31.7 - ev * 0.83));
    float grow = 1.0 + (uWarpGrow - 1.0) * smoothstep(uStraight, uStraight + max(uOnset, 1e-3), age);
    float anchor = smoothstep(0.0, 0.6, d);                     // pinned at the muzzle
    return o + dir * d + (e1 * w.x + e2 * w.y) * (uWarpAmp * grow * anchor) + driftDir * (uDrift * max(age, 0.0) * anchor);
  }
  void main() {
    int i = int(aSlot + 0.5);
    vec4 A = uMA[i];
    vec4 B = uMB[i];
    vec4 K = uMC[i];
    vUA = vec2(0.0); vM = vec4(0.0); vViewZ = 1.0; vWorld = vec3(0.0);
    if (A.w <= 0.0 || K.w <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    vec3 dir = B.xyz;
    float speed = K.x;
    float seed = K.y;
    float headD = min(speed * A.w, B.w);
    float d = min(aU * B.w, headD);
    float age = A.w - d / speed;                                // time since the head passed this point
    vec3 ref = abs(dir.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 e1 = normalize(cross(dir, ref));
    vec3 e2 = cross(e1, dir);
    float ang = seed * 6.2832;
    vec3 rnd = e1 * cos(ang) + e2 * sin(ang);
    vec3 driftDir = normalize(mix(rnd, vec3(0.0, 1.0, 0.0), uDriftUp) + vec3(0.0, 1e-4, 0.0));
    vec3 c = centreAt(A.xyz, dir, d, age, seed, e1, e2, driftDir);
    float da = max(d - 0.05, 0.0);
    float db = min(d + 0.05, headD);
    vec3 ca = centreAt(A.xyz, dir, da, A.w - da / speed, seed, e1, e2, driftDir);
    vec3 cb = centreAt(A.xyz, dir, db, A.w - db / speed, seed, e1, e2, driftDir);
    vec3 tng = cb - ca;
    float tl = length(tng);
    tng = tl > 1e-6 ? tng / tl : dir;
    vec3 side = cross(tng, cameraPosition - c);
    float sl = length(side);
    side = sl > 1e-6 ? side / sl : e1;
    float width = mix(uWidths.x, uWidths.y, smoothstep(0.0, uLife, age)) * K.z;
    width *= mix(0.6, 1.0, smoothstep(0.0, max(uRamp, 1e-4), age));      // about 80% of its width one frame in
    float depth = max(-(viewMatrix * vec4(c, 1.0)).z, 1e-3);
    float pxPerM = projectionMatrix[1][1] * 0.5 * uViewport.y / depth;
    float comp = 1.0;
    if (width * pxPerM < uMinPx) { comp = width * pxPerM / uMinPx; width = uMinPx / pxPerM; }
    vec3 pos = c + side * (aSide * width * 1.25);              // quad half-width = 1.25 FWHM = 2.94 sigma
    vec4 mv = viewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    vViewZ = -mv.z;
    vWorld = pos;
    vUA = vec2(aSide, d);
    vM = vec4(age, seed, K.w * comp, width);
  }`;

// MIST fragment. Uniforms: uAlbedo = linear mist colour; uOpacity = alpha at the peak; uRamp, uLife (s);
//   uHalf = fade half-life (s); uFadeShape 0 exponential .. 1 linear; uFibre 0..1 = fibrous edges; uBreakup 0..1,
//   uBreakScale (m), uBreakOnset (s) = patchy break-up; uBeads 0..1 = beaded line for the first frame;
//   uAmbient = linear radiance factor of the fill (hemisphere average / pi x brightness); uSunCol = the key light's
//   colour x intensity / pi x brightness, uSunDir = unit vector toward it, uAniso = Henyey-Greenstein g;
//   uFogCol, uFogDensity = the scene's FogExp2; tSceneDepth / uNearFar / uSoft (m) = soft edge against surfaces.
const mistFrag = (depthGLSL) => /* glsl */`
  uniform highp sampler2D tSceneDepth;
  uniform vec2 uNearFar;
  uniform float uSoft;
  uniform vec3 uAlbedo;
  uniform float uOpacity;
  uniform float uRamp;
  uniform float uLife;
  uniform float uHalf;
  uniform float uFadeShape;
  uniform float uFibre;
  uniform float uBreakup;
  uniform float uBreakScale;
  uniform float uBreakOnset;
  uniform float uBeads;
  uniform vec3 uAmbient;
  uniform vec3 uSunCol;
  uniform vec3 uSunDir;
  uniform float uAniso;
  uniform vec3 uFogCol;
  uniform float uFogDensity;
  uniform float uDebug;              // 1 = tint the ribbon (geometry view), 0 = off
  varying vec2 vUA;
  varying vec4 vM;
  varying float vViewZ;
  varying vec3 vWorld;
  ${depthGLSL}
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float vn2(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  void main() {
    float age = vM.x;
    if (age <= 0.0 || age >= uLife) discard;
    float seed = vM.y;
    float c = vUA.x;
    float along = vUA.y;
    float w = max(vM.w, 1e-3);
    // opacity over the age of this point: ramp in, then fade (exponential .. linear), forced to 0 at the end of life
    float ramp = smoothstep(0.0, max(uRamp, 1e-4), age);
    float expo = exp(-age * 0.6931 / max(uHalf, 1e-3));
    float lin = clamp(1.0 - age / uLife, 0.0, 1.0);
    float fade = mix(expo, lin, uFadeShape) * (1.0 - smoothstep(0.8 * uLife, uLife, age));
    // cross-section: Gaussian whose width wobbles along the path (fibrous edges), fine fibres at the rim
    float wob = vn2(vec2(along / (w * 5.0) + seed * 40.0, 3.7));
    float cEff = c / max(1.0 + uFibre * (wob - 0.5) * 0.9, 0.2);
    float prof = exp(-4.33 * cEff * cEff);
    float fib = vn2(vec2(along / (w * 1.6) + seed * 13.0, c * 3.0 + 7.1));
    prof *= 1.0 - uFibre * 0.6 * smoothstep(0.25, 0.9, abs(c)) * fib;
    // patchy break-up that grows with age (slowly changing noise along the path)
    float bAmt = uBreakup * smoothstep(uBreakOnset, max(uLife * 0.75, uBreakOnset + 1e-3), age);
    float m = 0.65 * vn2(vec2(along / uBreakScale + seed * 23.0, age * 0.8 + seed * 5.0))
            + 0.35 * vn2(vec2(along / (uBreakScale * 0.37) + 11.0, age * 1.3 + 2.0));
    float brk = mix(1.0, smoothstep(0.32, 0.62, m), bAmt);
    // beaded at birth: a dotted line that merges within about a frame
    float spacing = 2.5 * w;
    float bead = pow(0.5 + 0.5 * cos(6.2832 * along / spacing + seed * 50.0), 3.0) * 1.8;
    float beadMix = uBeads * (1.0 - smoothstep(0.0, 0.02, age));
    float alpha = uOpacity * vM.z * ramp * fade * prof * brk * mix(1.0, bead, beadMix);
    // lit by the scene: fill + key light with forward scattering (normalised so g = 0 gives the plain key)
    vec3 V = normalize(cameraPosition - vWorld);
    float cosT = dot(-uSunDir, V);
    float g = uAniso;
    float hg = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosT, 1e-4), 1.5);
    vec3 col = uAlbedo * (uAmbient + uSunCol * (0.5 * hg));
    float fogF = 1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ);
    col = mix(col, uFogCol, fogF);
    // soft edge where the mist meets the opaque scene (also hides it behind geometry)
    float sceneZ = rangeViewDepth(texelFetch(tSceneDepth, ivec2(gl_FragCoord.xy), 0).r, uNearFar);
    alpha *= smoothstep(0.0, 1.0, (sceneZ - vViewZ) / max(uSoft, 1e-3));
    if (uDebug > 0.5) { col = mix(col, vec3(0.05, 0.5, 0.25), 0.6); alpha = max(alpha, 0.35); }
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }`;

// IMPACT FLASH vertex (placeholder for a later impact effect). Per-slot uniform (world space, metres):
//   uIA[i] = glow centre xyz (the hit point, pulled off the surface along its normal), brightness 0..1 (0 = slot off)
// Globals: uSize = glow radius (m); the quad's half-size is 3 radii, turned to face the camera in view space.
const IMP_VERT = /* glsl */`
  #define NR ${NR}
  attribute vec2 aCorner;            // -1 / +1 in x and y
  attribute float aSlot;
  uniform vec4 uIA[NR];
  uniform float uSize;
  varying vec2 vQ;                   // quad position in glow radii (-3 .. 3)
  varying float vB;                  // brightness 0..1
  varying float vViewZ;              // view depth of the glow centre (m)
  void main() {
    int i = int(aSlot + 0.5);
    vec4 A = uIA[i];
    vQ = aCorner * 3.0; vB = A.w; vViewZ = 1.0;
    if (A.w <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }   // slot off: outside the clip volume
    vec4 mv = viewMatrix * vec4(A.xyz, 1.0);
    vViewZ = -mv.z;
    mv.xy += aCorner * (3.0 * uSize);
    gl_Position = projectionMatrix * mv;
  }`;

// IMPACT FLASH fragment. Uniforms: uCol = linear HDR colour x glow brightness; uSize = glow radius (m);
//   uFogDensity = the scene's FogExp2 density (1/m); tSceneDepth / uNearFar = the opaque scene depth, so the glow
//   hides behind nearer geometry but not behind the surface it sits on (its depth is pulled one radius toward the
//   camera and the fade runs over one more radius).
const impFrag = (depthGLSL) => /* glsl */`
  uniform highp sampler2D tSceneDepth;
  uniform vec2 uNearFar;
  uniform vec3 uCol;
  uniform float uSize;
  uniform float uFogDensity;
  varying vec2 vQ;
  varying float vB;
  varying float vViewZ;
  ${depthGLSL}
  void main() {
    float r2 = dot(vQ, vQ);                                       // squared distance in glow radii
    float core = exp(-2.0 * r2);                                  // hot centre
    float halo = max(1.0 / (1.0 + 2.5 * r2) - 0.1, 0.0) * 0.35;   // soft skirt, 0 at the quad edge (3 radii)
    float sceneZ = rangeViewDepth(texelFetch(tSceneDepth, ivec2(gl_FragCoord.xy), 0).r, uNearFar);
    float occ = smoothstep(0.0, uSize, sceneZ - (vViewZ - uSize));
    float fog = exp(-uFogDensity * uFogDensity * vViewZ * vViewZ);
    gl_FragColor = vec4(uCol * ((core + halo) * vB * occ * fog), 1.0);
  }`;

export const TRACER_SCHEMA = SCHEMA;
export const TRACER_PRESETS = PRESETS;

// ------------------------------------------------------------------------------------------------------------
export function createTracer(game, shared) {
  const T3 = THREE;
  const render = game.render;
  const clock = shared.clock;
  const P = Object.assign({}, U4);            // the live values ("group.key"), kept in sync with game.params
  let version = 0, derivedVersion = -1;
  shared.bindParams('vfx.tracer.', SCHEMA, PRESETS, 'U4 reference', P, () => { version++; });

  let fxScene = null, fxPass = null, removePass = null;
  let projMesh = null, mistMesh = null, projGeo = null, mistGeo = null, projMat = null, mistMat = null;
  let impMesh = null, impGeo = null, impMat = null;
  let PA = null, PB = null, PC = null, MA = null, MB = null, MC = null, IA = null;   // Float32Array views of the slot uniforms
  const LREQ = new Float64Array(NL * 8);            // per light request this frame: x y z intensity reach mix-to-impact shot -
  const ORDER = new Int32Array(NR);                 // active rounds, newest first (rebuilt in render, no allocation)
  const FV = new Float64Array(8);                   // this frame's values for placeLights(): renderTime, speed, streak
                                                    // length, leftover s, brightness jitter, max range, detach
  const CLOCK = new Float64Array(2);                // [0] t of the last update(), [1] the last renderTime drawn
  const reducedStatic = false;                      // the study's reduced-motion still: the game handles reduced motion
  const rounds = [];
  const D = {};                                     // derived linear colours
  let shotCount = 0;

  function makeRound(i) {
    return {
      index: i, active: false, drawn: false, shot: -1, t0: 0, traced: false, mist: false,
      origin: new T3.Vector3(), dir: new T3.Vector3(0, 0, -1),
      hitDist: Infinity, hitPoint: new T3.Vector3(), hitNormal: new T3.Vector3(0, 1, 0), hitObject: null,
      rnd: new Float32Array(NRND),
    };
  }


  function derive() {
    const col = (k, mul) => D[k].set(P[k]).multiplyScalar(mul);
    col('proj.headCol', P['proj.headInt']);
    col('proj.bodyCol', P['proj.bodyInt']);
    col('proj.tailCol', P['proj.tailInt']);
    col('rim.col', P['rim.int']);
    col('halo.col', P['halo.int']);
    D['mist.col'].set(P['mist.col']);
    const pu = projMat.uniforms;
    pu.uHeadCol.value.copy(D['proj.headCol']);
    pu.uBodyCol.value.copy(D['proj.bodyCol']);
    pu.uTailCol.value.copy(D['proj.tailCol']);
    pu.uRimCol.value.copy(D['rim.col']);
    pu.uRimWidth.value = P['rim.on'] ? P['rim.width'] : 0;
    pu.uGlowCol.value.copy(D['halo.col']);
    pu.uGlowR.value = P['halo.on'] && P['halo.int'] > 0 ? P['halo.radius'] * 0.01 : 0;
    pu.uGlowHead.value = P['halo.headBias'];
    pu.uWidth.value = P['proj.width'] * 0.01;
    pu.uHeadMul.value = P['proj.headWidth'];
    pu.uHeadLen.value = P['proj.headLen'] * 0.01;
    pu.uNeck.value = P['proj.neck'] * 0.01;
    pu.uTaperStart.value = P['proj.taperStart'] * 0.01;
    pu.uTipWidth.value = P['proj.tipWidth'];
    pu.uFrontFade.value = P['proj.frontFade'] * 0.01;
    pu.uNose.value = P['proj.nose'] * 0.01;
    pu.uHeadEnd.value = P['proj.headEnd'] * 0.01;
    pu.uHandover.value = P['proj.handover'] * 0.01;
    pu.uTongue.value = P['proj.tongue'] * 0.01;
    pu.uNeckDip.value = P['proj.neckDip'];
    pu.uNeckLen.value = P['proj.neckLen'] * 0.01;
    pu.uBodyEnd.value = P['proj.bodyEnd'] * 0.01;
    pu.uTailFade.value = P['proj.tailFade'] * 0.01;
    pu.uHardness.value = P['proj.hardness'];
    pu.uMinSigma.value = P['proj.minSigma'];
    pu.uMaxWidth.value = P['proj.width'] * 0.01 * Math.max(1, P['proj.headWidth']) * (1 + P['vary.width'] * 0.01);
    const mu = mistMat.uniforms;
    mu.uAlbedo.value.copy(D['mist.col']);
    mu.uOpacity.value = P['mist.opacity'];
    mu.uRamp.value = P['mist.rampIn'] * 0.001;
    mu.uLife.value = P['mist.life'] * 0.001;
    mu.uHalf.value = P['mist.halfLife'] * 0.001;
    mu.uFadeShape.value = P['mist.fadeShape'];
    mu.uWidths.value.set(P['mist.w0'] * 0.01, P['mist.w1'] * 0.01);
    mu.uStraight.value = P['mist.straight'] * 0.001;
    mu.uOnset.value = P['mist.onset'] * 0.001;
    mu.uWarpAmp.value = P['mist.warpAmp'] * 0.01;
    mu.uWarpGrow.value = P['mist.warpGrow'];
    mu.uWarpScale.value = P['mist.warpScale'];
    mu.uCurl.value = P['mist.curl'];
    mu.uDrift.value = P['mist.drift'] * 0.01;
    mu.uDriftUp.value = P['mist.driftUp'];
    mu.uFibre.value = P['mist.fibre'];
    mu.uBreakup.value = P['mist.breakup'];
    mu.uBreakScale.value = P['mist.breakScale'];
    mu.uBreakOnset.value = P['mist.breakOnset'] * 0.001;
    mu.uBeads.value = P['mist.beads'];
    mu.uSoft.value = P['mist.soft'];
    mu.uAniso.value = P['mist.aniso'];
    D['light.col'].set(P['light.col']);                           // linear; the pool lights mix toward impact.col
    D['impact.col'].set(P['impact.col']);
    impMat.uniforms.uCol.value.copy(D['impact.col']).multiplyScalar(P['impact.glow']);
    impMat.uniforms.uSize.value = P['impact.size'] * 0.01;
    derivedVersion = version;
  }

  function readLights() {
    const SL = shared.sceneLights(), sunLight = SL.sun, fillLight = SL.fill;
    const mu = mistMat.uniforms;
    const b = P['mist.bright'] / Math.PI;
    // fields written directly, with the same arithmetic as copy / add / multiplyScalar / normalize: a computed number
    // passed to a method the JIT does not inline is boxed, which made this a per-frame heap allocation
    const am = mu.uAmbient.value, sc = mu.uSunCol.value;
    if (fillLight) {
      const fc = fillLight.color, gc = fillLight.groundColor, s = 0.5 * fillLight.intensity * b;
      am.r = (fc.r + gc.r) * s; am.g = (fc.g + gc.g) * s; am.b = (fc.b + gc.b) * s;
    } else { const s = 0.1 * b; am.r = s; am.g = s; am.b = s; }
    if (sunLight) {
      const lc = sunLight.color, s = sunLight.intensity * b;
      sc.r = lc.r * s; sc.g = lc.g * s; sc.b = lc.b * s;
      const sp = sunLight.position, tp = sunLight.target.position, sd = mu.uSunDir.value;
      const dx = sp.x - tp.x, dy = sp.y - tp.y, dz = sp.z - tp.z;
      const inv = 1 / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
      sd.x = dx * inv; sd.y = dy * inv; sd.z = dz * inv;
    } else { sc.r = 0; sc.g = 0; sc.b = 0; }
    const fog = render.scene.fog;
    const fd = fog && fog.isFogExp2 ? fog.density : 0;
    if (mu.uFogDensity.value !== fd) mu.uFogDensity.value = fd;                 // write scalars only on change: a number
    if (projMat.uniforms.uFogDensity.value !== fd) projMat.uniforms.uFogDensity.value = fd;   // stored per frame is a heap box
    if (impMat.uniforms.uFogDensity.value !== fd) impMat.uniforms.uFogDensity.value = fd;
    if (fog) mu.uFogCol.value.copy(fog.color);
  }

  function pathLength(r) { return Math.min(r.hitDist, P['end.maxRange']); }
  function speedNow() { return Math.max(P['proj.speed'], 1); }
  function projLife(r) {                          // s of the projectile asset: flight plus the leftover frame
    return pathLength(r) / speedNow() + (P['end.on'] ? P['end.frames'] * FRAME : 0);
  }
  function mistLife(r) { return pathLength(r) / speedNow() + P['mist.life'] * 0.001; }
  function impactLife(r) {                        // s: flight plus the flash; 0 = no flash (layer off, untraced, or no hit)
    return P['impact.on'] && r.traced && r.hitObject ? pathLength(r) / speedNow() + P['impact.dur'] * 0.001 : 0;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Geometry: one shared buffer per asset, NR instances each (static; the shaders place everything)
  function buildProjectileGeometry() {
    const g = new T3.BufferGeometry();
    const corner = new Float32Array(NR * 4 * 2), slot = new Float32Array(NR * 4), pos = new Float32Array(NR * 4 * 3);
    const idx = [];
    for (let i = 0; i < NR; i++) {
      const c = [[0, -1], [0, 1], [1, -1], [1, 1]];
      for (let k = 0; k < 4; k++) { corner[(i * 4 + k) * 2] = c[k][0]; corner[(i * 4 + k) * 2 + 1] = c[k][1]; slot[i * 4 + k] = i; }
      const b = i * 4;
      idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
    g.setAttribute('position', new T3.BufferAttribute(pos, 3));        // unused by the shader; three.js wants one
    g.setAttribute('aCorner', new T3.BufferAttribute(corner, 2));
    g.setAttribute('aSlot', new T3.BufferAttribute(slot, 1));
    g.setIndex(idx);
    return g;
  }
  function buildMistGeometry() {
    const g = new T3.BufferGeometry();
    const nv = NR * (SEG + 1) * 2;
    const slot = new Float32Array(nv), uu = new Float32Array(nv), side = new Float32Array(nv), pos = new Float32Array(nv * 3);
    const idx = [];
    let v = 0;
    for (let i = 0; i < NR; i++) {
      const base = v;
      for (let s = 0; s <= SEG; s++) {
        for (const sd of [-1, 1]) { slot[v] = i; uu[v] = s / SEG; side[v] = sd; v++; }
        if (s < SEG) { const a = base + s * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      }
    }
    g.setAttribute('position', new T3.BufferAttribute(pos, 3));
    g.setAttribute('aSlot', new T3.BufferAttribute(slot, 1));
    g.setAttribute('aU', new T3.BufferAttribute(uu, 1));
    g.setAttribute('aSide', new T3.BufferAttribute(side, 1));
    g.setIndex(idx);
    return g;
  }
  function buildImpactGeometry() {
    const g = new T3.BufferGeometry();
    const corner = new Float32Array(NR * 4 * 2), slot = new Float32Array(NR * 4), pos = new Float32Array(NR * 4 * 3);
    const idx = [];
    const c = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (let i = 0; i < NR; i++) {
      for (let k = 0; k < 4; k++) { corner[(i * 4 + k) * 2] = c[k][0]; corner[(i * 4 + k) * 2 + 1] = c[k][1]; slot[i * 4 + k] = i; }
      const b = i * 4;
      idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
    }
    g.setAttribute('position', new T3.BufferAttribute(pos, 3));        // unused by the shader; three.js wants one
    g.setAttribute('aCorner', new T3.BufferAttribute(corner, 2));
    g.setAttribute('aSlot', new T3.BufferAttribute(slot, 1));
    g.setIndex(idx);
    return g;
  }

  // Moving light + impact flash for the instant drawn (called by render(); its numbers arrive through FV). Fills the
  // impact glow slots, then hands the NL pool lights to the newest rounds that want light: a round in flight gets
  // light.perRound lights from light.at back along its streak, its leftover frame one light, and an impact flash (if
  // on) takes the round's light over at the hit point. Every light stays light.standoff off the hit surface, and within
  // light.near of it dims with the square of that distance (a point light a few cm from a surface blows it out at any
  // intensity; uncapped, the wall flared white in the last frame of flight). Unused lights get intensity 0. Returns
  // whether any impact glow shows. Allocation-free: typed arrays and object fields only.
  function placeLights(nAct) {
    const renderTime = FV[0], v = FV[1], L = FV[2], leftDur = FV[3], jB = FV[4], maxR = FV[5], det = FV[6];
    const lightOn = P['light.on'] && P['light.int'] > 0;
    const impOn = P['impact.on'];
    const per = Math.max(1, Math.min(NL, Math.round(P['light.perRound'])));
    const fdur = Math.max(P['impact.dur'] * 0.001, 1e-3);
    const so = P['light.standoff'];
    let nl = 0, anyI = false;
    for (let k = 0; k < nAct; k++) {
      const i = ORDER[k], r = rounds[i];
      if (!r.traced || !r.drawn) continue;
      const path = Math.min(r.hitDist, maxR);
      let age = Math.max(renderTime - r.t0, 0);
      if (reducedStatic) age = path * P['still.reducedAt'] * 0.01 / v;
      const tHit = path / v;
      const o = r.origin, d = r.dir, hp = r.hitPoint, hn = r.hitNormal;
      // impact flash: a glow at the hit point (off the surface along its normal), quadratic fade over impact.dur
      let flash = 0;
      if (impOn && r.hitObject && age >= tHit && age < tHit + fdur) {
        const x = (age - tHit) / fdur;
        flash = (1 - x) * (1 - x);
        const off = P['impact.offset'], o4 = i * 4;
        IA[o4] = hp.x + hn.x * off; IA[o4 + 1] = hp.y + hn.y * off; IA[o4 + 2] = hp.z + hn.z * off; IA[o4 + 3] = flash;
        anyI = true;
      }
      if (nl >= NL) continue;
      if (flash > 0) {                                              // the hand-off: the round's light flashes at the hit
        const off = Math.max(so, P['impact.offset']), b = nl * 8;
        LREQ[b] = hp.x + hn.x * off; LREQ[b + 1] = hp.y + hn.y * off; LREQ[b + 2] = hp.z + hn.z * off;
        LREQ[b + 3] = P['impact.int'] * flash; LREQ[b + 4] = P['impact.reach']; LREQ[b + 5] = 1; LREQ[b + 6] = r.shot;
        nl++;
        continue;
      }
      if (!lightOn || age >= tHit + leftDur) continue;
      // computed only on the paths that use them: a value left unused on the past-the-leftover path was boxed (12 B
      // per frame, found with the heap sampler)
      const bright = 1 + (r.rnd[0] * 2 - 1) * jB;
      const hit = r.hitObject !== null;
      // farthest a light may go along the path: `so` off the hit surface, measured along its normal (so a grazing
      // hit pulls the light back further, up to 4 x so); nearM: the near-field dimmer, see nearDim below
      const cosI = hit ? Math.abs(d.x * hn.x + d.y * hn.y + d.z * hn.z) : 1.0;
      const dMax = hit ? path - so / Math.max(cosI, 0.25) : path;
      const nearM = hit ? P['light.near'] : 0.0;
      if (age < tHit) {                                             // in flight: perRound lights from the head back
        const headD = v * age;
        if (headD <= det + 1e-3) continue;
        const rampM = P['light.ramp'];
        const I0 = P['light.int'] * bright;
        const sLen = Math.min(L, headD - det);                      // the streak drawn now
        for (let j = 0; j < per && nl < NL; j++) {
          const back = (P['light.at'] + (per > 1 ? P['light.spread'] * j / (per - 1) : 0)) * 0.01 * sLen;
          const dd = Math.max(Math.min(headD - back, dMax), det);
          // each light fades in over its OWN first rampM metres, so a light spread back toward the tail never sits
          // at full strength next to the shooter
          let ramp = 1;
          if (rampM > 0) { const x = Math.min(Math.max((dd - det) / rampM, 0), 1); ramp = x * x * (3 - 2 * x); }
          const I = I0 * ramp;
          // near the hit surface a point light blows it out (inverse square): closer than nearM to its plane, the
          // light dims with the square of that distance, so the surface gets no more than it would at nearM
          const sp = (path - dd) * cosI;
          const nearDim = nearM > 0 && sp < nearM ? (sp * sp) / (nearM * nearM) : 1;
          const b = nl * 8;
          LREQ[b] = o.x + d.x * dd; LREQ[b + 1] = o.y + d.y * dd; LREQ[b + 2] = o.z + d.z * dd;
          LREQ[b + 3] = I * nearDim; LREQ[b + 4] = P['light.reach']; LREQ[b + 5] = 0; LREQ[b + 6] = r.shot;
          nl++;
        }
      } else {                                                      // leftover frame: one dimmer light by the hit
        const dd = Math.max(dMax, det), b = nl * 8;
        const sp = (path - dd) * cosI;
        const nearDim = nearM > 0 && sp < nearM ? (sp * sp) / (nearM * nearM) : 1;
        LREQ[b] = o.x + d.x * dd; LREQ[b + 1] = o.y + d.y * dd; LREQ[b + 2] = o.z + d.z * dd;
        LREQ[b + 3] = P['light.int'] * P['light.leftover'] * 0.01 * bright * nearDim; LREQ[b + 4] = P['light.reach'];
        LREQ[b + 5] = 0; LREQ[b + 6] = r.shot;
        nl++;
      }
    }
    // cover-room: the requests go to the shared light pool (index.js), which keeps the brightest near the camera
    const lc = D['light.col'], ic = D['impact.col'];
    for (let n = 0; n < NL; n++) {
      if (n >= nl) { LREQ[n * 8 + 3] = 0; LREQ[n * 8 + 6] = -1; continue; }
      const b = n * 8, m = LREQ[b + 5];
      shared.lights.request(LREQ[b], LREQ[b + 1], LREQ[b + 2], LREQ[b + 3], LREQ[b + 4],
        lc.r + (ic.r - lc.r) * m, lc.g + (ic.g - lc.g) * m, lc.b + (ic.b - lc.b) * m);
    }
    return anyI;
  }

  // ------------------------------------------------------------------------------------------------------------
  // One pass draws the effect scene onto the HDR image (after the distortion composite, before bloom).
  function makePass() {
    class FxTracerPass extends Pass {
      constructor() { super(); this.needsSwap = false; }
      render(renderer, writeBuffer, readBuffer) {
        if (!projMesh.visible && !mistMesh.visible && !impMesh.visible) return;
        const clear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.setRenderTarget(readBuffer);
        renderer.render(fxScene, render.camera);
        renderer.autoClear = clear;
      }
    }
    return new FxTracerPass();
  }

  // render(): pure presentation for the instant drawn; reads the panel every time
  function renderFrame(renderTime) {
    CLOCK[1] = renderTime;
    if (derivedVersion !== version) derive();
    const cv = render.renderer.domElement;                            // its size IS the drawing buffer (= getDrawingBufferSize)
    const bw = cv.width, bh = cv.height;
    const pu = projMat.uniforms, mu = mistMat.uniforms;
    const pv = pu.uViewport.value, mv = mu.uViewport.value;
    pv.x = bw; pv.y = bh; mv.x = bw; mv.y = bh;
    const maxPx = Math.max(bw, bh) * 0.75, zMin = Math.max(render.camera.near * 1.5, 0.05);
    if (pu.uMaxPx.value !== maxPx) pu.uMaxPx.value = maxPx;
    if (pu.uZMin.value !== zMin) pu.uZMin.value = zMin;
    pu.uNearFar.value.set(render.camera.near, render.camera.far);
    mu.uNearFar.value.set(render.camera.near, render.camera.far);
    readLights();
    const v = speedNow();
    const L = P['proj.length'] * v * FRAME;
    const leftDur = P['end.on'] ? P['end.frames'] * FRAME : 0;
    const jB = P['vary.bright'] * 0.01, jW = P['vary.width'] * 0.01;
    const maxR = P['end.maxRange'];
    const det = P['proj.detach'];                                // m: the streak is born this far ahead of the muzzle
    let anyP = false, anyM = false, nAct = 0;
    for (let i = 0; i < NR; i++) {
      const r = rounds[i];
      const o4 = i * 4;
      PA[o4 + 3] = 0; MA[o4 + 3] = 0; MC[o4 + 3] = 0; IA[o4 + 3] = 0;
      if (!r.active) continue;
      // cover-room, the visible clock: a round's clock starts on the first frame that draws it, which shows age firstAge
      // (explicit clock: the fire time, as the study's static modes)
      if (!r.drawn) { r.drawn = true; if (!clock.explicit) r.t0 = renderTime - P['time.firstAge'] * 0.001; }
      // active rounds, newest first (insertion sort on firing time, then shot number): the light pool's priority
      let j = nAct++;
      while (j > 0) {
        const q = rounds[ORDER[j - 1]];
        if (q.t0 > r.t0 || (q.t0 === r.t0 && q.shot > r.shot)) break;
        ORDER[j] = ORDER[j - 1]; j--;
      }
      ORDER[j] = i;
      const path = Math.min(r.hitDist, maxR);                     // = pathLength(r), inlined (a returned number is boxed)
      let age = Math.max(renderTime - r.t0, 0);
      if (reducedStatic) age = path * P['still.reducedAt'] * 0.01 / v;
      // projectile asset
      if (r.traced && P['proj.on']) {
        const tHit = path / v;
        let headD = -1, bright = 1 + (r.rnd[0] * 2 - 1) * jB, orange = 0;
        if (age < tHit) headD = v * age;
        else if (age < tHit + leftDur) { headD = path; bright *= P['end.level'] * 0.01; orange = P['end.orange']; }
        if (headD > det + 1e-3 && bright > 0) {
          const tailD = Math.max(headD - L, det);                    // moment 01: the young streak starts ~40 px ahead of
                                                                     // the muzzle; the mist still runs from the muzzle
          const o = r.origin, d = r.dir;                              // head / tail end = origin + dir * distance
          PA[o4] = d.x * headD + o.x; PA[o4 + 1] = d.y * headD + o.y; PA[o4 + 2] = d.z * headD + o.z; PA[o4 + 3] = bright;
          PB[o4] = d.x * tailD + o.x; PB[o4 + 1] = d.y * tailD + o.y; PB[o4 + 2] = d.z * tailD + o.z; PB[o4 + 3] = 1 + (r.rnd[1] * 2 - 1) * jW;
          PC[o4] = orange; PC[o4 + 1] = 1; PC[o4 + 2] = L > 1e-6 ? Math.max(1 - (headD - tailD) / L, 0) : 0; PC[o4 + 3] = 0;
          anyP = true;
        }
      }
      // mist asset
      if (r.mist && P['mist.on'] && age > 0 && age < path / v + P['mist.life'] * 0.001) {
        MA[o4] = r.origin.x; MA[o4 + 1] = r.origin.y; MA[o4 + 2] = r.origin.z; MA[o4 + 3] = age;
        MB[o4] = r.dir.x; MB[o4 + 1] = r.dir.y; MB[o4 + 2] = r.dir.z; MB[o4 + 3] = path;
        MC[o4] = v; MC[o4 + 1] = P['vary.warpPhase'] ? r.rnd[2] : 0.37; MC[o4 + 2] = 1 + (r.rnd[3] * 2 - 1) * jW * 0.5; MC[o4 + 3] = 1;
        anyM = true;
      }
    }
    projMesh.visible = anyP;
    mistMesh.visible = anyM;
    FV[0] = renderTime; FV[1] = v; FV[2] = L; FV[3] = leftDur; FV[4] = jB; FV[5] = maxR; FV[6] = det;
    impMesh.visible = placeLights(nAct);                          // numbers go through FV: a double passed as an
  }                                                                 // argument to a call that is not inlined is boxed

  // ------------------------------------------------------------------------------------------------------------
  // Build (the study's init)
  for (const k of ['proj.headCol', 'proj.bodyCol', 'proj.tailCol', 'rim.col', 'halo.col', 'mist.col', 'light.col', 'impact.col']) D[k] = new T3.Color();
  PA = new Float32Array(NR * 4); PB = new Float32Array(NR * 4); PC = new Float32Array(NR * 4);
  MA = new Float32Array(NR * 4); MB = new Float32Array(NR * 4); MC = new Float32Array(NR * 4);
  IA = new Float32Array(NR * 4);
  const nearFar = new T3.Vector2(render.camera.near, render.camera.far);
  projMat = new T3.ShaderMaterial({
    uniforms: {
      uPA: { value: PA }, uPB: { value: PB }, uPC: { value: PC },
      uViewport: { value: new T3.Vector2(1280, 720) }, uZMin: { value: 0.06 }, uMaxWidth: { value: 0.09 },
      uMinSigma: { value: 0.7 }, uGlowR: { value: 0 }, uMaxPx: { value: 2000 },
      tSceneDepth: { value: render.sceneDepth }, uNearFar: { value: nearFar }, uOccSoft: { value: 0.05 },
      uWidth: { value: 0.045 }, uHeadMul: { value: 1.6 }, uHeadLen: { value: 0.27 }, uNeck: { value: 0.09 },
      uTaperStart: { value: 0.6 }, uTipWidth: { value: 0.3 }, uFrontFade: { value: 0.05 }, uNose: { value: 0.08 },
      uHeadCol: { value: new T3.Color() }, uBodyCol: { value: new T3.Color() }, uTailCol: { value: new T3.Color() },
      uHeadEnd: { value: 0.26 }, uHandover: { value: 0.06 }, uTongue: { value: 0.07 }, uNeckDip: { value: 0.45 }, uNeckLen: { value: 0.18 },
      uBodyEnd: { value: 0.86 }, uTailFade: { value: 0.12 }, uHardness: { value: 0.6 },
      uRimCol: { value: new T3.Color() }, uRimWidth: { value: 0.5 },
      uGlowCol: { value: new T3.Color() }, uGlowHead: { value: 0.6 }, uFogDensity: { value: 0 }, uDebug: { value: 0 },
    },
    vertexShader: PROJ_VERT, fragmentShader: projFrag(render.sceneDepthGLSL),
    transparent: true, depthTest: false, depthWrite: false, blending: T3.AdditiveBlending, fog: false,
  });
  mistMat = new T3.ShaderMaterial({
    uniforms: {
      uMA: { value: MA }, uMB: { value: MB }, uMC: { value: MC },
      uLife: { value: 0.7 }, uRamp: { value: 0.03 }, uWidths: { value: new T3.Vector2(0.055, 0.065) },
      uStraight: { value: 0 }, uOnset: { value: 0.7 }, uWarpAmp: { value: 0.035 }, uWarpGrow: { value: 1.5 },
      uWarpScale: { value: 4.5 }, uCurl: { value: 0.3 }, uDrift: { value: 0 }, uDriftUp: { value: 0.5 },
      uViewport: { value: new T3.Vector2(1280, 720) }, uMinPx: { value: 1.6 },
      tSceneDepth: { value: render.sceneDepth }, uNearFar: { value: nearFar }, uSoft: { value: 0.3 },
      uAlbedo: { value: new T3.Color() }, uOpacity: { value: 0.38 }, uHalf: { value: 0.19 }, uFadeShape: { value: 0 },
      uFibre: { value: 0.5 }, uBreakup: { value: 0.6 }, uBreakScale: { value: 1.4 }, uBreakOnset: { value: 0.12 },
      uBeads: { value: 0.5 }, uAmbient: { value: new T3.Color() }, uSunCol: { value: new T3.Color() },
      uSunDir: { value: new T3.Vector3(0, 1, 0) }, uAniso: { value: 0.35 },
      uFogCol: { value: new T3.Color() }, uFogDensity: { value: 0 }, uDebug: { value: 0 },
    },
    vertexShader: MIST_VERT, fragmentShader: mistFrag(render.sceneDepthGLSL),
    transparent: true, depthTest: false, depthWrite: false, blending: T3.NormalBlending, fog: false,
    side: T3.DoubleSide,
  });
  impMat = new T3.ShaderMaterial({
    uniforms: {
      uIA: { value: IA }, uSize: { value: 0.12 }, uCol: { value: new T3.Color() }, uFogDensity: { value: 0 },
      tSceneDepth: { value: render.sceneDepth }, uNearFar: { value: nearFar },
    },
    vertexShader: IMP_VERT, fragmentShader: impFrag(render.sceneDepthGLSL),
    transparent: true, depthTest: false, depthWrite: false, blending: T3.AdditiveBlending, fog: false,
  });
  projGeo = buildProjectileGeometry();
  mistGeo = buildMistGeometry();
  impGeo = buildImpactGeometry();
  projMesh = new T3.Mesh(projGeo, projMat);
  mistMesh = new T3.Mesh(mistGeo, mistMat);
  impMesh = new T3.Mesh(impGeo, impMat);
  projMesh.name = 'u4TracerProjectile'; mistMesh.name = 'u4TracerMist'; impMesh.name = 'u4TracerImpact';
  projMesh.frustumCulled = mistMesh.frustumCulled = impMesh.frustumCulled = false;   // the vertex shaders place everything
  projMesh.renderOrder = 1; mistMesh.renderOrder = 0; impMesh.renderOrder = 2;      // mist first, the streak on top, then the flash
  projMesh.visible = mistMesh.visible = impMesh.visible = false;
  fxScene = new T3.Scene();
  fxScene.name = 'u4TracerScene';
  fxScene.add(mistMesh, projMesh, impMesh);
  fxPass = makePass();
  removePass = render.addPass(fxPass);
  for (let i = 0; i < NR; i++) rounds.push(makeRound(i));
  derive();

  // ------------------------------------------------------------------------------------------------------------
  // API
  const _d = new T3.Vector3();
  // One round from `from` (the muzzle, world m) to `to`. opts.hit (default true): `to` is a hit point on a surface whose
  // normal is opts.normal (default: facing back along the round); hit false: the round flies on to end.maxRange.
  function fire(from, to, opts) {
    const n = shotCount++;
    const every = Math.max(1, Math.round(P['freq.every']));
    const traced = n % every === 0;
    const mist = traced || P['freq.mistUntraced'];
    if (!traced && !mist) return;
    _d.subVectors(to, from);
    const len = _d.length();
    if (!(len > 1e-6)) return;
    let r = null;
    for (let i = 0; i < rounds.length; i++) if (!rounds[i].active) { r = rounds[i]; break; }
    if (!r) { r = rounds[0]; for (let i = 1; i < rounds.length; i++) if (rounds[i].t0 < r.t0) r = rounds[i]; }   // oldest first
    const rng = shared.rng;
    for (let i = 0; i < NRND; i++) r.rnd[i] = rng();
    r.origin.copy(from);
    r.dir.copy(_d).multiplyScalar(1 / len);
    if (!(opts && opts.hit === false)) {
      r.hitDist = len; r.hitPoint.copy(to); r.hitObject = true;
      if (opts && opts.normal) r.hitNormal.copy(opts.normal); else r.hitNormal.copy(r.dir).negate();
    } else {
      r.hitDist = Infinity; r.hitObject = null; r.hitNormal.set(0, 1, 0);
      r.hitPoint.copy(r.dir).multiplyScalar(P['end.maxRange']).add(r.origin);
    }
    r.traced = traced; r.mist = mist;
    r.shot = n; r.t0 = shared.now(); r.drawn = false; r.active = true;
  }

  // retires rounds whose assets have all finished (a round not drawn yet stays: its clock has not started)
  function update(t) {
    CLOCK[0] = t;
    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i];
      if (!r.active || !r.drawn) continue;
      const age = t - r.t0;
      const projDone = !r.traced || age > projLife(r) + 0.02;
      const mistDone = !r.mist || age > mistLife(r) + 0.02;
      const impDone = age > impactLife(r) + 0.02;
      if (projDone && mistDone && impDone) r.active = false;
    }
  }

  function clear() { for (const r of rounds) r.active = false; }

  function state() {
    const alive = rounds.filter((r) => r.active);
    return {
      preset: game.params.get('vfx.tracer.preset'),
      alive: alive.length,
      projectileVisible: !!(projMesh && projMesh.visible),
      mistVisible: !!(mistMesh && mistMesh.visible),
      lights: Array.from({ length: NL }, (_, n) => (LREQ[n * 8 + 3] > 0 ? { shot: LREQ[n * 8 + 6], intensity: +LREQ[n * 8 + 3].toFixed(3) } : null)),
      rounds: alive.map((r) => {
        const o4 = r.index * 4, on = PA && PA[o4 + 3] > 0;
        return {
          shot: r.shot, drawn: r.drawn, age: +(CLOCK[1] - r.t0).toFixed(5),
          hitDistance: Number.isFinite(r.hitDist) ? +r.hitDist.toFixed(3) : null,
          head: on ? [PA[o4], PA[o4 + 1], PA[o4 + 2]].map((x) => +x.toFixed(4)) : null,
          tail: on ? [PB[o4], PB[o4 + 1], PB[o4 + 2]].map((x) => +x.toFixed(4)) : null,
        };
      }),
    };
  }

  function dispose() {
    if (removePass) removePass();
    removePass = null;
    for (const o of [projGeo, mistGeo, impGeo, projMat, mistMat, impMat]) if (o) o.dispose();
    rounds.length = 0;
  }

  return {
    P, fire, update, render: renderFrame, clear, state, dispose,
    firstAge: () => P['time.firstAge'] * 0.001,     // s
    speed: () => speedNow(),                         // m/s of the drawn round (impacts wait for it)
    maxRange: () => P['end.maxRange'],               // m
  };
}
