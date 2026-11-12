// Cover Room HUD (A6): reticle, weapon panel, hit marker, damage streaks, health look, enemy awareness, prompt.
// Contract: refs/design.md "hud/hud.js". The art is original (our shapes and drawing); the behaviour and layout follow
// refs/player-spec.md §5, §7, §8 and refs/ai-spec.md §1.2. Every number is a param under hud.* with its source tag.
//
// API (cheap and safe to call every sim step; repeated identical calls are no-ops):
//   setReticle({mode: 'none'|'hip'|'aim'|'grenade', spread, onTarget, style?})
//       Pistol aim = a dot at hud.reticle.y (42 % from the top) [player-spec §8 MEASURED]; the pistol shows no bloom.
//       style 'arcs' (rifle, §8 F5) draws a ring of four arc ticks whose radius = spread, a cone HALF-angle in radians
//       projected with the camera's vertical FOV. 'grenade' hides the reticle (the grenade module draws the arc).
//       'hip' shows a small hip reticle [INFERRED, brief; §8 open question 8], held hud.reticle.hipHold s after the
//       last 'hip' call so a weapon can send 'hip' on each hip shot and 'none' otherwise.
//       The camera/weapon must aim through (0.5, hud.reticle.y) of the screen, not the centre.
//   setAmmo(mag, reserve, visible, magSize?)
//       Bottom-left panel: one tick per round of magSize (default hud.ammo.magSize), spent rounds dimmed, and the
//       total-rounds number = mag + reserve [§8 MEASURED F1]. visible = aiming or reloading right now.
//   setGrenades(n)       grenade count beside the number, shown while n > 0 [§8 INFERRED].
//   setCombat(on)        optional: the encounter is in combat. Also inferred from awareness() states combat/search.
//       Panel rule [§8]: up while combat || aiming || reloading || ammo changed within hud.pickupShowT; fades in over
//       hud.fadeIn; when the rule goes false it waits hud.hideDelay, then fades out over hud.fadeOut.
//   hitMarker('body'|'head'|'kill')   4-tick X at the reticle, hud.hit.time [§8 MEASURED]; priority kill > head > body.
//   damage(dirWorld, strength=1)      dirWorld = the hit's TRAVEL direction (attacker -> player, as in the `damage`
//       event's dir). A dark red streak drips in from the screen edge facing the attacker (top = in front) [§7] and is
//       re-placed every frame as the camera turns. It holds while health < hud.damage.holdLuck, then fades.
//   setHealthLook(luck)  luck = health fraction (1 = unhurt). Calls game.render.setGrade({saturation, vignette,
//       contrast}) with saturation = lerp(minSat, 1, smoothstep(0, satKnee, luck)), vignette = (1 - luck) x vignetteMax
//       [§7]; a DOM fallback if render.setGrade is missing. tint is never sent, so render keeps its own.
//   awareness(actor, value 0..1, state)   ai-spec §1.2: hidden at 0; 'unaware' = white arc filling, 'suspicious' /
//       'investigate' / 'search' = yellow arc filling, 'combat' (alias 'alerted') = solid orange. value = the fill of
//       the arc being shown (unaware: a; suspicious: a - 1; search: the refill), ignored in combat. Call every step per
//       enemy; anchored over the head (rig 'head' bone, else pos + height), hidden off-screen, beyond
//       hud.awareness.maxDist, or (hud.awareness.occlude) behind static geometry; dropped after hud.awareness.stale s
//       without a call or when actor.alive === false.
//   prompt(text | null, worldPos?)   "[Key] verb" renders the key as a chip. Bottom centre, or anchored over worldPos.
//   toggle(visible?)     show/hide the overlay (no argument flips it). The render grade is not affected.
//   wire() -> off()      optional: drive hitMarker/damage from game.events (damage, death).
//   frame(dt)            advance fades by dt. createHud registers it as system 'hud' (order 90, frame phase) with
//                        realDt x timeScale, frozen while paused, so fades line up with the measured timings.
//
// Cost: one DOM overlay built once (pools: 6 streaks, hud.awareness.pool markers, 40 ammo ticks). Per frame ~50 param
// reads and only transform/opacity/custom-property writes, each skipped when unchanged. No WebGL draw calls.
import * as THREE from 'three';

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;
const KITE = 'M12 0.7 L23.4 11.4 L12 29.3 L0.6 11.4 Z';   // awareness diamond in its 24 x 30 viewBox (w:h = 1:1.24 [MEASURED])
const HIT_RANK = { body: 1, head: 2, kill: 3 };
// ai-spec §1.2 [DEV]: white = about to notice, yellow = suspicious / investigating (and searching), orange = combat.
const AW_COLOR = { unaware: 'white', suspicious: 'yellow', investigate: 'yellow', search: 'yellow', combat: 'orange', alerted: 'orange' };
const REF_H = 720;                      // player-spec measured the HUD on 1280x720 frames; sizes are px at 720p
const TICK_POOL = 40;                   // most magazine ticks the panel can show
const STREAK_POOL = 6;
const GW_POOL = 6;                        // grenade warning icons at once
// Our frag silhouette for the grenade warning, 20 x 32 units = px at 720p [MEASURED box]: round body, fuse cap, spoon.
// Upright frag per the build spec (the tilted-cylinder glyph seen once is a second grenade type we don't have).
const FRAG_GLYPH = '<circle cx="10" cy="21.3" r="9.6"/><rect x="6.2" y="7.2" width="7.6" height="6.4" rx="1.2"/>' +
  '<rect x="7.6" y="3.4" width="4.8" height="4.4" rx="0.8"/><path d="M12.6 4.2 L16.8 5.6 L18.4 15.2 L16.4 15.6 L15 8.2 L12.6 7.6 Z"/>';
const CORNER_BAND = 10 / DEG;           // streak rotation blends between edge normals within this of a screen corner
// prefers-reduced-motion: no scale pops or drip-in, and no blink shorter than this (s).
const REDUCED_MIN_FLASH = 0.3;
let instances = 0;

