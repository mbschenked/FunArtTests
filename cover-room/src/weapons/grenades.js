// Grenades (B2): player hold-to-aim with an arc preview, AI throws, projectile physics, fuse, blast.
// Contract: refs/design.md "weapons/*". Numbers: refs/player-spec.md §6, refs/ai-spec.md §6 and §1.3.
//
//   createGrenades(game, {system = true}) -> game.grenades
//   beginAim(owner) -> bool        needs a grenade, a live owner, no reload running. Preview on.
//   updateAim(owner, aimDir?)      once per sim step while held (repeat calls in the same step are ignored). aimDir is the
//                                  aim direction (camera forward / reticle ray); omitted -> game.cameraRig.aimRay, then
//                                  cameraRig yaw/pitch, then the owner's yaw. Solves ONE launch velocity and runs the
//                                  preview with it.
//   release(owner) -> bool         latches that launch position + velocity; the grenade leaves the hand throwReleaseT s
//                                  later with exactly those values (nothing re-solves or scales them after the preview).
//   cancel(owner)                  drop the aim without throwing (cover pressed while aiming, player-spec §6).
//   throwAt(owner, target, {arc: 'high'|'low', requireClear}) -> bool   AI: solve + throw now (the AI owns its bark/anim lead).
//   planThrow(owner, target, {arc}, out?) -> {from, vel, landing, normal, flightT, clear}   AI "clear arc" check, no throw.
//   live -> [{pos, vel, fuseLeft, fuseStarted, owner, radius (blast radius), bodyRadius, predicted (first-contact point),
//             age, rolling, resting, id}]    the AI reads this to flee. Pooled records: don't keep references.
//   preview -> {visible, owner, points (Float32Array xyz), count, landing, normal, center, hit, onWall, flightT,
//               launchPos, launchVel, range}  index.js draws it.
//   isAiming(owner) · stateOf(owner) -> {phase: 'none'|'aiming'|'throwing', t} · lookScale(owner) (look gain while aiming)
//   count(owner) · give(owner, n) · setCount(owner, n)   carry, capped at grenade.maxCarry (AI: infinite by default)
//   detonate(pos, owner)           explosion now (also used by tests and scripted events)
//
// Distance control [ASSUMED, after Max's grenade-arc notes]: the horizontal throw range comes from the aim pitch through an
// eased band (S-curve) between grenade.aim.pitchLow and pitchHigh, mapped to [minRange, maxRange]; the direction is yaw only.
// grenade.aim.distanceFrom = 'reticle' instead takes the range from where the reticle ray hits (player-spec §6 rule).
// The apex follows player-spec §6: 1.5 m + 0.25 x range above the hand.
//
// Integrator: exact for constant gravity at the step nodes (p += v dt - g dt^2/2, v -= g dt), one fixed dt (game.dt) for
// the preview, the AI plan and the live grenade, and the same simStep() function for all three. So the preview's first
// contact IS the live grenade's first contact, and the lob solver lands on its target up to the chord sag (< 1 mm).
import { bounce } from '../core/world.js';
import { ORDER } from '../core/game.js';
import { vecClass, actorPoint, applyDamage, defineWeaponParams, fwdX, fwdZ } from './weapon.js';

const DEG = Math.PI / 180;
const SKIN = 1e-4;          // m, keeps a resting sphere off the surface it touched
const FLOOR_NY = 0.7;       // a contact normal steeper than this counts as floor for rolling
const POOL = 16;            // live grenades at once
const MAX_PREVIEW = 600;    // preview samples (10 s at 60 Hz)

