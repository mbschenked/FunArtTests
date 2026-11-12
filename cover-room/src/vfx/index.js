// game.vfx: muzzle flash, tracer, bullet impacts, grenade explosion. Contract: refs/design.md "vfx/* (A5): game.vfx".
//   createVfx(game, opts) -> vfx; also sets game.vfx and registers the 'vfx' system (order 80, frame()).
//   vfx.muzzleFlash(muzzleObject3D | {pos, dir, obj?}, opts?)   opts.scale: size multiplier for this shot (1 = the preset)
//   vfx.tracer(from, to, opts?)                                  opts.hit (default true: `to` is a hit point), opts.normal
//   vfx.impact(point, normal, material?, opts?)                 material 'stone' | 'dirt' | 'metal' | 'character'; opts.delay (s)
//   vfx.explosion(pos, opts?)                                    opts.radius (m, blast radius), opts.scale
// Hooks: every 'shot' event spawns the flash + tracer + impact (impact delayed until the tracer arrives), every
// 'grenade:explode' spawns the explosion and emits 'camshake' {pos, strength}.
//
// SHARED PIECES (this file; the four effect modules get them through `shared`):
//   clock      the VFX clock: t = the instant being drawn (game.time + the unstepped remainder, so slow motion is smooth),
//              frame = number of the frame about to be drawn. explicit = true (test captures) makes every effect's age
//              exactly t - spawn time; live, an effect's clock starts on the first frame that draws it (the studies'
//              "visible clock": every shot's first frame shows the same moment whatever sim step it fired on).
//   lights     a fixed pool of 4 PointLights (three.js recompiles every lit material when the light COUNT changes, so no
//              light is ever added or removed after start). Effects request lights each frame; the pool keeps the 4 with the
//              highest intensity / (1 + camera distance^2). [ASSUMED budget: 4]
//   particles  two GPU-evaluated pools (one draw call each): 'smoke' (premultiplied alpha, lit by the scene's key + fill,
//              may glow with heat: fireballs are smoke that starts hot) and 'fire' (additive HDR: flame puffs, glows, sparks).
//              A particle's motion is analytic (initial velocity, linear drag, constant acceleration), so any frame at any
//              time is exact and nothing is integrated per frame on the CPU. Drawn in an effect pass after the distortion
//              composite and before bloom, soft against render.sceneDepth.
//   decals     instanced lit decals (bullet holes, scorch) in the main scene, faded in the shader.
//   debris     instanced lit stone chips in the main scene, analytic ballistic flight with up to 4 ground bounces.
// Draw calls while effects are alive: particles 2, tracer 1-3, muzzle 4, decals 1, debris 1, shock ring 1 (<= 12).
import * as THREE from 'three';
import { Pass, FullScreenQuad, FULLSCREEN_VERT } from '../core/render.js';
import { mulberry32 } from '../core/game.js';
import { createMuzzle } from './muzzle.js';
import { createTracer } from './tracer.js';
import { createImpact } from './impact.js';
import { createExplosion } from './explosion.js';

const NL = 4;                   // point-light pool size [ASSUMED]
const MAX_REQ = 32;             // light requests per frame

// ------------------------------------------------------------------------------------------------------------------------------
// Params: an effect's flat values object P ("group.key" -> value) bound to game.params under `prefix` ("vfx.muzzle."). The
// schema is the studies' [groupId, title, items], item = [key, kind, label, min, max, step] (kind n number, c colour '#rrggbb',
// b toggle, s select with the options in item[3]). `<prefix>preset` picks a preset (it writes every key). onChange() runs after
// any value changes. Colour params carry {color: true} and selects {options} for the panel.
function sanitizeValue(it, v) {
  const kind = it[1];
  if (kind === 'n') { v = Number(v); return Number.isFinite(v) ? Math.min(Math.max(v, it[3]), it[4]) : undefined; }
  if (kind === 'b') return v === true || v === 1 || v === '1' || v === 'true' ? true : (v === false || v === 0 || v === '0' || v === 'false' ? false : undefined);
  if (kind === 'c') { if (typeof v !== 'string') return undefined; const s = v.startsWith('#') ? v : '#' + v; return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : undefined; }
  if (kind === 's') { const o = it[3]; if (o.indexOf(v) >= 0) return v; const sl = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, ''); for (const x of o) if (sl(x) === sl(v)) return x; return undefined; }
  return undefined;
}
function bindParams(params, prefix, schema, presets, defaultPreset, P, onChange) {
  const index = {};
  for (const [gid, , items] of schema) for (const it of items) index[gid + '.' + it[0]] = it;
  const keys = Object.keys(index);
  const names = Object.keys(presets);
  const url = params._urlOverrides || {};
  const presetKey = prefix + 'preset';
  let preset = params.define(presetKey, defaultPreset, { options: names, label: 'Preset' });
  if (!presets[preset]) preset = defaultPreset;
  const base = presets[defaultPreset], boot = presets[preset];
  for (const k of keys) {
    const it = index[k];
    const opts = { label: it[2] };
    if (it[1] === 'n') { opts.min = it[3]; opts.max = it[4]; opts.step = it[5]; }
    else if (it[1] === 's') opts.options = it[3];
    else if (it[1] === 'c') opts.color = true;
    let v = params.define(prefix + k, base[k], opts);
    if (boot !== base && !((prefix + k) in url) && v === base[k]) { v = boot[k]; params.set(prefix + k, v); }
    const s = sanitizeValue(it, v);
    P[k] = s === undefined ? base[k] : s;
    params.onChange(prefix + k, (nv) => { const sv = sanitizeValue(it, nv); if (sv !== undefined) { P[k] = sv; onChange(k); } });
  }
  params.onChange(presetKey, (name) => {
    const src = presets[name];
    if (!src) return;
    for (const k of keys) params.set(prefix + k, src[k]);
  });
  return { keys, index, preset: () => params.get(presetKey) };
}

