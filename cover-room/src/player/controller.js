// Player controller (B1): the player actor, its movement modes, and the glue to camera, weapons, grenades and health.
// Contract: refs/design.md "player/*". Spec: refs/player-spec.md §1–4 and §7, refs/climb-spec.md §2 and §4.
//
//   install(game) -> actor        creates the player + the camera rig, sets game.player / game.cameraRig, adds systems
//   createPlayer(game, opts) -> actor   (install calls it; opts.createCharacter overrides the rig factory)
//
// actor (Actor shape, team 'player') + B1 fields:
//   anim                          the animState the animator reads (contract fields + extensions, see makeAnim)
//   cameraProfile, cameraLow, cameraPivot, cameraYawHint    read by the camera rig (any mode may set them)
//   exposed                       false while hidden in cover (the AI's exposure test may read it)
//   weapon                        B2's pistol (created lazily through any loaded module exporting createWeapon)
//   ctrl                          see below
// actor.ctrl:
//   mode                          'ground' | 'roll' | 'air' | 'cover' | 'mantle' | 'climb' | 'dead'
//   registerMode(name, {enter(from, ctx), update(dt) -> moved?, exit(to)})
//   setMode(name, ctx)            exit, enter, emit 'state' {sys: 'move', from, to}. If the old mode's update had not
//                                 moved the actor yet (returned falsy), the new mode updates in the same step, so input
//                                 reaches motion within one sim step.
//   caps                          per-step permissions the active mode sets: allowFire, fireReady, allowReload,
//                                 allowGrenade, fireMode ('none' | 'hip' | 'aim' | 'blind')
//   stick {x, z, mag, dx, dz}     this step's move stick, camera-relative in world XZ (x/z scaled by mag, dx/dz unit)
//   camYaw                        camera yaw this step (after look input)
//   move(dx, dy, dz) -> world.moveCapsule result (feet-anchored, step-up = player.stepHeight)
//   emit(sys, from, to)           'state' event (payload object is reused: copy what you keep)
//   jumpAction(dirX, dirZ, opts)  Jump pressed: mantle/vault, else game.climb.canGrab, else a jump. -> true if it changed mode
//   tryMantle(dirX, dirZ, opts) -> ctx | null
//   roll(dirX, dirZ)              roll if off cooldown -> bool
//   respawn()                     back to the spawn, full health
//   inCombat, grenadeAiming, lookScale, speed, health (health.js object)
// Climbing (B3): ground and air call game.climb.canGrab(actor, {fromAir, intentDir}) on jump and every descending air
// step; a grab enters the 'climb' mode with ctx {grab, fromAir, intentDir}. The climb mode owns actor.pos/yaw/anim.climb
// and leaves with setMode('ground') (standing on top; actor.vel used as the start velocity) or setMode('air') (a drop:
// falls from actor.vel). Every mode change emits 'state' {sys: 'move'}; ground gaits emit {sys: 'gait'}.
import * as THREE from 'three';
import { ORDER } from '../core/game.js';
import { install as installCamera } from './camera.js';
import { defineCoverParams, findCover, lowCoverDist, createCoverMode } from './cover.js';
import { createHealth } from './health.js';

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
export const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };

// Every feel number. Sources: player-spec (PS) / climb-spec (CS) section, confidence tag. [MEASURED] rows marked
// (yt-workaround) come from footage fetched with a YouTube download workaround (see the specs' provenance notes).
function defineParams(P) {
  const d = (k, v, o) => P.define(k, v, o);
  // locomotion (PS §2)
  d('player.move.walkThreshold', 0.55, { min: 0.1, max: 0.95, step: 0.01, label: 'walk/run stick split' }); // PS §2 [INFERRED]
  d('player.move.runFullAt', 0.9, { min: 0.5, max: 1, step: 0.01, label: 'full run at stick' });             // [INFERRED]
  d('player.walk.minSpeed', 0.6, { min: 0, max: 2, step: 0.05, label: 'slowest walk (m/s)' });            // [INFERRED] light push
  d('player.walk.speed', 1.6, { min: 0.3, max: 4, step: 0.05, label: 'walk (m/s)' });                      // PS §2 [INFERRED]
  d('player.run.speed', 4.8, { min: 1, max: 9, step: 0.05, label: 'run (m/s)' });                          // PS §2 [INFERRED] protocol P1
  d('player.aimWalk.speed', 1.4, { min: 0.3, max: 4, step: 0.05, label: 'aim walk (m/s)' });               // PS §2 [INFERRED]
  d('player.crouchWalk.speed', 1.5, { min: 0.3, max: 4, step: 0.05, label: 'crouch walk (m/s)' });         // PS §2 [INFERRED]
  d('player.accel', 18, { min: 1, max: 80, step: 0.5, label: 'accel (m/s²)' });                            // PS §2 [INFERRED] ~0.27 s to run
  d('player.decel', 22, { min: 1, max: 80, step: 0.5, label: 'decel (m/s²)' });                            // PS §2 [INFERRED] ~0.22 s to stop
  d('player.turnRate', 720, { min: 90, max: 2000, step: 10, label: 'turn (deg/s)' });                       // PS §2 [INFERRED]
  d('player.turnRateIdle', 1080, { min: 90, max: 3000, step: 10, label: 'turn from idle (deg/s)' });       // [INFERRED] turn-in-place starts
  d('player.turn.keep90', 0.6, { min: 0, max: 1, step: 0.05, label: 'speed kept at 90° off' });            // [INFERRED] weight in turns
  d('player.aim.turnRate', 1440, { min: 90, max: 4000, step: 10, label: 'aim body turn (deg/s)' });        // [INFERRED]
  d('player.runTurn180.time', 0.30, { min: 0.05, max: 1, step: 0.01, label: 'plant turn (s)' });           // PS §2 runTurn180Time [INFERRED]
  d('player.runTurn180.angle', 135, { min: 90, max: 180, step: 1, label: 'plant turn above (deg)' });      // PS §2 rule [INFERRED]
  d('player.runTurn180.minSpeed', 3.6, { min: 0, max: 9, step: 0.1, label: 'plant turn min speed' });      // [INFERRED] "while running"
  d('player.runTurn180.exitSpeed', 2.5, { min: 0, max: 6, step: 0.1, label: 'plant turn exit speed' });    // [INFERRED]
  d('player.stepHeight', 0.5, { min: 0.1, max: 0.8, step: 0.01, label: 'auto step-up (m)' });              // CS §2 "knee-height" [WIKI] value [INFERRED]
  d('player.snapDown', 0.3, { min: 0, max: 0.8, step: 0.01, label: 'ground snap (m)' });                   // [INFERRED]
  d('player.autoCrouch', true, { label: 'auto-crouch near low cover' });                                    // PS §2 [WIKI][MEASURED F1 qualitative]
  d('player.autoCrouch.range', 0.85, { min: 0, max: 3, step: 0.05, label: 'auto-crouch range (m)' });      // [INFERRED]
  d('player.hipFire.faceT', 0.6, { min: 0, max: 3, step: 0.05, label: 'hip-fire face camera (s)' });       // [INFERRED]
  d('player.aimBlendT', 0.12, { min: 0.01, max: 1, step: 0.01, label: 'aim pose blend (s)' });             // [INFERRED] ≈ camera.aim.inTime
  d('player.inputBuffer', 0.10, { min: 0, max: 0.5, step: 0.01, label: 'fire buffer (s)' });               // PS §5 pistol.inputBuffer [INFERRED]
  // roll (PS §2, F5 MP character (yt-workaround))
  d('player.roll.entryPlant', 0.10, { min: 0, max: 0.4, step: 0.01, label: 'plant before dive (s)' });     // PS §2 [MEASURED, MP] (yt-workaround)
  d('player.roll.duration', 0.75, { min: 0.2, max: 2, step: 0.01, label: 'dive → up (s)' });               // PS §2 [MEASURED, MP] F5 0:14.37→0:15.10 (yt-workaround)
  d('player.roll.controlBackT', 0.80, { min: 0.2, max: 2, step: 0.01, label: 'control back after dive (s)' }); // PS §2 [MEASURED, MP] F5 0:15.17 (yt-workaround)
  d('player.roll.distance', 2.2, { min: 0.5, max: 5, step: 0.05, label: 'dive distance (m)' });            // PS §2 [MEASURED, MP, low] (yt-workaround)
  d('player.roll.plantCarry', 0.5, { min: 0, max: 1, step: 0.05, label: 'speed kept in plant' });          // [INFERRED]
  d('player.roll.exitSpeed', 2.0, { min: 0, max: 5, step: 0.1, label: 'speed out (stick held)' });         // [INFERRED]
  d('player.roll.cooldown', 0.15, { min: 0, max: 1, step: 0.01, label: 'cooldown (s)' });                  // PS §2 [INFERRED]
  // jump / air / land (CS §4)
  d('player.jump.gravity', 18, { min: 5, max: 40, step: 0.5, label: 'jump gravity (m/s²)' });             // CS §4 [INFERRED] fits 0.38–0.42 s
  d('player.jump.apex', 0.4, { min: 0.1, max: 1.5, step: 0.01, label: 'apex (m)' });                       // CS §4 [INFERRED]
  d('player.jump.loadT', 0.10, { min: 0, max: 0.3, step: 0.01, label: 'crouch-load (s)' });                // CS §4 [MEASURED rough] 0.10–0.15
  d('player.jump.hopSpeed', 1.6, { min: 0, max: 5, step: 0.05, label: 'standing hop (m/s)' });             // CS §4 rule [INFERRED value]
  d('player.jump.coyoteT', 0.08, { min: 0, max: 0.3, step: 0.01, label: 'coyote time (s)' });              // [INFERRED]
  d('player.fall.gravity', 12, { min: 5, max: 40, step: 0.5, label: 'late-fall gravity (m/s²)' });        // CS §4 [INFERRED]
  d('player.fall.switchT', 0.3, { min: 0, max: 2, step: 0.05, label: 'late-fall after (s)' });             // CS §4 [INFERRED]
  d('player.fall.terminal', 20, { min: 5, max: 60, step: 1, label: 'terminal speed (m/s)' });              // [INFERRED]
  d('player.air.control', 0.15, { min: 0, max: 1, step: 0.01, label: 'air control (× accel)' });          // CS §4 [INFERRED]
  d('player.air.turnRate', 180, { min: 0, max: 1000, step: 10, label: 'air turn (deg/s)' });               // [INFERRED]
  d('player.land.softT', 0.15, { min: 0, max: 1, step: 0.01, label: 'soft land (s)' });                    // CS §4 [INFERRED]
  d('player.land.hardH', 2.0, { min: 0.5, max: 8, step: 0.1, label: 'hard land from (m)' });               // CS §4 [INFERRED]
  d('player.land.hardT', 0.5, { min: 0, max: 2, step: 0.01, label: 'hard land recovery (s)' });            // CS §4 pose [MEASURED], time [INFERRED]
  d('player.land.lethalH', 8, { min: 2, max: 30, step: 0.5, label: 'lethal fall (m)' });                  // CS §4 [INFERRED]
  // mantle / vault (CS §2)
  d('player.mantle.min', 0.5, { min: 0.2, max: 1.2, step: 0.01, label: 'mantle above (m)' });             // CS §2 step-up max 0.5 [INFERRED]
  d('player.mantle.max', 1.6, { min: 0.8, max: 2.5, step: 0.01, label: 'mantle up to (m)' });             // CS §2 0.8–1.6 / low-ledge choice ≤1.6 [INFERRED]
  d('player.mantle.reach', 0.6, { min: 0.1, max: 1.5, step: 0.05, label: 'wall within (m)' });             // CS §2 "facing wall within 0.6 m" [INFERRED]
  d('player.mantle.time', 0.6, { min: 0.2, max: 2, step: 0.01, label: 'mantle 1.2 m (s)' });                // [INFERRED] climb-up 0.65 s to crouch (CS §3 [MEASURED]) minus the hang
  d('player.mantle.inset', 0.45, { min: 0.2, max: 1, step: 0.01, label: 'stand-on inset (m)' });          // [INFERRED]
  d('player.vault.max', 1.1, { min: 0.5, max: 1.6, step: 0.01, label: 'vault up to (m)' });               // CS §2 [INFERRED]
  d('player.vault.maxDepth', 0.8, { min: 0.1, max: 2, step: 0.05, label: 'vault thickness max (m)' });     // [INFERRED]
  d('player.vault.minSpeed', 2.5, { min: 0, max: 6, step: 0.1, label: 'vault needs speed (m/s)' });       // CS §2 "running" [INFERRED]
  d('player.vault.reach', 1.25, { min: 0.3, max: 3, step: 0.05, label: 'vault wall within (m, running)' });  // [INFERRED] a run covers 0.6 m in 0.12 s
  d('player.vault.time', 0.55, { min: 0.2, max: 1.5, step: 0.01, label: 'vault (s)' });                    // [INFERRED]
  d('player.vault.keepSpeed', 0.85, { min: 0, max: 1.2, step: 0.05, label: 'speed kept' });               // [INFERRED]
  defineCoverParams(P);
}

// The animState (refs/design.md "character/*"), plus modeT (0..1 progress for roll / land / mantle, null otherwise: the
// animator's documented field). Extensions beyond the contract (B1): crouch 0..1, gait, time (s in
// mode), t (0..1 progress of timed moves: roll, mantle, land, cover enter), jump {phase: 'load'|'rise'|'fall', vy},
// land {hard, t}, mantle {kind: 'mantle'|'vault', height, t}, cover.edge (bool), cover.corner (0..1 while wrapping),
// cover.slide (bool: entered at a run), turn180 (0..1 while plant-turning, else -1).
function makeAnim() {
  return {
    mode: 'locomotion', speed: 0, localVel: { x: 0, z: 0 }, turnRate: 0,
    aim: { on: false, yaw: 0, pitch: 0, weight: 0 }, fireT: 99, action: null,
    cover: { height: 'low', side: 1, pose: 'idle', t: 0, edge: false, corner: 0, slide: false },
    climb: { pose: 'hang', handL: new THREE.Vector3(), handR: new THREE.Vector3(), dir: 0, t: 0 },
    hit: { dir: new THREE.Vector3(), part: 'torso', t: 99 }, death: { dir: new THREE.Vector3(0, 0, 1), t: 0 },
    modeT: null, crouch: 0, gait: 'idle', time: 0, t: 0, turn180: -1,
    jump: { phase: 'rise', vy: 0 }, land: { hard: false, t: 0 }, mantle: { kind: 'mantle', height: 0, dist: 0.45, t: 0 },
  };
}

// The rig factory: opts.createCharacter, game.createCharacter (set async by character/animator.js), or any loaded
// module exporting createCharacter.
function findCreateCharacter(game, opts) {
  if (opts.createCharacter) return opts.createCharacter;
  if (typeof game.createCharacter === 'function') return game.createCharacter;
  const m = game.modules || {};
  for (const k in m) if (m[k] && typeof m[k].createCharacter === 'function') return m[k].createCharacter;
  return null;
}

