// Guns (B2): the player's pistol and the enemies' rifle. Contract: refs/design.md "weapons/*".
//
//   createWeapon(game, owner, kind = 'pistol' | 'rifle', overrides) -> weapon
//     overrides: per-instance values keyed like the param suffix ({magSize: 30, 'aim.bloomMax': 2, ...}); they win over
//       game.params. Two non-param keys: muzzle (an Object3D, or fn(outVec3) -> outVec3) replaces the rig's 'muzzle'
//       socket; register: false keeps the weapon out of game.weapons.list (then call weapon.update(dt) yourself).
//   weapon.setTrigger(down)     player path: semi-auto. A press fires on the next update() if the gate is open; a press
//                               during the cooldown or a reload is buffered for inputBuffer s.
//   weapon.setAim(on|null)      aimed fire (bloom only after the first shot). null (default) = read game.input 'aim' for
//                               the player, false for anyone else.
//   weapon.setBlind(on)         blind fire from cover (wide cone). The default driver sets it in cover without aim.
//   weapon.fireAt(point) -> bool  AI path: one round now if able, aimed exactly at `point` plus the tiny `spread` cone.
//   weapon.reload() -> bool · weapon.cancelReload() (roll/sprint abort: no refill before commit) · weapon.addAmmo(n)
//   weapon.update(dt)           advances timers and fires a pending press. Idempotent per sim step (game.frame), so the
//                               weapons system and an owner may both call it.
//   weapon.currentSpread() -> rad (cone half-angle the next shot would use) · weapon.canFire() -> bool
//   weapon.state = {mag, reserve, total, reloading, cooldown, lastShotT, sinceShot, fireT, phase, bloom (deg),
//                   reloadT, reloadDur, reloadAuto, reloadDuck: {active, hold, down, t}, shots}
//     reloadDuck is the cover controller's hint: when a reload starts while popped up, hold `hold` s, then drop into
//     cover over `down` s (player-spec §4: 4-frame hold, then 0.17 s down). The reload clock already includes it.
//
// Every round emits 'shot' {shooter, weapon, origin, dir, hit, muzzle: {pos, dir}, end, aimPoint, spread, first} and
// 'noise' {pos, radius, kind: 'gunshot'}; a hit on a surface also emits 'noise' kind 'impact'; a hit on an actor
// emits 'damage' (see applyDamage). PAYLOADS ARE POOLED: listeners copy what they keep (events are synchronous).
//
// Hitscan (player-spec §3 rules): the aim ray comes from game.cameraRig.aimRay(out) (through the reticle). It is cast
// from the muzzle's depth along that ray, so geometry between the camera and the player is skipped. The shot then goes
// muzzle -> that aim point; if the line is blocked, the blocker is hit. With zero spread the bullet lands exactly on
// the reticle point (first-shot rule, [DEV G]).
//
// No import of 'three' (node unit tests): vectors are made from the game's Vector3 class (see vecClass).

export const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------------------------ vectors
// Minimal Vector3 for node tests. Only methods that THREE.Vector3 also has are used anywhere in weapons/*.
export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  distanceTo(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
}

// The Vector3 class payloads are built from: game.Vector3, else the camera's (THREE.Vector3 in the browser), else Vec3.
export function vecClass(game) {
  if (game && typeof game.Vector3 === 'function') return game.Vector3;
  const p = game && game.camera && game.camera.position;
  if (p && typeof p.constructor === 'function' && typeof p.addScaledVector === 'function') return p.constructor;
  return Vec3;
}

// Facing from yaw (design.md: yaw 0 faces +Z; +yaw turns left, as three.js rotation.y).
export const fwdX = (yaw) => Math.sin(yaw);
export const fwdZ = (yaw) => Math.cos(yaw);
// Right of a +Z-forward, Y-up character: forward x up = (-cos yaw, 0, sin yaw).
export const rightX = (yaw) => -Math.cos(yaw);
export const rightZ = (yaw) => Math.sin(yaw);

// Point at an offset {right, up, fwd} from the actor's feet, facing its yaw. Writes out.
export function actorPoint(actor, right, up, fwd, out) {
  const y = actor.yaw || 0;
  return out.set(
    actor.pos.x + rightX(y) * right + fwdX(y) * fwd,
    actor.pos.y + up,
    actor.pos.z + rightZ(y) * right + fwdZ(y) * fwd);
}

