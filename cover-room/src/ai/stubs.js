// Stand-ins used ONLY when the real module is missing, so the AI runs on its own (tests/ai.html, partial boots):
//   createStubRig      when no createCharacter exists (character/*). A posable block figure with pelvis/head bones.
//   createStubWeapon   when no createWeapon exists (weapons/*). Emits 'shot' / 'noise' / 'damage' per design.md.
//   createStubGrenades when game.grenades is missing. throwAt / planThrow / live, fuse, blast with falloff.
// Integration swaps them automatically: enemy.js and index.js look for the real exports first.
import * as THREE from 'three';

// ------------------------------------------------------------------------------------------------ rig
export const STUB_HITBOXES = [
  { bone: 'pelvis', a: [0, -0.05, 0], b: [0, 0.5, 0], radius: 0.22, part: 'torso' },
  { bone: 'head', a: [0, -0.04, 0], b: [0, 0.08, 0], radius: 0.12, part: 'head' },
  { bone: 'legs', a: [0, 0.1, 0], b: [0, 0.8, 0], radius: 0.16, part: 'limb' },
];

const _mats = {};
function mat(hex) { return _mats[hex] || (_mats[hex] = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.8 })); }
const _geo = {};
function geo(k, f) { return _geo[k] || (_geo[k] = f()); }

// Original block figure: sand fatigues, dark vest, rifle. Poses from animState: crouch, pop-up, lean, hit, death.
export function createStubRig(game, { seed = 0 } = {}) {
  const root = new THREE.Group(); root.name = 'ai-stub-rig';
  const legs = new THREE.Object3D(); legs.name = 'legs'; root.add(legs);
  const pelvis = new THREE.Object3D(); pelvis.name = 'pelvis'; pelvis.position.y = 0.92; root.add(pelvis);
  const head = new THREE.Object3D(); head.name = 'head'; head.position.y = 0.73; pelvis.add(head);
  const gunPivot = new THREE.Object3D(); gunPivot.position.set(-0.18, 0.42, 0.12); pelvis.add(gunPivot);
  const tone = [0xb59e74, 0xa8946c, 0xbfa77a][seed % 3];
  const add = (parent, g, m, x, y, z) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.castShadow = true; parent.add(o); return o; };
  add(legs, geo('leg', () => new THREE.BoxGeometry(0.16, 0.9, 0.18)), mat(0x6f6450), 0.1, 0.45, 0);
  add(legs, geo('leg', () => new THREE.BoxGeometry(0.16, 0.9, 0.18)), mat(0x6f6450), -0.1, 0.45, 0);
  add(pelvis, geo('torso', () => new THREE.BoxGeometry(0.42, 0.62, 0.26)), mat(tone), 0, 0.3, 0);
  add(pelvis, geo('vest', () => new THREE.BoxGeometry(0.44, 0.36, 0.28)), mat(0x3b3a33), 0, 0.36, 0);
  add(head, geo('head', () => new THREE.BoxGeometry(0.2, 0.24, 0.22)), mat(0xc49a78), 0, 0, 0);
  add(head, geo('cap', () => new THREE.BoxGeometry(0.23, 0.07, 0.27)), mat(0x4a4a3a), 0, 0.13, 0.02);
  add(gunPivot, geo('gun', () => new THREE.BoxGeometry(0.07, 0.09, 0.75)), mat(0x26282b), 0, 0, 0.3);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.02, 0.7); gunPivot.add(muzzle);
  const bones = { pelvis, head, legs };
  const sockets = { muzzle, head, hand_r: gunPivot, hand_l: gunPivot, grenade_hand: head };
  return {
    root, bones, stub: true,
    socket: (n) => sockets[n] || null,
    getBoneWorld: (n, out) => { const b = bones[n]; if (!b) { out.x = NaN; return out; } return b.getWorldPosition(out); },
    update(dt, a) {
      if (!a) return;
      let crouch = 0, lean = 0, tiltX = 0, lie = 0;
      if (a.mode === 'cover') {
        const low = a.cover.height !== 'high';
        if (a.cover.pose === 'idle' || a.cover.pose === 'blind') crouch = low ? 1 : 0;
        if (a.cover.pose === 'lean') lean = a.cover.side || 1;
      } else if (a.mode === 'hitreact') tiltX = -0.35;
      else if (a.mode === 'death') lie = Math.min(1, (a.death.t || 0) / 0.6);
      pelvis.position.y = 0.92 - 0.42 * crouch;
      legs.scale.y = 1 - 0.45 * crouch;
      pelvis.position.x = -0.35 * lean;                     // side +1 = toward root −X
      pelvis.rotation.set(tiltX, 0, 0.25 * lean);
      root.rotation.x = -lie * Math.PI / 2 * 0.98;
      if (a.aim && a.aim.on) gunPivot.rotation.set(-(a.aim.pitch || 0), a.aim.yaw || 0, 0);
      else gunPivot.rotation.set(0.6, 0, 0);
    },
  };
}

