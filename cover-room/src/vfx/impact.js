// Bullet impacts (original). Built from the shared VFX pieces (index.js): GPU smoke / fire particles, lit debris chips and
// lit decals, so an impact costs no draw call of its own and nothing is allocated per hit.
//   stone / dirt / wood: a dust puff (a quick dense spray inside a slower, wider cloud, lit by the level's key and fill light),
//     a few stone chips that fly off the surface, bounce on the floor and settle, a short-lived bullet-hole decal; stone also
//     throws a spark or two now and then, with a faint flash.
//   metal: sparks and a faint flash, a small grey puff, a dark hole.
//   character: a small, non-gory puff: a muted dark-maroon-grey cloth burst, no decal, no chips.
// Timing: an impact spawned by a 'shot' starts when the tracer's head arrives (index.js passes the delay), so the dust bursts
// as the streak hits. All numbers are original and [ASSUMED] (picked by eye on tests/vfx.html); every one is a param under
// vfx.impact.* so they can be matched to footage later.
import * as THREE from 'three';

// per-material multipliers on the vfx.impact.* params: dust amount, dust colour (sRGB), chips, spark chance, spark count,
// decal (1 = bullet hole), chip shade
const MATERIALS = {
  stone:  { dust: 1.0, col: null,      chips: 1.0, spark: 1.0, sparks: 1.0, decal: 1, shade: 1.0 },
  dirt:   { dust: 1.4, col: '#8f7a62', chips: 0.6, spark: 0.0, sparks: 0.0, decal: 1, shade: 0.7 },
  wood:   { dust: 0.8, col: '#b59c7c', chips: 1.0, spark: 0.0, sparks: 0.0, decal: 1, shade: 0.9 },
  metal:  { dust: 0.35, col: '#8d8d8f', chips: 0.0, spark: 3.0, sparks: 2.5, decal: 1, shade: 0.6 },
};