// ------------------------------------------------------------------------------------------------------------------------------
// Light pool. request() takes a world position (m), intensity (candela, three.js physical, decay 2), reach (m; the light fades
// to 0 there) and a linear colour; end() keeps the NL with the highest intensity / (1 + d^2), d = distance to the camera.
class LightPool {
  constructor(scene) {
    this.lights = [];
    for (let i = 0; i < NL; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.name = 'vfxLight' + i;
      l.castShadow = false;
      l.position.set(0, -50, 0);                 // parked under the ground while idle
      scene.add(l);
      this.lights.push(l);
    }
    this.req = new Float64Array(MAX_REQ * 9);     // x y z I reach r g b priority
    this.n = 0;
    this.cx = 0; this.cy = 0; this.cz = 0;
    this.used = 0;
  }
  begin(camera) {
    const e = camera.matrixWorld.elements;
    this.cx = e[12]; this.cy = e[13]; this.cz = e[14];
    this.n = 0;
  }
  request(x, y, z, I, reach, r, g, b) {
    if (!(I > 0) || this.n >= MAX_REQ) return;
    const o = this.n++ * 9, q = this.req;
    const dx = x - this.cx, dy = y - this.cy, dz = z - this.cz;
    q[o] = x; q[o + 1] = y; q[o + 2] = z; q[o + 3] = I; q[o + 4] = reach; q[o + 5] = r; q[o + 6] = g; q[o + 7] = b;
    q[o + 8] = I / (1 + dx * dx + dy * dy + dz * dz);
  }
  end() {
    const q = this.req;
    let used = 0;
    for (; used < NL; used++) {                    // partial selection: the NL highest priorities
      let best = -1, bp = 0;
      for (let i = 0; i < this.n; i++) { const p = q[i * 9 + 8]; if (p > bp) { bp = p; best = i; } }
      if (best < 0) break;
      const o = best * 9, l = this.lights[used];
      l.position.set(q[o], q[o + 1], q[o + 2]);
      if (l.intensity !== q[o + 3]) l.intensity = q[o + 3];
      if (l.distance !== q[o + 4]) l.distance = q[o + 4];
      l.color.setRGB(q[o + 5], q[o + 6], q[o + 7]);
      q[o + 8] = -1;
    }
    for (let i = used; i < NL; i++) if (this.lights[i].intensity !== 0) this.lights[i].intensity = 0;
    this.used = used;
  }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Puff atlas: 4 x 4 cells of 256 px, generated on the GPU once (our own noise; no image files).
// Output per texel: R = density 0..1, G / B = the density surface's normal x / y (0.5 = flat; +y = cell up), A = core: where
// heat sits and the erosion order (low dissolves first). Cell space p is -1..1.
const PUFF_GEN_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform float uSeed;           // texture seed
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float gnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 5; i++) { s += a * gnoise(p); p = p * 2.03 + vec2(17.1, 9.7); a *= 0.5; }
    return s / 0.96875;
  }
  // a lumpy puff: a few overlapping round lobes, the outline warped by fbm
  float puff(vec2 p, float cell) {
    float d = 0.0;
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      vec2 c = (vec2(hash12(vec2(cell, fi) + uSeed), hash12(vec2(fi, cell) + uSeed * 1.7)) - 0.5) * 0.62;
      float r = 0.30 + 0.20 * hash12(vec2(cell * 3.1 + fi, 7.0 + uSeed));
      d = max(d, 1.0 - length(p - c) / r);
    }
    float n = fbm(p * 2.6 + vec2(cell * 7.31, cell * 3.17) + uSeed);
    float dens = smoothstep(0.0, 0.55, d + (n - 0.5) * 0.7);
    dens *= 1.0 - smoothstep(0.78, 0.98, length(p));       // never reaches the quad edge
    return dens * (0.75 + 0.25 * fbm(p * 5.3 + 11.0 + cell));
  }
  void main() {
    vec2 cxy = floor(vUv * 4.0);
    float cell = cxy.y * 4.0 + cxy.x;
    vec2 p = fract(vUv * 4.0) * 2.0 - 1.0;
    float e = 2.0 / 256.0;
    float d = puff(p, cell);
    float dx = puff(p + vec2(e, 0.0), cell) - puff(p - vec2(e, 0.0), cell);
    float dy = puff(p + vec2(0.0, e), cell) - puff(p - vec2(0.0, e), cell);
    vec3 n = normalize(vec3(-dx, -dy, 4.0 * e));             // the density read as a height field
    float core = clamp(d * (0.55 + 0.9 * fbm(p * 3.7 + 5.0 + cell * 1.3)), 0.0, 1.0);
    gl_FragColor = vec4(d, n.x * 0.5 + 0.5, n.y * 0.5 + 0.5, core);
  }`;

// Particle vertex shader, shared by both pools. Per instance:
//   aP0   spawn position xyz (m, world), spawn time (s, VFX clock)
//   aV0   initial velocity xyz (m/s), linear drag rate k (1/s): v(t) = v0 e^-kt + (a/k)(1 - e^-kt)
//   aAcc  constant acceleration xyz (m/s^2: gravity, buoyancy, wind x k), life (s)
//   aSize diameter at birth (m), final diameter (m), growth rate (1/s: d(t) = d1 + (d0 - d1) e^-gt), roll at birth (rad)
//   aCol  linear albedo rgb (smoke) or HDR colour (fire), opacity at birth
//   aMisc heat at birth (HDR radiance of the hot core), heat decay rate (1/s), spin (rad/s), atlas cell + 16 x kind
//         (fire pool kinds: 0 flame puff, 1 round glow, 2 spark streak)
//   aFade fade-in (s), fade-out starts at (fraction of life), erosion at end of life (0..1), streak (s of motion; sparks)
// Uniforms: uTime (s, VFX clock), uViewport (drawing buffer px), uMinPx (thinnest drawn spark, px).
const PARTICLE_VERT = /* glsl */`
  attribute vec4 aP0;
  attribute vec4 aV0;
  attribute vec4 aAcc;
  attribute vec4 aSize;
  attribute vec4 aCol;
  attribute vec4 aMisc;
  attribute vec4 aFade;
  uniform float uTime;
  uniform vec2 uViewport;
  uniform float uMinPx;
  varying vec2 vUv;            // quad position -1..1 (x across, y along for sparks)
  varying vec4 vCol;           // colour, opacity x envelope
  varying vec4 vM;             // heat now, kind, atlas cell, erosion now
  varying vec2 vRot;           // cos / sin of the roll (rotates the atlas normal into view space)
  varying float vViewZ;        // view depth (m)
  varying vec3 vViewPos;       // view-space position
  vec3 posAt(float age) {
    float k = max(aV0.w, 0.05);
    float f = (1.0 - exp(-k * age)) / k;
    return aP0.xyz + aV0.xyz * f + aAcc.xyz * ((age - f) / k);
  }
  void main() {
    float age = uTime - aP0.w;
    float life = aAcc.w;
    vUv = position.xy; vCol = vec4(0.0); vM = vec4(0.0); vRot = vec2(1.0, 0.0); vViewZ = 1.0; vViewPos = vec3(0.0);
    if (age < 0.0 || age >= life || life <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }   // not born / dead: clipped
    float kind = floor(aMisc.w / 16.0 + 0.001);
    float cell = aMisc.w - kind * 16.0;
    float env = smoothstep(0.0, max(aFade.x, 1e-4), age) * (1.0 - smoothstep(aFade.y * life, life, age));
    float heat = aMisc.x * exp(-aMisc.y * age);
    float ero = aFade.z * smoothstep(0.25 * life, life, age);
    vCol = vec4(aCol.rgb, aCol.a * env);
    vM = vec4(heat, kind, cell, ero);
    vec3 p = posAt(age);
    float diam = aSize.y + (aSize.x - aSize.y) * exp(-aSize.z * age);
    #ifdef FIRE_POOL
    if (kind > 1.5) {
      // spark: a streak from where it was aSize... s ago to where it is, as a view-space quad across the motion
      vec3 v1 = (viewMatrix * vec4(p, 1.0)).xyz;
      vec3 v0 = (viewMatrix * vec4(posAt(max(age - aFade.w, 0.0)), 1.0)).xyz;
      vec3 ax = v1 - v0;
      float al = length(ax);
      vec3 dir = al > 1e-5 ? ax / al : vec3(0.0, 1.0, 0.0);
      vec3 across = cross(dir, normalize(-v1));
      float cl = length(across);
      across = cl > 1e-4 ? across / cl : vec3(1.0, 0.0, 0.0);
      float z = max(-v1.z, 0.05);
      float focal = projectionMatrix[1][1] * 0.5 * uViewport.y;
      float w = max(diam, uMinPx * z / focal);
      vCol.a *= min(diam / w, 1.0) * 0.999 + 0.001;          // a widened sub-pixel spark keeps its energy
      vec3 q = mix(v0, v1, position.y * 0.5 + 0.5) + across * (position.x * w) + dir * (position.y * w * 0.5);
      vViewPos = q; vViewZ = -q.z;
      gl_Position = projectionMatrix * vec4(q, 1.0);
      return;
    }
    #endif
    float rot = aSize.w + aMisc.z * age;
    float c = cos(rot), s = sin(rot);
    vRot = vec2(c, s);
    vec4 mv = viewMatrix * vec4(p, 1.0);
    mv.xy += vec2(c * position.x - s * position.y, s * position.x + c * position.y) * (0.5 * diam);
    vViewPos = mv.xyz; vViewZ = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;

// Shared fragment helpers. fireRamp(h): HDR radiance of flame at heat h (scene-referred). A saturated orange at a high gain:
// under tone map E each channel has its own shoulder, so the core shows white-yellow and the cooler rim deep orange-red.
const PARTICLE_COMMON = /* glsl */`
  uniform sampler2D tAtlas;
  uniform highp sampler2D tSceneDepth;
  uniform vec2 uNearFar;       // camera near / far (m)
  uniform float uSoft;         // soft contact distance with the opaque scene (m)
  uniform float uFogDensity;   // scene FogExp2 density (1/m), 0 = none
  uniform vec3 uFogCol;        // fog colour (linear)
  varying vec2 vUv;
  varying vec4 vCol;
  varying vec4 vM;
  varying vec2 vRot;
  varying float vViewZ;
  varying vec3 vViewPos;
  vec2 cellUv(float cell, vec2 q) {
    float cy = floor(cell / 4.0 + 0.001);
    float cx = cell - cy * 4.0;
    return (vec2(cx, cy) + q * 0.5 + 0.5) * 0.25;
  }
  vec3 fireRamp(float h) {
    vec3 cool = vec3(1.0, 0.16, 0.03);
    vec3 hot = vec3(1.0, 0.50, 0.16);
    return mix(cool, hot, smoothstep(0.6, 6.0, h)) * h;
  }
  float sceneZ() { return rangeViewDepth(texelFetch(tSceneDepth, ivec2(gl_FragCoord.xy), 0).r, uNearFar); }
  float fogKeep() { return exp(-uFogDensity * uFogDensity * vViewZ * vViewZ); }
`;

// Smoke pool fragment (premultiplied alpha). Uniforms: uAmbient = fill radiance factor (linear, the hemisphere light's mean /
// pi), uSunCol = key light colour x intensity / pi, uSunDirV = unit vector toward the key light IN VIEW SPACE, uAniso =
// Henyey-Greenstein g of the forward scattering.
const SMOKE_FRAG = /* glsl */`
  uniform vec3 uAmbient;
  uniform vec3 uSunCol;
  uniform vec3 uSunDirV;
  uniform float uAniso;
  void main() {
    vec4 s = texture2D(tAtlas, cellUv(vM.z, vUv));
    float ero = vM.w;
    float dens = clamp((s.r - ero) / max(1.0 - ero, 0.05), 0.0, 1.0);
    float alpha = dens * vCol.a;
    vec2 nt = s.gb * 2.0 - 1.0;
    vec2 nxy = vec2(vRot.x * nt.x - vRot.y * nt.y, vRot.y * nt.x + vRot.x * nt.y);
    vec3 n = vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
    float wrap = clamp(dot(n, uSunDirV) * 0.5 + 0.5, 0.0, 1.0);
    float sunT = wrap * mix(1.0, wrap, 0.5) * (1.0 - 0.4 * dens);
    vec3 V = normalize(-vViewPos);
    float cosT = dot(-uSunDirV, V);
    float g = uAniso;
    float hg = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosT, 1e-4), 1.5);
    vec3 col = vCol.rgb * (uAmbient + uSunCol * (sunT + 0.25 * hg * (1.0 - dens)));
    float fk = fogKeep();
    col = mix(uFogCol, col, fk);
    float h = vM.x * (0.2 + 0.8 * s.a) * smoothstep(0.05, 0.5, s.r);
    col += fireRamp(h) * fk;
    alpha *= smoothstep(0.0, uSoft, sceneZ() - vViewZ);
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(col * alpha, alpha);
  }`;

// Fire pool fragment (additive HDR; alpha untouched, so the per-texel bloom weight stays 1).
const FIRE_FRAG = /* glsl */`
  void main() {
    float kind = vM.y;
    vec3 col;
    if (kind < 0.5) {                                       // flame puff: heat shaped by the atlas core
      vec4 s = texture2D(tAtlas, cellUv(vM.z, vUv));
      float dens = clamp((s.r - vM.w) / max(1.0 - vM.w, 0.05), 0.0, 1.0);
      col = fireRamp(vM.x * (0.3 + 0.7 * s.a)) * dens * vCol.a * vCol.rgb;
    } else if (kind < 1.5) {                                // round glow: hot centre + soft skirt, 0 at the quad edge
      float r2 = dot(vUv, vUv);
      float g = exp(-6.0 * r2) + max(0.25 / (1.0 + 30.0 * r2) - 0.0081, 0.0);
      col = vCol.rgb * (vM.x * g * vCol.a);
    } else {                                                // spark: Gaussian across, bright head, fading tail
      float g = exp(-3.0 * vUv.x * vUv.x);
      float along = smoothstep(-1.0, 0.6, vUv.y);
      col = vCol.rgb * (vM.x * g * along * vCol.a);
    }
    float occ = smoothstep(0.0, uSoft, sceneZ() - vViewZ);
    gl_FragColor = vec4(col * occ * fogKeep(), 0.0);
  }`;

class ParticlePool {
  constructor(name, max, material) {
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(2, 2);
    g.setIndex(base.getIndex());
    g.setAttribute('position', base.getAttribute('position'));
    this.attrs = {};
    for (const k of ['aP0', 'aV0', 'aAcc', 'aSize', 'aCol', 'aMisc', 'aFade']) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(k, a);
      this.attrs[k] = a;
    }
    // every slot starts dead (life 0)
    g.instanceCount = 0;
    this.g = g; this.base = base; this.max = max;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.head = 0; this.high = 0;
    this.dirtyLo = Infinity; this.dirtyHi = -1;
    this.aliveUntil = -Infinity;
  }
  // write one particle from the spec object (see PARTICLE_VERT for the meaning of every field); returns the slot
  emit(s) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    if (i + 1 > this.high) { this.high = i + 1; this.g.instanceCount = this.high; }
    const o = i * 4, A = this.attrs;
    let a = A.aP0.array; a[o] = s.px; a[o + 1] = s.py; a[o + 2] = s.pz; a[o + 3] = s.t0;
    a = A.aV0.array; a[o] = s.vx; a[o + 1] = s.vy; a[o + 2] = s.vz; a[o + 3] = s.drag;
    a = A.aAcc.array; a[o] = s.ax; a[o + 1] = s.ay; a[o + 2] = s.az; a[o + 3] = s.life;
    a = A.aSize.array; a[o] = s.d0; a[o + 1] = s.d1; a[o + 2] = s.grow; a[o + 3] = s.roll;
    a = A.aCol.array; a[o] = s.cr; a[o + 1] = s.cg; a[o + 2] = s.cb; a[o + 3] = s.alpha;
    a = A.aMisc.array; a[o] = s.heat; a[o + 1] = s.heatK; a[o + 2] = s.spin; a[o + 3] = s.cell + 16 * s.kind;
    a = A.aFade.array; a[o] = s.fadeIn; a[o + 1] = s.fadeOut; a[o + 2] = s.erode; a[o + 3] = s.streak;
    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
    const end = s.t0 + s.life;
    if (end > this.aliveUntil) this.aliveUntil = end;
    return i;
  }
  flush() {
    if (this.dirtyHi < 0) return;
    const lo = this.dirtyLo, n = this.dirtyHi - lo + 1;
    for (const k in this.attrs) {
      const a = this.attrs[k];
      a.clearUpdateRanges();
      a.addUpdateRange(lo * 4, n * 4);
      a.needsUpdate = true;
    }
    this.dirtyLo = Infinity; this.dirtyHi = -1;
  }
  clear() {
    for (const k in this.attrs) this.attrs[k].array.fill(0);
    this.head = 0; this.high = 0; this.g.instanceCount = 0; this.aliveUntil = -Infinity;
    for (const k in this.attrs) { this.attrs[k].clearUpdateRanges(); this.attrs[k].needsUpdate = true; }
  }
}