export function createPlayer(game, opts = {}) {
  const P = game.params;
  defineParams(P);
  const pg = (k) => P.get(k);
  const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

  const sp = game.level && game.level.spawns && game.level.spawns.player;
  const spawn = { pos: V(), yaw: 0 };
  if (sp && sp.pos) spawn.pos.set(sp.pos.x ?? sp.pos[0] ?? 0, sp.pos.y ?? sp.pos[1] ?? 0, sp.pos.z ?? sp.pos[2] ?? 0);
  if (sp && Number.isFinite(sp.yaw)) spawn.yaw = sp.yaw;

  const actor = {
    id: 'player', team: 'player', pos: spawn.pos.clone(), vel: V(), yaw: spawn.yaw, height: 1.8, radius: 0.35,
    health: 100, maxHealth: 100, alive: true, rig: null, hitboxes: null,
    state: { move: 'ground', cover: null, climb: null, weapon: null },
    anim: makeAnim(), cameraProfile: 'explore', cameraLow: false, cameraPivot: null, cameraYawHint: null,
    exposed: true, weapon: null, ctrl: null, spawn,
  };
  actor.animState = actor.anim;   // same object: character/animator.js reads actor.animState, the task brief says actor.anim

  // rig (retried lazily: the factory may arrive after boot) + hitboxes (the fallback capsule until a rig has parts)
  let rigTried = -1e9, rigFailed = false;
  function ensureRig() {
    if (actor.rig || rigFailed || game.frame - rigTried < 30) return;
    rigTried = game.frame;
    const mk = findCreateCharacter(game, opts);
    if (!mk) return;
    try {
      actor.rig = mk(game, { palette: 'player', seed: 7, actor });
      if (actor.rig && actor.rig.root && !actor.rig.root.parent && game.scene) game.scene.add(actor.rig.root);
    } catch (err) { console.error('[player] createCharacter failed:', err); actor.rig = null; rigFailed = true; }
    if (actor.rig && game.world && game.world.addHitboxes) {
      const parts = actor.rig.hitboxParts || null;
      if (Array.isArray(parts)) game.world.addHitboxes(actor, parts);
    }
  }
  ensureRig();
  if (game.world && game.world.addHitboxes && !actor.hitboxes) game.world.addHitboxes(actor, null);

  // ---------------------------------------------------------------------------------------------- ctrl core
  const modes = Object.create(null);
  const stateEvt = { actor, sys: '', from: '', to: '', t: 0 };
  const moveOpts = { stepHeight: 0.5, snapDown: 0.3 };
  const delta = V();
  const ray = { origin: V(), dir: V(), camOrigin: V() };
  const castOpts = { ignore: actor };
  const ctrl = {
    mode: 'ground', modeT: 0, prevMode: 'none',
    caps: { allowFire: false, fireReady: false, allowReload: false, allowGrenade: false, fireMode: 'none' },
    stick: { x: 0, z: 0, mag: 0, dx: 0, dz: 1 },
    camYaw: actor.yaw, speed: 0,
    inCombat: false, lastCombatT: -1e9, lastShotT: -1e9, lastHipT: -1e9,
    grenadeAiming: false, throwT: -1e9, lookScale: 1,
    rollReadyT: 0, bufferedFireT: -1e9, _changed: false, _pressFrame: -1, _hudCombat: null,
    gait: 'idle', health: null,
    modes,

    registerMode(name, impl) { modes[name] = impl; impl.name = name; return impl; },

    // Edge of a context button (cover / jump / swapShoulder) that no earlier mode acted on this step: after a mode
    // change in the step the press counts as used, so the new mode doesn't act on it a second time.
    pressed(a) { return game.input.pressed(a) && ctrl._pressFrame !== game.frame; },

    setMode(name, ctx) {
      const impl = modes[name];
      if (!impl) { if (!ctrl._warned) console.warn(`[player] mode '${name}' is not registered`); ctrl._warned = true; return false; }
      const from = ctrl.mode;
      const old = modes[from];
      if (old && old.exit) old.exit(name);
      ctrl.prevMode = from;
      ctrl.mode = name;
      ctrl.modeT = 0;
      actor.state.move = name;
      ctrl._changed = true;
      ctrl._pressFrame = game.frame;
      ctrl.emit('move', from, name);
      if (impl.enter) impl.enter(from, ctx || null);
      return true;
    },

    emit(sys, from, to) {
      stateEvt.sys = sys; stateEvt.from = from; stateEvt.to = to; stateEvt.t = game.time;
      game.events.emit('state', stateEvt);
    },

    move(dx, dy, dz) {
      delta.set(dx, dy, dz);
      moveOpts.stepHeight = pg('player.stepHeight');
      moveOpts.snapDown = pg('player.snapDown');
      if (game.world && game.world.moveCapsule) return game.world.moveCapsule(actor, delta, moveOpts);
      actor.pos.add(delta);   // no world: free movement on y = 0
      if (actor.pos.y < 0) actor.pos.y = 0;
      return { grounded: actor.pos.y <= 1e-6, groundY: 0, hitWall: false, wallNormal: V(), hitCeiling: false };
    },

    roll(dx, dz) {
      if (game.time < ctrl.rollReadyT) return false;
      return ctrl.setMode('roll', { dx, dz });
    },

    tryMantle(dx, dz, o) { return detectMantle(dx, dz, o); },

    // Jump pressed: mantle/vault > climb grab > plain jump (CS §2 state machine). Returns true if the mode changed.
    jumpAction(dx, dz, o = {}) {
      const m = detectMantle(dx, dz, o);
      if (m) return ctrl.setMode('mantle', m);
      const grab = tryGrab(false, dx, dz);
      if (grab) return ctrl.setMode('climb', grab);
      if (o.noJump) return false;
      return ctrl.setMode('air', { jump: true, dx, dz });
    },

    respawn() {
      actor.pos.copy(spawn.pos); actor.vel.set(0, 0, 0); actor.yaw = spawn.yaw;
      actor.alive = true;
      ctrl.lastCombatT = -1e9; ctrl.lastShotT = -1e9; ctrl.lastHipT = -1e9;
      if (ctrl.health) ctrl.health.reset();
      if (ctrl.grenadeAiming && game.grenades && game.grenades.cancel) game.grenades.cancel(actor);
      ctrl.grenadeAiming = false;
      ctrl.setMode('ground');
      const rig = game.cameraRig;
      if (rig) { rig.yaw = spawn.yaw; rig.pitch = pg('camera.pitchDefault') * DEG; actor.cameraProfile = 'explore'; rig.snap(); }
      game.events.emit('player:respawn', { actor });
    },
  };
  actor.ctrl = ctrl;

  // ---- shared helpers -----------------------------------------------------------------------------------------
  const intent = { x: 0, z: 0 };
  const grabCtx = { grab: null, fromAir: false, intentDir: V() };
  function tryGrab(fromAir, dx, dz) {
    const c = game.climb;
    if (!c || typeof c.canGrab !== 'function' || !modes.climb) return null;
    grabCtx.intentDir.set(dx, 0, dz);
    grabCtx.fromAir = fromAir;
    const g = c.canGrab(actor, grabCtx);
    if (!g) return null;
    grabCtx.grab = g;
    return grabCtx;
  }

  // Drop (cover) at a top edge, or walking off one slowly: B3's canGrab({dropFromTop}) -> the climb mode.
  const dropOpts = { dropFromTop: true, intentDir: V() };
  function tryDropToHang(st) {
    const c = game.climb;
    if (!c || typeof c.canGrab !== 'function' || !modes.climb) return false;
    if (st.mag > 0.2) dropOpts.intentDir.set(st.dx, 0, st.dz); else dropOpts.intentDir.set(Math.sin(actor.yaw), 0, Math.cos(actor.yaw));
    const g = c.canGrab(actor, dropOpts);
    if (!g) return false;
    grabCtx.grab = g; grabCtx.fromAir = false; grabCtx.intentDir.copy(dropOpts.intentDir);
    return ctrl.setMode('climb', grabCtx);
  }

  // Mantle / vault target (CS §2): a wall within player.mantle.reach ahead whose top is in (mantle.min, mantle.max]
  // above the feet, with standing room on top. A thin top with floor behind, taken at a run (or from cover), vaults.
  const mantleCtx = { kind: 'mantle', h: 0, top: 0, nx: 0, nz: 0, wx: 0, wz: 0, sx: 0, sz: 0, lx: 0, ly: 0, lz: 0, depth: 0, speed: 0 };
  const probeOpts = { rays: 3, spread: 0.3 };
  const qMin = V(), qMax = V(), qOut = [];
  function detectMantle(dx, dz, o = {}) {
    const w = game.world;
    if (!w || !w.probeWall) return null;
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) return null;
    dx /= l; dz /= l;
    const hProbe = Math.min(pg('player.stepHeight'), pg('player.mantle.min')) + 0.05;
    delta.set(dx, 0, dz);
    const speed = Math.hypot(actor.vel.x, actor.vel.z);
    const running = speed >= pg('player.vault.minSpeed');
    const reach = running ? Math.max(pg('player.mantle.reach'), pg('player.vault.reach')) : pg('player.mantle.reach');
    const hit = w.probeWall(actor.pos, delta, actor.radius + reach, hProbe, probeOpts);
    if (!hit) return null;
    const hitDist = hit.dist;
    const top = hit.top, h = top - actor.pos.y;
    if (!(h > pg('player.mantle.min') && h <= pg('player.mantle.max'))) return null;
    // the wall must face us (normal against the probe)
    const nx = hit.normal.x, nz = hit.normal.z;
    if (nx * dx + nz * dz > -0.5) return null;
    const wx = hit.point.x, wz = hit.point.z;
    // standing point on top, inset from the lip along -normal
    const inset = pg('player.mantle.inset');
    const sx = wx - nx * inset, sz = wz - nz * inset;
    const gTop = w.groundAt(sx, sz, top + 0.05);
    const standOk = gTop !== null && Math.abs(gTop - top) < 0.06 && headroom(sx, top, sz);
    // vault: scan through the top along -normal for the far edge, then floor behind
    let vault = false, depth = 0, lx = 0, ly = 0, lz = 0;
    if (h <= pg('player.vault.max') && (o.fromCover || running)) {
      const maxD = pg('player.vault.maxDepth');
      for (let d = 0.1; d <= maxD + 1e-6; d += 0.05) {
        const g = w.groundAt(wx - nx * d, wz - nz * d, top + 0.05);
        if (g === null || g < top - 0.25) { depth = d; break; }
      }
      if (depth > 0) {
        const off = depth + actor.radius + 0.35;
        lx = wx - nx * off; lz = wz - nz * off;
        const gl = w.groundAt(lx, lz, top - 0.25);
        if (gl !== null && top - gl <= pg('player.vault.max') + 0.6 && gl > actor.pos.y - 1.0 && headroom(lx, gl, lz)) { vault = true; ly = gl; }
      }
    }
    if (!vault && (!standOk || hitDist > actor.radius + pg('player.mantle.reach') + 0.02)) return null;
    Object.assign(mantleCtx, { kind: vault ? 'vault' : 'mantle', h, top, nx, nz, wx, wz, sx, sz, lx, ly, lz, depth, speed });
    return mantleCtx;
  }
  function headroom(x, y, z) {
    const r = actor.radius - 0.02;
    qMin.set(x - r, y + 0.06, z - r); qMax.set(x + r, y + actor.height - 0.05, z + r);
    qOut.length = 0;
    const list = game.world.queryBoxes(qMin, qMax, qOut);
    for (let i = 0; i < list.length; i++) if (list[i].top > y + 0.06 && list[i].bottom < y + actor.height - 0.05) return false;
    return true;
  }

  function speedFor(mag, walkHeld, crouch) {
    if (mag <= 1e-4) return 0;
    const wT = pg('player.move.walkThreshold'), runAt = Math.max(wT + 0.01, pg('player.move.runFullAt'));
    const wMin = pg('player.walk.minSpeed'), walk = pg('player.walk.speed');
    let s;
    if (walkHeld || mag < wT) s = lerp(wMin, walk, clamp(mag / wT, 0, 1));
    else s = lerp(walk, pg('player.run.speed'), clamp((mag - wT) / (runAt - wT), 0, 1));
    if (crouch) s = Math.min(s, pg('player.crouchWalk.speed'));
    return s;
  }

  function turnScale(err) {
    const k90 = pg('player.turn.keep90');
    const a = Math.abs(err);
    return a <= Math.PI / 2 ? lerp(1, k90, a / (Math.PI / 2)) : lerp(k90, 0, (a - Math.PI / 2) / (Math.PI / 2));
  }

  function setGait(g) {
    if (g === ctrl.gait) return;
    const from = ctrl.gait;
    ctrl.gait = g;
    actor.anim.gait = g;
    ctrl.emit('gait', from, g);
  }

  // Grenade hold has its own, wider framing so the raised throw hand stays out of the lens (B2 note).
  function groundProfile(aim) {
    actor.cameraProfile = ctrl.grenadeAiming ? 'grenade' : aim ? 'aim' : ctrl.inCombat ? 'combat' : 'explore';
  }
  ctrl.aimProfile = () => (ctrl.grenadeAiming ? 'grenade' : 'aim');

  // ============================================================================================== GROUND
  const ground = {
    landLock: 0, landT: 0, landHard: false, plantT: -1, plant: { y0: 0, err: 0, dx: 0, dz: 0, s0: 0 }, crouchAmt: 0,
    enter(from, ctx) {
      this.landLock = 0; this.landT = 0; this.landHard = false; this.plantT = -1;
      if (ctx && ctx.land === 'hard') { this.landLock = pg('player.land.hardT'); this.landHard = true; this.landT = this.landLock; }
      else if (ctx && ctx.land === 'soft') this.landT = pg('player.land.softT');
      ctrl.speed = ctx && Number.isFinite(ctx.speed) ? ctx.speed : Math.hypot(actor.vel.x, actor.vel.z);
      if (this.landHard) ctrl.speed = 0;
      actor.vel.y = 0;
      actor.anim.mode = 'locomotion';
    },
    update(dt) {
      const inp = game.input, st = ctrl.stick, caps = ctrl.caps, a = actor.anim;
      const locked = this.landLock > 0;
      const aimHeld = !locked && inp.down('aim');
      const aim = aimHeld || ctrl.grenadeAiming;
      // shoulder swap shares the jump key: only while aiming (PS §1)
      if (aimHeld && (ctrl.pressed('swapShoulder') || ctrl.pressed('jump')) && game.cameraRig) game.cameraRig.swapShoulder();
      if (!locked && ctrl.pressed('cover')) {
        if (ctrl.grenadeAiming) { cancelGrenade(); }
        else if (tryDropToHang(st)) return false;     // at a top edge: drop to hang (CS §2, B3)
        else {
          intent.x = st.mag > 0.2 ? st.dx : Math.sin(actor.yaw); intent.z = st.mag > 0.2 ? st.dz : Math.cos(actor.yaw);
          const c = findCover(game, actor, intent.x, intent.z, { stick: st.mag > 0.2, camYaw: ctrl.camYaw });
          if (c) return !ctrl.setMode('cover', c);
          const rx = st.mag > 0.2 ? st.dx : Math.sin(actor.yaw), rz = st.mag > 0.2 ? st.dz : Math.cos(actor.yaw);
          if (ctrl.roll(rx, rz)) return false;
        }
      }
      if (!locked && !aim && ctrl.pressed('jump') && this.plantT < 0) {
        const jx = st.mag > 0.2 ? st.dx : Math.sin(actor.yaw), jz = st.mag > 0.2 ? st.dz : Math.cos(actor.yaw);
        if (ctrl.jumpAction(jx, jz)) return false;
      }

      caps.allowReload = !locked; caps.allowGrenade = !locked;
      caps.allowFire = !locked; caps.fireReady = true;
      caps.fireMode = aimHeld ? 'aim' : 'hip';

      // auto-crouch near low cover out of combat (PS §2)
      // (not at a run: running past a low wall stays upright and at speed)
      const nearLow = pg('player.autoCrouch') && !aim && !ctrl.inCombat && speedFor(locked ? 0 : st.mag, inp.down('walk'), false) <= pg('player.walk.speed') + 0.2
        && lowCoverDist(game, actor) <= pg('player.autoCrouch.range');
      this.crouchAmt = clamp(this.crouchAmt + (nearLow ? dt : -dt) / 0.2, 0, 1);

      const mag = locked ? 0 : st.mag;
      const target = speedFor(mag, inp.down('walk'), nearLow);
      const accel = pg('player.accel'), decel = pg('player.decel');
      let turnRate = 0;
      const hipFacing = !aim && game.time - ctrl.lastHipT < pg('player.hipFire.faceT') && mag < 0.2;

      if (aim || hipFacing) {
        // strafe: the body faces the camera, velocity follows the stick (PS §2 AimWalk)
        const err = wrapPi(ctrl.camYaw - actor.yaw), r = pg('player.aim.turnRate') * DEG * dt;
        const step = clamp(err, -r, r);
        actor.yaw = wrapPi(actor.yaw + step); turnRate = step / dt;
        const s = aim ? pg('player.aimWalk.speed') * clamp(mag / pg('player.move.walkThreshold'), 0, 1) : 0;
        const tx = st.dx * s, tz = st.dz * s;
        let vx = actor.vel.x, vz = actor.vel.z;
        const dvx = tx - vx, dvz = tz - vz, dl = Math.hypot(dvx, dvz);
        const rate = (tx * vx + tz * vz < vx * vx + vz * vz ? decel : accel) * dt;
        if (dl > rate) { vx += (dvx / dl) * rate; vz += (dvz / dl) * rate; } else { vx = tx; vz = tz; }
        actor.vel.x = vx; actor.vel.z = vz;
        ctrl.speed = Math.hypot(vx, vz);
        this.plantT = -1;
      } else if (this.plantT >= 0) {
        // run plant-turn (PS §2 runTurn180Time): decelerate along the old line, pivot, leave at exitSpeed
        const T = pg('player.runTurn180.time'), p = this.plant;
        this.plantT += dt;
        const u = clamp(this.plantT / T, 0, 1);
        const exit = pg('player.runTurn180.exitSpeed') * (mag > 0.2 ? 1 : 0);
        const s = lerp(p.s0, -exit, u);
        actor.vel.x = p.dx * s; actor.vel.z = p.dz * s;
        const yPrev = actor.yaw;
        actor.yaw = wrapPi(p.y0 + p.err * smooth(u));
        turnRate = wrapPi(actor.yaw - yPrev) / dt;
        a.turn180 = u;
        if (u >= 1) { this.plantT = -1; ctrl.speed = exit; a.turn180 = -1; }
      } else {
        a.turn180 = -1;
        let tgt = 0;
        if (mag > 1e-4) {
          const ty = Math.atan2(st.dx, st.dz);
          const err = wrapPi(ty - actor.yaw);
          if (ctrl.speed >= pg('player.runTurn180.minSpeed') && Math.abs(err) > pg('player.runTurn180.angle') * DEG) {
            const p = this.plant;
            p.y0 = actor.yaw; p.err = err; p.dx = Math.sin(actor.yaw); p.dz = Math.cos(actor.yaw); p.s0 = ctrl.speed;
            this.plantT = 0;
            a.turn180 = 0;
          } else {
            const r = (ctrl.speed < 0.5 ? pg('player.turnRateIdle') : pg('player.turnRate')) * DEG * dt;
            const step = clamp(err, -r, r);
            actor.yaw = wrapPi(actor.yaw + step); turnRate = step / dt;
            tgt = target * turnScale(wrapPi(ty - actor.yaw));
          }
        }
        if (this.plantT < 0) {
          ctrl.speed = tgt > ctrl.speed ? Math.min(tgt, ctrl.speed + accel * dt) : Math.max(tgt, ctrl.speed - decel * dt);
          actor.vel.x = Math.sin(actor.yaw) * ctrl.speed; actor.vel.z = Math.cos(actor.yaw) * ctrl.speed;
        }
      }
      if (this.landLock > 0) this.landLock -= dt;
      if (this.landT > 0) this.landT -= dt;

      const x0 = actor.pos.x, z0 = actor.pos.z;
      const res = ctrl.move(actor.vel.x * dt, 0, actor.vel.z * dt);
      if (res.hitWall) {  // keep the speed we actually achieved (running into a wall stops you)
        const ax = (actor.pos.x - x0) / dt, az = (actor.pos.z - z0) / dt;
        if (this.plantT < 0) {
          if (aim || hipFacing) { actor.vel.x = ax; actor.vel.z = az; ctrl.speed = Math.hypot(ax, az); }
          else ctrl.speed = Math.min(ctrl.speed, Math.hypot(ax, az));
        }
      }
      if (!res.grounded) {
        // walking off a top edge slowly catches it (CS §2 DROP_TO_HANG); otherwise fall
        if (ctrl.speed <= pg('player.walk.speed') + 0.3 && tryDropToHang(st)) return true;
        ctrl.setMode('air', { walkOff: true }); return true;
      }

      // anim
      const landing = this.landT > 0;
      a.crouch = this.crouchAmt;
      a.turnRate = turnRate;
      a.land.hard = this.landHard; a.land.t = landing ? 1 - this.landT / (this.landHard ? pg('player.land.hardT') : pg('player.land.softT')) : 1;
      a.t = a.land.t;
      a.mode = landing ? 'land' : 'locomotion';
      a.modeT = landing ? a.land.t : null;
      setGait(this.landLock > 0 ? 'hardLand' : this.landT > 0 ? 'land' : this.plantT >= 0 ? 'turn180'
        : aim ? (ctrl.speed > 0.1 ? 'aimWalk' : 'aim')
          : nearLow ? (ctrl.speed > 0.1 ? 'crouchWalk' : 'crouch')
            : ctrl.speed < 0.1 ? 'idle' : ctrl.speed <= pg('player.walk.speed') + 0.3 ? 'walk' : 'run');
      groundProfile(aim);
      return true;
    },
    exit() { setGait('none'); actor.anim.turn180 = -1; },
  };

  // ============================================================================================== ROLL
  // PS §2: plant (entryPlant) -> dive covering `distance` over `duration` -> control back at entryPlant + controlBackT.
  // Yaw snaps to the roll direction on the press (private reference project rule, PS §2). Input is ignored until control back.
  const roll = {
    t: 0, dx: 0, dz: 1, v0: 0, sp: 0,
    enter(from, ctx) {
      const l = Math.hypot(ctx.dx, ctx.dz) || 1;
      this.dx = ctx.dx / l; this.dz = ctx.dz / l;
      actor.yaw = Math.atan2(this.dx, this.dz);
      this.t = 0;
      this.v0 = Math.hypot(actor.vel.x, actor.vel.z);
      this.sp = 0;
      if (actor.weapon && actor.weapon.state && actor.weapon.state.reloading && actor.weapon.cancelReload) actor.weapon.cancelReload();
      if (ctrl.grenadeAiming) cancelGrenade();
      actor.cameraLow = false;
      actor.anim.mode = 'roll';
    },
    update(dt) {
      this.t += dt;
      const plant = pg('player.roll.entryPlant'), dur = pg('player.roll.duration'), back = plant + pg('player.roll.controlBackT');
      const t = this.t;
      let s;
      if (t < plant) s = this.v0 * pg('player.roll.plantCarry');
      else if (t < plant + dur) {
        const u = (t - plant) / dur;
        s = (pg('player.roll.distance') / dur) * (1.3 - 0.6 * u);   // fast out of the dive, slowing; integrates to `distance`
      } else {
        const held = ctrl.stick.mag > 0.2;
        const tgt = held ? pg('player.roll.exitSpeed') : 0;
        s = Math.max(tgt, this.sp - pg('player.decel') * dt);
      }
      this.sp = s;
      actor.vel.x = this.dx * s; actor.vel.z = this.dz * s; actor.vel.y = 0;
      const res = ctrl.move(actor.vel.x * dt, 0, actor.vel.z * dt);
      const a = actor.anim;
      a.mode = 'roll'; a.t = clamp((t - plant) / dur, 0, 1); a.modeT = clamp(t / back, 0, 1); a.crouch = 1; a.turnRate = 0;
      groundProfile(false);
      if (!res.grounded) { ctrl.setMode('air', { walkOff: true }); return true; }
      if (t >= back - 1e-9) {
        ctrl.rollReadyT = game.time + pg('player.roll.cooldown');
        ctrl.setMode('ground', { speed: s });
      }
      return true;
    },
  };

  // ============================================================================================== AIR
  // CS §4: crouch-load, v0 = sqrt(2 g apex) at g = jump gravity, late-fall gravity after fall.switchT of descent,
  // air control, ceiling stop, catch test every descending step (game.climb.canGrab), landing bands.
  const air = {
    phase: 'fall', t: 0, loadT: 0, apexY: 0, fallT: 0, cap: 0, coyote: 0, jumped: false,
    enter(from, ctx) {
      this.t = 0; this.fallT = 0; this.coyote = 0; this.jumped = false;
      this.apexY = actor.pos.y;
      if (ctx && ctx.jump) this.startJump(ctx.dx, ctx.dz);
      else {
        this.phase = 'fall';
        if (ctx && ctx.walkOff) { this.coyote = pg('player.jump.coyoteT'); actor.vel.y = Math.min(actor.vel.y, 0); }
        this.cap = Math.max(Math.hypot(actor.vel.x, actor.vel.z), 1.0);
      }
      actor.anim.mode = this.phase === 'load' ? 'jump' : 'fall';
    },
    startJump(dx, dz) {
      const st = ctrl.stick;
      const sp = Math.hypot(actor.vel.x, actor.vel.z);
      if (st.mag > 0.2) actor.yaw = Math.atan2(st.dx, st.dz);   // yaw snaps to the stick at takeoff (CS §4)
      const h = Math.max(sp, st.mag > 0.2 ? pg('player.jump.hopSpeed') * st.mag : 0);
      actor.vel.x = Math.sin(actor.yaw) * h; actor.vel.z = Math.cos(actor.yaw) * h;
      this.cap = Math.max(h, 1.0);
      this.loadT = pg('player.jump.loadT');
      this.phase = this.loadT > 0 ? 'load' : 'rise';
      this.jumped = true;
      this.coyote = 0;
      if (this.phase === 'rise') this.takeoff();
      ctrl.emit('air', 'none', this.phase);
    },
    takeoff() {
      actor.vel.y = Math.sqrt(2 * pg('player.jump.gravity') * pg('player.jump.apex'));
      this.phase = 'rise';
      this.apexY = actor.pos.y;
      ctrl.emit('air', 'load', 'rise');
    },
    update(dt) {
      const inp = game.input, st = ctrl.stick, a = actor.anim;
      this.t += dt;
      groundProfile(false);
      if (this.phase === 'load') {
        this.loadT -= dt;
        const res = ctrl.move(actor.vel.x * dt, 0, actor.vel.z * dt);
        a.mode = 'jump'; a.modeT = null; a.jump.phase = 'load'; a.jump.vy = 0; a.t = 1 - this.loadT / Math.max(1e-6, pg('player.jump.loadT'));
        if (!res.grounded) { this.phase = 'fall'; return true; }
        if (this.loadT <= 1e-9) this.takeoff();
        return true;
      }
      if (this.coyote > 0) {
        this.coyote -= dt;
        if (ctrl.pressed('jump')) {
          const jx = st.mag > 0.2 ? st.dx : Math.sin(actor.yaw), jz = st.mag > 0.2 ? st.dz : Math.cos(actor.yaw);
          const m = detectMantle(jx, jz);
          if (m) return !ctrl.setMode('mantle', m);
          this.loadT = 0; actor.vel.y = 0;
          this.startJump(jx, jz);
        }
      }
      // catch: on takeoff and while descending (design.md / CS §2)
      if (actor.vel.y <= 0 || this.t <= dt * 1.5) {
        const g = tryGrab(true, st.mag > 0.2 ? st.dx : Math.sin(actor.yaw), st.mag > 0.2 ? st.dz : Math.cos(actor.yaw));
        if (g) return !ctrl.setMode('climb', g);
      }
      // gravity
      const desc = actor.vel.y <= 0;
      if (desc) this.fallT += dt;
      const gr = desc && this.fallT > pg('player.fall.switchT') ? pg('player.fall.gravity') : pg('player.jump.gravity');
      const vy0 = actor.vel.y;
      actor.vel.y = Math.max(vy0 - gr * dt, -pg('player.fall.terminal'));
      if (vy0 > 0 && actor.vel.y <= 0) ctrl.emit('air', 'rise', 'fall');
      // air control (CS §4): accelerate toward the stick, capped at the takeoff speed
      if (st.mag > 0.2) {
        const acc = pg('player.air.control') * pg('player.accel') * dt * st.mag;
        let vx = actor.vel.x + st.dx * acc, vz = actor.vel.z + st.dz * acc;
        const l = Math.hypot(vx, vz);
        if (l > this.cap) { vx *= this.cap / l; vz *= this.cap / l; }
        actor.vel.x = vx; actor.vel.z = vz;
        const err = wrapPi(Math.atan2(st.dx, st.dz) - actor.yaw), r = pg('player.air.turnRate') * DEG * dt;
        actor.yaw = wrapPi(actor.yaw + clamp(err, -r, r));
      }
      const x0 = actor.pos.x, z0 = actor.pos.z;
      const res = ctrl.move(actor.vel.x * dt, (vy0 + actor.vel.y) * 0.5 * dt, actor.vel.z * dt);
      if (res.hitCeiling && actor.vel.y > 0) actor.vel.y = 0;
      if (res.hitWall) { actor.vel.x = (actor.pos.x - x0) / dt; actor.vel.z = (actor.pos.z - z0) / dt; }
      if (actor.pos.y > this.apexY) this.apexY = actor.pos.y;
      this.phase = actor.vel.y > 0 ? 'rise' : 'fall';
      a.mode = this.jumped && this.phase === 'rise' ? 'jump' : 'fall';
      a.modeT = null;
      a.jump.phase = this.phase; a.jump.vy = actor.vel.y;
      if (res.grounded && actor.vel.y <= 0) {
        const fallH = this.apexY - actor.pos.y;
        actor.vel.y = 0;
        if (fallH > pg('player.land.lethalH')) { ctrl.setMode('dead', { fall: true, dir: null }); return true; }
        ctrl.setMode('ground', { land: fallH >= pg('player.land.hardH') ? 'hard' : 'soft' });
      }
      return true;
    },
  };

  // ============================================================================================== MANTLE / VAULT
  const mantle = {
    t: 0, dur: 0, x0: 0, y0: 0, z0: 0, px: 0, pz: 0, c: { ...mantleCtx },
    enter(from, ctx) {
      Object.assign(this.c, ctx);
      const c = this.c;
      this.t = 0;
      this.x0 = actor.pos.x; this.y0 = actor.pos.y; this.z0 = actor.pos.z;
      // plant point: against the wall face
      const off = actor.radius + 0.03;
      this.px = c.wx + c.nx * off; this.pz = c.wz + c.nz * off;
      this.dist = Math.max(0, (this.x0 - c.wx) * c.nx + (this.z0 - c.wz) * c.nz);   // root -> wall face, for the animator
      this.dur = c.kind === 'vault' ? pg('player.vault.time') : pg('player.mantle.time') * (0.5 + 0.5 * c.h / 1.2);
      actor.yaw = Math.atan2(-c.nx, -c.nz);
      actor.vel.set(0, 0, 0);
      if (ctrl.grenadeAiming) cancelGrenade();
      actor.cameraLow = false;
      actor.anim.mode = 'mantle';
      ctrl.emit('mantle', 'none', c.kind);
    },
    update(dt) {
      const c = this.c, a = actor.anim;
      this.t += dt;
      const u = clamp(this.t / this.dur, 0, 1);
      const px = actor.pos.x, py = actor.pos.y, pz = actor.pos.z;
      if (c.kind === 'mantle') {
        // A: close to the wall (0–0.2), B: rise to the top (0.15–0.65), C: step onto it (0.6–1)
        const ua = smooth(u / 0.2), ub = 1 - Math.pow(1 - clamp((u - 0.15) / 0.5, 0, 1), 2), uc = smooth((u - 0.6) / 0.4);
        const ax = lerp(this.x0, this.px, ua), az = lerp(this.z0, this.pz, ua);
        actor.pos.set(lerp(ax, c.sx, uc), lerp(this.y0, c.top, ub), lerp(az, c.sz, uc));
      } else {
        // vault: hands on the lip, body arcs over the top, lands beyond
        const ux = smooth(u);
        const peak = c.top + 0.12;
        const x = lerp(this.x0, c.lx, ux), z = lerp(this.z0, c.lz, ux);
        // height: up to peak by 0.45, hold over the top, down to the landing floor by 1
        let y;
        if (u < 0.45) y = lerp(this.y0, peak, 1 - Math.pow(1 - u / 0.45, 2));
        else if (u < 0.6) y = peak;
        else y = lerp(peak, c.ly, Math.pow((u - 0.6) / 0.4, 2));
        actor.pos.set(x, y, z);
      }
      actor.vel.set((actor.pos.x - px) / dt, (actor.pos.y - py) / dt, (actor.pos.z - pz) / dt);
      a.mode = 'mantle'; a.t = u; a.modeT = u; a.mantle.kind = c.kind; a.mantle.height = c.h; a.mantle.dist = this.dist; a.mantle.t = u; a.crouch = 0;
      groundProfile(false);
      if (u >= 1) {
        const keep = c.kind === 'vault' ? c.speed * pg('player.vault.keepSpeed') : 0;
        actor.vel.set(Math.sin(actor.yaw) * keep, 0, Math.cos(actor.yaw) * keep);
        ctrl.move(0, -0.01, 0);   // settle the grounded state on the new floor
        ctrl.setMode('ground', { speed: keep });
      }
      return true;
    },
  };

  // ============================================================================================== DEAD
  const dead = {
    t: 0,
    enter(from, ctx) {
      this.t = 0;
      actor.alive = false;
      actor.vel.x = 0; actor.vel.z = 0;
      if (ctrl.grenadeAiming) cancelGrenade();
      if (actor.weapon && actor.weapon.setTrigger) actor.weapon.setTrigger(false);
      const d = actor.anim.death;
      if (ctx && ctx.dir) d.dir.copy(ctx.dir); else d.dir.set(Math.sin(actor.yaw), 0, Math.cos(actor.yaw));
      d.t = 0;
      actor.anim.mode = 'death'; actor.anim.modeT = null;
      actor.cameraLow = false; actor.exposed = true;
    },
    update(dt) {
      this.t += dt;
      actor.anim.mode = 'death'; actor.anim.death.t = this.t;
      actor.cameraProfile = 'explore';
      actor.vel.y = Math.max(actor.vel.y - pg('player.jump.gravity') * dt, -pg('player.fall.terminal'));
      const res = ctrl.move(0, actor.vel.y * dt, 0);
      if (res.grounded) actor.vel.y = 0;
      return true;
    },
    exit() { actor.alive = true; },
  };

  ctrl.registerMode('ground', ground);
  ctrl.registerMode('roll', roll);
  ctrl.registerMode('air', air);
  ctrl.registerMode('mantle', mantle);
  ctrl.registerMode('dead', dead);
  ctrl.registerMode('cover', createCoverMode(game, actor, ctrl));
  ctrl.health = createHealth(game, actor, ctrl);

  // ---------------------------------------------------------------------------------------------- weapons glue
  function cancelGrenade() {
    if (game.grenades && game.grenades.cancel) game.grenades.cancel(actor);
    ctrl.grenadeAiming = false;
  }

  let weaponLookupFrame = -1;
  function resolveWeapon() {
    if (actor.weapon || game.frame - weaponLookupFrame < 30) return;
    weaponLookupFrame = game.frame;
    const m = game.modules || {};
    for (const k in m) if (m[k] && typeof m[k].ensurePlayerWeapon === 'function') { m[k].ensurePlayerWeapon(game); if (actor.weapon) return; }
    for (const k in m) {
      const fn = m[k] && m[k].createWeapon;
      if (typeof fn === 'function') { actor.weapon = fn(game, actor, 'pistol'); break; }
    }
  }

  function weaponsStep(dt) {
    const inp = game.input, caps = ctrl.caps, w = actor.weapon;
    if (w) {
      if (w.setAim) w.setAim(caps.fireMode === 'aim');
      if (w.setBlind) w.setBlind(caps.fireMode === 'blind');
      let trig = false;
      if (caps.allowFire) {
        if (inp.pressed('fire')) ctrl.bufferedFireT = game.time;
        if (caps.fireReady) {
          trig = inp.down('fire');
          // a press made before fire-ready (pop-up aim, PS §4 fireReadyT) still fires, within the input buffer
          if (!trig && ctrl.bufferedFireT > ctrl.lastShotT && game.time - ctrl.bufferedFireT <= pg('player.inputBuffer') + pg('cover.popAim.fireReadyT')) {
            trig = !w.state || !w.state.trigger;
            ctrl.bufferedFireT = -1e9;
          }
        }
      }
      if (trig && caps.fireMode === 'hip' && inp.pressed('fire')) ctrl.lastHipT = game.time;
      if (w.setTrigger) w.setTrigger(trig);
      if (caps.allowReload && inp.pressed('reload') && w.reload) w.reload();
      if (w.update) w.update(dt);       // idempotent per step (B2); fires this step's press now
    }
    const G = game.grenades;
    if (G) {
      if (ctrl.grenadeAiming) {
        if (!caps.allowGrenade) cancelGrenade();
        else if (!inp.down('grenade')) { if (G.release) G.release(actor); ctrl.grenadeAiming = false; ctrl.throwT = game.time; }
        else if (game.cameraRig && G.updateAim) { game.cameraRig.aimRay(ray); G.updateAim(actor, ray.dir); }
      } else if (caps.allowGrenade && inp.pressed('grenade') && !(w && w.state && w.state.reloading) && G.beginAim) {
        if (G.beginAim(actor)) {
          ctrl.grenadeAiming = true;
          if (game.cameraRig && G.updateAim) { game.cameraRig.aimRay(ray); G.updateAim(actor, ray.dir); }
        }
      }
      ctrl.lookScale = ctrl.grenadeAiming ? (G.lookScale ? G.lookScale(actor) : 0.6) : 1;
    }
  }

  // shot / damage feed: fireT, combat flag
  game.events.on('shot', (e) => {
    if (e && e.shooter === actor) { ctrl.lastShotT = game.time; ctrl.lastCombatT = game.time; }
  });

  // ---------------------------------------------------------------------------------------------- anim common
  const throwAction = { type: 'throw', t: 0 }, throwAimAction = { type: 'throwAim', t: 0 }, reloadAction = { type: 'reload', t: 0 };
  const aimPt = V();
  function animCommon(dt) {
    const a = actor.anim, w = actor.weapon, caps = ctrl.caps;
    a.time = ctrl.modeT;
    a.speed = Math.hypot(actor.vel.x, actor.vel.z);
    const s = Math.sin(actor.yaw), c = Math.cos(actor.yaw);
    a.localVel.x = actor.vel.x * c - actor.vel.z * s;    // +x = character's left (local +X)
    a.localVel.z = actor.vel.x * s + actor.vel.z * c;    // +z = forward
    a.fireT = game.time - ctrl.lastShotT;
    // action
    const gs = game.grenades && game.grenades.stateOf ? game.grenades.stateOf(actor) : null;
    if (w && w.state && w.state.reloading) { reloadAction.t = w.state.reloadDur ? clamp(w.state.reloadT / w.state.reloadDur, 0, 1) : 0; a.action = reloadAction; }
    else if (ctrl.grenadeAiming) { throwAimAction.t = 0; a.action = throwAimAction; }
    else if (gs && gs.phase === 'throwing') { throwAction.t = clamp(gs.t / 0.4, 0, 1); a.action = throwAction; }
    else if (game.time - ctrl.throwT < 0.4) { throwAction.t = (game.time - ctrl.throwT) / 0.4; a.action = throwAction; }
    else a.action = null;
    // aim: on while aimed fire / grenade aim / a recent hip shot; yaw relative to the body, pitch absolute (rad),
    // both pointing from the chest at what the reticle ray hits (convergence)
    const want = caps.fireMode === 'aim' || caps.fireMode === 'blind' || ctrl.grenadeAiming
      || (caps.fireMode === 'hip' && game.time - ctrl.lastHipT < pg('player.hipFire.faceT'));
    const bt = pg('player.aimBlendT');
    a.aim.weight = clamp(a.aim.weight + (want ? dt : -dt) / bt, 0, 1);
    a.aim.on = want;
    if ((want || a.aim.weight > 0) && game.cameraRig) {
      game.cameraRig.aimRay(ray);
      const hit = game.world ? game.world.raycast(ray.origin, ray.dir, 80, castOpts) : null;
      if (hit) aimPt.copy(hit.point); else aimPt.copy(ray.origin).addScaledVector(ray.dir, 50);
      const dx = aimPt.x - actor.pos.x, dy = aimPt.y - (actor.pos.y + 1.4), dz = aimPt.z - actor.pos.z;
      a.aim.yaw = wrapPi(Math.atan2(dx, dz) - actor.yaw);
      a.aim.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    }
    // hit reaction clock (health.js sets dir/part and zeroes t)
    a.hit.t += dt;
  }

  // ---------------------------------------------------------------------------------------------- the system
  const sys = {
    name: 'player', order: ORDER.player,
    update(dt) {
      const inp = game.input;
      if (!inp) return;
      const rig = game.cameraRig;
      ctrl.camYaw = rig ? rig.yaw : actor.yaw;
      // camera-relative stick in world XZ: forward = (sin cy, cos cy), right = (-cos cy, sin cy)
      const m = inp.axis('move');
      const sy = Math.sin(ctrl.camYaw), cy = Math.cos(ctrl.camYaw);
      const st = ctrl.stick;
      st.x = sy * m.y - cy * m.x; st.z = cy * m.y + sy * m.x;
      st.mag = Math.min(1, Math.hypot(m.x, m.y));
      if (st.mag > 1e-6) { const l = Math.hypot(st.x, st.z); st.dx = st.x / l; st.dz = st.z / l; }
      resolveWeapon();
      ensureRig();
      ctrl.inCombat = game.time - ctrl.lastCombatT < pg('camera.combat.holdT') || !!(game.ai && (game.ai.inCombat === true || game.ai.combat === true));
      if (ctrl.inCombat !== ctrl._hudCombat && game.hud && typeof game.hud.setCombat === 'function') { ctrl._hudCombat = ctrl.inCombat; game.hud.setCombat(ctrl.inCombat); }
      if (ctrl.health) ctrl.health.update(dt);
      const caps = ctrl.caps;
      caps.allowFire = false; caps.fireReady = false; caps.allowReload = false; caps.allowGrenade = false; caps.fireMode = 'none';
      // mode update; a mode that changes mode before moving hands the same step to the new mode
      for (let i = 0; i < 3; i++) {
        const name = ctrl.mode;
        ctrl._changed = false;
        const moved = modes[name].update(dt);
        if (!ctrl._changed || moved) break;
      }
      ctrl.modeT += dt;
      weaponsStep(dt);
      if (rig) rig.lookScale = ctrl.lookScale;
      animCommon(dt);
    },
  };
  game.addSystem(sys);
  ctrl.system = sys;

  // B2's weapons module stands its own input driver down (weapon.player.autoInput 'auto') once game.player.ctrl exists:
  // this controller drives the pistol and grenades with the mode rules (pop-up fire-ready, lean only at an edge,
  // blind fire only without aim).

  game.actors.push(actor);
  game.player = actor;
  return actor;
}

// main.js boot entry: the player, then the camera rig (camera.js's own install is then a no-op).
export function install(game) {
  const actor = createPlayer(game);
  const rig = installCamera(game);
  rig.actor = actor;
  rig.yaw = actor.yaw;
  rig.snap();
  return actor;
}
