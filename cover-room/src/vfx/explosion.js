// Grenade explosion (original; to be refined against footage). Built from the shared VFX pieces (index.js):
//   flash        a round HDR glow for ~4 frames plus three textured hot-core flame puffs (the first frames are white-yellow)
//   fireball     smoke puffs that are born hot (HDR heat, white-yellow -> orange -> dull red as they cool in ~0.4 s) and become
//                the dark base of the smoke: one population, so the fire turns into smoke without a seam
//   smoke column grey puffs launched up over the first 0.4 s, slowed by drag, then rising on buoyancy and drifting with the
//                wind; they spread and erode into wisps and linger ~6 s; the lowest ones carry a little ember glow
//   dust ring    beige dust thrown out along the ground (fast, then braked by drag), expanding and settling for ~2 s
//   debris       lit stone chips in a cone around up, bouncing and settling; hot sparks / embers streaking out
//   scorch       a soot decal on the ground that fades out over the last 6 s of its life
//   light pulse  a pooled point light: a sharp flash (~40 ms) then the fireball's orange glow (~0.6 s)
//   shock ring   a short screen-space distortion ring (render.distortionScene), ~0.18 s
//   camshake     index.js emits 'camshake' {pos, strength} on 'grenade:explode' (the camera module owns the response)
// Every number is a param under vfx.explosion.* [ASSUMED unless noted: picked by eye on tests/vfx.html; no footage measure yet].
import * as THREE from 'three';

const NE = 4;            // simultaneous explosions with a live light / shock ring