// ------------------------------------------------------------------------------------------------ weapon
// The contract's AI path only: fireAt(point), reload(), update(dt), state. Same events as weapons/weapon.js.
export function createStubWeapon(game, owner, kind, P, muzzleFn) {
  const V = game.world.Vector3;
  const state = { kind, mag: P('ai.stub.mag'), reserve: 9999, reloading: false, reloadT: 0, reloadDur: P('ai.stub.reload'), cooldown: 0, lastShotT: -Infinity };
  const M = new V(), D = new V(), end = new V();
  const hitObj = { point: new V(), normal: new V(), dist: 0, collider: null, actor: null, part: null };
  const shotEv = { shooter: owner, weapon: null, origin: new V(), dir: new V(), hit: null, muzzle: { pos: new V(), dir: new V() }, end: new V() };
  const noiseEv = { pos: new V(), radius: 50, kind: 'gunshot', source: owner };
  const dmgEv = { target: null, amount: 0, source: owner, part: 'torso', dir: new V(), kind: 'bullet' };
  const castOpts = { ignore: owner };
  let lastFrame = -1;
  const w = {
    kind, state, stub: true, magSize: P('ai.stub.mag'),
    fireAt(point) {
      if (state.reloading || state.cooldown > 0 || state.mag <= 0) return false;
      if (muzzleFn) muzzleFn(M); else M.set(owner.pos.x, owner.pos.y + 1.45, owner.pos.z);
      D.set(point.x - M.x, point.y - M.y, point.z - M.z);
      const L = Math.hypot(D.x, D.y, D.z);
      if (L < 1e-6) return false;
      D.set(D.x / L, D.y / L, D.z / L);
      const h = game.world.raycast(M, D, 120, castOpts);
      if (h) { hitObj.point.copy(h.point); hitObj.normal.copy(h.normal); hitObj.dist = h.dist; hitObj.collider = h.collider; hitObj.actor = h.actor; hitObj.part = h.part; end.copy(h.point); }
      else end.set(M.x + D.x * 120, M.y + D.y * 120, M.z + D.z * 120);
      shotEv.weapon = w; shotEv.origin.copy(M); shotEv.dir.copy(D); shotEv.hit = h ? hitObj : null;
      shotEv.muzzle.pos.copy(M); shotEv.muzzle.dir.copy(D); shotEv.end.copy(end);
      game.events.emit('shot', shotEv);
      noiseEv.pos.copy(M);
      game.events.emit('noise', noiseEv);
      if (h && h.actor && h.actor.alive !== false) {
        const t = h.actor;
        dmgEv.target = t; dmgEv.amount = P('ai.stub.damage'); dmgEv.part = h.part || 'torso'; dmgEv.dir.copy(D);
        if (typeof t.takeDamage === 'function') t.takeDamage(dmgEv);
        else if (typeof t.health === 'number') t.health = Math.max(0, t.health - dmgEv.amount);
        game.events.emit('damage', dmgEv);
      }
      state.mag--; state.cooldown = 60 / P('ai.burst.autoRpm'); state.lastShotT = game.time;
      return true;
    },
    reload() { if (state.reloading || state.mag >= P('ai.stub.mag')) return false; state.reloading = true; state.reloadT = 0; state.reloadDur = P('ai.stub.reload'); return true; },
    update(dt) {
      if (game.frame === lastFrame) return;
      lastFrame = game.frame;
      state.cooldown = Math.max(0, state.cooldown - dt);
      if (state.reloading) { state.reloadT += dt; if (state.reloadT >= state.reloadDur) { state.reloading = false; state.mag = P('ai.stub.mag'); } }
    },
    setBlind() {},
  };
  return w;
}