// ------------------------------------------------------------------------------------------------ params
// [key suffix, default, panel opts, source]. Sources: refs/player-spec.md §5 (pistol), refs/ai-spec.md §5/§7 (rifle).
// [MEASURED] F1 values come from footage fetched with a YouTube download workaround (see player-spec "Footage caveat");
// they stay in use and are marked "F1 (yt-workaround)".
const PISTOL = [
  ['magSize', 12, { min: 1, max: 40, step: 1 }],                       // §5 [MEASURED F1 (yt-workaround) HUD 40->28 over 12 shots] [WIKI Prima]
  ['maxTotal', 60, { min: 1, max: 200, step: 1, label: 'max total (incl. mag)' }], // §5 [MEASURED F1 (yt-workaround) cap 60] [WIKI]
  ['startTotal', 40, { min: 0, max: 200, step: 1, label: 'start total' }],         // §5 [MEASURED low, F1 (yt-workaround) start of fight]
  ['fireInterval', 0.200, { min: 0.05, max: 1, step: 0.005, label: 'fire interval (s)' }], // §5 [MEASURED F1 (yt-workaround) 5 x 12 frames @60]
  ['reloadTime', 0.85, { min: 0.1, max: 3, step: 0.01, label: 'reload, empty (s)' }],      // §5 [MEASURED F1 (yt-workaround) last shot -> bar full]
  ['tacticalReloadTime', 0.85, { min: 0.1, max: 3, step: 0.01, label: 'reload, tactical (s)' }], // §5 [INFERRED] no data; same as empty
  // §5 lists reloadCommitT 0.80 [INFERRED] ("bar fills near the end"), but the [MEASURED] 0.85 is last shot -> bar FULL and
  // the bar fills at the commit, so the commit defaults to 0.85 to honour the measurement. Set 0.80 to follow the table.
  ['reloadCommitT', 0.85, { min: 0, max: 3, step: 0.01, label: 'reload commit (s)' }],
  ['autoReload', true, { label: 'auto reload on empty' }],             // §5 [MEASURED F1 (yt-workaround)]
  ['damage', 28, { min: 1, max: 200, step: 1, label: 'body damage' }], // §5 [MEASURED low] ~4 body shots (ai-spec §7 reuses UC2's 34 [INFERRED])
  ['headMult', 4, { min: 1, max: 10, step: 0.1, label: 'head x' }],    // §5 [INFERRED] one-shot headshot (ai-spec §7 says x3)
  ['limbMult', 0.75, { min: 0.1, max: 2, step: 0.05, label: 'limb x' }], // §5 [INFERRED]
  ['falloffStart', 50, { min: 0, max: 200, step: 1, label: 'falloff start (m)' }], // §5 [DEV G] no falloff to 50 m
  ['falloffEndMult', 1.0, { min: 0, max: 1, step: 0.05, label: 'damage x at max range' }], // [INFERRED] spec gives none past 50 m
  ['maxRange', 80, { min: 5, max: 300, step: 1, label: 'max range (m)' }],      // §5 [INFERRED]
  ['aim.firstShotSpread', 0, { min: 0, max: 5, step: 0.05, label: 'first shot spread (deg)' }], // §5 [DEV G] dead centre
  ['aim.firstShotResetT', 0.35, { min: 0, max: 2, step: 0.01, label: 'first-shot reset (s)' }], // §5 [INFERRED]
  ['aim.base', 0.25, { min: 0, max: 5, step: 0.05, label: 'follow-up base spread (deg)' }],     // §5 rule names aimBase, no value [INFERRED]
  ['aim.bloomPerShot', 0.35, { min: 0, max: 3, step: 0.05, label: 'bloom / shot (deg)' }],      // §5 [INFERRED]
  ['aim.bloomMax', 1.5, { min: 0, max: 10, step: 0.05, label: 'bloom max (deg)' }],             // §5 [INFERRED]
  ['aim.bloomDecay', 4, { min: 0, max: 30, step: 0.1, label: 'bloom decay (deg/s)' }],          // §5 [INFERRED]
  // [ASSUMED] recovery starts this long after a shot. With §5's 0.35 deg/shot and 4 deg/s decay and no delay, bloom would
  // vanish within one 0.200 s interval and never build on rapid fire.
  ['aim.bloomRecoverDelay', 0.22, { min: 0, max: 1, step: 0.01, label: 'bloom recovery delay (s)' }],
  ['hip.spread', 3.5, { min: 0, max: 15, step: 0.1, label: 'hip spread (deg)' }],               // §5 [INFERRED]
  ['hip.movePenalty', 1.5, { min: 0, max: 10, step: 0.1, label: 'hip move penalty (deg)' }],    // §5 [INFERRED]
  ['hip.moveSpeed', 2.5, { min: 0, max: 8, step: 0.1, label: 'running above (m/s)' }],          // [ASSUMED] "when running"
  ['blind.spread', 8, { min: 0, max: 20, step: 0.5, label: 'blind-fire spread (deg)' }],        // §4 cover.blindFire.spreadDeg [INFERRED]
  ['recoil.kickPitch', 0.22, { min: 0, max: 3, step: 0.01, label: 'kick pitch (deg)' }],        // §5 [MEASURED F1 (yt-workaround) phase correlation]
  ['recoil.kickPeakT', 0.05, { min: 0, max: 0.5, step: 0.005, label: 'kick peak (s)' }],        // §5 [MEASURED F1 (yt-workaround)]
  ['recoil.recoverT', 0.10, { min: 0, max: 1, step: 0.005, label: 'kick recover (s)' }],        // §5 [MEASURED F1 (yt-workaround)] no net climb
  ['recoil.yawJitter', 0.05, { min: 0, max: 1, step: 0.01, label: 'kick yaw jitter (deg)' }],   // §5 [INFERRED]
  ['inputBuffer', 0.10, { min: 0, max: 0.5, step: 0.01, label: 'input buffer (s)' }],           // §5 [INFERRED]
  ['noise', 50, { min: 0, max: 100, step: 1, label: 'gunshot noise (m)' }],                     // ai-spec §1.3 [INFERRED] whole room
  ['reloadDuck.hold', 0.067, { min: 0, max: 0.5, step: 0.001, label: 'duck hold (s)' }],        // §4 cover.popAim.emptyHold [MEASURED F1 (yt-workaround)] 4 frames
  ['reloadDuck.down', 0.17, { min: 0, max: 1, step: 0.01, label: 'duck down (s)' }],            // §4 cover.popAim.outTime [MEASURED F1 (yt-workaround)]
  ['spread', 0, { min: 0, max: 5, step: 0.05, label: 'fireAt spread (deg)' }],                 // AI path only; the AI picks hit or miss
  ['muzzleScale', 1.0, { min: 0.2, max: 3, step: 0.05, label: 'muzzle flash scale' }],         // vfx preset is the pistol
];