export function createExplosion(game, shared) {
  const params = game.params;
  const render = game.render;
  const def = (k, v, o) => params.define('vfx.explosion.' + k, v, o);
  // the visible clock (as the shots'): live, a blast's first drawn frame shows this age, so frame 1 is the flash at its peak
  // In-game pass (11 Nov, headless grenade capture from the player camera): bigger, faster-cooling fireball and a denser,
  // darker smoke column that rises, so the blast reads past the player's body. Was size 1, fireball 14 x 2.3 m cool 11,
  // smoke 28 x 0.6 #615b55 rise 0.75, light 140, dust 0.5, debris 26. [ASSUMED, by eye]
  def('firstAge', 4, { min: 0, max: 16, step: 0.1, label: 'First drawn frame shows age (ms)' });
  def('radius', 5, { min: 0.5, max: 20, step: 0.1, label: 'Default blast radius (m; the grenade event sends its own)' });
  def('size', 1.25, { min: 0.2, max: 3, step: 0.01, label: 'Visual size (x)' });
  def('shake', 1, { min: 0, max: 4, step: 0.01, label: 'Camera shake strength at the default radius' });
  def('flash.gain', 10, { min: 0, max: 200, step: 0.5, label: 'Flash intensity (HDR)' });
  def('flash.size', 2.4, { min: 0.5, max: 15, step: 0.1, label: 'Flash diameter (m)' });
  def('flash.ms', 70, { min: 10, max: 300, step: 1, label: 'Flash life (ms)' });
  def('core.heat', 30, { min: 0, max: 200, step: 0.5, label: 'Hot core flame heat (HDR)' });
  def('light.peak', 100, { min: 0, max: 5000, step: 5, label: 'Light: flash peak (candela)' });        // [ASSUMED] ~7 radiance on the floor 1.6 m below for a frame
  def('light.glow', 45, { min: 0, max: 2000, step: 1, label: 'Light: fireball glow (candela)' });
  def('light.ms', 650, { min: 50, max: 3000, step: 10, label: 'Light: glow gone by (ms)' });
  def('light.height', 1.6, { min: 0.3, max: 5, step: 0.05, label: 'Light height above the blast (m)' });
  def('light.reach', 16, { min: 1, max: 60, step: 0.5, label: 'Light reach (m)' });
  def('light.color', '#ffb064', { color: true, label: 'Light colour (glow)' });
  def('fireball.count', 20, { min: 0, max: 40, step: 1, label: 'Fireball puffs (count)' });
  def('fireball.size', 2.9, { min: 0.2, max: 8, step: 0.05, label: 'Fireball puff final diameter (m)' });
  def('fireball.speed', 6.5, { min: 0, max: 30, step: 0.1, label: 'Fireball expansion speed (m/s)' });
  def('fireball.heat', 32, { min: 0, max: 120, step: 0.5, label: 'Fireball heat at birth (HDR)' });
  def('fireball.cool', 14, { min: 0.5, max: 30, step: 0.1, label: 'Fireball cooling rate (1/s)' });
  def('smoke.count', 34, { min: 0, max: 60, step: 1, label: 'Smoke column puffs (count)' });
  def('smoke.size', 3.8, { min: 0.3, max: 12, step: 0.05, label: 'Smoke puff final diameter (m)' });
  def('smoke.life', 6.5, { min: 0.5, max: 20, step: 0.1, label: 'Smoke life (s)' });
  def('smoke.rise', 1.15, { min: 0, max: 6, step: 0.05, label: 'Smoke rise speed (m/s, after launch)' });
  def('smoke.launch', 5.2, { min: 0, max: 20, step: 0.1, label: 'Smoke launch speed (m/s)' });
  def('smoke.opacity', 0.78, { min: 0, max: 1, step: 0.01, label: 'Smoke opacity' });
  def('smoke.color', '#453f3a', { color: true, label: 'Smoke colour' });
  def('dust.count', 16, { min: 0, max: 48, step: 1, label: 'Ground dust ring puffs (count)' });
  def('dust.size', 2.6, { min: 0.2, max: 8, step: 0.05, label: 'Dust puff final diameter (m)' });
  def('dust.speed', 11, { min: 0, max: 40, step: 0.1, label: 'Dust ring speed (m/s)' });
  def('dust.life', 3.2, { min: 0.2, max: 10, step: 0.05, label: 'Dust life (s)' });
  def('dust.opacity', 0.62, { min: 0, max: 1, step: 0.01, label: 'Dust opacity' });
  def('dust.color', '#ab9e8a', { color: true, label: 'Dust colour' });
  def('debris.count', 40, { min: 0, max: 64, step: 1, label: 'Debris chips (count)' });
  def('debris.speed', 9, { min: 0, max: 30, step: 0.1, label: 'Debris speed (m/s)' });
  def('sparks.count', 28, { min: 0, max: 96, step: 1, label: 'Sparks / embers (count)' });
  def('sparks.speed', 14, { min: 0, max: 40, step: 0.1, label: 'Spark speed (m/s)' });
  def('sparks.gain', 14, { min: 0, max: 80, step: 0.5, label: 'Spark intensity (HDR)' });
  def('scorch.size', 2.8, { min: 0, max: 10, step: 0.05, label: 'Scorch diameter (m)' });
  def('scorch.life', 25, { min: 1, max: 120, step: 0.5, label: 'Scorch life (s)' });
  def('wind.x', 0.35, { min: -5, max: 5, step: 0.05, label: 'Wind x (m/s)' });
  def('wind.z', 0.1, { min: -5, max: 5, step: 0.05, label: 'Wind z (m/s)' });
  def('shock.amp', 0.012, { min: 0, max: 0.06, step: 0.001, label: 'Shock ring distortion (UV)' });
  def('shock.radius', 4, { min: 0.5, max: 15, step: 0.1, label: 'Shock ring radius (m)' });
  def('shock.ms', 180, { min: 20, max: 1000, step: 5, label: 'Shock ring life (ms)' });

  const P = (k) => params.get('vfx.explosion.' + k);
  const rnd = shared.rng;
  const S = shared.particles.spec;
  const _c = new THREE.Color(), _cl = new THREE.Color(), _flashC = new THREE.Color(1, 0.93, 0.8);

  // live explosions (for the light pulse and the shock ring): x y z t0 scale groundY
  const EX = new Float64Array(NE * 6).fill(-1e9);
  let head = 0;

  // shock ring meshes: camera-facing quads in the distortion scene. Uniforms: uCenter (world m), uRadius (m), uAmp (UV units),
  // uWidth (ring width as a fraction of the radius), uAspect (drawing buffer w / h, keeps the ring round in pixels).
  const shockGeo = new THREE.PlaneGeometry(2, 2);
  const shocks = [];
  for (let i = 0; i < NE; i++) {
    const m = new THREE.Mesh(shockGeo, new THREE.ShaderMaterial({
      ...render.distortionMaterialParams,
      uniforms: { uCenter: { value: new THREE.Vector3() }, uRadius: { value: 1 }, uAmp: { value: 0 }, uWidth: { value: 0.18 }, uAspect: { value: 1.78 } },
      vertexShader: /* glsl */`
        uniform vec3 uCenter;
        uniform float uRadius;
        varying vec2 vQ;
        void main() {
          vec4 mv = viewMatrix * vec4(uCenter, 1.0);
          mv.xy += position.xy * uRadius;
          vQ = position.xy;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uAmp;
        uniform float uWidth;
        uniform float uAspect;
        varying vec2 vQ;
        void main() {
          float r = length(vQ);
          float x = (r - 0.75) / uWidth;
          float ring = exp(-x * x) * (1.0 - smoothstep(0.92, 1.0, r));
          vec2 dir = r > 1e-4 ? vQ / r : vec2(0.0);
          // content appears pushed outward: the lookup moves inward
          gl_FragColor = vec4(-dir * vec2(1.0 / uAspect, 1.0) * ring * uAmp, 0.0, 1.0);
        }`,
    }));
    m.frustumCulled = false;
    m.visible = false;
    m.name = 'vfxShockRing' + i;
    render.distortionScene.add(m);
    shocks.push(m);
  }

  function randUnit(out) {
    const z = rnd() * 2 - 1, a = rnd() * 6.2832, s = Math.sqrt(1 - z * z);
    out.x = s * Math.cos(a); out.y = z; out.z = s * Math.sin(a);
  }
  const U = { x: 0, y: 0, z: 0 };
  function baseSpec(px, py, pz, t0) {
    S.px = px; S.py = py; S.pz = pz; S.t0 = t0;
    S.ax = 0; S.ay = 0; S.az = 0; S.heat = 0; S.heatK = 1; S.spin = (rnd() - 0.5) * 0.8; S.kind = 0; S.streak = 0;
    S.fadeIn = 0.03; S.fadeOut = 0.4; S.erode = 0.6; S.roll = rnd() * 6.2832; S.cell = (rnd() * 16) | 0;
  }

  function spawn(x, y, z, radius, scale, t0) {
    const s = P('size') * scale * Math.sqrt(Math.min(Math.max(radius / P('radius'), 0.25), 4));
    const gy = shared.groundAt(x, z, y + 0.5, y);
    const wx = P('wind.x'), wz = P('wind.z');
    const i = head; head = (head + 1) % NE;
    EX[i * 6] = x; EX[i * 6 + 1] = y; EX[i * 6 + 2] = z; EX[i * 6 + 3] = t0; EX[i * 6 + 4] = s; EX[i * 6 + 5] = gy;

    // flash: a round glow, then three textured hot-core puffs (white-yellow for the first frames)
    baseSpec(x, y + 0.6 * s, z, t0);
    S.vx = S.vy = S.vz = 0; S.drag = 1;
    S.d0 = P('flash.size') * 0.55 * s; S.d1 = P('flash.size') * s; S.grow = 40;
    S.life = P('flash.ms') * 0.001; S.cr = _flashC.r; S.cg = _flashC.g; S.cb = _flashC.b; S.alpha = 1;
    S.heat = P('flash.gain'); S.heatK = 0; S.kind = 1; S.fadeIn = 0.001; S.fadeOut = 0.2; S.erode = 0;
    shared.particles.fire.emit(S);
    for (let k = 0; k < 3; k++) {
      randUnit(U);
      baseSpec(x + U.x * 0.25 * s, y + (0.45 + 0.2 * k) * s, z + U.z * 0.25 * s, t0);
      S.vx = U.x * 2 * s; S.vy = (1.5 + Math.abs(U.y)) * s; S.vz = U.z * 2 * s; S.drag = 8;
      S.d0 = 1.0 * s; S.d1 = 2.0 * s; S.grow = 14;
      S.life = 0.12 + 0.05 * k; S.cr = S.cg = S.cb = 1; S.alpha = 1;
      S.heat = P('core.heat') * (1 - 0.2 * k); S.heatK = 9; S.kind = 0; S.fadeIn = 0.001; S.fadeOut = 0.35; S.erode = 0.5;
      shared.particles.fire.emit(S);
    }

    // fireball: hot smoke puffs, expanding fast then braked, cooling into the dark base of the smoke
    linear('#3b3631', _c);
    const nf = P('fireball.count') | 0;
    for (let k = 0; k < nf; k++) {
      randUnit(U);
      U.y = Math.abs(U.y) * 0.8 + 0.2;
      const l = Math.hypot(U.x, U.y, U.z); U.x /= l; U.y /= l; U.z /= l;
      const sp = P('fireball.speed') * s * (0.45 + 0.55 * rnd());
      baseSpec(x + U.x * 0.15 * s, y + 0.35 * s + U.y * 0.15 * s, z + U.z * 0.15 * s, t0 + 0.012 * rnd());
      S.vx = U.x * sp; S.vy = U.y * sp; S.vz = U.z * sp; S.drag = 6;
      S.ax = wx * 6; S.ay = 1.5 * 6; S.az = wz * 6;                  // then rises at ~1.5 m/s with the wind
      S.d0 = 0.5 * s; S.d1 = P('fireball.size') * s * (0.7 + 0.45 * rnd()); S.grow = 6;
      S.life = 1.8 + 0.9 * rnd();
      const sh = 0.85 + 0.3 * rnd();
      S.cr = _c.r * sh; S.cg = _c.g * sh; S.cb = _c.b * sh; S.alpha = 0.92;
      S.heat = P('fireball.heat') * (0.6 + 0.4 * rnd()); S.heatK = P('fireball.cool') * (0.8 + 0.4 * rnd());
      S.fadeIn = 0.012; S.fadeOut = 0.45; S.erode = 0.55;
      shared.particles.smoke.emit(S);
    }

    // smoke column: puffs launched up over the first second at mixed speeds (fast ones make the top, slow late ones the base,
    // so it stands as a column from the ground), then buoyant, drifting with the wind, spreading and eroding into wisps
    linear(P('smoke.color'), _c);
    const ns = P('smoke.count') | 0, life = P('smoke.life'), rise = P('smoke.rise');
    for (let k = 0; k < ns; k++) {
      const f = ns > 1 ? k / (ns - 1) : 0;
      const a = rnd() * 6.2832, rr = 0.55 * s * Math.sqrt(rnd());
      const delay = 0.05 + 0.95 * Math.pow(f, 1.3) + 0.03 * rnd();
      baseSpec(x + Math.cos(a) * rr, y + (0.25 + 0.5 * rnd()) * s, z + Math.sin(a) * rr, t0 + delay);
      const up = P('smoke.launch') * s * (0.2 + 0.8 * rnd()) * (1 - 0.6 * f);
      S.vx = Math.cos(a) * 1.2 * s * rnd(); S.vy = up; S.vz = Math.sin(a) * 1.2 * s * rnd(); S.drag = 1.6;
      S.ax = wx * 1.6; S.ay = rise * (0.35 + 0.65 * rnd()) * 1.6; S.az = wz * 1.6;   // mixed buoyancy: the slow ones keep the base
      S.d0 = 0.9 * s; S.d1 = P('smoke.size') * s * (0.7 + 0.5 * rnd()); S.grow = 0.7;
      S.life = life * (0.75 + 0.55 * rnd());
      const sh = 0.82 + 0.3 * rnd();
      S.cr = _c.r * sh; S.cg = _c.g * sh; S.cb = _c.b * sh; S.alpha = P('smoke.opacity') * (0.7 + 0.3 * rnd());
      S.heat = P('fireball.heat') * 0.12 * Math.exp(-P('fireball.cool') * delay); S.heatK = 7;   // born as hot as the fireball is then
      S.fadeIn = 0.15; S.fadeOut = 0.35; S.erode = 0.7;
      shared.particles.smoke.emit(S);
    }

    // ground dust ring
    linear(P('dust.color'), _c);
    const nd = P('dust.count') | 0;
    for (let k = 0; k < nd; k++) {
      const a = (k + rnd() * 0.8) / Math.max(nd, 1) * 6.2832;
      const ca = Math.cos(a), sa = Math.sin(a);
      baseSpec(x + ca * 0.4 * s, gy + 0.18 * s, z + sa * 0.4 * s, t0 + 0.015 * rnd());
      const sp = P('dust.speed') * s * (0.75 + 0.5 * rnd());
      S.vx = ca * sp; S.vy = 0.5 * s; S.vz = sa * sp; S.drag = 4.2;
      S.ax = wx * 4.2; S.ay = 0.3 * 4.2; S.az = wz * 4.2;
      S.d0 = 0.35 * s; S.d1 = P('dust.size') * s * (0.8 + 0.4 * rnd()); S.grow = 2.2;
      S.life = P('dust.life') * (0.8 + 0.4 * rnd());
      const sh = 0.9 + 0.2 * rnd();
      S.cr = _c.r * sh; S.cg = _c.g * sh; S.cb = _c.b * sh; S.alpha = P('dust.opacity');
      S.fadeIn = 0.04; S.fadeOut = 0.3; S.erode = 0.6;
      shared.particles.smoke.emit(S);
    }

    // debris chips: a cone of ~60 degrees around up
    const nb = P('debris.count') | 0;
    for (let k = 0; k < nb; k++) {
      const th = 1.05 * Math.sqrt(rnd()), ph = rnd() * 6.2832;
      const sp = P('debris.speed') * s * (0.4 + 0.8 * rnd());
      const st = Math.sin(th);
      shared.debris.add(x, y + 0.1, z, Math.cos(ph) * st * sp, Math.cos(th) * sp, Math.sin(ph) * st * sp,
        t0, 2.4 + 1.2 * rnd(), (0.015 + 0.045 * rnd()) * s, gy, 0.3, 10 + 18 * rnd(), 0.7 + 0.4 * rnd(), rnd);
    }

    // sparks / embers
    const nk = P('sparks.count') | 0;
    for (let k = 0; k < nk; k++) {
      randUnit(U);
      U.y = Math.abs(U.y) * 0.9 + 0.1;
      const l = Math.hypot(U.x, U.y, U.z); U.x /= l; U.y /= l; U.z /= l;
      const sp = P('sparks.speed') * s * (0.35 + 0.65 * rnd());
      baseSpec(x, y + 0.3 * s, z, t0 + 0.01 * rnd());
      S.vx = U.x * sp; S.vy = U.y * sp; S.vz = U.z * sp; S.drag = 1.3; S.ay = -9.81;
      S.d0 = S.d1 = 0.012; S.grow = 1;
      S.life = 0.35 + 0.6 * rnd();
      S.cr = 1; S.cg = 0.55; S.cb = 0.22; S.alpha = 1;
      S.heat = P('sparks.gain') * (0.6 + 0.6 * rnd()); S.heatK = 3.5;
      S.kind = 2; S.streak = 0.025; S.fadeIn = 0.001; S.fadeOut = 0.6; S.erode = 0;
      shared.particles.fire.emit(S);
    }

    // scorch on the ground
    if (P('scorch.size') > 0 && y - gy < 1.5) {
      const sl = P('scorch.life');
      shared.decals.add(x, gy, z, 0, 1, 0, 1, P('scorch.size') * s * (0.85 + 0.3 * rnd()), rnd() * 6.2832, t0, sl, Math.min(6, sl * 0.5));
    }
  }

  const colCache = new Map();
  function linear(hex, out) { let c = colCache.get(hex); if (!c) { c = new THREE.Color(hex); colCache.set(hex, c); } return out.copy(c); }

  // per frame: the light pulse and the shock rings of live explosions
  function renderFrame(t) {
    const peak = P('light.peak'), glow = P('light.glow'), lms = P('light.ms') * 0.001, reach = P('light.reach');
    const sms = P('shock.ms') * 0.001, amp = P('shock.amp'), sr = P('shock.radius');
    linear(P('light.color'), _cl);
    const cv = render.renderer.domElement, aspect = cv.width / Math.max(cv.height, 1);
    for (let i = 0; i < NE; i++) {
      const o = i * 6, age = t - EX[o + 3], s = EX[o + 4];
      const m = shocks[i];
      if (age < 0 || age > Math.max(lms, sms) + 0.05) { m.visible = false; continue; }
      // light: a sharp flash (time constant 40 ms) on top of the fireball's glow, which is gone by light.ms
      const f = Math.exp(-age / 0.04);
      const g = Math.exp(-age / (0.35 * lms)) * (1 - smooth(0.6 * lms, lms, age));
      const I = (peak * f + glow * g) * s * s;
      if (I > 0.5) {
        const w = f / (f + g + 1e-6);                            // the flash is near white, the glow orange
        shared.lights.request(EX[o], EX[o + 1] + P('light.height') * s, EX[o + 2], I, reach * s,
          _cl.r + (1 - _cl.r) * w, _cl.g + (0.93 - _cl.g) * w, _cl.b + (0.8 - _cl.b) * w);
      }
      // shock ring
      if (age < sms && amp > 0) {
        const x = age / sms;
        m.visible = true;
        const u = m.material.uniforms;
        u.uCenter.value.set(EX[o], EX[o + 1] + 0.8 * s, EX[o + 2]);
        u.uRadius.value = sr * s * Math.sqrt(x) + 0.05;
        u.uAmp.value = amp * (1 - x) * (1 - x);
        u.uAspect.value = aspect;
      } else m.visible = false;
    }
  }
  function smooth(a, b, x) { const u = Math.min(Math.max((x - a) / (b - a), 0), 1); return u * u * (3 - 2 * u); }

  return {
    spawn,
    render: renderFrame,
    clear() { EX.fill(-1e9); for (const m of shocks) m.visible = false; },
    state() {
      const t = shared.clock.t;
      let live = 0;
      for (let i = 0; i < NE; i++) if (t - EX[i * 6 + 3] >= 0 && t - EX[i * 6 + 3] < P('smoke.life') * 1.2) live++;
      return { live };
    },
  };
}