function makeSpec() {
  return { px: 0, py: 0, pz: 0, t0: 0, vx: 0, vy: 0, vz: 0, drag: 1, ax: 0, ay: 0, az: 0, life: 1,
    d0: 0.1, d1: 0.1, grow: 1, roll: 0, cr: 1, cg: 1, cb: 1, alpha: 1, heat: 0, heatK: 1, spin: 0, cell: 0, kind: 0,
    fadeIn: 0.02, fadeOut: 0.6, erode: 0, streak: 0 };
}

function createParticles(shared) {
  const { render } = shared;
  const rd = render.renderer;
  const atlasRT = new THREE.WebGLRenderTarget(1024, 1024, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.NoColorSpace,
  });
  {
    const q = new FullScreenQuad(new THREE.ShaderMaterial({ uniforms: { uSeed: { value: 3.7 } }, vertexShader: FULLSCREEN_VERT,
      fragmentShader: PUFF_GEN_FRAG, depthTest: false, depthWrite: false, blending: THREE.NoBlending }));
    const prev = rd.getRenderTarget();
    rd.setRenderTarget(atlasRT);
    q.render(rd);
    rd.setRenderTarget(prev);
    q.material.dispose(); q.dispose();
  }
  const nearFar = new THREE.Vector2(0.05, 400);
  const common = () => ({
    tAtlas: { value: atlasRT.texture }, tSceneDepth: { value: render.sceneDepth }, uNearFar: { value: nearFar },
    uTime: { value: 0 }, uViewport: { value: new THREE.Vector2(1280, 720) }, uMinPx: { value: 1.2 },
    uFogDensity: { value: 0 }, uFogCol: { value: new THREE.Color() },
  });
  const smokeMat = new THREE.ShaderMaterial({
    uniforms: Object.assign(common(), {
      uSoft: { value: 0.35 }, uAmbient: { value: new THREE.Color(0.1, 0.1, 0.1) }, uSunCol: { value: new THREE.Color(0, 0, 0) },
      uSunDirV: { value: new THREE.Vector3(0, 1, 0) }, uAniso: { value: 0.3 },
    }),
    vertexShader: PARTICLE_VERT, fragmentShader: render.sceneDepthGLSL + PARTICLE_COMMON + SMOKE_FRAG,
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const fireMat = new THREE.ShaderMaterial({
    uniforms: Object.assign(common(), { uSoft: { value: 0.06 } }),
    defines: { FIRE_POOL: 1 },
    vertexShader: PARTICLE_VERT, fragmentShader: render.sceneDepthGLSL + PARTICLE_COMMON + FIRE_FRAG,
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const MATS = [smokeMat, fireMat];               // hoisted: no array literal per frame
  const smoke = new ParticlePool('vfxSmoke', 768, smokeMat);
  const fire = new ParticlePool('vfxFire', 512, fireMat);
  smoke.mesh.renderOrder = 0; fire.mesh.renderOrder = 1;
  const pscene = new THREE.Scene();
  pscene.add(smoke.mesh, fire.mesh);

  class VfxParticlePass extends Pass {
    constructor() { super(); this.needsSwap = false; }
    render(r, writeBuffer, readBuffer) {
      if (!smoke.mesh.visible && !fire.mesh.visible) return;
      const clear = r.autoClear;
      r.autoClear = false;
      r.setRenderTarget(readBuffer);
      r.render(pscene, render.camera);
      r.autoClear = clear;
    }
  }
  const pass = new VfxParticlePass();
  render.addPass(pass);

  const _v = new THREE.Vector3(), _m = new THREE.Matrix3();
  const api = {
    smoke, fire, spec: makeSpec(), atlas: atlasRT.texture,
    // per frame: clock, viewport, scene light and fog read-back
    frame(t) {
      const cam = render.camera;
      const cv = rd.domElement;
      for (let m = 0; m < 2; m++) {
        const u = MATS[m].uniforms;
        u.uTime.value = t;
        u.uViewport.value.set(cv.width, cv.height);
      }
      nearFar.set(cam.near, cam.far);
      smoke.flush(); fire.flush();
      smoke.mesh.visible = smoke.high > 0 && t < smoke.aliveUntil + 0.05;
      fire.mesh.visible = fire.high > 0 && t < fire.aliveUntil + 0.05;
      if (!smoke.mesh.visible && !fire.mesh.visible) return;
      const fog = render.scene.fog;
      const fd = fog && fog.isFogExp2 ? fog.density : 0;
      for (let m = 0; m < 2; m++) {
        const u = MATS[m].uniforms;
        if (u.uFogDensity.value !== fd) u.uFogDensity.value = fd;
        if (fog) u.uFogCol.value.copy(fog.color);
      }
      const L = shared.sceneLights();
      const su = smokeMat.uniforms, b = shared.P('vfx.smoke.bright') / Math.PI;
      const am = su.uAmbient.value, sc = su.uSunCol.value;
      if (L.fill) {
        const fc = L.fill.color, gc = L.fill.groundColor, s = 0.5 * L.fill.intensity * b;
        am.r = (fc.r + gc.r) * s; am.g = (fc.g + gc.g) * s; am.b = (fc.b + gc.b) * s;
      } else if (L.ambient) {
        const s = L.ambient.intensity * b; am.r = L.ambient.color.r * s; am.g = L.ambient.color.g * s; am.b = L.ambient.color.b * s;
      } else { am.r = am.g = am.b = 0.1 * b; }
      if (L.sun) {
        const lc = L.sun.color, s = L.sun.intensity * b;
        sc.r = lc.r * s; sc.g = lc.g * s; sc.b = lc.b * s;
        const sp = L.sun.matrixWorld.elements, tp = L.sun.target.matrixWorld.elements;
        _v.set(sp[12] - tp[12], sp[13] - tp[13], sp[14] - tp[14]);
        if (_v.lengthSq() < 1e-12) _v.set(0, 1, 0);
        _v.normalize();
        _m.setFromMatrix4(cam.matrixWorldInverse);
        su.uSunDirV.value.copy(_v).applyMatrix3(_m).normalize();
      } else { sc.r = sc.g = sc.b = 0; }
      su.uAniso.value = shared.P('vfx.smoke.aniso');
    },
    clear() { smoke.clear(); fire.clear(); },
    count(t) {                                   // live particles at t (debug, allocation ok)
      let n = 0;
      for (const pool of [smoke, fire]) {
        const p0 = pool.attrs.aP0.array, acc = pool.attrs.aAcc.array;
        for (let i = 0; i < pool.high; i++) { const age = t - p0[i * 4 + 3]; if (age >= 0 && age < acc[i * 4 + 3]) n++; }
      }
      return n;
    },
  };
  return api;
}

// ------------------------------------------------------------------------------------------------------------------------------
// Decals: our own canvas-drawn atlas (2 cells: bullet hole, scorch), lit by the scene (MeshStandardMaterial), faded in the
// shader by age. Per instance aDecal = (cell, spawn time s, life s, fade-out s).
function drawDecalAtlas() {
  const W = 512, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const rnd = mulberry32(911);
  // cell 0: bullet hole. Dark crater, a ring of freshly chipped lighter stone with a jagged edge, a few hairline cracks.
  g.save(); g.translate(128, 128);
  const ring = (r0, jag, n) => { g.beginPath(); for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; const r = r0 * (1 - jag * rnd()); g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.closePath(); };
  g.fillStyle = 'rgba(214,204,188,0.92)'; ring(108, 0.35, 28); g.fill();
  g.strokeStyle = 'rgba(70,64,58,0.55)'; g.lineWidth = 3;
  for (let i = 0; i < 6; i++) { const a = rnd() * Math.PI * 2, l = 70 + 50 * rnd(); g.beginPath(); g.moveTo(Math.cos(a) * 30, Math.sin(a) * 30); g.lineTo(Math.cos(a + (rnd() - 0.5) * 0.4) * l, Math.sin(a + (rnd() - 0.5) * 0.4) * l); g.stroke(); }
  g.fillStyle = 'rgba(150,140,128,0.95)'; ring(62, 0.3, 20); g.fill();
  const cr = g.createRadialGradient(0, 0, 4, 0, 0, 44);
  cr.addColorStop(0, 'rgba(14,12,11,1)'); cr.addColorStop(0.7, 'rgba(34,30,27,1)'); cr.addColorStop(1, 'rgba(60,54,48,0.95)');
  g.fillStyle = cr; ring(44, 0.25, 16); g.fill();
  g.restore();
  // cell 1: scorch. Soft sooty blotch with a noisy rim, slightly brown toward the edge, black at the centre.
  g.save(); g.translate(384, 128);
  for (let i = 0; i < 90; i++) {
    const a = rnd() * Math.PI * 2, r = 70 * Math.sqrt(rnd()), s = 30 + 50 * rnd();
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    const gr = g.createRadialGradient(x, y, 0, x, y, s);
    const dark = 1 - r / 110;
    gr.addColorStop(0, `rgba(${18 + 20 * (1 - dark)},${15 + 14 * (1 - dark)},12,${0.16 * dark + 0.04})`);
    gr.addColorStop(1, 'rgba(20,16,12,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fill();
  }
  g.restore();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function createDecals(shared, max = 96) {
  const { render } = shared;
  const tex = drawDecalAtlas();
  const geo = new THREE.PlaneGeometry(1, 1);
  const aDecal = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
  aDecal.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aDecal', aDecal);
  const uTime = { value: 0 };
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.95, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uDecalTime = uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aDecal;\nuniform float uDecalTime;\nvarying float vDecalFade;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = vec2((uv.x + aDecal.x) * 0.5, uv.y);\n{ float dAge = uDecalTime - aDecal.y; vDecalFade = dAge < 0.0 ? 0.0 : 1.0 - smoothstep(aDecal.z - aDecal.w, aDecal.z, dAge); }');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vDecalFade;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vDecalFade;');
  };
  mat.customProgramCacheKey = () => 'vfxDecal1';
  const mesh = new THREE.InstancedMesh(geo, mat, max);
  mesh.name = 'vfxDecals';
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < max; i++) mesh.setMatrixAt(i, zero);
  render.scene.add(mesh);
  const ends = new Float64Array(max).fill(-1);
  let head = 0;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _n = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1);
  return {
    mesh,
    // cell 0 bullet hole, 1 scorch; size = diameter (m); roll (rad); life / fade (s)
    add(px, py, pz, nx, ny, nz, cell, size, roll, t0, life, fade) {
      const i = head; head = (head + 1) % max;
      _n.set(nx, ny, nz).normalize();
      _q.setFromUnitVectors(Z, _n);
      _q2.setFromAxisAngle(Z, roll);
      _q.multiply(_q2);
      _p.set(px + _n.x * 0.004, py + _n.y * 0.004, pz + _n.z * 0.004);
      _s.set(size, size, size);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      mesh.instanceMatrix.needsUpdate = true;
      const a = aDecal.array, o = i * 4;
      a[o] = cell; a[o + 1] = t0; a[o + 2] = life; a[o + 3] = fade;
      aDecal.needsUpdate = true;
      ends[i] = t0 + life;
    },
    frame(t) {
      uTime.value = t;
      let any = false, live = false;
      for (let i = 0; i < max; i++) {
        if (ends[i] < 0) continue;
        if (t > ends[i] + 0.1) { mesh.setMatrixAt(i, zero); ends[i] = -1; any = true; } else live = true;
      }
      if (any) mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = live;                         // no draw call while no decal is alive
    },
    clear() { for (let i = 0; i < max; i++) { mesh.setMatrixAt(i, zero); ends[i] = -1; } mesh.instanceMatrix.needsUpdate = true; },
  };
}

// ------------------------------------------------------------------------------------------------------------------------------
// Debris chips: lit, flat-shaded stone chips. Ballistic flight under gravity (no drag), bouncing off a flat ground at the
// height given at spawn (restitution on the normal speed, the tangential speed x0.55 per bounce), resting after 4 bounces;
// they shrink away over the last 0.3 s of life. Evaluated analytically per frame (exact at any time).
function createDebris(shared, max = 96) {
  const { render } = shared;
  const geo = new THREE.IcosahedronGeometry(0.5, 0);
  geo.scale(1, 0.62, 0.8);
  const mat = new THREE.MeshStandardMaterial({ color: '#8a8278', roughness: 0.9, metalness: 0, flatShading: true });
  const mesh = new THREE.InstancedMesh(geo, mat, max);
  mesh.name = 'vfxDebris';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < max; i++) mesh.setMatrixAt(i, zero);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
  render.scene.add(mesh);
  const D = new Float64Array(max * 16);   // px py pz vx vy vz t0 life size groundY rest axX axY axZ spin active
  let head = 0, anyActive = false;
  const G = 9.81;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _a = new THREE.Vector3();
  const _c = new THREE.Color();
  const OUT = new Float64Array(4);        // x y z, time in flight before resting (for the spin)
  function evalChip(o, age) {
    let x = D[o], y = D[o + 1], z = D[o + 2], vx = D[o + 3], vy = D[o + 4], vz = D[o + 5];
    const gy = D[o + 9], e = D[o + 10];
    let t = age, flight = 0;
    for (let b = 0; b < 5; b++) {
      const h = y - gy;
      const disc = vy * vy + 2 * G * Math.max(h, 0);
      const tHit = (vy + Math.sqrt(disc)) / G;
      if (t < tHit || b === 4) {
        if (b === 4) t = 0;
        OUT[0] = x + vx * t; OUT[1] = Math.max(y + vy * t - 0.5 * G * t * t, gy); OUT[2] = z + vz * t; OUT[3] = flight + t;
        return;
      }
      x += vx * tHit; z += vz * tHit; y = gy;
      vy = -(vy - G * tHit) * e; vx *= 0.55; vz *= 0.55;
      t -= tHit; flight += tHit;
      if (vy < 0.25) { OUT[0] = x; OUT[1] = gy; OUT[2] = z; OUT[3] = flight; return; }
    }
  }
  return {
    mesh,
    // size = chip length (m); groundY = the floor it bounces on (m); rest = restitution 0..1; shade = albedo multiplier
    add(px, py, pz, vx, vy, vz, t0, life, size, groundY, rest, spin, shade, rnd) {
      const i = head; head = (head + 1) % max;
      const o = i * 16;
      D[o] = px; D[o + 1] = py; D[o + 2] = pz; D[o + 3] = vx; D[o + 4] = vy; D[o + 5] = vz;
      D[o + 6] = t0; D[o + 7] = life; D[o + 8] = size; D[o + 9] = groundY; D[o + 10] = rest;
      _a.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
      D[o + 11] = _a.x; D[o + 12] = _a.y; D[o + 13] = _a.z; D[o + 14] = spin; D[o + 15] = 1;
      _c.setScalar(shade);
      mesh.setColorAt(i, _c);
      mesh.instanceColor.needsUpdate = true;
      anyActive = true;
    },
    frame(t) {
      mesh.visible = anyActive;                    // no draw call while no chip is alive
      if (!anyActive) return;
      let still = false, changed = false;
      for (let i = 0; i < max; i++) {
        const o = i * 16;
        if (D[o + 15] === 0) continue;
        const age = t - D[o + 6], life = D[o + 7];
        if (age >= life) { D[o + 15] = 0; mesh.setMatrixAt(i, zero); changed = true; continue; }
        still = true; changed = true;
        if (age < 0) { mesh.setMatrixAt(i, zero); continue; }
        evalChip(o, age);
        const sz = D[o + 8] * (1 - Math.max(0, Math.min(1, (age - (life - 0.3)) / 0.3)));
        _p.set(OUT[0], OUT[1] + sz * 0.3, OUT[2]);
        _a.set(D[o + 11], D[o + 12], D[o + 13]);
        _q.setFromAxisAngle(_a, D[o + 14] * OUT[3]);
        _s.set(sz, sz, sz);
        _m.compose(_p, _q, _s);
        mesh.setMatrixAt(i, _m);
      }
      if (changed) mesh.instanceMatrix.needsUpdate = true;
      anyActive = still;
    },
    clear() { for (let i = 0; i < max; i++) { D[i * 16 + 15] = 0; mesh.setMatrixAt(i, zero); } mesh.instanceMatrix.needsUpdate = true; anyActive = false; },
  };
}