const RIFLE = [
  ['magSize', 30, { min: 1, max: 100, step: 1 }],                      // ai-spec §5 [INFERRED]
  ['maxTotal', 9999, { min: 1, max: 9999, step: 1, label: 'max total' }], // [ASSUMED] enemies don't run dry
  ['startTotal', 9999, { min: 0, max: 9999, step: 1, label: 'start total' }], // [ASSUMED]
  ['fireInterval', 0.1, { min: 0.03, max: 1, step: 0.005, label: 'fire interval (s)' }], // ai-spec §5 AR 600 rpm [INFERRED]
  ['reloadTime', 2.0, { min: 0.1, max: 5, step: 0.05, label: 'reload (s)' }],           // ai-spec §5 [INFERRED]
  ['tacticalReloadTime', 2.0, { min: 0.1, max: 5, step: 0.05, label: 'reload, tactical (s)' }], // [INFERRED] same
  ['reloadCommitT', 1.8, { min: 0, max: 5, step: 0.05, label: 'reload commit (s)' }],   // [ASSUMED] near the end
  ['autoReload', true, { label: 'auto reload on empty' }],             // [ASSUMED]
  ['damage', 7, { min: 1, max: 100, step: 1, label: 'damage' }],       // player-spec §7 enemy rifle hit on player [INFERRED] (ai-spec §7 says 8-10)
  ['headMult', 1, { min: 1, max: 10, step: 0.1, label: 'head x' }],    // [INFERRED] the player's "luck" has no headshots
  ['limbMult', 1, { min: 0.1, max: 2, step: 0.05, label: 'limb x' }],  // [INFERRED]
  ['falloffStart', 60, { min: 0, max: 200, step: 1, label: 'falloff start (m)' }], // [ASSUMED] the AI's accuracy curve does the falloff
  ['falloffEndMult', 1.0, { min: 0, max: 1, step: 0.05, label: 'damage x at max range' }], // [ASSUMED]
  ['maxRange', 80, { min: 5, max: 300, step: 1, label: 'max range (m)' }],     // [INFERRED] AR curve hits 0% at 60 m (ai-spec §5)
  ['spread', 0.3, { min: 0, max: 5, step: 0.05, label: 'fireAt spread (deg)' }], // [ASSUMED] "tiny"; the AI picks hit or miss
  ['inputBuffer', 0.10, { min: 0, max: 0.5, step: 0.01, label: 'input buffer (s)' }], // [ASSUMED]
  ['noise', 50, { min: 0, max: 100, step: 1, label: 'gunshot noise (m)' }],   // ai-spec §1.3 [INFERRED]
  ['muzzleScale', 1.25, { min: 0.2, max: 3, step: 0.05, label: 'muzzle flash scale' }], // [ASSUMED] read by vfx onShot
  // Player-path keys the rifle needs only if a player ever holds it [ASSUMED]:
  ['aim.firstShotSpread', 0, { min: 0, max: 5, step: 0.05 }], ['aim.firstShotResetT', 0.35, { min: 0, max: 2, step: 0.01 }],
  ['aim.base', 0.3, { min: 0, max: 5, step: 0.05 }], ['aim.bloomRecoverDelay', 0.15, { min: 0, max: 1, step: 0.01 }],
  ['aim.bloomPerShot', 0.25, { min: 0, max: 3, step: 0.05 }], ['aim.bloomMax', 2.0, { min: 0, max: 10, step: 0.05 }],
  ['aim.bloomDecay', 4, { min: 0, max: 30, step: 0.1 }], ['hip.spread', 4, { min: 0, max: 15, step: 0.1 }],
  ['hip.movePenalty', 1.5, { min: 0, max: 10, step: 0.1 }], ['hip.moveSpeed', 2.5, { min: 0, max: 8, step: 0.1 }],
  ['blind.spread', 8, { min: 0, max: 20, step: 0.5 }],
  ['recoil.kickPitch', 0.3, { min: 0, max: 3, step: 0.01 }], ['recoil.kickPeakT', 0.04, { min: 0, max: 0.5, step: 0.005 }],
  ['recoil.recoverT', 0.09, { min: 0, max: 1, step: 0.005 }], ['recoil.yawJitter', 0.08, { min: 0, max: 1, step: 0.01 }],
  ['reloadDuck.hold', 0.067, { min: 0, max: 0.5, step: 0.001 }], ['reloadDuck.down', 0.17, { min: 0, max: 1, step: 0.01 }],
];

