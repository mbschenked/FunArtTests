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
const RING_R = 9;                       // awareness ring radius in its 24-unit SVG viewBox
const RING_C = TAU * RING_R;            // circumference (stroke-dasharray)
const HIT_RANK = { body: 1, head: 2, kill: 3 };
// ai-spec §1.2 [DEV]: white = about to notice, yellow = suspicious / investigating (and searching), orange = combat.
const AW_COLOR = { unaware: 'white', suspicious: 'yellow', investigate: 'yellow', search: 'yellow', combat: 'orange', alerted: 'orange' };
const REF_H = 720;                      // player-spec measured the HUD on 1280x720 frames; sizes are px at 720p
const TICK_POOL = 40;                   // most magazine ticks the panel can show
const STREAK_POOL = 6;
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
  ['hud.reticle.style',         'dot', { options: ['dot', 'arcs'], label: 'aim reticle' }],                   // [MEASURED F1: pistol dot; F5: rifle arcs]
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
  ['hud.awareness.size',        26,    { min: 10, max: 60, step: 1, label: 'marker size (px @720p)' }],      // [ASSUMED] art
  ['hud.awareness.lift',        0.32,  { min: 0, max: 1.5, step: 0.01, label: 'height above head (m)' }],    // [ASSUMED]
  ['hud.awareness.fadeIn',      0.15,  { min: 0, max: 1, step: 0.01, label: 'marker fade in (s)' }],         // [INFERRED]
  ['hud.awareness.fadeOut',     0.45,  { min: 0, max: 2, step: 0.01, label: 'marker fade out (s)' }],        // [INFERRED]
  ['hud.awareness.combatPersist', true, { label: 'orange stays through combat' }],                            // [DEV ai-spec §1.2 "solid orange in Combat"]
  ['hud.awareness.combatHold',  1.6,   { min: 0, max: 6, step: 0.1, label: 'orange hold if not persistent (s)' }], // [ASSUMED]
  ['hud.awareness.stale',       0.4,   { min: 0.05, max: 3, step: 0.05, label: 'drop if not updated (s)' }],  // [ASSUMED] the AI calls every step
  ['hud.awareness.maxDist',     45,    { min: 5, max: 150, step: 1, label: 'max distance (m)' }],           // [ASSUMED] the room is ~30 m
  ['hud.awareness.nearDist',    6,     { min: 0, max: 40, step: 0.5, label: 'full size within (m)' }],       // [ASSUMED]
  ['hud.awareness.farScale',    0.65,  { min: 0.2, max: 1, step: 0.05, label: 'scale at max distance' }],    // [ASSUMED]
  ['hud.awareness.pop',         0.3,   { min: 0, max: 1, step: 0.05, label: 'combat pop (scale)' }],          // [ASSUMED]; 0 under reduced motion
  ['hud.awareness.occlude',     true,  { label: 'hide behind walls' }],                                       // [ASSUMED]; ai-spec open question 6
  ['hud.awareness.pool',        8,     { min: 1, max: 32, step: 1, label: 'pool size (read at start)' }],    // [ASSUMED]
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
    svg.setAttribute('viewBox', '0 0 24 24');
    const mk = (tag, cls, attrs) => {
      const n = document.createElementNS(SVGNS, tag);
      n.setAttribute('class', cls);
      for (const a in attrs) n.setAttribute(a, attrs[a]);
      svg.appendChild(n);
      return n;
    };
    mk('circle', 'bg', { cx: 12, cy: 12, r: RING_R });
    mk('circle', 'core', { cx: 12, cy: 12, r: RING_R - 1.5 });
    const fill = mk('circle', 'fill', { cx: 12, cy: 12, r: RING_R, transform: 'rotate(-90 12 12)',
      'stroke-dasharray': RING_C.toFixed(3), 'stroke-dashoffset': RING_C.toFixed(3) });
    mk('path', 'pin', { d: 'M9.2 23.4 L14.8 23.4 L12 27.6 Z' });   // small pointer down toward the head
    node.appendChild(svg);
    const glyph = el('span', 'glyph', node);
    aw.push({ node, fill, glyph, actor: null, value: 0, state: 'unaware', color: 'white', lastCall: -1e9, alpha: 0,
      alertT: 1e9, occluded: false, losFresh: false, onScreen: false, shownValue: -1, shownColor: '', shownGlyph: '',
      tx: NaN, ty: NaN, ts: NaN, cache: {}, anchor: new THREE.Vector3() });
  }
  const awByActor = new Map();

  const center = el('div', 'crhud-center', root);
  const retEl = el('div', 'crhud-ret', center);
  el('div', 'crhud-dot', retEl);
  const arcsEl = el('div', 'crhud-arcs', center);
  el('div', 'ring', arcsEl);
  const hipEl = el('div', 'crhud-hip', center);
  el('div', 'ring', hipEl);
  el('div', 'crhud-dot', hipEl);
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

  const ret = { mode: 'none', spread: 0, onTarget: false, style: null, hipT: 1e9, dotA: 0, arcsA: 0, hipA: 0, gap: -1, tint: null };
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
    const len = P('hud.hit.len');
    setVar('--hit-len', len * u, 'px');
    setVar('--hit-gap', Math.round(Math.max(0, P('hud.hit.span') / Math.SQRT2 - len) * u * 100) / 100, 'px');   // span = √2 (gap + len)
    setVar('--hit-thick', P('hud.hit.thickness') * u, 'px');
    setVar('--aw-size', P('hud.awareness.size') * u, 'px');
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
      e.alpha = approach(e.alpha, want, dt, fadeIn, fadeOut);
      setAlpha(e.node, e.cache, 'a', onScreen ? e.alpha : 0);           // off-screen: gone at once (no edge slide)

      if (e.color !== e.shownColor) {
        if (e.shownColor) e.node.classList.remove(e.shownColor);
        if (e.color) e.node.classList.add(e.color);
        e.shownColor = e.color;
        const g = e.color === 'orange' ? '!' : '';
        if (g !== e.shownGlyph) { e.shownGlyph = g; e.glyph.textContent = g; }
      }
      const qv = e.color === 'orange' ? 1 : Math.round(e.value * 200) / 200;
      if (qv !== e.shownValue) {
        e.shownValue = qv;
        e.fill.setAttribute('stroke-dashoffset', (RING_C * (1 - qv)).toFixed(2));
      }

      // Release once faded, when only a fresh non-zero call could bring it back.
      if ((isStale || (e.color !== 'orange' && e.value <= 0)) && e.alpha <= 0) {
        awByActor.delete(a);
        e.actor = null; e.shownValue = -1;
        setAlpha(e.node, e.cache, 'a', 0);
      }
    }
  }

  function frameReticle(dt) {
    ret.hipT += dt;
    const mode = ret.mode, aiming = mode === 'aim';
    const style = ret.style || P('hud.reticle.style');
    const persistent = P('hud.reticle.persistentDot') && mode !== 'grenade';
    const wantArcs = aiming && style === 'arcs' ? 1 : 0;
    const wantDot = (aiming && style !== 'arcs') || (persistent && !wantArcs) ? 1 : 0;
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
    }
  }

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
        gapPx: ret.gap, onTarget: ret.onTarget, yFrac: P('hud.reticle.y') },
      panel: { mag: ammo.mag, reserve: ammo.reserve, cap: ammo.cap, total: ammo.total, grenades: ammo.grenades,
        alpha: +ammo.alpha.toFixed(3), offFor: +Math.min(ammo.offFor, 999).toFixed(3), encounter: combatFlag || awEncounter },
      hit: hit.kind ? { kind: hit.kind, t: +hit.t.toFixed(3), dur: hit.dur } : null,
      streaks: streaks.filter((s) => s.active).map((s) => ({ x: s.cache.px, y: s.cache.py, rot: s.cache.rot, alpha: s.cache.a,
        t: +s.t.toFixed(3), fading: s.fadeT >= 0 })),
      health: { target: health.target, cur: +health.cur.toFixed(4), grade: { ...grade } },
      awareness: aw.filter((e) => e.actor).map((e) => ({ id: e.actor.id, state: e.state, color: e.color, value: e.value,
        alpha: +e.alpha.toFixed(3), onScreen: e.onScreen, occluded: e.occluded, x: e.tx, y: e.ty, scale: e.ts })),
      prompt: prm.text, promptAlpha: +prm.alpha.toFixed(3), promptAnchored: prm.anchored, promptXY: prm.anchored ? [prm.tx, prm.ty] : null,
    };
  }

  function dispose() {
    if (sys && game.removeSystem) game.removeSystem(sys);
    if (ro) ro.disconnect(); else removeEventListener('resize', measure);
    if (reduceMq && reduceMq.removeEventListener) reduceMq.removeEventListener('change', onReduce);
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