export function createImpact(game, shared) {
  const params = game.params;
  const def = (k, v, o) => params.define('vfx.impact.' + k, v, o);
  // [ASSUMED] all: original look, tuned by eye on tests/vfx.html at the shoulder camera (day exposure)
  def('dust.count', 4, { min: 0, max: 12, step: 1, label: 'Dust puffs (count)' });
  def('dust.size', 0.55, { min: 0.05, max: 2, step: 0.01, label: 'Dust puff final diameter (m)' });
  def('dust.speed', 2.2, { min: 0, max: 10, step: 0.05, label: 'Dust puff speed off the surface (m/s)' });
  def('dust.life', 1.2, { min: 0.1, max: 5, step: 0.05, label: 'Dust life (s)' });
  def('dust.opacity', 0.72, { min: 0, max: 1, step: 0.01, label: 'Dust opacity' });
  def('dust.color', '#d2c8b8', { color: true, label: 'Dust colour (stone)' });
  def('spray.count', 3, { min: 0, max: 8, step: 1, label: 'Dense spray puffs (count)' });
  def('spray.speed', 5.5, { min: 0, max: 20, step: 0.1, label: 'Spray speed (m/s)' });
  def('chips.count', 5, { min: 0, max: 16, step: 1, label: 'Stone chips (count)' });
  def('chips.size', 1.6, { min: 0.2, max: 6, step: 0.1, label: 'Chip size (cm)' });
  def('chips.speed', 3.4, { min: 0, max: 12, step: 0.1, label: 'Chip speed (m/s)' });
  def('sparks.chance', 0.4, { min: 0, max: 1, step: 0.01, label: 'Stone: chance of sparks' });
  def('sparks.count', 3, { min: 0, max: 16, step: 1, label: 'Sparks (count)' });
  def('sparks.gain', 9, { min: 0, max: 60, step: 0.5, label: 'Spark intensity (HDR)' });
  def('flash.gain', 2.2, { min: 0, max: 20, step: 0.1, label: 'Hit flash intensity (HDR)' });
  def('flash.size', 7, { min: 1, max: 40, step: 0.5, label: 'Hit flash diameter (cm)' });
  def('decal.size', 9, { min: 2, max: 30, step: 0.5, label: 'Bullet hole diameter (cm)' });
  def('decal.life', 10, { min: 0.5, max: 60, step: 0.5, label: 'Bullet hole life (s)' });
  def('decal.fade', 3, { min: 0.1, max: 20, step: 0.1, label: 'Bullet hole fades over (s)' });
  def('hit.color', '#7a4a42', { color: true, label: 'Character hit puff colour' });
  def('hit.mist', '#b9ada4', { color: true, label: 'Character hit: cloth-dust mist colour' });
  def('hit.size', 0.4, { min: 0.05, max: 1.5, step: 0.01, label: 'Character hit puff diameter (m)' });
  def('hit.life', 0.4, { min: 0.05, max: 2, step: 0.01, label: 'Character hit puff life (s)' });
  def('hit.opacity', 0.8, { min: 0, max: 1, step: 0.01, label: 'Character hit puff opacity' });

  const P = (k) => params.get('vfx.impact.' + k);
  const rnd = shared.rng;
  const S = shared.particles.spec;
  const N = { x: 0, y: 1, z: 0 }, E1 = { x: 1, y: 0, z: 0 }, E2 = { x: 0, y: 0, z: 1 }, DIR = { x: 0, y: 0, z: 0 };
  const _c = new THREE.Color(), _c2 = new THREE.Color();
  const colCache = new Map();
  const linear = (hex, out) => { let c = colCache.get(hex); if (!c) { c = new THREE.Color(hex); colCache.set(hex, c); } out.copy(c); return out; };

  function frame(nx, ny, nz) {
    const l = Math.hypot(nx, ny, nz) || 1;
    N.x = nx / l; N.y = ny / l; N.z = nz / l;
    let ax = 0, ay = 1, az = 0;
    if (Math.abs(N.y) > 0.8) { ax = 1; ay = 0; }
    let x = N.y * az - N.z * ay, y = N.z * ax - N.x * az, z = N.x * ay - N.y * ax;
    const m = Math.hypot(x, y, z) || 1; x /= m; y /= m; z /= m;
    E1.x = x; E1.y = y; E1.z = z;
    E2.x = N.y * z - N.z * y; E2.y = N.z * x - N.x * z; E2.z = N.x * y - N.y * x;
  }
  // random unit direction within `cone` radians of the normal (uniform in angle; tilted toward the cone edge by `bias`)
  function coneDir(cone) {
    const th = cone * Math.sqrt(rnd()), ph = rnd() * Math.PI * 2;
    const st = Math.sin(th), ct = Math.cos(th), cp = Math.cos(ph), sp = Math.sin(ph);
    DIR.x = N.x * ct + (E1.x * cp + E2.x * sp) * st;
    DIR.y = N.y * ct + (E1.y * cp + E2.y * sp) * st;
    DIR.z = N.z * ct + (E1.z * cp + E2.z * sp) * st;
  }
  function baseSpec(px, py, pz, t0) {
    S.px = px; S.py = py; S.pz = pz; S.t0 = t0;
    S.ax = 0; S.ay = 0; S.az = 0; S.heat = 0; S.heatK = 1; S.spin = 0; S.kind = 0; S.streak = 0;
    S.fadeIn = 0.03; S.fadeOut = 0.3; S.erode = 0.6; S.roll = rnd() * 6.2832; S.cell = (rnd() * 16) | 0;
  }

  function dust(px, py, pz, t0, sc, mat, col) {
    const n = Math.round(P('dust.count') * mat.dust), ns = Math.round(P('spray.count') * mat.dust);
    const size = P('dust.size') * sc, life = P('dust.life'), op = P('dust.opacity');
    for (let i = 0; i < n + ns; i++) {
      const spray = i >= n;
      coneDir(spray ? 0.35 : 0.75);
      const sp = (spray ? P('spray.speed') : P('dust.speed')) * (0.6 + 0.8 * rnd()) * Math.sqrt(sc);
      baseSpec(px + N.x * 0.02, py + N.y * 0.02, pz + N.z * 0.02, t0 + (spray ? 0 : 0.008 * i));
      S.vx = DIR.x * sp; S.vy = DIR.y * sp; S.vz = DIR.z * sp;
      S.drag = spray ? 9 : 5.5;
      S.ay = 0.14 * S.drag;                              // drifts up at ~0.14 m/s once it has slowed
      S.d0 = size * (spray ? 0.08 : 0.15); S.d1 = size * (spray ? 0.45 : 0.75 + 0.5 * rnd()); S.grow = spray ? 9 : 4.5;
      S.life = (spray ? 0.35 : 1) * life * (0.75 + 0.5 * rnd());
      const shade = 0.88 + 0.24 * rnd();
      S.cr = col.r * shade; S.cg = col.g * shade; S.cb = col.b * shade;
      S.alpha = op * (spray ? 1.0 : 0.65 + 0.35 * rnd());
      S.spin = (rnd() - 0.5) * 1.2;
      S.fadeOut = spray ? 0.2 : 0.3;
      shared.particles.smoke.emit(S);
    }
  }

  function sparks(px, py, pz, t0, count, gain) {
    for (let i = 0; i < count; i++) {
      coneDir(1.1);
      const sp = 5 + 7 * rnd();
      baseSpec(px + N.x * 0.01, py + N.y * 0.01, pz + N.z * 0.01, t0);
      S.vx = DIR.x * sp; S.vy = DIR.y * sp; S.vz = DIR.z * sp; S.drag = 2.5;
      S.ay = -9.81;
      S.d0 = S.d1 = 0.006; S.grow = 1;
      S.life = 0.07 + 0.13 * rnd();
      S.cr = 1; S.cg = 0.62; S.cb = 0.3; S.alpha = 1;
      S.heat = gain * (0.6 + 0.6 * rnd()); S.heatK = 6;
      S.kind = 2; S.streak = 0.012; S.fadeIn = 0.001; S.fadeOut = 0.5; S.erode = 0;
      shared.particles.fire.emit(S);
    }
  }

  function flash(px, py, pz, t0, gain, size) {
    if (!(gain > 0)) return;
    baseSpec(px + N.x * 0.03, py + N.y * 0.03, pz + N.z * 0.03, t0);
    S.vx = S.vy = S.vz = 0; S.drag = 1;
    S.d0 = S.d1 = size; S.grow = 1;
    S.life = 0.04; S.cr = 1; S.cg = 0.82; S.cb = 0.58; S.alpha = 1;
    S.heat = gain; S.heatK = 0; S.kind = 1; S.fadeIn = 0.001; S.fadeOut = 0; S.erode = 0;
    shared.particles.fire.emit(S);
  }

  function chips(px, py, pz, t0, count, sc, shade) {
    const gy = shared.groundAt(px, pz, py + 0.05, N.y > 0.7 ? py : py - 1.2);   // fallback [ASSUMED]: a floor ~1.2 m below a wall hit
    for (let i = 0; i < count; i++) {
      coneDir(0.95);
      const sp = P('chips.speed') * (0.5 + 0.9 * rnd());
      shared.debris.add(px + N.x * 0.01, py + N.y * 0.01, pz + N.z * 0.01, DIR.x * sp, DIR.y * sp + 0.6, DIR.z * sp,
        t0, 1.1 + 0.6 * rnd(), P('chips.size') * 0.01 * sc * (0.5 + 0.8 * rnd()), Math.min(gy, py), 0.35, 12 + 20 * rnd(),
        shade * (0.85 + 0.3 * rnd()), rnd);
    }
  }

  function characterPuff(px, py, pz, t0, sc) {
    linear(P('hit.color'), _c);
    const size = P('hit.size') * sc, life = P('hit.life'), op = P('hit.opacity');
    for (let i = 0; i < 4; i++) {
      const fine = i === 3;
      coneDir(fine ? 0.9 : 0.6);
      const sp = (fine ? 0.8 : 1.6) * (0.6 + 0.8 * rnd());
      baseSpec(px + N.x * 0.03, py + N.y * 0.03, pz + N.z * 0.03, t0);
      S.vx = DIR.x * sp; S.vy = DIR.y * sp; S.vz = DIR.z * sp; S.drag = 7; S.ay = 0.1 * 7;
      S.d0 = size * 0.15; S.d1 = size * (fine ? 1.3 : 0.7 + 0.4 * rnd()); S.grow = fine ? 5 : 8;
      S.life = life * (fine ? 1.4 : 0.8 + 0.4 * rnd());
      if (fine) linear(P('hit.mist'), _c2); else _c2.copy(_c).multiplyScalar(0.9 + 0.2 * rnd());
      S.cr = _c2.r; S.cg = _c2.g; S.cb = _c2.b;
      S.alpha = op * (fine ? 0.55 : 1);
      S.fadeIn = 0.015; S.fadeOut = 0.15; S.erode = 0.5;
      shared.particles.smoke.emit(S);
    }
  }

  return {
    MATERIALS,
    // world point / normal (m), material name, spawn time t0 (s, VFX clock; may be in the future), size scale
    spawn(px, py, pz, nx, ny, nz, material, t0, sc = 1) {
      frame(nx, ny, nz);
      if (material === 'character' || material === 'flesh') { characterPuff(px, py, pz, t0, sc); return; }
      const mat = MATERIALS[material] || MATERIALS.stone;
      linear(mat.col || P('dust.color'), _c2);
      dust(px, py, pz, t0, sc, mat, _c2);
      const chance = Math.min(P('sparks.chance') * mat.spark, 1);
      if (chance > 0 && rnd() < chance) {
        sparks(px, py, pz, t0, Math.round(P('sparks.count') * mat.sparks * (0.5 + rnd())), P('sparks.gain'));
        flash(px, py, pz, t0, P('flash.gain'), P('flash.size') * 0.01 * sc);
      }
      chips(px, py, pz, t0, Math.round(P('chips.count') * mat.chips * (0.6 + 0.8 * rnd())), sc, mat.shade);
      if (mat.decal) shared.decals.add(px, py, pz, N.x, N.y, N.z, 0, P('decal.size') * 0.01 * sc * (0.8 + 0.4 * rnd()),
        rnd() * 6.2832, t0, P('decal.life'), P('decal.fade'));
    },
  };
}