// key, default, panel options. Every feel number carries its source.
const PARAMS = [
  ['hud.scale',                 1,     { min: 0.6, max: 1.6, step: 0.05, label: 'UI scale' }],                 // [ASSUMED]
  // weapon panel visibility, player-spec §8
  ['hud.fadeIn',                0.25,  { min: 0, max: 1, step: 0.01, label: 'panel fade in (s)' }],           // [MEASURED F1 0:06.1-0:06.4]
  ['hud.hideDelay',             4.0,   { min: 0, max: 10, step: 0.1, label: 'panel hide delay (s)' }],       // [INFERRED §8]
  ['hud.fadeOut',               0.5,   { min: 0, max: 2, step: 0.01, label: 'panel fade out (s)' }],          // [INFERRED §8]
  ['hud.pickupShowT',           3.0,   { min: 0, max: 10, step: 0.1, label: 'show after ammo change (s)' }],  // [INFERRED §8]
  ['hud.panel.x',               0.10,  { min: 0, max: 0.9, step: 0.005, label: 'panel x (screen frac)' }],    // [MEASURED F1 §8]
  ['hud.panel.y',               0.85,  { min: 0.1, max: 1, step: 0.005, label: 'panel y (screen frac)' }],    // [MEASURED F1 §8]
  ['hud.ammo.magSize',          12,    { min: 1, max: TICK_POOL, step: 1, label: 'ticks if not given' }],    // [MEASURED F1 §5]
  ['hud.ammo.spentAlpha',       0.25,  { min: 0, max: 1, step: 0.01, label: 'spent tick alpha' }],           // [MEASURED F1 §8]
  ['hud.ammo.totalIncludesMag', true,  { label: 'number counts the mag' }],                                   // [MEASURED F1 §8]
  // reticle
  ['hud.reticle.style',         'u4',  { options: ['u4', 'dot', 'arcs'], label: 'aim reticle' }],             // u4 = Max's pick (the pistol in U4's crosshair clip); dot [MEASURED F1]; arcs [MEASURED F5 rifle]
  // 'u4' style: a ring of three arcs while aiming; each shot drops the ring and shows the bullet dot, which kicks up and
  // settles; ~0.17 s after the last shot the ring comes back open and shrinks in. [MEASURED refs/frames/reticle: YouTube
  // _CPi2pmZ32o "Uncharted 4's Dynamic Crosshair System", 1080p60, pistol shots 24.0-26.3 s; px below are @720p]
  ['hud.u4.radius',             10.5,  { min: 4, max: 40, step: 0.5, label: 'ring radius (px @720p)' }],     // [MEASURED] arc centroids 14.5-16.3 px @1080p
  ['hud.u4.openRadius',         19.5,  { min: 4, max: 80, step: 0.5, label: 'ring open radius (px)' }],      // [MEASURED] reappears at 25-30 px @1080p
  ['hud.u4.contractTau',        0.12,  { min: 0.01, max: 1, step: 0.01, label: 'ring shrink tau (s)' }],     // [MEASURED] 25.5 -> 14.3 px in 0.33 s
  ['hud.u4.stroke',             1.6,   { min: 0.5, max: 5, step: 0.1, label: 'arc stroke (px)' }],           // [MEASURED] ~2 px @1080p (+ dark edge)
  ['hud.u4.bulletDot',          4.7,   { min: 1, max: 14, step: 0.1, label: 'bullet dot (px)' }],            // [MEASURED] 5 px core @1080p + 1 px outline (refs/stealth-measured.md)
  ['hud.u4.bulletKick',         4,     { min: 0, max: 20, step: 0.5, label: 'dot kick up (px)' }],           // [MEASURED] ~6 px @1080p the frame after a shot
  ['hud.u4.bulletTau',          0.035, { min: 0.005, max: 0.3, step: 0.005, label: 'dot settle tau (s)' }],  // [MEASURED] back to ~1 px within 2 frames
  ['hud.u4.dotHold',            0.10,  { min: 0, max: 1.5, step: 0.01, label: 'dot hold after shot (s)' }],  // [MEASURED] 24.27->24.37, 25.14->25.24
  ['hud.u4.dotFade',            0.04,  { min: 0, max: 0.5, step: 0.01, label: 'dot fade (s)' }],             // [MEASURED] gone within 2-3 frames
  ['hud.u4.ringReturn',         0.17,  { min: 0, max: 1.5, step: 0.01, label: 'ring back after shot (s)' }], // [MEASURED] 0.17-0.2 s after the last shot
  ['hud.u4.useShotDir',         true,  { label: 'dot follows the bullet' }],                               // [WIKI] "the dot tracks where each bullet goes"
  ['hud.reticle.y',             0.42,  { min: 0.3, max: 0.6, step: 0.005, label: 'reticle y (frac from top)' }], // [MEASURED F1, F5 §8]
  ['hud.reticle.dot',           6,     { min: 2, max: 14, step: 0.5, label: 'dot (px @720p)' }],             // [MEASURED F1 zoom §8]
  ['hud.reticle.fadeIn',        0.06,  { min: 0, max: 0.5, step: 0.01, label: 'reticle fade in (s)' }],       // [INFERRED]; cover->aim camera is 0.14 s (§3)
  ['hud.reticle.fadeOut',       0.10,  { min: 0, max: 1, step: 0.01, label: 'reticle fade out (s)' }],        // [INFERRED]
  ['hud.reticle.targetTint',    true,  { label: 'tint over enemies' }],                                       // [INFERRED, brief]; §8 silent
  ['hud.reticle.persistentDot', false, { label: 'persistent dot (option)' }],                                 // [WIKI §8, PS5 accessibility]
  ['hud.reticle.hipShow',       true,  { label: 'hip-fire reticle' }],                                        // [INFERRED, brief]; §8 open question 8
  ['hud.reticle.hipHold',       0.6,   { min: 0, max: 3, step: 0.05, label: 'hip reticle hold (s)' }],        // [INFERRED]
  ['hud.reticle.hipDot',        4,     { min: 1, max: 10, step: 0.5, label: 'hip dot (px @720p)' }],         // [ASSUMED] art
  ['hud.reticle.ringMin',       8,     { min: 0, max: 60, step: 1, label: 'ring min radius (px @720p)' }],   // [ASSUMED]
  ['hud.reticle.ringMax',       80,    { min: 10, max: 300, step: 1, label: 'ring max radius (px @720p)' }], // [ASSUMED]
  // hit marker, player-spec §8
  ['hud.hit.time',              0.30,  { min: 0.05, max: 1, step: 0.01, label: 'hit marker (s)' }],           // [MEASURED F1]
  ['hud.hit.killTime',          0.40,  { min: 0.05, max: 1.5, step: 0.01, label: 'kill marker (s)' }],        // [INFERRED]
  ['hud.hit.span',              22,    { min: 8, max: 60, step: 1, label: 'X span (px @720p)' }],            // [MEASURED F1]
  ['hud.hit.len',               7,     { min: 2, max: 20, step: 0.5, label: 'tick length (px @720p)' }],     // [ASSUMED] art
  ['hud.hit.thickness',         2,     { min: 1, max: 5, step: 0.5, label: 'tick thickness (px @720p)' }],   // [ASSUMED] art
  ['hud.hit.pop',               0.25,  { min: 0, max: 1, step: 0.05, label: 'pop (scale)' }],                 // [ASSUMED]; 0 under reduced motion
  // damage streaks, player-spec §7 (spec keys fx.damage.*)
  ['hud.damage.streakIn',       0.15,  { min: 0, max: 1, step: 0.01, label: 'streak in (s)' }],               // [INFERRED §7 fx.damage.streakIn]
  ['hud.damage.streakFade',     1.0,   { min: 0, max: 4, step: 0.05, label: 'streak fade (s)' }],             // [MEASURED low §7, F1 0:15-0:16]
  ['hud.damage.holdLuck',       0.95,  { min: 0, max: 1, step: 0.01, label: 'hold while health below' }],    // [INFERRED] §7 names streakHoldLuck, no value; 0.95 starts the fade as regen starts (F1 ~2.3 s)
  ['hud.damage.minHold',        0.25,  { min: 0, max: 2, step: 0.05, label: 'min hold (s)' }],                // [ASSUMED]
  ['hud.damage.length',         0.75,  { min: 0.2, max: 1.5, step: 0.01, label: 'streak length (x height)' }], // [ASSUMED] art
  ['hud.damage.depth',          0.27,  { min: 0.05, max: 0.6, step: 0.01, label: 'streak depth (x height)' }],  // [ASSUMED] art
  ['hud.damage.merge',          30,    { min: 0, max: 90, step: 1, label: 'merge hits within (deg)' }],     // [ASSUMED]
  // health look, player-spec §7 (spec keys fx.damage.*), sent to render.setGrade
  ['hud.health.minSat',         0.05,  { min: 0, max: 1, step: 0.01, label: 'saturation at 0 health' }],     // [MEASURED MP F6/F7]
  ['hud.health.satKnee',        0.7,   { min: 0.05, max: 1, step: 0.01, label: 'colour loss below' }],       // [INFERRED §7]
  ['hud.health.vignetteMax',    0.45,  { min: 0, max: 1, step: 0.01, label: 'vignette at 0 health' }],       // [MEASURED qualitative F2]
  ['hud.health.contrastDrop',   0,     { min: 0, max: 0.5, step: 0.01, label: 'contrast drop at 0 health' }], // [ASSUMED] §7 silent
  ['hud.health.lag',            0.08,  { min: 0, max: 1, step: 0.01, label: 'grade lag (s)' }],               // [ASSUMED] softens the step on a hit
  // enemy awareness, ai-spec §1.2
  ['hud.awareness.size',        27,    { min: 10, max: 60, step: 1, label: 'diamond width (px @720p)' }],    // [MEASURED refs/stealth-measured.md §1: 26-28 x 33 @720p, enemy ~1.5 m]
  ['hud.awareness.lift',        0.10,  { min: 0, max: 1.5, step: 0.01, label: 'gap head top -> diamond (m)' }], // [MEASURED §1 ~0.10 m gap, centre ~0.16 m]
  ['hud.awareness.fadeIn',      0.15,  { min: 0, max: 1, step: 0.01, label: 'marker fade in (s)' }],         // [INFERRED]
  ['hud.awareness.fadeOut',     0.45,  { min: 0, max: 2, step: 0.01, label: 'marker fade out (s)' }],        // [INFERRED]
  ['hud.awareness.combatPersist', false, { label: 'orange stays through combat' }],                           // [WIKI Prima via stealth-measured §1: no indicator in full combat]
  ['hud.awareness.combatHold',  1.2,   { min: 0, max: 6, step: 0.1, label: 'orange hold if not persistent (s)' }], // [INFERRED stealth-measured: show orange at full awareness, ~1-1.5 s]
  ['hud.awareness.stale',       0.4,   { min: 0.05, max: 3, step: 0.05, label: 'drop if not updated (s)' }],  // [ASSUMED] the AI calls every step
  ['hud.awareness.maxDist',     45,    { min: 5, max: 150, step: 1, label: 'max distance (m)' }],           // [ASSUMED] the room is ~30 m
  ['hud.awareness.nearDist',    6,     { min: 0, max: 40, step: 0.5, label: 'full size within (m)' }],       // [ASSUMED]
  ['hud.awareness.farScale',    0.65,  { min: 0.2, max: 1, step: 0.05, label: 'scale at max distance' }],    // [ASSUMED]
  ['hud.awareness.pop',         0.3,   { min: 0, max: 1, step: 0.05, label: 'combat pop (scale)' }],          // [ASSUMED]; 0 under reduced motion
  ['hud.awareness.occlude',     true,  { label: 'hide behind walls' }],                                       // [ASSUMED]; ai-spec open question 6
  ['hud.awareness.pool',        8,     { min: 1, max: 32, step: 1, label: 'pool size (read at start)' }],    // [ASSUMED]
  // grenade danger indicator, refs/grenade-warning-measured.md "Build spec" (sizes px @720p)
  ['hud.grenadeWarn.on',        true,  { label: 'grenade warning on' }],
  ['hud.grenadeWarn.size',      54,    { min: 20, max: 120, step: 1, label: 'outline diamond diagonal (px @720p)' }], // [MEASURED 0.075 H]
  ['hud.grenadeWarn.filledSize', 78,   { min: 20, max: 160, step: 1, label: 'filled diamond diagonal (px @720p)' }],  // [MEASURED 0.108 H]
  ['hud.grenadeWarn.stroke',    2,     { min: 0.5, max: 6, step: 0.25, label: 'outline stroke (px @720p)' }],         // [MEASURED]
  ['hud.grenadeWarn.glyphW',    20,    { min: 6, max: 60, step: 1, label: 'glyph width (px @720p)' }],               // [MEASURED]
  ['hud.grenadeWarn.glyphH',    32,    { min: 6, max: 80, step: 1, label: 'glyph height (px @720p)' }],              // [MEASURED]
  ['hud.grenadeWarn.color',     '#e40c18', { label: 'red' }],                                                       // [INFERRED from MEASURED p90]
  ['hud.grenadeWarn.pointerR',  45,    { min: 10, max: 120, step: 1, label: 'pointer distance, outline (px @720p)' }], // [MEASURED]
  ['hud.grenadeWarn.pointerRFilled', 52, { min: 10, max: 140, step: 1, label: 'pointer distance, filled (px @720p)' }], // [MEASURED]
  ['hud.grenadeWarn.pointerW',  16,    { min: 4, max: 40, step: 1, label: 'pointer base (px @720p)' }],             // [MEASURED]
  ['hud.grenadeWarn.pointerL',  17,    { min: 4, max: 40, step: 1, label: 'pointer length (px @720p)' }],           // [MEASURED]
  ['hud.grenadeWarn.pointerTurn', 350, { min: 0, max: 2000, step: 10, label: 'pointer turn rate (deg/s, 0 = snap)' }], // [MEASURED once]
  ['hud.grenadeWarn.pointerDead', 0.05, { min: 0, max: 0.3, step: 0.01, label: 'keep pointer angle within (x height of centre)' }], // [ASSUMED]
  ['hud.grenadeWarn.warnRadius', 12,   { min: 1, max: 40, step: 0.5, label: 'show within (m of the player)' }],     // [ASSUMED >= the 10 m seen]
  ['hud.grenadeWarn.dangerRadius', 0,  { min: 0, max: 15, step: 0.1, label: 'filled within (m; 0 = grenade kill radius)' }], // [INFERRED = grenade.blast.killRadius]
  ['hud.grenadeWarn.occludedAlpha', 0.45, { min: 0, max: 1, step: 0.01, label: 'behind a wall: icon alpha' }],     // [INFERRED]
  ['hud.grenadeWarn.occludedPointerAlpha', 0.7, { min: 0, max: 1, step: 0.01, label: 'behind a wall: pointer alpha' }], // [INFERRED]
  ['hud.grenadeWarn.edgeInset', 0.07,  { min: 0, max: 0.3, step: 0.005, label: 'off-screen ellipse inset (x height)' }], // [ASSUMED] never seen off-screen
  ['hud.grenadeWarn.ownFromContact', true, { label: "player's own grenade: show from first contact" }],              // [ASSUMED] V3 ~0.3-0.4 s after release
  // prompt
  ['hud.prompt.fade',           0.15,  { min: 0, max: 1, step: 0.01, label: 'prompt fade (s)' }],            // [ASSUMED]
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
// Linear fade of a toward target at 1/time per second; time <= 0 snaps.
const approach = (a, target, dt, timeIn, timeOut) => {
  if (a === target) return a;
  const t = target > a ? timeIn : timeOut;
  if (t <= 0) return target;
  const step = dt / t;
  return target > a ? Math.min(target, a + step) : Math.max(target, a - step);
};

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

// Writes an opacity only when it changed enough to matter; fully faded parts get data-a="0" (visibility hidden).
function setAlpha(node, cache, key, a) {
  const q = Math.round(a * 1000) / 1000;
  if (cache[key] === q) return;
  cache[key] = q;
  node.style.opacity = q;
  node.dataset.a = q > 0 ? '1' : '0';
}

// Our own pistol silhouette (generic semi-auto, muzzle right), 90 x 51 units = px at 720p.
const GUN_SVG = `<svg class="gun" viewBox="0 0 90 51" aria-hidden="true">
  <path class="body" d="M9 10 L9 7 L14 7 L14 10 L79 10 L79 7.5 L82 7.5 L82 10 L84 10 L86 12 L86 21 L84 21 L84 26 L44 26 L40 21
    L32 21 L30.5 27 L25 46.5 Q24.3 49 21.8 49 L6.8 49 Q3.6 49 4.3 46 L9 27 L10 21 L6 21 L6 12 Z"/>
  <path class="cut" d="M16 12.5 V19 M19 12.5 V19 M22 12.5 V19 M25 12.5 V19 M50 13 H64 V17 H50 Z"/>
  <path class="guard-o" d="M30.5 27 Q31 35.5 38 35.5 L42 35.5 Q46 35.5 46 31 L46 26"/>
  <path class="guard" d="M30.5 27 Q31 35.5 38 35.5 L42 35.5 Q46 35.5 46 31 L46 26"/>
  <path class="guard" d="M36.5 26 Q38.5 29.5 37 32.5"/>
</svg>`;

// One damage streak, drawn once: a soft wash and a ragged band along the edge, with thin tapered drips of seeded lengths.
// 100 x 50 units, stretched to hud.damage.length x hud.damage.depth (about 5.4 x 3.9 px per unit at 720p).
function streakSvg(seed, gid, wid, fid) {
  let s = (seed * 7919 + 104729) % 233280;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const f = (v) => v.toFixed(2);
  let band = 'M0 -2 L100 -2 L100 4 ';
  for (let x = 100; x >= 0; x -= 2.5) band += `L${f(x)} ${f(2.5 + rnd() * rnd() * 9)} `;
  band += 'Z';
  let drips = '';
  const n = 11 + Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) {
    const x = 10 + rnd() * 80, w = 0.3 + rnd() * rnd() * 1.1, len = 7 + rnd() * rnd() * 36, tip = w * 0.4;
    drips += `M${f(x - w)} 3 C${f(x - w)} ${f(len * 0.5)} ${f(x - tip)} ${f(len * 0.8)} ${f(x - tip)} ${f(len)} `
           + `L${f(x + tip)} ${f(len)} C${f(x + tip)} ${f(len * 0.8)} ${f(x + w)} ${f(len * 0.5)} ${f(x + w)} 3 Z `;
    const r = tip * 1.5, ry = r * 1.4;                                   // small bead; the viewBox is stretched ~1.4x wider
    drips += `M${f(x - r)} ${f(len)} a${f(r)} ${f(ry)} 0 1 0 ${f(2 * r)} 0 a${f(r)} ${f(ry)} 0 1 0 ${f(-2 * r)} 0 Z `;
  }
  return `<svg viewBox="0 0 100 50" preserveAspectRatio="none" aria-hidden="true">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4a0403" stop-opacity="0.95"/>
      <stop offset="0.2" stop-color="#650806" stop-opacity="0.88"/>
      <stop offset="1" stop-color="#8a0c09" stop-opacity="0.45"/>
    </linearGradient>
    <linearGradient id="${wid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5a0504" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#5a0504" stop-opacity="0"/>
    </linearGradient>
    <filter id="${fid}" x="-5%" y="-10%" width="110%" height="130%"><feGaussianBlur stdDeviation="0.45 0.6"/></filter>
  </defs>
  <rect x="0" y="-2" width="100" height="26" fill="url(#${wid})"/>
  <path d="${band} ${drips}" fill="url(#${gid})" filter="url(#${fid})"/>
</svg>`;
}