// ------------------------------------------------------------------------------------------------ grenades
// throwAt solves a high lob (apex 2.5 m over the higher end), the grenade flies, bounces once on the floor and explodes
// after the fuse. Blast numbers follow player-spec §6 (kill radius 3 m, radius 6 m, 150 max damage) [INFERRED there].
export function createStubGrenades(game, P) {
  const V = game.world.Vector3;
  const pool = [];
  for (let i = 0; i < 4; i++) pool.push({ pos: new V(), vel: new V(), fuseLeft: 0, owner: null, radius: 6, alive: false, id: i });
  const live = [];
  const expl = { pos: new V(), radius: 6, owner: null };
  const throwEv = { owner: null, pos: new V(), vel: new V() };
  const noiseEv = { pos: new V(), radius: 50, kind: 'grenade', source: null };
  const dmgEv = { target: null, amount: 0, source: null, part: 'torso', dir: new V(), kind: 'blast' };
  const tmp = new V(), tmp2 = new V();
  const sweepOpts = { hitActors: false };
  const g = {
    live, stub: true,
    planThrow(owner, target, opts, out = {}) {
      const from = owner.pos;
      const y0 = from.y + 1.7, y1 = target.y + 0.1;
      const apex = Math.max(y0, y1) + 2.5, gr = 9.81;
      const vy = Math.sqrt(2 * gr * (apex - y0));
      const T = vy / gr + Math.sqrt(2 * (apex - y1) / gr);
      out.from = { x: from.x, y: y0, z: from.z };
      out.vel = { x: (target.x - from.x) / T, y: vy, z: (target.z - from.z) / T };
      out.flightT = T; out.clear = true; out.landing = { x: target.x, y: y1, z: target.z };
      return out;
    },
    throwAt(owner, target, opts) {
      const r = pool.find((p) => !p.alive);
      if (!r) return false;
      const pl = g.planThrow(owner, target, opts, {});
      r.pos.set(pl.from.x, pl.from.y, pl.from.z); r.vel.set(pl.vel.x, pl.vel.y, pl.vel.z);
      r.fuseLeft = P('ai.grenade.fuse'); r.owner = owner; r.alive = true;   // fuse from the throw [INFERRED] ai-spec §6
      live.push(r);
      throwEv.owner = owner; throwEv.pos.copy(r.pos); throwEv.vel.copy(r.vel);
      game.events.emit('grenade:throw', throwEv);
      return true;
    },
    update(dt) {
      for (let i = live.length - 1; i >= 0; i--) {
        const r = live[i];
        r.vel.y -= 9.81 * dt;
        tmp.set(r.pos.x + r.vel.x * dt, r.pos.y + r.vel.y * dt, r.pos.z + r.vel.z * dt);
        const h = game.world.sweepSphere(r.pos, tmp, 0.06, sweepOpts);
        if (h) { r.pos.copy(h.center); game.world.bounce(r.vel, h.normal, 0.3, 0.4); }
        else r.pos.copy(tmp);
        r.fuseLeft -= dt;
        if (r.fuseLeft <= 0) { live.splice(i, 1); r.alive = false; g.detonate(r.pos, r.owner); }
      }
    },
    detonate(pos, owner) {
      expl.pos.copy(pos); expl.owner = owner;
      game.events.emit('grenade:explode', expl);
      noiseEv.pos.copy(pos); noiseEv.source = owner;
      game.events.emit('noise', noiseEv);
      for (const a of game.actors) {
        if (a.alive === false) continue;
        const d = Math.hypot(a.pos.x - pos.x, a.pos.y + 0.9 - pos.y, a.pos.z - pos.z);
        if (d > 6) continue;
        tmp2.set(a.pos.x, a.pos.y + 0.9, a.pos.z);
        if (!game.world.lineOfSight(pos, tmp2, sweepOpts)) continue;
        const amt = Math.round(150 * (d <= 3 ? 1 : 1 - (d - 3) / 3));
        dmgEv.target = a; dmgEv.amount = amt; dmgEv.source = owner; dmgEv.dir.set(a.pos.x - pos.x, 0, a.pos.z - pos.z);
        if (typeof a.takeDamage === 'function') a.takeDamage(dmgEv);
        else if (typeof a.health === 'number') a.health = Math.max(0, a.health - amt);
        game.events.emit('damage', dmgEv);
      }
    },
    beginAim() { return false; }, updateAim() {}, release() { return false; }, cancel() {},
  };
  return g;
}