// [key, default, panel opts]; source in the trailing comment.
const PARAMS = [
  ['grenade.maxCarry', 4, { min: 0, max: 10, step: 1 }],                                   // §6 [WIKI] all games
  ['grenade.startCount', 2, { min: 0, max: 10, step: 1 }],                                 // §6 [INFERRED]
  ['grenade.fuseStartsOn', 'contact', { options: ['contact', 'throw'], label: 'fuse starts on' }], // §6 [WIKI, MP]; SP unmeasured
  ['grenade.fuse', 2.0, { min: 0.2, max: 6, step: 0.05, label: 'fuse (s)' }],              // §6 [INFERRED] MP is 3 s; protocol P4
  ['grenade.ai.fuseStartsOn', 'throw', { options: ['contact', 'throw'], label: 'AI fuse starts on' }], // ai-spec §6 [INFERRED]
  ['grenade.ai.fuse', 2.5, { min: 0.2, max: 6, step: 0.05, label: 'AI fuse (s)' }],        // ai-spec §6 [INFERRED]
  ['grenade.ai.infinite', true, { label: 'AI has infinite grenades' }],                    // [ASSUMED] the director rations them
  ['grenade.ai.maxLive', 1, { min: 0, max: 8, step: 1, label: 'AI grenades in flight max' }], // ai-spec §6 [INFERRED]
  ['grenade.ai.lowApexBase', 0.5, { min: 0, max: 5, step: 0.05, label: 'low arc apex (m)' }],   // [ASSUMED]
  ['grenade.ai.lowApexPerM', 0.06, { min: 0, max: 0.5, step: 0.01, label: 'low arc apex / m' }], // [ASSUMED]
  ['grenade.ai.clearTol', 1.0, { min: 0, max: 5, step: 0.05, label: 'clear-arc tolerance (m)' }], // [ASSUMED]
  ['grenade.minRange', 3, { min: 0.5, max: 20, step: 0.5, label: 'min range (m)' }],       // §6 [INFERRED]
  ['grenade.maxRange', 25, { min: 3, max: 60, step: 0.5, label: 'max range (m)' }],        // §6 [INFERRED]
  ['grenade.apexBase', 1.5, { min: 0, max: 10, step: 0.05, label: 'apex above hand (m)' }], // §6 [MEASURED shape F4 (yt-workaround), INFERRED value]
  ['grenade.apexPerM', 0.25, { min: 0, max: 1, step: 0.01, label: 'apex per m of range' }], // §6 [MEASURED shape F4 (yt-workaround), INFERRED value]
  ['grenade.gravity', 9.81, { min: 1, max: 30, step: 0.01 }],                              // §6 [INFERRED]
  ['grenade.radius', 0.06, { min: 0.02, max: 0.3, step: 0.005, label: 'body radius (m)' }], // §6 [INFERRED]
  ['grenade.restitution', 0.35, { min: 0, max: 1, step: 0.01, label: 'restitution (walls only while rollDist > 0)' }],                           // §6 [INFERRED]
  ['grenade.friction', 0.6, { min: 0, max: 1, step: 0.01, label: 'tangent keep / bounce (walls only while rollDist > 0)' }], // §6 [INFERRED] (world.bounce gets 1 - this)
  ['grenade.rollVn', 0.5, { min: 0, max: 3, step: 0.05, label: 'roll below |v_n| (m/s; unused while rollDist > 0)' }], // §6 [INFERRED]
  ['grenade.rollDecel', 3.0, { min: 0, max: 20, step: 0.1, label: 'rolling decel (m/s2)' }], // [ASSUMED]
  // Max 12 Nov: "grenades should roll, but only a 8th of a meter or so". > 0: a floor landing doesn't hop, and its roll
  // speed is capped so it rolls about this far at rollDecel, then rests. 0: the old bounce (restitution) + free roll.
  ['grenade.rollDist', 0.125, { min: 0, max: 3, step: 0.005, label: 'roll after landing (m, 0 = bounce + free roll)' }],
  ['grenade.restSpeed', 0.05, { min: 0, max: 1, step: 0.01, label: 'rest below (m/s)' }],   // [ASSUMED]
  ['grenade.throwReleaseT', 0.25, { min: 0, max: 1, step: 0.01, label: 'release delay (s)' }], // §6 [INFERRED]
  ['grenade.inheritVel', 0.3, { min: 0, max: 1, step: 0.05, label: 'inherit thrower vel' }],   // §6 [INFERRED]; part of the ONE launch velocity, so the preview shows it
  ['grenade.maxLife', 8, { min: 1, max: 30, step: 0.5, label: 'max life (s)' }],           // [ASSUMED] a contact fuse that never touches anything
  ['grenade.landNoise', 12, { min: 0, max: 50, step: 1, label: 'landing noise (m)' }],     // ai-spec §1.3 thrown landing [INFERRED]
  ['grenade.blast.killRadius', 3.0, { min: 0, max: 15, step: 0.1, label: 'full-damage radius (m)' }], // §6 [INFERRED]
  ['grenade.blast.radius', 6.0, { min: 0.5, max: 20, step: 0.1, label: 'blast radius (m)' }],         // §6 [INFERRED]
  ['grenade.blast.maxDamage', 150, { min: 0, max: 500, step: 1, label: 'max damage' }],               // §6 [INFERRED]
  ['grenade.blast.playerDamageScale', 0.6, { min: 0, max: 2, step: 0.05, label: 'damage x to player' }], // §6 [INFERRED]
  ['grenade.blast.noise', 50, { min: 0, max: 100, step: 1, label: 'blast noise (m)' }],               // ai-spec §1.3 [INFERRED]
  ['grenade.aimLookScale', 0.6, { min: 0.1, max: 1, step: 0.05, label: 'look gain while aiming' }],   // §6 [INFERRED] (private reference project 0.6)
  ['grenade.aim.distanceFrom', 'pitch', { options: ['pitch', 'reticle'], label: 'distance from' }],    // [ASSUMED] pitch band (brief)
  ['grenade.aim.pitchLow', -20, { min: -80, max: 40, step: 0.5, label: 'band low (deg) -> min range' }],  // [ASSUMED] Max's arc notes
  ['grenade.aim.pitchHigh', 45, { min: -40, max: 89, step: 0.5, label: 'band high (deg) -> max range' }], // [ASSUMED] Max's arc notes
  ['grenade.aim.ease', 2.0, { min: 1, max: 5, step: 0.05, label: 'band S-curve exponent' }],          // [ASSUMED] Max's arc notes
  ['grenade.aim.smooth', 12, { min: 0, max: 60, step: 0.5, label: 'range smoothing (1/s, 0 = off)' }], // [ASSUMED] Max's arc notes
  ['grenade.hand.right', 0.22, { min: -1, max: 1, step: 0.01, label: 'release point right (m)' }],    // [ASSUMED] no grenade_hand socket
  ['grenade.hand.up', 1.75, { min: 0, max: 2.5, step: 0.01, label: 'release point up (m)' }],         // [ASSUMED]
  ['grenade.hand.fwd', 0.1, { min: -1, max: 1, step: 0.01, label: 'release point fwd (m)' }],         // [ASSUMED]
  ['grenade.preview.maxT', 4, { min: 0.5, max: 10, step: 0.1, label: 'preview horizon (s)' }],        // [ASSUMED]
];