export function createHud(game, opts = {}) {
  const params = game.params;
  for (const [k, v, o] of PARAMS) params.define(k, v, o);
  const P = (k) => params.get(k);
  const uid = 'crhud' + ++instances;

  const reduceMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = !!(reduceMq && reduceMq.matches);
  const onReduce = (e) => { reduced = e.matches; };
  if (reduceMq && reduceMq.addEventListener) reduceMq.addEventListener('change', onReduce);

  // ---------------------------------------------------------------- DOM, built once
  const parent = opts.parent || document.body;
  const root = el('div', 'crhud' + (parent === document.body ? '' : ' crhud-local'));
  // The look lives in hud.css. Pages that don't link it (the game page did not, so the HUD sat unstyled below the
  // canvas) get it injected once, resolved next to this module.
  if (!document.querySelector('link[href$="hud.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = new URL('./hud.css', import.meta.url).href;
    document.head.appendChild(link);
  }
  root.setAttribute('aria-hidden', 'true');

  const gradeEl = el('div', 'crhud-grade', root);
  const gradeDesat = el('div', 'desat', gradeEl);
  const gradeVig = el('div', 'vig', gradeEl);
  gradeEl.dataset.a = '0';

  const streaks = [];
  for (let i = 0; i < STREAK_POOL; i++) {
    const node = el('div', 'crhud-streak', root);
    node.innerHTML = streakSvg(i + 1, `${uid}-sg${i}`, `${uid}-sw${i}`, `${uid}-sf${i}`);
    node.dataset.a = '0';
    streaks.push({ node, dir: new THREE.Vector3(), t: 1e9, fadeT: -1, strength: 1, active: false, cache: {}, tf: '' });
  }

  const awLayer = el('div', 'crhud-aw-layer', root);
  const awPoolSize = Math.max(1, Math.round(P('hud.awareness.pool')));
  const aw = [];
  const SVGNS = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < awPoolSize; i++) {
    const node = el('div', 'crhud-aw', awLayer);
    node.dataset.a = '0';
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 30');
    const mk = (tag, cls, attrs) => {
      const n = document.createElementNS(SVGNS, tag);
      n.setAttribute('class', cls);
      for (const a in attrs) n.setAttribute(a, attrs[a]);
      svg.appendChild(n);
      return n;
    };
    // U4's threat indicator is a solid kite, widest 3/8 down, the long lower point toward the head [MEASURED
    // stealth-measured §1]. The colour rises from the bottom with the value (direction [ASSUMED]: Prima says only
    // "fills progressively"); a dark underlay and a coloured rim keep the empty part readable.
    const cid = `${uid}-awc${i}`;
    const defs = mk('defs', 'd', {});
    const clip = document.createElementNS(SVGNS, 'clipPath');
    clip.setAttribute('id', cid);
    const clipRect = document.createElementNS(SVGNS, 'rect');
    clipRect.setAttribute('x', '0'); clipRect.setAttribute('width', '24'); clipRect.setAttribute('y', '30'); clipRect.setAttribute('height', '30');
    clip.appendChild(clipRect); defs.appendChild(clip);
    mk('path', 'bg', { d: KITE });
    const fill = mk('path', 'fill', { d: KITE, 'clip-path': `url(#${cid})` });
    fill.clipRect = clipRect;
    mk('path', 'rim', { d: KITE });
    node.appendChild(svg);
    const glyph = el('span', 'glyph', node);
    aw.push({ node, fill, glyph, actor: null, value: 0, state: 'unaware', color: 'white', lastCall: -1e9, alpha: 0,
      alertT: 1e9, occluded: false, losFresh: false, onScreen: false, shownValue: -1, shownColor: '', shownGlyph: '',
      tx: NaN, ty: NaN, ts: NaN, cache: {}, anchor: new THREE.Vector3() });
  }
  const awByActor = new Map();

  // Grenade danger icons (refs/grenade-warning-measured.md): a red diamond around a frag glyph, fixed screen size, drawn
  // at the grenade's projected position, and a hollow white triangle outside it pointing away from the screen centre.
  // The diamond and the glyph are separate SVGs so the glyph keeps its pixel size when the diamond grows (FILLED).
  const gwLayer = el('div', 'crhud-gw-layer', root);
  const gw = [];
  for (let i = 0; i < GW_POOL; i++) {
    const node = el('div', 'crhud-gw', gwLayer);
    node.innerHTML =
      `<svg class="dia" viewBox="0 0 100 100"><path d="M50 1 L99 50 L50 99 L1 50 Z" vector-effect="non-scaling-stroke"/></svg>` +
      `<svg class="gly" viewBox="0 0 20 32">${FRAG_GLYPH}</svg>` +
      `<svg class="ptr" viewBox="0 0 17 16"><path d="M1 1 L16 8 L1 15 Z" vector-effect="non-scaling-stroke"/></svg>`;
    const icon = { node, ptr: node.lastChild, id: -1, seen: false, filled: false, occluded: false, edge: false, ang: 0, angSet: false,
      x: NaN, y: NaN, shownTf: '', shownPtr: '', cache: {}, pos: new THREE.Vector3() };
    node.dataset.a = '0';
    gw.push(icon);
  }

  const center = el('div', 'crhud-center', root);
  const retEl = el('div', 'crhud-ret', center);
  el('div', 'crhud-dot', retEl);
  const arcsEl = el('div', 'crhud-arcs', center);
  el('div', 'ring', arcsEl);
  const hipEl = el('div', 'crhud-hip', center);
  el('div', 'ring', hipEl);
  el('div', 'crhud-dot', hipEl);
  const r3El = el('div', 'crhud-r3', center);
  el('div', 'ring', r3El);
  const bulEl = el('div', 'crhud-bullet', center);
  el('div', 'crhud-dot', bulEl);
  r3El.dataset.a = bulEl.dataset.a = '0';
  const hitEl = el('div', 'crhud-hit', center);
  for (let i = 0; i < 4; i++) el('div', 'crhud-hk', hitEl);
  retEl.dataset.a = arcsEl.dataset.a = hipEl.dataset.a = hitEl.dataset.a = '0';

  const panelEl = el('div', 'crhud-panel', root);
  panelEl.insertAdjacentHTML('afterbegin', GUN_SVG);
  const ticksEl = el('div', 'ticks', panelEl);
  const ticks = [];
  for (let i = 0; i < TICK_POOL; i++) ticks.push(el('span', 'tick off', ticksEl));
  const totalEl = el('span', 'total', panelEl);
  const grenEl = el('div', 'gren none', panelEl);
  el('span', 'icon', grenEl);
  const grenN = el('span', 'n', grenEl);
  panelEl.dataset.a = '0';

  const promptEl = el('div', 'crhud-prompt', root);
  promptEl.setAttribute('role', 'status');
  const promptKey = el('span', 'k', promptEl);
  const promptText = el('span', 't', promptEl);
  promptEl.dataset.a = '0';

  parent.appendChild(root);

  // Viewport size, read on resize only (never per frame).
  let W = 1, H = 1;
  const measure = () => { W = root.clientWidth || innerWidth; H = root.clientHeight || innerHeight; };
  let ro = null;
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(measure); ro.observe(root); }
  else addEventListener('resize', measure);
  measure();

  // ---------------------------------------------------------------- state
  const cache = {};                 // last written opacity / scale per part
  const vars = {};                  // last written custom properties (numbers)
  let clock = 0;                    // HUD sim clock (s)
  let shown = true;
  let combatFlag = false, awEncounter = false;
  let u = 1;                        // px per 720p px (viewport height / 720 x hud.scale)

  const ret = { mode: 'none', spread: 0, onTarget: false, style: null, hipT: 1e9, dotA: 0, arcsA: 0, hipA: 0, gap: -1, tint: null,
    // 'u4' style: ring of three arcs + bullet dot
    r3A: 0, r3: 0, r3Sent: -1, bulA: 0, bx: 0, by: 0, bSent: '', shotClock: -1e9, wasAiming: false, seed: 0x9e3779b9 };
  const ammo = { mag: null, reserve: null, cap: 0, total: null, grenades: null, flag: false, changedAt: -1e9, offFor: 1e9,
    alpha: 0, grenadeMode: null };
  const hit = { kind: null, t: 1e9, dur: 0, shownKind: '' };
  const health = { target: 1, cur: 1, sent: -1 };
  const grade = { saturation: 1, vignette: 0, contrast: 1 };   // reused object handed to render.setGrade (no tint)
  const prm = { text: null, alpha: 0, target: 0, anchored: false, at: new THREE.Vector3(), tx: NaN, ty: NaN };

  const tmpV = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const rayDir = new THREE.Vector3();
  const rayOpts = { hitActors: false };
  let losCursor = 0;

  // Custom property from a number + unit; the string is only built when the number changed.
  function setVar(name, num, unit) {
    if (vars[name] === num) return;
    vars[name] = num;
    root.style.setProperty(name, num + unit);
  }

  // Sizes from params -> custom properties. A numeric compare each frame, so live tuning costs no per-frame strings.
  function applySizes() {
    u = Math.round((H / REF_H) * P('hud.scale') * 1000) / 1000;
    setVar('--u', u, 'px');
    setVar('--ret-y', Math.round(P('hud.reticle.y') * 10000) / 100, '%');
    setVar('--ret-dot', P('hud.reticle.dot') * u, 'px');
    setVar('--hip-dot', P('hud.reticle.hipDot') * u, 'px');
    setVar('--r3-stroke', Math.round(P('hud.u4.stroke') * u * 100) / 100, 'px');
    setVar('--bul-dot', Math.round(P('hud.u4.bulletDot') * u * 100) / 100, 'px');
    const len = P('hud.hit.len');
    setVar('--hit-len', len * u, 'px');
    setVar('--hit-gap', Math.round(Math.max(0, P('hud.hit.span') / Math.SQRT2 - len) * u * 100) / 100, 'px');   // span = √2 (gap + len)
    setVar('--hit-thick', P('hud.hit.thickness') * u, 'px');
    setVar('--aw-size', P('hud.awareness.size') * u, 'px');
    const r2 = (v) => Math.round(v * u * 100) / 100;
    setVar('--gw-size', r2(P('hud.grenadeWarn.size')), 'px');
    setVar('--gw-fsize', r2(P('hud.grenadeWarn.filledSize')), 'px');
    setVar('--gw-stroke', r2(P('hud.grenadeWarn.stroke')), 'px');
    setVar('--gw-glw', r2(P('hud.grenadeWarn.glyphW')), 'px');
    setVar('--gw-glh', r2(P('hud.grenadeWarn.glyphH')), 'px');
    setVar('--gw-pw', r2(P('hud.grenadeWarn.pointerW')), 'px');
    setVar('--gw-pl', r2(P('hud.grenadeWarn.pointerL')), 'px');
    const red = P('hud.grenadeWarn.color');
    if (red !== vars['--gw-red']) { vars['--gw-red'] = red; root.style.setProperty('--gw-red', red); }
    setVar('--streak-l', Math.round(P('hud.damage.length') * H), 'px');
    setVar('--streak-d', Math.round(P('hud.damage.depth') * H), 'px');
    setVar('--panel-x', Math.round(P('hud.panel.x') * 10000) / 100, '%');
    setVar('--panel-y', Math.round(P('hud.panel.y') * 10000) / 100, '%');
    setVar('--spent-a', P('hud.ammo.spentAlpha'), '');
  }

  // Cone half-angle (rad) -> pixels from the reticle point, using the camera's vertical FOV.
  function spreadPx(spread) {
    const cam = game.camera;
    const fov = cam && cam.fov ? cam.fov : 60;
    const zoom = cam && cam.zoom ? cam.zoom : 1;
    return (Math.tan(Math.max(0, spread)) / (Math.tan((fov * Math.PI) / 360) / zoom)) * (H / 2);
  }

  // ---------------------------------------------------------------- API
  function setReticle(r) {
    if (!r) return;
    const mode = r.mode || 'none';
    ret.mode = mode;
    if (typeof r.spread === 'number') ret.spread = r.spread;
    ret.onTarget = !!r.onTarget;
    ret.style = r.style || null;
    if (mode === 'hip') ret.hipT = 0;
  }

  function updateTicks(mag, cap) {
    for (let i = 0; i < TICK_POOL; i++) {
      const cls = i >= cap ? 'tick off' : i >= mag ? 'tick spent' : 'tick';   // rounds left on the left [ASSUMED]
      if (ticks[i].className !== cls) ticks[i].className = cls;
    }
  }

  function setAmmo(mag, reserve, visible, magSize) {
    const cap = Math.min(TICK_POOL, magSize > 0 ? magSize : P('hud.ammo.magSize'));
    if (ammo.mag !== null && (mag !== ammo.mag || reserve !== ammo.reserve)) ammo.changedAt = clock;   // fired / reloaded / picked up
    if (mag !== ammo.mag || cap !== ammo.cap) { updateTicks(mag, cap); ammo.cap = cap; }
    const total = P('hud.ammo.totalIncludesMag') ? mag + reserve : reserve;
    if (total !== ammo.total) {
      ammo.total = total;
      totalEl.textContent = String(total);
      panelEl.classList.toggle('empty', total === 0);
    }
    ammo.mag = mag; ammo.reserve = reserve; ammo.flag = !!visible;
  }

  function setGrenades(n) {
    if (ammo.grenades !== null && n !== ammo.grenades) ammo.changedAt = clock;   // threw / picked up
    if (n !== ammo.grenades) { grenN.textContent = String(n); grenEl.classList.toggle('none', !(n > 0)); }
    ammo.grenades = n;
  }

  function setCombat(on) { combatFlag = !!on; }

  function hitMarker(kind = 'body') {
    if (!HIT_RANK[kind]) kind = 'body';
    const active = hit.kind && hit.t < hit.dur;
    if (active && HIT_RANK[hit.kind] > HIT_RANK[kind]) return;          // a kill marker is not cut short by a body hit
    hit.kind = kind; hit.t = 0;
    hit.dur = P(kind === 'kill' ? 'hud.hit.killTime' : 'hud.hit.time');
    if (reduced) hit.dur = Math.max(hit.dur, REDUCED_MIN_FLASH);
  }

  function damage(dirWorld, strength = 1) {
    if (!dirWorld) return;
    let x = -dirWorld.x, z = -dirWorld.z;                                // attacker side = opposite of travel, flattened
    const len = Math.hypot(x, z);
    if (len < 1e-6) return;                                              // straight down/up: no side to show
    x /= len; z /= len;
    strength = clamp01(+strength || 0);
    const mergeCos = Math.cos(P('hud.damage.merge') / DEG);
    let slot = null;                                                     // same side: refresh that streak
    for (const s of streaks) if (s.active && s.dir.x * x + s.dir.z * z >= mergeCos) { slot = s; break; }
    if (slot) {
      slot.strength = Math.max(slot.fadeT < 0 ? slot.strength : 0, strength);
      if (slot.t > P('hud.damage.streakIn')) slot.t = P('hud.damage.streakIn');   // already in: stay full, restart the hold
    } else {
      for (const s of streaks) if (!s.active) { slot = s; break; }       // else a free one
      if (!slot) { slot = streaks[0]; for (const s of streaks) if (s.t > slot.t) slot = s; }   // else the oldest
      slot.t = 0; slot.strength = strength;
    }
    slot.dir.set(x, 0, z);
    slot.fadeT = -1;
    slot.active = true;
  }

  function setHealthLook(luck) { health.target = clamp01(+luck); }

  function awareness(actor, value, state = 'suspicious') {
    if (!actor) return;
    const color = AW_COLOR[state] || 'yellow';
    value = clamp01(+value || 0);
    let e = awByActor.get(actor);
    if (!e) {
      if (color !== 'orange' && value <= 0) return;                      // hidden at 0 (ai-spec §1.2): take no marker
      for (const c of aw) if (!c.actor) { e = c; break; }
      if (!e) return;                                                    // pool exhausted: raise hud.awareness.pool
      e.actor = actor; e.alpha = 0; e.color = ''; e.alertT = 1e9; e.occluded = false; e.losFresh = true;
      e.tx = e.ty = e.ts = NaN;
      awByActor.set(actor, e);
    }
    if (color === 'orange' && e.color !== 'orange') e.alertT = 0;        // the moment of full awareness: pop
    e.state = state; e.color = color; e.value = value; e.lastCall = clock;
  }

  function prompt(text, at = null) {
    if (text === '') text = null;
    if (text != null && at) prm.at.copy(at);
    const anchored = text != null ? !!at : prm.anchored;                 // a fading prompt stays where it was
    if (text === prm.text && anchored === prm.anchored) return;
    if (anchored !== prm.anchored) {
      prm.anchored = anchored;
      promptEl.classList.toggle('anchored', anchored);
      if (!anchored) { promptEl.style.transform = ''; prm.tx = prm.ty = NaN; }
    }
    prm.text = text;
    if (text == null) { prm.target = 0; return; }
    const m = /^\s*\[([^\]]+)\]\s*(.*)$/.exec(String(text));
    promptKey.textContent = m ? m[1] : '';
    promptText.textContent = m ? m[2] : String(text);
    prm.target = 1;
  }

  function toggle(visible) {
    shown = visible === undefined ? !shown : !!visible;
    root.classList.toggle('crhud-off', !shown);
    return shown;
  }

  // ---------------------------------------------------------------- per frame
  // Head anchor: the rig's SMPL 'head' joint (+0.12 m to the crown) when the rig can report it, else feet + height.
  function anchorOf(actor, out) {
    const rig = actor.rig;
    out.x = NaN;
    if (rig && typeof rig.getBoneWorld === 'function') rig.getBoneWorld('head', out);
    if (out.x === out.x) out.y += 0.12;
    else { out.copy(actor.pos); out.y += actor.height || 1.8; }
    out.y += P('hud.awareness.lift');
    return out;
  }

  // World point -> overlay px in tmpV (x, y); returns false when behind the camera or outside the view (+margin).
  function toScreen(cam, p, margin) {
    tmpV.copy(p).project(cam);
    if (!(tmpV.z > -1 && tmpV.z < 1)) return false;
    if (tmpV.x < -1 - margin || tmpV.x > 1 + margin || tmpV.y < -1 - margin || tmpV.y > 1 + margin) return false;
    tmpV.x = Math.round((tmpV.x * 0.5 + 0.5) * W * 10) / 10;
    tmpV.y = Math.round((-tmpV.y * 0.5 + 0.5) * H * 10) / 10;
    return true;
  }

  function checkOcclusion(e) {
    rayDir.subVectors(e.anchor, camPos);
    const dist = rayDir.length();
    if (dist < 1e-3) { e.occluded = false; return; }
    rayDir.multiplyScalar(1 / dist);
    const h = game.world.raycast(camPos, rayDir, dist, rayOpts);          // static geometry only; result object is reused
    e.occluded = !!(h && h.dist < dist - 0.05);
  }

  function frameAwareness(dt, cam) {
    const fadeIn = P('hud.awareness.fadeIn'), fadeOut = P('hud.awareness.fadeOut');
    const persist = P('hud.awareness.combatPersist'), hold = P('hud.awareness.combatHold');
    const stale = P('hud.awareness.stale'), maxD = P('hud.awareness.maxDist');
    const nearD = P('hud.awareness.nearDist'), farS = P('hud.awareness.farScale');
    const pop = reduced ? 0 : P('hud.awareness.pop');
    const occlude = P('hud.awareness.occlude') && game.world && typeof game.world.raycast === 'function';

    // Occlusion: two raycasts per frame, round robin over the live markers; new markers are checked at once below.
    if (occlude && cam) {
      for (let n = 0, tries = 0; n < 2 && tries < aw.length; tries++) {
        const e = aw[losCursor];
        losCursor = (losCursor + 1) % aw.length;
        if (!e.actor || !e.onScreen) continue;
        checkOcclusion(e);
        n++;
      }
    } else for (const e of aw) e.occluded = false;

    awEncounter = false;
    for (const e of aw) {
      if (!e.actor) continue;
      const a = e.actor;
      e.alertT += dt;
      const isStale = clock - e.lastCall > stale || a.alive === false;
      if (!isStale && (e.color === 'orange' || e.state === 'search')) awEncounter = true;

      let onScreen = false;
      if (cam && !isStale) {
        anchorOf(a, e.anchor);
        const dist = e.anchor.distanceTo(camPos);
        if (dist <= maxD && toScreen(cam, e.anchor, 0.05)) {
          onScreen = true;
          const k = clamp01((dist - nearD) / Math.max(1e-3, maxD - nearD));
          let s = 1 - (1 - farS) * k;
          if (e.color === 'orange' && pop > 0 && e.alertT < 0.25) s *= 1 + pop * (1 - e.alertT / 0.25);
          s = Math.round(s * 1000) / 1000;
          if (tmpV.x !== e.tx || tmpV.y !== e.ty || s !== e.ts) {
            e.tx = tmpV.x; e.ty = tmpV.y; e.ts = s;
            e.node.style.transform = 'translate3d(' + e.tx + 'px,' + e.ty + 'px,0) translate(-50%,-100%) scale(' + s + ')';
          }
        }
      }
      e.onScreen = onScreen;
      if (e.losFresh && onScreen) { if (occlude) checkOcclusion(e); e.losFresh = false; }

      let want;
      if (isStale) want = 0;
      else if (e.color === 'orange') want = persist || e.alertT < hold ? 1 : 0;
      else want = e.value > 0 ? 1 : 0;
      if (e.occluded) want = 0;
      e.alpha = a.alive === false ? 0 : approach(e.alpha, want, dt, fadeIn, fadeOut);   // taken down / killed: snaps off [MEASURED §1]
      setAlpha(e.node, e.cache, 'a', onScreen ? e.alpha : 0);           // off-screen: gone at once (no edge slide)

      if (e.color !== e.shownColor) {
        if (e.shownColor) e.node.classList.remove(e.shownColor);
        if (e.color) e.node.classList.add(e.color);
        e.shownColor = e.color;
        const g = '';                                                    // U4: no glyph on the diamond [MEASURED §1]
        if (g !== e.shownGlyph) { e.shownGlyph = g; e.glyph.textContent = g; }
      }
      const qv = e.color === 'orange' ? 1 : Math.round(e.value * 200) / 200;
      if (qv !== e.shownValue) {
        e.shownValue = qv;
        e.fill.clipRect.setAttribute('y', (0.7 + 28.6 * (1 - qv)).toFixed(2));
      }

      // Release once faded, when only a fresh non-zero call could bring it back.
      if ((isStale || (e.color !== 'orange' && e.value <= 0)) && e.alpha <= 0) {
        awByActor.delete(a);
        e.actor = null; e.shownValue = -1;
        setAlpha(e.node, e.cache, 'a', 0);
      }
    }
  }

  // Grenade danger indicator. One icon per live grenade within warnRadius of the player: an enemy grenade from its
  // release, the player's own from first contact. Instant show and hide (no fades, gone on the explosion frame),
  // FILLED within dangerRadius, dimmed behind static geometry, clamped to an ellipse when off-screen or behind.
  const _clip = new THREE.Vector4();
  function frameGrenadeWarn(dt, cam) {
    const gr = game.grenades, pl = game.player;
    const live = P('hud.grenadeWarn.on') && cam && gr && pl ? gr.live : null;
    const warnR = P('hud.grenadeWarn.warnRadius');
    const dangerR = P('hud.grenadeWarn.dangerRadius') ||
      (params.has('grenade.blast.killRadius') ? P('grenade.blast.killRadius') : 3);
    const ownContact = P('hud.grenadeWarn.ownFromContact');
    const occlude = game.world && typeof game.world.raycast === 'function';
    const turn = P('hud.grenadeWarn.pointerTurn') * Math.PI / 180;
    const dead = P('hud.grenadeWarn.pointerDead') * H;
    const inset = P('hud.grenadeWarn.edgeInset') * H;
    const ea = Math.max(1, W / 2 - inset), eb = Math.max(1, H / 2 - inset);
    const cx = W / 2, cy = H / 2;

    for (const g of gw) g.seen = false;
    if (live) {
      for (let i = 0; i < live.length; i++) {
        const b = live[i];
        if (!b || !b.pos) continue;
        const own = b.owner === pl;
        if (own && ownContact && !b.fuseStarted) continue;
        const d = b.pos.distanceTo(pl.pos);
        if (d > warnR) continue;
        // the icon already following this grenade, else a free one
        let g = null;
        for (const c of gw) if (c.id === b.id) { g = c; break; }
        if (!g) for (const c of gw) if (c.id < 0) { g = c; g.id = b.id; g.angSet = false; break; }
        if (!g) continue;                                         // pool full: the nearest ones already have icons
        g.seen = true;
        g.pos.copy(b.pos);
        g.filled = d <= dangerR;

        // screen position: clip space, so a grenade behind the camera still gets a direction
        _clip.set(b.pos.x, b.pos.y, b.pos.z, 1).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
        let x, y, edge = false;
        if (_clip.w > 1e-4) {
          x = cx + (_clip.x / _clip.w) * cx;
          y = cy - (_clip.y / _clip.w) * cy;
        } else {
          // Behind the camera, x/w and y/w come out mirrored; the raw clip x/y still carry the true left/right and
          // up/down, so use them (screen y down) and push to the edge on the grenade's side.
          const dx = _clip.x, dy = -_clip.y;
          const l = Math.hypot(dx, dy);
          x = cx + (l > 1e-6 ? dx / l : 0) * 1e5;
          y = cy + (l > 1e-6 ? dy / l : 1) * 1e5;
          edge = true;
        }
        const ox = x - cx, oy = y - cy;
        const k = (ox * ox) / (ea * ea) + (oy * oy) / (eb * eb);
        if (k > 1) { const s = 1 / Math.sqrt(k); x = cx + ox * s; y = cy + oy * s; edge = true; }
        else if (x < 0 || x > W || y < 0 || y > H) edge = true;
        g.edge = edge;
        x = Math.round(x * 10) / 10; y = Math.round(y * 10) / 10;

        // pointer: away from the screen centre, turning along the shorter arc; keeps its angle near the centre
        const rx = x - cx, ry = y - cy;
        if (Math.hypot(rx, ry) > dead || !g.angSet) {
          const want = Math.atan2(ry, rx);
          if (!g.angSet || turn <= 0) { g.ang = want; g.angSet = true; }
          else {
            let err = want - g.ang;
            err = Math.atan2(Math.sin(err), Math.cos(err));
            const stepA = turn * dt;
            g.ang += Math.abs(err) <= stepA ? err : Math.sign(err) * stepA;
          }
        }

        // occlusion against static geometry (a one-frame lag is fine and matches U4)
        if (occlude && !edge) {
          rayDir.subVectors(g.pos, camPos);
          const dist = rayDir.length();
          if (dist > 1e-3) {
            rayDir.multiplyScalar(1 / dist);
            const h = game.world.raycast(camPos, rayDir, dist, rayOpts);
            g.occluded = !!(h && h.dist < dist - 0.15);
          } else g.occluded = false;
        } else g.occluded = false;

        if (x !== g.x || y !== g.y) {
          g.x = x; g.y = y;
          g.node.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
        }
        const pr = (g.filled ? P('hud.grenadeWarn.pointerRFilled') : P('hud.grenadeWarn.pointerR')) * u;
        const ptf = 'rotate(' + (Math.round(g.ang * 5730) / 100) + 'deg) translateX(' + (Math.round(pr * 10) / 10) + 'px)';
        if (ptf !== g.shownPtr) { g.shownPtr = ptf; g.ptr.style.transform = ptf; }
        if (g.filled !== g.cache.filled) { g.cache.filled = g.filled; g.node.classList.toggle('filled', g.filled); }
        const ia = g.occluded ? P('hud.grenadeWarn.occludedAlpha') : 1;
        const pa = g.occluded ? P('hud.grenadeWarn.occludedPointerAlpha') : 1;
        if (ia !== g.cache.ia) { g.cache.ia = ia; g.node.style.setProperty('--gw-ia', ia); }
        if (pa !== g.cache.pa) { g.cache.pa = pa; g.node.style.setProperty('--gw-pa', pa); }
        setAlpha(g.node, g.cache, 'a', 1);
      }
    }
    // grenades that exploded, left the radius or were never live: gone at once [MEASURED: hidden on the blast frame]
    for (const g of gw) if (!g.seen && g.id >= 0) { g.id = -1; g.angSet = false; setAlpha(g.node, g.cache, 'a', 0); }
  }

  function frameReticle(dt) {
    ret.hipT += dt;
    const mode = ret.mode, aiming = mode === 'aim';
    const style = ret.style || P('hud.reticle.style');
    const persistent = P('hud.reticle.persistentDot') && mode !== 'grenade';
    const wantArcs = aiming && style === 'arcs' ? 1 : 0;
    const wantDot = (aiming && style === 'dot') || (persistent && !wantArcs && style !== 'u4') ? 1 : 0;
    frameU4(dt, aiming && style === 'u4');
    const wantHip = P('hud.reticle.hipShow') && !aiming && mode !== 'grenade' &&
      (mode === 'hip' || ret.hipT < P('hud.reticle.hipHold')) ? 1 : 0;
    const rIn = P('hud.reticle.fadeIn'), rOut = P('hud.reticle.fadeOut');
    ret.dotA = approach(ret.dotA, wantDot, dt, rIn, rOut);
    ret.arcsA = approach(ret.arcsA, wantArcs, dt, rIn, rOut);
    ret.hipA = approach(ret.hipA, wantHip, dt, rIn, rOut);
    setAlpha(retEl, cache, 'ret', ret.dotA);
    setAlpha(arcsEl, cache, 'arcs', ret.arcsA);
    setAlpha(hipEl, cache, 'hip', ret.hipA);
    if (ret.arcsA > 0 || ret.hipA > 0) {
      const gap = Math.round(Math.min(P('hud.reticle.ringMax') * u, Math.max(P('hud.reticle.ringMin') * u, spreadPx(ret.spread))) * 4) / 4;
      if (gap !== ret.gap) { ret.gap = gap; setVar('--ret-gap', gap, 'px'); }
    }
    const tint = ret.onTarget && P('hud.reticle.targetTint') && mode !== 'none';
    if (tint !== ret.tint) {
      ret.tint = tint;
      retEl.classList.toggle('on-target', tint);
      arcsEl.classList.toggle('on-target', tint);
      hipEl.classList.toggle('on-target', tint);
      r3El.classList.toggle('on-target', tint);
      bulEl.classList.toggle('on-target', tint);
    }
  }

  // 'u4' reticle. Aiming and not firing: the three arcs. A shot (onPlayerShot) hides the ring and shows the bullet dot at
  // the shot's screen offset plus an upward kick that settles back; dotHold after the last shot the dot fades, and at
  // ringReturn the ring fades back in at openRadius and shrinks to radius.
  function frameU4(dt, on) {
    const since = clock - ret.shotClock;
    if (on && !ret.wasAiming) ret.r3 = P('hud.u4.openRadius') * u;             // aim-in: the ring closes in
    ret.wasAiming = on;
    const fade = Math.max(1e-3, P('hud.u4.dotFade'));
    const wantRing = on && since >= P('hud.u4.ringReturn') ? 1 : 0;
    ret.r3A = approach(ret.r3A, wantRing, dt, fade, fade * 0.5);
    const wantBul = on && since < P('hud.u4.dotHold') ? 1 : 0;
    ret.bulA = wantBul ? 1 : Math.max(0, ret.bulA - dt / fade);
    if (!wantRing) ret.r3 = P('hud.u4.openRadius') * u;                        // hidden: waits open
    else {
      const rest = P('hud.u4.radius') * u, tau = P('hud.u4.contractTau');
      ret.r3 = rest + (ret.r3 - rest) * Math.exp(-dt / Math.max(1e-3, tau));
    }
    setAlpha(r3El, cache, 'r3', ret.r3A);
    setAlpha(bulEl, cache, 'bul', ret.bulA);
    if (ret.r3A > 0) {
      const r = Math.round(ret.r3 * 4) / 4;
      if (r !== ret.r3Sent) { ret.r3Sent = r; setVar('--r3', r, 'px'); }
    }
    if (ret.bulA > 0) {
      const k = Math.exp(-dt / Math.max(1e-3, P('hud.u4.bulletTau')));
      ret.bx *= k; ret.by *= k;
      const tf = 'translate3d(' + (Math.round(ret.bx * 4) / 4) + 'px,' + (Math.round(ret.by * 4) / 4) + 'px,0)';
      if (tf !== ret.bSent) { ret.bSent = tf; bulEl.style.transform = tf; }
    }
  }

  // The player fired: place the bullet dot where the round went (its end point projected; the reticle is the origin),
  // plus the measured kick up with a small sideways wobble. Payloads are pooled, so nothing is kept.
  const _shotP = new THREE.Vector3();
  function onPlayerShot(e) {
    if (ret.mode !== 'aim') return;
    ret.shotClock = clock;
    let dx = 0, dy = 0;
    const cam = game.camera;
    if (cam && e.end && P('hud.u4.useShotDir')) {
      _shotP.copy(e.end).project(cam);
      if (_shotP.z < 1) { dx = _shotP.x * W / 2; dy = -_shotP.y * H / 2 + H / 2 - P('hud.reticle.y') * H; }
    }
    ret.seed = (Math.imul(ret.seed ^ (ret.seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;   // local hash: the sim RNG is untouched
    const kick = P('hud.u4.bulletKick') * u;
    dx += ((ret.seed / 4294967296) - 0.5) * 0.5 * kick;
    dy -= kick;
    const lim = P('hud.u4.openRadius') * u, m = Math.hypot(dx, dy);
    if (m > lim) { dx *= lim / m; dy *= lim / m; }
    ret.bx = dx; ret.by = dy;
  }
  const offShot = game.events ? game.events.on('shot', (e) => { if (e && game.player && e.shooter === game.player) onPlayerShot(e); }) : null;

  function framePanel(dt) {
    const mode = ret.mode;
    const on = combatFlag || awEncounter || mode === 'aim' || mode === 'grenade' || ammo.flag ||
      clock - ammo.changedAt < P('hud.pickupShowT');
    ammo.offFor = on ? 0 : ammo.offFor + dt;
    const want = ammo.mag !== null && (on || ammo.offFor < P('hud.hideDelay')) ? 1 : 0;
    ammo.alpha = approach(ammo.alpha, want, dt, P('hud.fadeIn'), P('hud.fadeOut'));
    setAlpha(panelEl, cache, 'panel', ammo.alpha);
    const gm = mode === 'grenade';
    if (gm !== ammo.grenadeMode) { ammo.grenadeMode = gm; panelEl.classList.toggle('grenade-mode', gm); }
  }

  function frameHit(dt) {
    if (!hit.kind) { setAlpha(hitEl, cache, 'hit', 0); return; }
    hit.t += dt;
    if (hit.kind !== hit.shownKind) {
      if (hit.shownKind) hitEl.classList.remove(hit.shownKind);
      hitEl.classList.add(hit.kind);
      hit.shownKind = hit.kind;
    }
    const k = hit.dur > 0 ? hit.t / hit.dur : 1;
    // Full at once, hold 40 %, fade the rest; reduced motion: one soft fade from the start, no pop.
    const a = reduced ? clamp01(1 - k * k) : k < 0.4 ? 1 : clamp01(1 - (k - 0.4) / 0.6);
    setAlpha(hitEl, cache, 'hit', a);
    const pop = reduced ? 0 : P('hud.hit.pop') * (hit.kind === 'kill' ? 1.4 : 1);
    const sc = Math.round((1 + pop * Math.max(0, 1 - k / 0.35)) * 1000) / 1000;
    if (sc !== cache.hitScale) { cache.hitScale = sc; hitEl.style.transform = 'scale(' + sc + ')'; }
    if (k >= 1) hit.kind = null;
  }

  function frameStreaks(dt, cam) {
    let rx = 1, rz = 0, fx = 0, fz = -1;
    if (cam) {
      const m = cam.matrixWorld.elements;
      rx = m[0]; rz = m[2];                                              // camera right (local +X), flattened
      fx = -m[8]; fz = -m[10];                                           // camera forward (local -Z), flattened
      const lr = Math.hypot(rx, rz) || 1, lf = Math.hypot(fx, fz) || 1;
      rx /= lr; rz /= lr; fx /= lf; fz /= lf;
    }
    const sIn = P('hud.damage.streakIn'), sFade = P('hud.damage.streakFade');
    const holdLuck = P('hud.damage.holdLuck'), minHold = P('hud.damage.minHold');
    const luck = health.target;
    const hw = W / 2, hh = H / 2, phiC = Math.atan2(hw, hh);
    const inset = Math.round(4 * u);
    for (const s of streaks) {
      if (!s.active) continue;
      s.t += dt;
      let a;
      if (s.t < sIn) a = s.t / sIn;
      else if (s.fadeT < 0 && (s.t < sIn + minHold || luck < holdLuck)) a = 1;   // hold while hurt [§7]
      else { s.fadeT = Math.max(0, s.fadeT) + dt; a = sFade > 0 ? 1 - s.fadeT / sFade : 0; }
      a = clamp01(a);
      if (a <= 0 && s.fadeT >= 0) s.active = false;

      // Screen angle, clockwise from 12 o'clock: in front = top edge, right = right edge, behind = bottom edge.
      const th = Math.atan2(s.dir.x * rx + s.dir.z * rz, s.dir.x * fx + s.dir.z * fz);
      const sx = Math.sin(th), sy = -Math.cos(th);
      const t = Math.min(Math.abs(sx) > 1e-6 ? hw / Math.abs(sx) : Infinity, Math.abs(sy) > 1e-6 ? hh / Math.abs(sy) : Infinity);
      const px = Math.round((hw + sx * t) * 2) / 2, py = Math.round((hh + sy * t) * 2) / 2;
      // Rotate so the drips point inward along the edge normal, blended across the corners.
      const aa = Math.abs(th);
      let base;
      if (aa < phiC - CORNER_BAND) base = 0;
      else if (aa < phiC + CORNER_BAND) base = 90 * smooth01((aa - phiC + CORNER_BAND) / (2 * CORNER_BAND));
      else if (aa < Math.PI - phiC - CORNER_BAND) base = 90;
      else if (aa < Math.PI - phiC + CORNER_BAND) base = 90 + 90 * smooth01((aa - Math.PI + phiC + CORNER_BAND) / (2 * CORNER_BAND));
      else base = 180;
      const rot = Math.round((th < 0 ? -base : base) * 10) / 10;
      const grow = reduced || sIn <= 0 ? 1 : Math.round((0.45 + 0.55 * smooth01(s.t / sIn)) * 100) / 100;   // drip in
      if (px !== s.cache.px || py !== s.cache.py || rot !== s.cache.rot || grow !== s.cache.grow) {
        s.cache.px = px; s.cache.py = py; s.cache.rot = rot; s.cache.grow = grow;
        s.node.style.transform = 'translate3d(' + px + 'px,' + py + 'px,0) rotate(' + rot + 'deg) translate(-50%,-' + inset + 'px) scale(1,' + grow + ')';
      }
      setAlpha(s.node, s.cache, 'a', s.active ? a * (0.45 + 0.55 * s.strength) : 0);   // intensity ∝ damage [§7]
    }
  }

  function frameHealth(dt) {
    const lag = P('hud.health.lag');
    if (lag <= 0) health.cur = health.target;
    else if (dt > 0) health.cur += (health.target - health.cur) * (1 - Math.exp(-dt / lag));
    if (Math.abs(health.cur - health.target) < 5e-4) health.cur = health.target;
    if (health.cur === health.sent) return;
    if (Math.abs(health.cur - health.sent) < 0.002 && health.cur !== health.target) return;
    health.sent = health.cur;
    const luck = health.cur, minSat = P('hud.health.minSat');
    // player-spec §7: saturation = lerp(minSat, 1, smoothstep(0, satKnee, luck)); vignette = (1 - luck) x vignetteMax
    grade.saturation = minSat + (1 - minSat) * smooth01(luck / Math.max(1e-3, P('hud.health.satKnee')));
    grade.vignette = (1 - luck) * P('hud.health.vignetteMax');
    grade.contrast = 1 - (1 - luck) * P('hud.health.contrastDrop');
    const r = game.render;
    if (r && typeof r.setGrade === 'function') {
      r.setGrade(grade);
      if (gradeEl.dataset.a !== '0') gradeEl.dataset.a = '0';
    } else {
      // Fallback: DOM desaturate + vignette over the canvas (a backdrop filter, only while hurt).
      gradeEl.dataset.a = luck < 0.999 ? '1' : '0';
      gradeDesat.style.setProperty('--grade-sat', grade.saturation.toFixed(3));
      gradeVig.style.opacity = grade.vignette.toFixed(3);
    }
  }

  function framePrompt(dt, cam) {
    const pf = P('hud.prompt.fade');
    prm.alpha = approach(prm.alpha, prm.target, dt, pf, pf);
    let vis = prm.alpha;
    if (prm.anchored && vis > 0) {
      if (cam && toScreen(cam, prm.at, 0)) {
        if (tmpV.x !== prm.tx || tmpV.y !== prm.ty) {
          prm.tx = tmpV.x; prm.ty = tmpV.y;
          promptEl.style.transform = 'translate3d(' + prm.tx + 'px,' + prm.ty + 'px,0) translate(-50%,-100%)';
        }
      } else vis = 0;
    }
    setAlpha(promptEl, cache, 'prompt', vis);
  }

  function frame(dt) {
    if (!(dt >= 0)) dt = 0;
    clock += dt;
    const cam = game.camera || null;
    if (cam) { cam.updateMatrixWorld(); camPos.setFromMatrixPosition(cam.matrixWorld); }
    applySizes();
    frameAwareness(dt, cam);          // first: it decides whether an encounter is on (panel rule)
    frameGrenadeWarn(dt, cam);
    frameReticle(dt);
    framePanel(dt);
    frameHit(dt);
    frameStreaks(dt, cam);
    frameHealth(dt);
    framePrompt(dt, cam);
  }

  // ---------------------------------------------------------------- optional event wiring
  function wire() {
    const ev = game.events;
    if (!ev) return () => {};
    const travel = new THREE.Vector3();
    const offs = [
      ev.on('damage', (e) => {
        const pl = game.player;
        if (!e || !pl) return;
        if (e.target === pl) {
          // The attacker's position beats the payload dir: it holds for bullets and blasts alike.
          const src = e.source && e.source.pos;
          if (src) travel.subVectors(pl.pos, src); else if (e.dir) travel.copy(e.dir); else return;
          damage(travel, clamp01((e.amount || 0) / (0.15 * (pl.maxHealth || 100))));   // 15 % of max = full streak
        } else if (e.source === pl && e.target && e.target.alive !== false) {
          hitMarker(e.part === 'head' ? 'head' : 'body');
        }
      }),
      ev.on('death', (e) => {
        if (e && game.player && e.source === game.player && e.actor !== game.player) hitMarker('kill');
      }),
    ];
    return () => { for (const off of offs) off(); };
  }

  // ---------------------------------------------------------------- test hooks (allocate; not for the hot path)
  function debug() {
    return {
      shown, clock: +clock.toFixed(4), reduced, u,
      reticle: { mode: ret.mode, dot: +ret.dotA.toFixed(3), arcs: +ret.arcsA.toFixed(3), hip: +ret.hipA.toFixed(3),
        u4: { ring: +ret.r3A.toFixed(3), radius: +ret.r3.toFixed(2), bullet: +ret.bulA.toFixed(3), bx: +ret.bx.toFixed(2), by: +ret.by.toFixed(2) },
        gapPx: ret.gap, onTarget: ret.onTarget, yFrac: P('hud.reticle.y') },
      panel: { mag: ammo.mag, reserve: ammo.reserve, cap: ammo.cap, total: ammo.total, grenades: ammo.grenades,
        alpha: +ammo.alpha.toFixed(3), offFor: +Math.min(ammo.offFor, 999).toFixed(3), encounter: combatFlag || awEncounter },
      hit: hit.kind ? { kind: hit.kind, t: +hit.t.toFixed(3), dur: hit.dur } : null,
      streaks: streaks.filter((s) => s.active).map((s) => ({ x: s.cache.px, y: s.cache.py, rot: s.cache.rot, alpha: s.cache.a,
        t: +s.t.toFixed(3), fading: s.fadeT >= 0 })),
      health: { target: health.target, cur: +health.cur.toFixed(4), grade: { ...grade } },
      awareness: aw.filter((e) => e.actor).map((e) => ({ id: e.actor.id, state: e.state, color: e.color, value: e.value,
        alpha: +e.alpha.toFixed(3), onScreen: e.onScreen, occluded: e.occluded, x: e.tx, y: e.ty, scale: e.ts })),
      grenadeWarn: gw.filter((g) => g.id >= 0).map((g) => ({ id: g.id, x: g.x, y: g.y, filled: g.filled, occluded: g.occluded,
        edge: g.edge, angle: +(g.ang * 180 / Math.PI).toFixed(1) })),
      prompt: prm.text, promptAlpha: +prm.alpha.toFixed(3), promptAnchored: prm.anchored, promptXY: prm.anchored ? [prm.tx, prm.ty] : null,
    };
  }

  function dispose() {
    if (sys && game.removeSystem) game.removeSystem(sys);
    if (ro) ro.disconnect(); else removeEventListener('resize', measure);
    if (reduceMq && reduceMq.removeEventListener) reduceMq.removeEventListener('change', onReduce);
    if (offShot) offShot();
    root.remove();
  }

  const hud = { setReticle, setAmmo, setGrenades, setCombat, hitMarker, damage, setHealthLook, awareness, prompt, toggle,
    frame, wire, debug, dispose, root };

  let sys = null;
  if (opts.system !== false && typeof game.addSystem === 'function') {
    sys = game.addSystem({ name: 'hud', order: 90, frame: (realDt, g) => frame(g.paused ? 0 : realDt * (g.timeScale ?? 1)) });
  }
  applySizes();
  game.hud = hud;
  return hud;
}