const COMMON = [
  ['weapon.applyDamage', true, { label: 'weapons apply damage' }],     // [ASSUMED] see applyDamage
  ['weapon.impactNoise', 4, { min: 0, max: 20, step: 0.5, label: 'impact noise (m)' }], // ai-spec §1.3 [INFERRED]
  ['weapon.hud.drive', true, { label: 'drive HUD ammo + grenades' }],   // [ASSUMED]
  ['weapon.hud.hitMarker', true, { label: 'call hud.hitMarker' }],     // [ASSUMED] turn off if main.js calls hud.wire()
  ['weapon.hud.reticle', true, { label: 'drive HUD reticle' }],         // [ASSUMED] off if the camera/controller owns it
];

export const WEAPON_PARAMS = { pistol: PISTOL, rifle: RIFLE, common: COMMON };

export function defineWeaponParams(params) {
  if (!params || params.has?.('weapon.applyDamage')) return;
  for (const [k, v, o] of COMMON) params.define(k, v, o);
  for (const [kind, list] of [['pistol', PISTOL], ['rifle', RIFLE]]) {
    for (const [k, v, o] of list) params.define(`weapon.${kind}.${k}`, v, o);
  }
}

// ------------------------------------------------------------------------------------------------ damage
// The one place weapons and grenades hurt actors. With weapon.applyDamage on (default):
//   target.takeDamage(payload) exists -> it is called and owns health and death;
//   otherwise target.health -= amount (integer, floored at 0) and, if it reaches 0, alive = false and 'death' is emitted.
// Then 'damage' is emitted (after the health change, so target.alive is already current). Listeners of 'damage' must
// not subtract health again. Returns true if this hit killed the target.
const _deathEv = { actor: null, source: null };
export function applyDamage(game, payload) {
  const t = payload.target;
  const wasAlive = t.alive !== false;
  let emittedDeath = false;
  if (game.params.get('weapon.applyDamage') && wasAlive) {
    if (typeof t.takeDamage === 'function') t.takeDamage(payload);
    else if (typeof t.health === 'number') {
      t.health = Math.max(0, t.health - payload.amount);
      if (t.health <= 0) { t.alive = false; emittedDeath = true; }
    }
  }
  game.events.emit('damage', payload);
  if (emittedDeath) {
    _deathEv.actor = t; _deathEv.source = payload.source;
    game.events.emit('death', _deathEv);
  }
  return wasAlive && t.alive === false;
}