// ------------------------------------------------------------------------------------------------------------------------------
export function createVfx(game, opts = {}) {
  const render = game.render;
  if (!render) throw new Error('createVfx: game.render is missing (create the renderer first)');
  const params = game.params;
  const clock = { t: 0, frame: 0, explicit: !!opts.explicitClock };
  const lights = new LightPool(render.scene);
  const sceneL = { sun: null, fill: null, ambient: null, scan: 0 };
  const shared = {
    game, render, THREE, clock, lights,
    rng: mulberry32(opts.seed ?? 0x5eed),          // VFX randomness: never game.rng, so gameplay runs repeat with VFX on or off
    now: () => game.time,                           // sim time at the moment an effect is spawned
    P: (k) => params.get(k),
    bindParams: (prefix, schema, presets, def, P, onChange) => bindParams(params, prefix, schema, presets, def, P, onChange),
    // the level's key light (first DirectionalLight), fill (HemisphereLight) or ambient; rescanned every 30 frames until found
    sceneLights() {
      if ((!sceneL.sun || !sceneL.fill) && sceneL.scan-- <= 0) {
        sceneL.scan = 30;
        render.scene.traverse((o) => {
          if (o.isDirectionalLight && !sceneL.sun) sceneL.sun = o;
          else if (o.isHemisphereLight && !sceneL.fill) sceneL.fill = o;
          else if (o.isAmbientLight && !sceneL.ambient) sceneL.ambient = o;
        });
      }
      return sceneL;
    },
    // ground height under (x, z) for debris; game.world.groundAt when present, else `fallback`
    groundAt(x, z, fromY, fallback) {
      const w = game.world;
      if (w && typeof w.groundAt === 'function') { const y = w.groundAt(x, z, fromY); if (Number.isFinite(y)) return y; }
      return fallback;
    },
  };
  // shared look values of the smoke pool (scene-lit puffs of the impacts and the explosion)
  params.define('vfx.smoke.bright', 1.6, { min: 0, max: 6, step: 0.01, label: 'Smoke brightness (response to the scene light)' });   // [ASSUMED] matched by eye to the tracer mist's 2.4 at half its albedo
  params.define('vfx.smoke.aniso', 0.3, { min: 0, max: 0.9, step: 0.01, label: 'Smoke forward scattering' });                     // [ASSUMED]
  params.define('vfx.on', true, { label: 'Effects on' });

  shared.particles = createParticles(shared);       // its pass first: smoke and sparks under the tracer and the flash
  shared.decals = createDecals(shared);
  shared.debris = createDebris(shared);
  const tracer = createTracer(game, shared);
  const muzzle = createMuzzle(game, shared);
  const impact = createImpact(game, shared);
  const explosion = createExplosion(game, shared);

  // Spawn queue: impacts and explosions requested during a sim step are spawned at the next drawn frame (live: their clock
  // starts on that frame, so `delay` lines up with the tracer's own visible clock; explicit: at the request time).
  const QN = 64;
  const Q = new Float64Array(QN * 12);              // kind px py pz nx ny nz a b c reqTime -
  const QM = new Array(QN).fill(null);              // material names
  let qn = 0;
  const KIND_IMPACT = 1, KIND_EXPLOSION = 2;
  function enqueue(kind, p, n, a, b, c, mat) {
    if (qn >= QN) return false;
    const o = qn * 12;
    Q[o] = kind; Q[o + 1] = p.x; Q[o + 2] = p.y; Q[o + 3] = p.z;
    Q[o + 4] = n ? n.x : 0; Q[o + 5] = n ? n.y : 1; Q[o + 6] = n ? n.z : 0;
    Q[o + 7] = a; Q[o + 8] = b; Q[o + 9] = c; Q[o + 10] = game.time;
    QM[qn] = mat || null;
    qn++;
    return true;
  }
  function flushQueue(t) {
    for (let i = 0; i < qn; i++) {
      const o = i * 12;
      const base = clock.explicit ? Q[o + 10] : t;
      if (Q[o] === KIND_IMPACT) {
        const firstAge = clock.explicit ? 0 : tracer.firstAge();
        impact.spawn(Q[o + 1], Q[o + 2], Q[o + 3], Q[o + 4], Q[o + 5], Q[o + 6], QM[i], base + Q[o + 7] - firstAge, Q[o + 8]);
      } else if (Q[o] === KIND_EXPLOSION) {
        explosion.spawn(Q[o + 1], Q[o + 2], Q[o + 3], Q[o + 7], Q[o + 8], clock.explicit ? base : base - params.get('vfx.explosion.firstAge') * 0.001);
      }
      QM[i] = null;
    }
    qn = 0;
  }

  const _to = new THREE.Vector3(), _dir = new THREE.Vector3();
  const materialOf = (hit) => {
    if (hit.actor) return 'character';
    const c = hit.collider;
    if (c) {
      if (typeof c.material === 'string') return c.material;
      if (c.material && typeof c.material.name === 'string' && c.material.name) return c.material.name;
      if (c.tags && typeof c.tags.has === 'function') for (const m of ['metal', 'wood', 'dirt', 'stone']) if (c.tags.has(m)) return m;
    }
    return 'stone';
  };
  const muzzleTarget = { pos: null, dir: null, obj: null };
  const flashOpts = { scale: 1 };

  const vfx = {
    shared, tracerFx: tracer, muzzleFx: muzzle, impactFx: impact, explosionFx: explosion,
    get clock() { return clock; },

    muzzleFlash(target, o) { if (!params.get('vfx.on')) return; muzzle.fire(target, o); },
    tracer(from, to, o) { if (!params.get('vfx.on')) return; tracer.fire(from, to, o); },
    impact(point, normal, material = 'stone', o) {
      if (!params.get('vfx.on')) return;
      enqueue(KIND_IMPACT, point, normal, o && o.delay > 0 ? o.delay : 0, o && o.scale > 0 ? o.scale : 1, 0, material);
    },
    explosion(pos, o) {
      if (!params.get('vfx.on')) return;
      enqueue(KIND_EXPLOSION, pos, null, o && o.radius > 0 ? o.radius : params.get('vfx.explosion.radius'), o && o.scale > 0 ? o.scale : 1, 0, null);
    },

    // The 'shot' hook: payload per refs/design.md. The flash follows the shooter's live 'muzzle' socket when the rig has one.
    onShot(p) {
      if (!params.get('vfx.on') || !p) return;
      const m = p.muzzle;
      let sock = null;
      const rig = p.shooter && p.shooter.rig;
      if (rig && typeof rig.socket === 'function') { try { sock = rig.socket('muzzle') || null; } catch (e) { sock = null; } }
      flashOpts.scale = p.weapon && typeof p.weapon === 'object' && p.weapon.muzzleScale > 0 ? p.weapon.muzzleScale : 1;
      if (m && m.pos && m.dir) {
        muzzleTarget.pos = m.pos; muzzleTarget.dir = m.dir; muzzleTarget.obj = sock;
        muzzle.fire(muzzleTarget, flashOpts);
      } else if (sock) muzzle.fire(sock, flashOpts);
      const from = m && m.pos ? m.pos : p.origin;
      if (!from) return;
      const hit = p.hit;
      if (hit && hit.point) {
        tracer.fire(from, hit.point, { hit: true, normal: hit.normal });
        const dist = from.distanceTo(hit.point);
        vfx.impact(hit.point, hit.normal || _dir.copy(from).sub(hit.point).normalize(), materialOf(hit), { delay: dist / tracer.speed() });
      } else {
        const d = p.dir || (m && m.dir);
        if (!d) return;
        _to.copy(d).normalize().multiplyScalar(tracer.maxRange()).add(from);
        tracer.fire(from, _to, { hit: false });
      }
    },
    onExplode(p) {
      if (!p || !p.pos) return;
      vfx.explosion(p.pos, { radius: p.radius });
      game.events.emit('camshake', { pos: p.pos, strength: params.get('vfx.explosion.shake') * Math.max(p.radius || 5, 0.5) / 5 });
    },

    // one drawn frame: the VFX clock, retire, place everything, assign the light pool
    frame() {
      const acc = Math.min(Math.max(game._acc || 0, 0), game.dt);
      const t = game.time + acc;
      clock.t = t;
      const cam = render.camera;
      cam.updateMatrixWorld();
      flushQueue(t);
      lights.begin(cam);
      tracer.update(t); muzzle.update(t);
      tracer.render(t, clock.frame);
      muzzle.render(t, clock.frame);
      explosion.render(t);
      shared.particles.frame(t);
      shared.decals.frame(t);
      shared.debris.frame(t);
      lights.end();
      clock.frame++;
    },
    clear() {
      shared.particles.clear(); shared.decals.clear(); shared.debris.clear();
      tracer.clear(); muzzle.clear(); explosion.clear(); qn = 0;
    },
    state() {
      return {
        t: clock.t, frame: clock.frame, explicit: clock.explicit,
        lights: lights.lights.map((l) => +l.intensity.toFixed(2)),
        particles: shared.particles.count(clock.t),
        tracer: tracer.state(), muzzle: muzzle.state(), explosion: explosion.state(),
      };
    },
  };

  game.events.on('shot', (p) => vfx.onShot(p));
  game.events.on('grenade:explode', (p) => vfx.onExplode(p));
  game.addSystem({ name: 'vfx', order: 80, frame: () => vfx.frame() });
  game.vfx = vfx;
  return vfx;
}