export function defineGrenadeParams(params) {
  if (!params || params.has?.('grenade.maxCarry')) return;
  for (const [k, v, o] of PARAMS) params.define(k, v, o);
}

// ------------------------------------------------------------------------------------------------ pure helpers
// Damage fraction at distance d: 1 inside killR, linear to 0 at R (player-spec §6).
export function blastFalloff(d, killR, R) {
  if (d <= killR) return 1;
  if (d >= R) return 0;
  return 1 - (d - killR) / (R - killR);
}

// S-curve on [0, 1] with exponent k (k = 1 is linear).
export function easeInOut(u, k) {
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  return u < 0.5 ? 0.5 * Math.pow(2 * u, k) : 1 - 0.5 * Math.pow(2 * (1 - u), k);
}
export function easeInOutInv(e, k) {
  e = e < 0 ? 0 : e > 1 ? 1 : e;
  return e < 0.5 ? 0.5 * Math.pow(2 * e, 1 / k) : 1 - 0.5 * Math.pow(2 * (1 - e), 1 / k);
}

// Launch velocity from `from` that passes through `to` (descending) after topping out at height apexY. Writes outVel,
// returns the flight time. apexY is raised to clear both ends if needed.
export function solveLob(from, to, apexY, g, outVel) {
  const top = Math.max(apexY, from.y + 1e-3, to.y + 1e-3);
  const vy = Math.sqrt(2 * g * (top - from.y));
  const T = vy / g + Math.sqrt(2 * (top - to.y) / g);
  outVel.set((to.x - from.x) / T, vy, (to.z - from.z) / T);
  return T;
}