// ------------------------------------------------------------------------------------------------ weapon
export function createWeapon(game, owner, kind = 'pistol', overrides = null) {
  if (kind !== 'pistol' && kind !== 'rifle') throw new Error(`createWeapon: unknown kind '${kind}'`);
  defineWeaponParams(game.params);
  const V3 = vecClass(game);
  const pre = `weapon.${kind}.`;
  const ov = overrides || {};
  const P = (k) => (Object.prototype.hasOwnProperty.call(ov, k) ? ov[k] : game.params.get(pre + k));
  const G = (k) => game.params.get(k);
  const rng = typeof game.rng === 'function' ? game.rng : Math.random;
  const isPlayer = () => owner && game.player === owner;

  // ---- state
  const total0 = Math.min(P('startTotal'), P('maxTotal'));
  const mag0 = Math.min(P('magSize'), total0);
  const state = {
    kind, mag: mag0, reserve: total0 - mag0,
    get total() { return this.mag + this.reserve; },
    reloading: false, reloadT: 0, reloadDur: 0, reloadAuto: false, committed: false,
    reloadDuck: { active: false, hold: 0, down: 0, t: 0 },
    cooldown: 0, lastShotT: -Infinity, sinceShot: Infinity,
    get fireT() { return this.sinceShot; },
    phase: 'ready', bloom: 0, shots: 0, burst: 0,
    trigger: false, pending: 0,
  };

  // ---- pooled scratch + payloads (no allocation per shot)
  const _ray = { origin: new V3(), dir: new V3() }; _ray.direction = _ray.dir;   // THREE.Ray-style alias
  const O = new V3(), D = new V3(), Dc = new V3(), M = new V3(), Pt = new V3(), tmp = new V3(), tmp2 = new V3();
  const aimHit = { point: new V3(), normal: new V3(), dist: 0, collider: null, actor: null, part: null };
  const hitObj = { point: new V3(), normal: new V3(), dist: 0, collider: null, actor: null, part: null };
  const shotEv = {
    shooter: owner, weapon: null, origin: new V3(), dir: new V3(), hit: null,
    muzzle: { pos: new V3(), dir: new V3() }, end: new V3(), aimPoint: new V3(), spread: 0, first: false,
  };
  const noiseEv = { pos: new V3(), radius: 0, kind: 'gunshot', source: owner };
  const impactEv = { pos: new V3(), radius: 0, kind: 'impact', source: owner };
  const dmgEv = { target: null, amount: 0, source: owner, part: 'torso', dir: new V3(), kind: 'bullet', point: new V3(), weapon: null };
  const kickArg = { pitch: 0, yaw: 0, peakT: 0, recoverT: 0 };
  const castOpts = { ignore: owner };
  const reticle = { mode: 'none', spread: 0, onTarget: false };
  let aimFlag = null, blind = false, lastFrame = -1, hipShotPending = false, aimHitValid = false;

  function setPhase(to) {
    if (state.phase === to) return;
    const from = state.phase;
    state.phase = to;
    if (owner && owner.state && typeof owner.state === 'object') owner.state.weapon = to;
    game.events.emit('state', { actor: owner, sys: 'weapon', from, to, t: game.time });
  }

  const aiming = () => (aimFlag !== null ? aimFlag
    : isPlayer() && game.input && typeof game.input.down === 'function' ? !!game.input.down('aim') : false);

  // ---- muzzle
  function muzzlePos(out) {
    const m = ov.muzzle;
    if (typeof m === 'function') return m(out);
    const sock = m || (owner && owner.rig && typeof owner.rig.socket === 'function' ? owner.rig.socket('muzzle') : null);
    if (sock && typeof sock.getWorldPosition === 'function') return sock.getWorldPosition(out);
    // [ASSUMED] fallback: right hand, chest height, arm's length forward
    return actorPoint(owner, 0.22, 1.42, 0.5, out);
  }

  // ---- aim ray (player path): camera ray through the reticle
  function aimRay() {
    const rig = game.cameraRig;
    if (rig && typeof rig.aimRay === 'function') {
      const r = rig.aimRay(_ray) || _ray;
      const d = r.dir || r.direction;
      O.copy(r.origin); D.copy(d).normalize();
      return;
    }
    const cam = game.camera;
    if (cam && typeof tmp.unproject === 'function') {   // three.js camera, no rig: ray through (0.5, reticleY)
      const ry = game.params.has('camera.aim.reticleY') ? game.params.get('camera.aim.reticleY') : 0.42;
      cam.updateMatrixWorld();
      cam.getWorldPosition(O);
      tmp.set(0, 1 - 2 * ry, 0.5).unproject(cam);
      D.subVectors(tmp, O).normalize();
      return;
    }
    // No camera: from the head along the owner's yaw.
    actorPoint(owner, 0, (owner.height || 1.8) - 0.15, 0, O);
    D.set(fwdX(owner.yaw || 0), 0, fwdZ(owner.yaw || 0));
  }

  // ---- spread (radians, cone half-angle) for the next shot
  function currentSpread() {
    if (blind) return P('blind.spread') * DEG;
    if (aiming()) {
      const first = state.shots === 0 || state.sinceShot > P('aim.firstShotResetT');
      if (first) return P('aim.firstShotSpread') * DEG;
      return Math.min(P('aim.bloomMax'), P('aim.base') + state.bloom) * DEG;
    }
    let s = P('hip.spread');
    const v = owner && owner.vel;
    if (v && Math.hypot(v.x, v.z) > P('hip.moveSpeed')) s += P('hip.movePenalty');
    return s * DEG;
  }

  // Random direction in a cone of half-angle a around unit d (uniform over the disk). Writes out.
  function cone(d, a, out) {
    out.copy(d);
    if (!(a > 0)) return out;
    const th = a * Math.sqrt(rng()), ph = 2 * Math.PI * rng();
    // basis perpendicular to d
    let ux, uy, uz;
    if (Math.abs(d.y) < 0.9) { ux = d.z; uy = 0; uz = -d.x; } else { ux = 0; uy = -d.z; uz = d.y; }
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const vx = d.y * uz - d.z * uy, vy = d.z * ux - d.x * uz, vz = d.x * uy - d.y * ux;
    const c = Math.cos(ph), s = Math.sin(ph), st = Math.sin(th), ct = Math.cos(th);
    out.set(d.x * ct + (ux * c + vx * s) * st, d.y * ct + (uy * c + vy * s) * st, d.z * ct + (uz * c + vz * s) * st);
    return out;
  }

  function copyHit(dst, h) {
    dst.point.copy(h.point); dst.normal.copy(h.normal); dst.dist = h.dist;
    dst.collider = h.collider || null; dst.actor = h.actor || null; dst.part = h.part || null;
    return dst;
  }

  // ---- gates
  function canFire() {
    return !state.reloading && state.mag > 0 && state.sinceShot >= P('fireInterval') - 1e-6 && owner.alive !== false;
  }

  // Fire one round from muzzle M toward point Pt (both set), with the shot's ray info already in shotEv.
  function discharge(spreadRad, first) {
    const world = game.world;
    const maxR = P('maxRange');
    // muzzle -> point
    tmp.subVectors(Pt, M);
    const L = tmp.length();
    let hit = null;
    if (L > 1e-6 && world) {
      const h = world.raycast(M, tmp, L + 0.02, castOpts);
      if (h) hit = copyHit(hitObj, h);
      else if (aimHitValid) hit = copyHit(hitObj, aimHit);   // grazing miss of the aim surface: keep the aim hit
    }
    const dir = shotEv.dir;
    if (L > 1e-6) dir.copy(tmp).multiplyScalar(1 / L); else dir.copy(D);
    shotEv.weapon = api;
    shotEv.origin.copy(M);
    shotEv.muzzle.pos.copy(M);
    shotEv.muzzle.dir.copy(dir);
    shotEv.hit = hit;
    if (hit) shotEv.end.copy(hit.point); else shotEv.end.copy(M).addScaledVector(dir, maxR);
    shotEv.spread = spreadRad;
    shotEv.first = first;

    // bookkeeping before the events, so listeners see the new count
    state.mag -= 1;
    state.shots += 1;
    state.sinceShot = 0;
    state.lastShotT = game.time;
    state.bloom = Math.min(P('aim.bloomMax'), state.bloom + P('aim.bloomPerShot'));

    game.events.emit('shot', shotEv);
    noiseEv.pos.copy(M); noiseEv.radius = P('noise');
    game.events.emit('noise', noiseEv);

    if (hit) {
      if (hit.actor) {
        const a = hit.actor;
        const part = hit.part === 'head' ? 'head' : hit.part === 'limb' ? 'limb' : 'torso';
        let amount = P('damage') * (part === 'head' ? P('headMult') : part === 'limb' ? P('limbMult') : 1);
        const fs = P('falloffStart');
        if (hit.dist > fs && maxR > fs) amount *= 1 + (P('falloffEndMult') - 1) * Math.min(1, (hit.dist - fs) / (maxR - fs));
        dmgEv.target = a; dmgEv.amount = Math.max(1, Math.round(amount)); dmgEv.part = part;
        dmgEv.dir.copy(dir); dmgEv.point.copy(hit.point); dmgEv.weapon = api; dmgEv.kind = 'bullet';
        const killed = applyDamage(game, dmgEv);
        if (isPlayer() && game.hud && G('weapon.hud.hitMarker') && a !== owner && a.team !== owner.team) {
          game.hud.hitMarker(killed ? 'kill' : part === 'head' ? 'head' : 'body');
        }
      } else if (G('weapon.impactNoise') > 0) {
        impactEv.pos.copy(hit.point); impactEv.radius = G('weapon.impactNoise');
        game.events.emit('noise', impactEv);
      }
    }

    // recoil (player camera)
    if (isPlayer() && game.cameraRig && typeof game.cameraRig.kick === 'function') {
      kickArg.pitch = P('recoil.kickPitch') * DEG;
      kickArg.yaw = (rng() * 2 - 1) * P('recoil.yawJitter') * DEG;
      kickArg.peakT = P('recoil.kickPeakT');
      kickArg.recoverT = P('recoil.recoverT');
      game.cameraRig.kick(kickArg);
    }
    if (!aiming() && !blind) hipShotPending = true;

    if (state.mag === 0 && P('autoReload')) startReload(true);
    return true;
  }

  // Player path: from the aim ray.
  function fireFromAim() {
    if (!canFire()) return false;
    aimRay();
    muzzlePos(M);
    const first = state.shots === 0 || state.sinceShot > P('aim.firstShotResetT');
    const spreadRad = currentSpread();
    cone(D, spreadRad, Dc);
    // start the aim cast at the muzzle's depth along the ray (skips things between the camera and the player)
    const t0 = Math.max(0, tmp.subVectors(M, O).dot(Dc));
    tmp2.copy(O).addScaledVector(Dc, t0);
    const maxR = P('maxRange');
    const h = game.world ? game.world.raycast(tmp2, Dc, maxR, castOpts) : null;
    aimHitValid = !!h;
    if (h) { copyHit(aimHit, h); Pt.copy(h.point); } else Pt.copy(tmp2).addScaledVector(Dc, maxR);
    shotEv.aimPoint.copy(Pt);
    return discharge(spreadRad, first && aiming());
  }

  // AI path: exactly at point (+ the tiny spread cone). The round flies on past the point to the first surface, so a
  // deliberate near-miss strikes the cover or wall behind it.
  function fireAt(point) {
    if (!canFire()) return false;
    muzzlePos(M);
    D.subVectors(point, M);
    const L = D.length();
    if (L < 1e-6) return false;
    D.multiplyScalar(1 / L);
    const spreadRad = P('spread') * DEG;
    cone(D, spreadRad, Dc);
    const maxR = P('maxRange');
    const h = game.world ? game.world.raycast(M, Dc, maxR, castOpts) : null;
    aimHitValid = !!h;
    if (h) { copyHit(aimHit, h); Pt.copy(h.point); } else Pt.copy(M).addScaledVector(Dc, maxR);
    shotEv.aimPoint.copy(point);
    return discharge(spreadRad, false);
  }

  // ---- reload
  function startReload(auto) {
    if (state.reloading) return false;
    if (state.mag >= P('magSize') || state.reserve <= 0) return false;
    state.reloading = true;
    state.reloadAuto = !!auto;
    state.reloadT = 0;
    state.committed = false;
    state.reloadDur = state.mag === 0 ? P('reloadTime') : P('tacticalReloadTime');
    const duck = state.reloadDuck;
    duck.active = true; duck.hold = P('reloadDuck.hold'); duck.down = P('reloadDuck.down'); duck.t = 0;
    setPhase('reloading');
    return true;
  }

  function commitReload() {
    const need = P('magSize') - state.mag;
    const take = Math.min(need, state.reserve);
    state.mag += take;
    state.reserve -= take;
    state.committed = true;
  }

  function endReload() {
    state.reloading = false;
    state.reloadDuck.active = false;
    setPhase('ready');
  }

  function cancelReload() {
    if (!state.reloading) return false;
    endReload();               // no refill before the commit (player-spec §5 abort frame)
    return true;
  }

  function addAmmo(n) {
    const room = P('maxTotal') - (state.mag + state.reserve);
    const add = Math.max(0, Math.min(n, room));
    state.reserve += add;
    if (state.mag === 0 && add > 0 && P('autoReload') && !state.reloading) startReload(true);
    return add;
  }

  // ---- input (player path)
  function setTrigger(down) {
    down = !!down;
    if (down && !state.trigger) state.pending = Math.max(P('inputBuffer'), 1e-6);   // a fresh press
    state.trigger = down;
  }

  // ---- step
  function update(dt) {
    if (game.frame === lastFrame) return;
    lastFrame = game.frame;

    state.sinceShot += dt;
    if (state.sinceShot > P('aim.bloomRecoverDelay')) state.bloom = Math.max(0, state.bloom - P('aim.bloomDecay') * dt);

    if (state.reloading) {
      state.reloadT += dt;
      state.reloadDuck.t = state.reloadT;
      if (!state.committed && state.reloadT >= P('reloadCommitT') - 1e-6) commitReload();
      if (state.reloadT >= state.reloadDur - 1e-6) { if (!state.committed) commitReload(); endReload(); }
    }

    if (state.pending > 0) {
      if (canFire()) { fireFromAim(); state.pending = 0; }
      else {
        state.pending -= dt;
        if (state.pending <= 0) state.pending = 0;
      }
    }
    state.cooldown = Math.max(0, P('fireInterval') - state.sinceShot);

    if (isPlayer()) driveHud();
  }

  function driveHud() {
    const hud = game.hud;
    if (!hud) return;
    const aim = aiming();
    if (G('weapon.hud.drive')) {
      // the HUD shows mag + reserve as the total (player-spec §8) and one tick per round of magSize
      hud.setAmmo(state.mag, state.reserve, aim || state.reloading || state.trigger || state.sinceShot < 0.25, P('magSize'));
    }
    if (!G('weapon.hud.reticle') || typeof hud.setReticle !== 'function') return;
    if (game.grenades && typeof game.grenades.isAiming === 'function' && game.grenades.isAiming(owner)) return;
    if (aim && !blind) {
      reticle.mode = 'aim';
      reticle.spread = currentSpread();
      reticle.onTarget = false;
      if (game.world) {
        aimRay();
        const h = game.world.raycast(O, D, P('maxRange'), castOpts);
        reticle.onTarget = !!(h && h.actor && h.actor.team !== owner.team && h.actor.alive !== false);
      }
      hud.setReticle(reticle);
    } else if (hipShotPending) {
      reticle.mode = 'hip'; reticle.spread = currentSpread(); reticle.onTarget = false;
      hud.setReticle(reticle);
      hipShotPending = false;
    } else {
      reticle.mode = 'none'; reticle.onTarget = false;
      hud.setReticle(reticle);
    }
  }

  const api = {
    kind, owner, state,
    setTrigger, setAim(on) { aimFlag = on == null ? null : !!on; }, setBlind(on) { blind = !!on; },
    get aiming() { return aiming(); }, get blind() { return blind; }, get muzzleScale() { return P('muzzleScale'); },
    fireAt, reload: () => startReload(false), cancelReload, addAmmo, update, canFire, currentSpread,
    param: P,
    dispose() {
      const list = game.weapons && game.weapons.list;
      if (list) { const i = list.indexOf(api); if (i >= 0) list.splice(i, 1); }
    },
  };
  shotEv.weapon = api;
  if (ov.register !== false && game.weapons && Array.isArray(game.weapons.list)) game.weapons.list.push(api);
  if (owner && owner.state && typeof owner.state === 'object') owner.state.weapon = state.phase;
  return api;
}