// ------------------------------------------------------------------------------------------------ system
export function createGrenades(game, opts = {}) {
  defineGrenadeParams(game.params);
  defineWeaponParams(game.params);           // weapon.applyDamage / weapon.hud.drive are shared
  const V3 = vecClass(game);
  const P = (k) => game.params.get(k);

  // ---- constants snapshot, refreshed once per step (params are live-tunable)
  const C = { g: 9.81, r: 0.06, rest: 0.35, keep: 0.6, rollVn: 0.5, rollDecel: 3, restSpeed: 0.05, rollDist: 0.125 };
  function snap() {
    C.g = P('grenade.gravity'); C.r = P('grenade.radius'); C.rest = P('grenade.restitution');
    C.keep = P('grenade.friction'); C.rollVn = P('grenade.rollVn'); C.rollDecel = P('grenade.rollDecel');
    C.restSpeed = P('grenade.restSpeed'); C.rollDist = P('grenade.rollDist');
  }

  // ---- bodies
  function makeBody() {
    return {
      pos: new V3(), vel: new V3(), rolling: false, resting: false, contacts: 0, age: 0,
      firstContact: new V3(), firstNormal: new V3(), firstCenter: new V3(), firstContactT: -1, firstCollider: null,
      contactInStep: 0, onContact: null,
    };
  }
  function resetBody(b, pos, vel) {
    b.pos.copy(pos); b.vel.copy(vel);
    b.rolling = false; b.resting = false; b.contacts = 0; b.age = 0; b.firstContactT = -1; b.firstCollider = null;
    b.contactInStep = 0;
  }

  const _to = new V3();
  let sweepOut = null, sweepOpts = null, sweepWorld = null;
  function sweeper() {
    const w = game.world;
    if (w !== sweepWorld) {
      sweepWorld = w;
      sweepOut = w && typeof w.makeHit === 'function' ? w.makeHit() : null;
      sweepOpts = { hitActors: false, out: sweepOut || undefined };
    }
    return w;
  }

  // One fixed step of grenade physics. The ONE integrator for the preview, AI plans and live grenades.
  function simStep(b, dt) {
    if (b.resting) { b.age += dt; return; }
    const world = sweeper();
    let rem = dt;
    for (let it = 0; it < 4 && rem > 1e-9; it++) {
      const g = b.rolling ? 0 : C.g;
      _to.set(b.pos.x + b.vel.x * rem, b.pos.y + b.vel.y * rem - 0.5 * g * rem * rem, b.pos.z + b.vel.z * rem);
      const h = world ? world.sweepSphere(b.pos, _to, C.r, sweepOpts) : null;
      if (!h) { b.pos.copy(_to); b.vel.y -= g * rem; rem = 0; break; }
      const tc = h.t * rem;
      b.pos.copy(h.center).addScaledVector(h.normal, SKIN);
      b.vel.y -= g * tc;
      rem -= tc;
      b.contacts++;
      if (b.contacts === 1) {
        b.firstContact.copy(h.point); b.firstNormal.copy(h.normal); b.firstCenter.copy(h.center);
        b.firstContactT = b.age + (dt - rem); b.firstCollider = h.collider || null;
      }
      b.contactInStep = dt - rem;
      if (b.onContact) b.onContact(b, h);
      const floor = h.normal.y > FLOOR_NY;
      if (floor && C.rollDist > 0) {
        // no hop: drop the normal part, and cap the roll speed so it rolls ~rollDist (v^2 = 2 a d) before resting
        b.vel.addScaledVector(h.normal, -b.vel.dot(h.normal));
        b.vel.y = 0;                                            // box tops are flat (world.js), so rolling is horizontal
        const sp = Math.hypot(b.vel.x, b.vel.z), cap = Math.sqrt(2 * C.rollDecel * C.rollDist);
        if (sp > cap) { const k = cap / sp; b.vel.x *= k; b.vel.z *= k; }
        b.rolling = true;
      } else {
        if (b.vel.dot(h.normal) < 0) bounce(b.vel, h.normal, C.rest, 1 - C.keep);
        if (floor && b.vel.dot(h.normal) < C.rollVn) {
          b.vel.addScaledVector(h.normal, -b.vel.dot(h.normal));   // settle: drop the normal part, roll on
          b.vel.y = 0;
          b.rolling = true;
        }
      }
    }
    b.age += dt;
    if (b.rolling) {
      const top = world ? world.groundAt(b.pos.x, b.pos.z, b.pos.y) : null;
      if (top === null || b.pos.y - C.r - top > 0.01) { b.rolling = false; return; }   // rolled off an edge
      const sp = Math.hypot(b.vel.x, b.vel.z);
      const ns = sp - C.rollDecel * dt;
      if (ns <= C.restSpeed) { b.vel.set(0, 0, 0); b.resting = true; }
      else { const k = ns / sp; b.vel.x *= k; b.vel.z *= k; }
    }
  }

  // Simulate from (pos, vel) until the first contact or maxT. Fills pts (Float32Array, may be null). Returns sample count.
  const _pb = makeBody();
  function predict(pos, vel, maxT, pts) {
    resetBody(_pb, pos, vel);
    const dt = game.dt || 1 / 60;
    const steps = Math.min(Math.ceil(maxT / dt), MAX_PREVIEW - 2);
    let n = 0;
    if (pts) { pts[0] = pos.x; pts[1] = pos.y; pts[2] = pos.z; n = 1; }
    for (let i = 0; i < steps; i++) {
      simStep(_pb, dt);
      if (_pb.contacts > 0) {
        if (pts) { const o = n * 3; pts[o] = _pb.firstCenter.x; pts[o + 1] = _pb.firstCenter.y; pts[o + 2] = _pb.firstCenter.z; n++; }
        break;
      }
      if (pts) { const o = n * 3; pts[o] = _pb.pos.x; pts[o + 1] = _pb.pos.y; pts[o + 2] = _pb.pos.z; n++; }
    }
    return n;
  }

  // ---- live pool
  const pool = [];
  for (let i = 0; i < POOL; i++) {
    const b = makeBody();
    Object.assign(b, {
      active: false, id: 0, owner: null, team: null, fuse: 0, fuseLeft: 0, fuseStarted: false, fuseOnContact: true,
      radius: 0, bodyRadius: 0, predicted: new V3(), hasPrediction: false, thrownAt: 0,
    });
    b.onContact = onLiveContact;
    pool.push(b);
  }
  const live = [];
  let nextId = 1;

  const throwEv = { owner: null, pos: new V3(), vel: new V3() };
  const explodeEv = { pos: new V3(), radius: 0, owner: null };
  const noiseEv = { pos: new V3(), radius: 0, kind: 'grenade', source: null };
  const landEv = { pos: new V3(), radius: 0, kind: 'impact', source: null };
  const dmgEv = { target: null, amount: 0, source: null, part: 'torso', dir: new V3(), kind: 'blast', point: new V3(), weapon: null };

  function onLiveContact(b, h) {
    if (b.contacts === 1) {
      // the part of this step after the contact already counts toward the fuse
      if (b.fuseOnContact && !b.fuseStarted) { b.fuseStarted = true; b.fuseLeft = b.fuse - ((game.dt || 1 / 60) - b.contactInStep); }
      const ln = P('grenade.landNoise');
      if (ln > 0) {
        landEv.pos.copy(h.point); landEv.radius = ln; landEv.source = b.owner;
        game.events.emit('noise', landEv);
      }
    }
  }

  function isEnemyThrower(owner) { return !!owner && owner !== game.player && owner.team !== 'player'; }

  function spawn(owner, pos, vel, predicted) {
    let b = null;
    for (let i = 0; i < POOL; i++) if (!pool[i].active) { b = pool[i]; break; }
    if (!b) return null;
    resetBody(b, pos, vel);
    const ai = isEnemyThrower(owner);
    b.active = true; b.id = nextId++; b.owner = owner; b.team = owner ? owner.team : null;
    b.fuse = P(ai ? 'grenade.ai.fuse' : 'grenade.fuse');
    b.fuseOnContact = P(ai ? 'grenade.ai.fuseStartsOn' : 'grenade.fuseStartsOn') === 'contact';
    b.fuseStarted = !b.fuseOnContact;
    b.fuseLeft = b.fuse;
    b.radius = P('grenade.blast.radius');
    b.bodyRadius = P('grenade.radius');
    b.hasPrediction = !!predicted;
    if (predicted) b.predicted.copy(predicted);
    b.thrownAt = game.time;
    live.push(b);
    throwEv.owner = owner; throwEv.pos.copy(pos); throwEv.vel.copy(vel);
    game.events.emit('grenade:throw', throwEv);
    return b;
  }

  function retire(b) {
    b.active = false;
    const i = live.indexOf(b);
    if (i >= 0) { live[i] = live[live.length - 1]; live.pop(); }
  }

  // ---- explosion
  const _cand = [], _found = [], _seen = new Set(), _tp = new V3(), _hp = new V3(), _bp = new V3();
  function detonate(pos, owner) {
    const R = P('grenade.blast.radius'), killR = P('grenade.blast.killRadius'), maxD = P('grenade.blast.maxDamage');
    explodeEv.pos.copy(pos); explodeEv.radius = R; explodeEv.owner = owner || null;
    game.events.emit('grenade:explode', explodeEv);
    noiseEv.pos.copy(pos); noiseEv.radius = P('grenade.blast.noise'); noiseEv.source = owner || null;
    game.events.emit('noise', noiseEv);

    // candidates: every actor in game.actors, plus hitbox owners the world finds in range
    _cand.length = 0; _seen.clear();
    const actors = game.actors || [];
    for (let i = 0; i < actors.length; i++) { const a = actors[i]; if (a && !_seen.has(a)) { _seen.add(a); _cand.push(a); } }
    const world = game.world;
    if (world && typeof world.overlapSphere === 'function') {
      const found = world.overlapSphere(pos, R, { out: _found });
      for (let i = 0; i < found.length; i++) { const a = found[i]; if (!_seen.has(a)) { _seen.add(a); _cand.push(a); } }
    }
    _bp.copy(pos); _bp.y += 0.1;                        // LOS rays start just above the grenade
    for (let i = 0; i < _cand.length; i++) {
      const a = _cand[i];
      if (!a || a.alive === false || !a.pos) continue;
      const h = a.height || 1.8, r = a.radius || 0.35;
      const lo = a.pos.y + r, hi = a.pos.y + Math.max(r, h - r);
      _tp.set(a.pos.x, Math.min(hi, Math.max(lo, pos.y)), a.pos.z);   // closest point on the body axis
      const d = _tp.distanceTo(pos);
      const f = blastFalloff(d, killR, R);
      if (f <= 0) continue;
      // line of sight from the blast to the body axis point or the head (actors don't block)
      if (world && typeof world.lineOfSight === 'function') {
        _hp.set(a.pos.x, a.pos.y + h - 0.15, a.pos.z);
        if (!world.lineOfSight(_bp, _tp, { hitActors: false }) && !world.lineOfSight(_bp, _hp, { hitActors: false })) continue;
      }
      let amount = maxD * f;
      if (a.team === 'player' || a === game.player) amount *= P('grenade.blast.playerDamageScale');
      amount = Math.round(amount);
      if (amount <= 0) continue;
      dmgEv.target = a; dmgEv.amount = amount; dmgEv.source = owner || null; dmgEv.point.copy(_tp);
      dmgEv.dir.subVectors(_tp, pos); const dl = dmgEv.dir.length(); if (dl > 1e-6) dmgEv.dir.multiplyScalar(1 / dl); else dmgEv.dir.set(0, 1, 0);
      const killed = applyDamage(game, dmgEv);
      if (owner && owner === game.player && a !== owner && game.hud && P('weapon.hud.hitMarker')) game.hud.hitMarker(killed ? 'kill' : 'body');
    }
    // camera shake: vfx/index.js emits 'camshake' on 'grenade:explode' and the camera rig listens, so none here.
  }

  // ---- carry
  const counts = new Map();
  function count(owner) {
    if (isEnemyThrower(owner) && P('grenade.ai.infinite')) return Infinity;
    if (!counts.has(owner)) counts.set(owner, Math.min(P('grenade.startCount'), P('grenade.maxCarry')));
    return counts.get(owner);
  }
  function setCount(owner, n) { counts.set(owner, Math.max(0, Math.min(n, P('grenade.maxCarry')))); return counts.get(owner); }
  function give(owner, n) { const before = count(owner); return setCount(owner, before + n) - before; }
  function take(owner) { if (count(owner) === Infinity) return; counts.set(owner, count(owner) - 1); }

  // ---- launch point
  const _hand = new V3();
  function handPos(owner, out) {
    const sock = owner && owner.rig && typeof owner.rig.socket === 'function' ? owner.rig.socket('grenade_hand') : null;
    if (sock && typeof sock.getWorldPosition === 'function') return sock.getWorldPosition(out);
    return actorPoint(owner, P('grenade.hand.right'), P('grenade.hand.up'), P('grenade.hand.fwd'), out);
  }

  // Range (m) for an aim pitch (rad) through the eased band, and its inverse (for scripted aiming).
  function bandU(pitch) {
    const lo = P('grenade.aim.pitchLow'), hi = P('grenade.aim.pitchHigh');
    return easeInOut((pitch / DEG - lo) / Math.max(1e-6, hi - lo), P('grenade.aim.ease'));
  }
  function rangeForPitch(pitch) {
    const a = P('grenade.minRange'), b = P('grenade.maxRange');
    return a + (b - a) * bandU(pitch);
  }
  function pitchForRange(R) {
    const a = P('grenade.minRange'), b = P('grenade.maxRange');
    const u = easeInOutInv((R - a) / Math.max(1e-6, b - a), P('grenade.aim.ease'));
    const lo = P('grenade.aim.pitchLow'), hi = P('grenade.aim.pitchHigh');
    return (lo + u * (hi - lo)) * DEG;
  }

  // Solve the lob from `from` to the ground point `target` (contact point; the centre aims r above it).
  const _tc = new V3();
  function solveTo(from, target, arc, outVel) {
    const dx = target.x - from.x, dz = target.z - from.z;
    const R = Math.hypot(dx, dz);
    const apexAbove = arc === 'low'
      ? P('grenade.ai.lowApexBase') + P('grenade.ai.lowApexPerM') * R
      : P('grenade.apexBase') + P('grenade.apexPerM') * R;
    _tc.set(target.x, target.y + C.r, target.z);
    const apexY = Math.max(from.y + apexAbove, _tc.y + 0.3);
    return solveLob(from, _tc, apexY, C.g, outVel);
  }

  // ---- player aim
  const preview = {
    visible: false, owner: null, points: new Float32Array(MAX_PREVIEW * 3), count: 0,
    landing: new V3(), normal: new V3(), center: new V3(), hit: false, onWall: false, flightT: 0,
    launchPos: new V3(), launchVel: new V3(), range: 0, target: new V3(), landingAtRelease: new V3(),
  };
  const aims = [];                  // per-owner aim state records (small; no Map iteration in the hot path)
  function aimOf(owner, create) {
    for (let i = 0; i < aims.length; i++) if (aims[i].owner === owner) return aims[i];
    if (!create) return null;
    const st = { owner, phase: 'none', t: 0, u: 0, uInit: false, frame: -1, launchPos: new V3(), launchVel: new V3(),
      releaseLeft: 0, releaseFrame: -1, yaw: 0, pitch: 0, range: 0, predicted: new V3(), view: { phase: 'none', t: 0 } };
    aims.push(st);
    return st;
  }
  function setAimPhase(st, to) {
    if (st.phase === to) return;
    const from = st.phase;
    st.phase = to; st.t = 0;
    game.events.emit('state', { actor: st.owner, sys: 'grenade', from, to, t: game.time });
  }

  function beginAim(owner) {
    if (!owner || owner.alive === false) return false;
    const st = aimOf(owner, true);
    if (st.phase !== 'none') return st.phase === 'aiming';
    if (!(count(owner) > 0)) return false;
    const w = owner.weapon;
    if (w && w.state && w.state.reloading) return false;      // player-spec §6: not while reloading
    st.uInit = false; st.frame = -1;
    setAimPhase(st, 'aiming');
    preview.owner = owner;
    updateAim(owner);
    return true;
  }

  const _ray = { origin: new V3(), dir: new V3() }; _ray.direction = _ray.dir;
  const _d = new V3(), _tgt = new V3(), _v0 = new V3();
  function updateAim(owner, aimDir) {
    const st = aimOf(owner, false);
    if (!st || st.phase !== 'aiming') return false;
    if (st.frame === game.frame) return true;
    const firstThisAim = st.frame === -1;
    st.frame = game.frame;
    snap();

    // aim direction -> yaw (horizontal) and pitch
    const rig = game.cameraRig;
    let haveRay = false;
    if (aimDir) _d.copy(aimDir);
    else if (rig && typeof rig.aimRay === 'function') {
      const r = rig.aimRay(_ray) || _ray;
      _ray.origin.copy(r.origin); _d.copy(r.dir || r.direction); haveRay = true;
    } else if (rig && typeof rig.yaw === 'number') {
      const p = rig.pitch || 0;
      _d.set(Math.sin(rig.yaw) * Math.cos(p), Math.sin(p), Math.cos(rig.yaw) * Math.cos(p));
    } else _d.set(fwdX(owner.yaw || 0), 0, fwdZ(owner.yaw || 0));
    const dl = _d.length() || 1;
    _d.multiplyScalar(1 / dl);
    st.yaw = Math.atan2(_d.x, _d.z);
    st.pitch = Math.asin(Math.max(-1, Math.min(1, _d.y)));

    handPos(owner, _hand);
    let R, ty = null;
    const minR = P('grenade.minRange'), maxR = P('grenade.maxRange');
    if (P('grenade.aim.distanceFrom') === 'reticle' && game.world) {
      if (!haveRay) _ray.origin.copy(_hand);
      const h = game.world.raycast(_ray.origin, _d, 200, { ignore: owner, hitActors: false });
      R = h ? Math.hypot(h.point.x - _hand.x, h.point.z - _hand.z) : maxR;
      if (h) ty = h.point.y;
      R = Math.max(minR, Math.min(maxR, R));
      st.u = (R - minR) / Math.max(1e-6, maxR - minR);
    } else {
      const e = bandU(st.pitch);
      const k = P('grenade.aim.smooth');
      if (!st.uInit || firstThisAim || !(k > 0)) st.u = e;
      else st.u += (e - st.u) * (1 - Math.exp(-k * (game.dt || 1 / 60)));
      R = minR + (maxR - minR) * st.u;
    }
    st.uInit = true;
    st.range = R;

    // target on the ground at range R along the yaw
    const sy = Math.sin(st.yaw), cy = Math.cos(st.yaw);
    const apexAbove = P('grenade.apexBase') + P('grenade.apexPerM') * R;
    const tx = _hand.x + sy * R, tz = _hand.z + cy * R;
    if (ty === null) {
      const gy = game.world ? game.world.groundAt(tx, tz, _hand.y + apexAbove) : null;
      ty = gy !== null ? gy : owner.pos.y;
    }
    _tgt.set(tx, ty, tz);
    solveTo(_hand, _tgt, 'high', _v0);

    // THE launch velocity: solved lob + inherited thrower velocity. The preview and the throw both use exactly this.
    st.launchPos.copy(_hand);
    st.launchVel.copy(_v0);
    const iv = P('grenade.inheritVel');
    if (iv > 0 && owner.vel) st.launchVel.addScaledVector(owner.vel, iv);

    runPreview(st);
    preview.target.copy(_tgt);
    return true;
  }

  function runPreview(st) {
    preview.owner = st.owner;
    preview.launchPos.copy(st.launchPos);
    preview.launchVel.copy(st.launchVel);
    preview.range = st.range;
    preview.count = predict(st.launchPos, st.launchVel, P('grenade.preview.maxT'), preview.points);
    preview.hit = _pb.contacts > 0;
    if (preview.hit) {
      preview.landing.copy(_pb.firstContact); preview.normal.copy(_pb.firstNormal); preview.center.copy(_pb.firstCenter);
      preview.flightT = _pb.firstContactT;
      preview.onWall = _pb.firstNormal.y < FLOOR_NY;
    } else {
      const o = (preview.count - 1) * 3;
      preview.landing.set(preview.points[o], preview.points[o + 1], preview.points[o + 2]);
      preview.normal.set(0, 1, 0); preview.center.copy(preview.landing);
      preview.flightT = P('grenade.preview.maxT'); preview.onWall = false;
    }
    preview.visible = true;
  }

  function release(owner) {
    const st = aimOf(owner, false);
    if (!st || st.phase !== 'aiming') return false;
    if (st.frame === -1) updateAim(owner);                      // never updated: solve once now
    st.releaseLeft = P('grenade.throwReleaseT');
    st.releaseFrame = game.frame;                               // the release step itself doesn't count down
    // The landing ring disappears on the release frame (player-spec §6 [MEASURED, MP]).
    if (preview.owner === owner) preview.visible = false;
    setAimPhase(st, 'throwing');
    preview.landingAtRelease.copy(preview.landing);
    st.predicted.copy(preview.landing);
    if (st.releaseLeft <= 1e-9) finishThrow(st);
    return true;
  }

  function finishThrow(st) {
    if (count(st.owner) > 0) {
      spawn(st.owner, st.launchPos, st.launchVel, st.predicted);
      take(st.owner);
    }
    setAimPhase(st, 'none');
  }

  function cancel(owner) {
    const st = aimOf(owner, false);
    if (!st || st.phase !== 'aiming') return false;
    if (preview.owner === owner) preview.visible = false;
    setAimPhase(st, 'none');
    return true;
  }

  // ---- AI
  const _plan = { from: new V3(), vel: new V3(), landing: new V3(), normal: new V3(), flightT: 0, clear: false, hit: false };
  function planThrow(owner, target, o = {}, out = null) {
    snap();
    const p = out || _plan;
    if (!p.from) Object.assign(p, { from: new V3(), vel: new V3(), landing: new V3(), normal: new V3() });
    handPos(owner, p.from);
    solveTo(p.from, target, o.arc === 'low' ? 'low' : 'high', p.vel);
    predict(p.from, p.vel, P('grenade.preview.maxT') + 2, null);
    p.hit = _pb.contacts > 0;
    if (p.hit) { p.landing.copy(_pb.firstContact); p.normal.copy(_pb.firstNormal); p.flightT = _pb.firstContactT; }
    else { p.landing.copy(_pb.pos); p.normal.set(0, 1, 0); p.flightT = _pb.age; }
    p.clear = p.hit && Math.hypot(p.landing.x - target.x, p.landing.z - target.z) <= P('grenade.ai.clearTol')
      && Math.abs(p.landing.y - target.y) <= P('grenade.ai.clearTol');
    return p;
  }

  function throwAt(owner, target, o = {}) {
    if (!owner || owner.alive === false || !target) return false;
    if (!(count(owner) > 0)) return false;
    if (isEnemyThrower(owner)) {
      let n = 0;
      for (let i = 0; i < live.length; i++) if (isEnemyThrower(live[i].owner)) n++;
      if (n >= P('grenade.ai.maxLive')) return false;
    }
    const p = planThrow(owner, target, o);
    if (o.requireClear && !p.clear) return false;
    if (!spawn(owner, p.from, p.vel, p.landing)) return false;
    take(owner);
    return true;
  }

  // ---- queries
  function isAiming(owner) { const st = aimOf(owner, false); return !!st && st.phase === 'aiming'; }
  function stateOf(owner) {
    const st = aimOf(owner, false);
    if (!st) return { phase: 'none', t: 0 };
    st.view.phase = st.phase; st.view.t = st.t;
    return st.view;
  }
  function lookScale(owner) { return isAiming(owner) ? P('grenade.aimLookScale') : 1; }

  // ---- step
  let lastFrame = -1, hudCount = -1;
  function update(dt) {
    if (game.frame === lastFrame) return;
    lastFrame = game.frame;
    snap();
    for (let i = 0; i < aims.length; i++) {
      const st = aims[i];
      st.t += dt;
      if (st.phase === 'throwing') {
        if (st.releaseFrame !== game.frame) st.releaseLeft -= dt;
        if (st.releaseLeft <= 1e-9) finishThrow(st);
      } else if (st.phase === 'aiming' && st.owner.alive === false) cancel(st.owner);
    }
    for (let i = live.length - 1; i >= 0; i--) {
      const b = live[i];
      const started = b.fuseStarted;
      simStep(b, dt);
      if (b.fuseStarted && started) b.fuseLeft -= dt;
      if ((b.fuseStarted && b.fuseLeft <= 1e-9) || b.age >= P('grenade.maxLife')) {
        _xp.copy(b.pos);
        const owner = b.owner;
        retire(b);
        detonate(_xp, owner);
      }
    }
    const pl = game.player;
    if (pl && game.hud && typeof game.hud.setGrenades === 'function' && P('weapon.hud.drive') !== false) {
      const n = count(pl);
      if (n !== hudCount) { hudCount = n; game.hud.setGrenades(n); }
    }
  }
  const _xp = new V3();

  const api = {
    live, preview,
    beginAim, updateAim, release, cancel, throwAt, planThrow,
    isAiming, stateOf, lookScale, count, give, setCount, detonate,
    rangeForPitch, pitchForRange, handPos, simStep, predict, update,
    get params() { return C; },
  };
  game.grenades = api;
  if (opts.system !== false && typeof game.addSystem === 'function') {
    game.addSystem({ name: 'grenades', order: ORDER.projectiles, update: (dt) => update(dt) });
  }
  return api;
}
