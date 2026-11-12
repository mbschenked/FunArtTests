// Climbing (B3): jump-to-grab, air catch, mantle/vault detection, and the 'climb' controller mode (hang, shimmy,
// corners, reach, lunge, climb-up, drop, drop-to-hang, look-back/jump-back, one-handed hang-aim).
// Contract: refs/design.md "player/*" (mode plug-ins) and "character/* animState.climb". Spec: refs/climb-spec.md.
// No static 'three' import, so node can unit-test it (tests/climb.test.mjs); the edge highlight imports three lazily.
//
//   install(game) -> game.climb
//   game.climb.canGrab(actor, {fromAir, intentDir, dropFromTop}) -> grab | null
//       Ground mode: call on Jump (fromAir false). Air mode: call every step while airborne (fromAir true).
//       Ground mode, Drop (`cover`) at a top edge or walking off one slowly: {dropFromTop: true}.
//       grab = {type: 'hang'|'mantle'|'vault'|'dropToHang', from: 'ground'|'air'|'top', mode: 'climb', edge, edgeId,
//               s, height, point, normal, standPos, farPos, top, speed}. The object is REUSED per actor: route it at
//               once with ctrl.setMode('climb', {grab}).
//   game.climb.createMode(actor) -> {enter(from, ctx), update(dt), exit(to)}   (also .mode(actor); cached per actor)
//   game.climb.attach(actor)      registers that mode on actor.ctrl as 'climb' (done lazily for game.player too)
//   game.climb.state(actor) -> sub-state name ('none' when not climbing); game.climb.data -> ClimbData
//   game.climb.rebuild()          re-read game.level.climb (after the room changes its markup)
//
// While the mode is active it is the ONLY writer of actor.pos / actor.yaw (spec §8: a grab owns the body), keeps
// actor.vel at zero, and writes:
//   actor.anim.climb = {active, pose ('hang'|'shimmy'|'reach'|'climbup'|'drop'|'hangAim' - the contract list), move
//       (the detailed sub-state), t (0..1 progress), dir (world move dir), handL, handR (world targets), gripL, gripR,
//       footL, footR, freeHang, normal (wall, outward), swing {x along wall-right, z out from wall}, extend (0..1 arm
//       reach feedback), lead ('L'|'R'), aim (0..1 hang-aim blend), aimYaw}
//   actor.cameraProfile = 'climb' | 'hangAim' | null (B1's camera rig reads it); actor.climbCam = {target, normal, moveDir}
//   actor.hangAim = true while entering/holding the hang-aim (weapon + camera read it); actor.hangAimLimits
//   'state' events {actor, sys: 'climb', from, to, t: game.time} on every sub-state transition (incl. 'none' <-> x).
// Exits: climb-up/mantle/vault -> ctrl.setMode('ground', {from:'climb'}); drop/jump-back -> ctrl.setMode('air',
// {from:'climb', vel}) with actor.vel set. Drop ignores the released edge for climb.catch.regrabDelay.
import { ORDER } from '../core/game.js';
import { ClimbData, Vec3 } from './climb-data.js';

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (u) => { u = clamp01(u); return u * u * (3 - 2 * u); };
const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const lerpAngle = (a, b, t) => a + wrapPi(b - a) * t;
const EPS_T = 1e-6;
const ZERO = Object.freeze({ x: 0, y: 0, z: 0 });
const PROBE_LOW = Object.freeze({ rays: 3, spread: 0.3 });
const RAY_STATIC = Object.freeze({ hitActors: false });

// Sub-state -> the animator contract's pose list (design.md animState.climb.pose).
const POSE = {
  none: 'hang', jumpGrab: 'reach', catch: 'hang', hang: 'hang', lean: 'reach', lookBack: 'hang', shimmy: 'shimmy',
  corner: 'shimmy', reach: 'reach', lunge: 'reach', jumpBack: 'reach', climbUp: 'climbup', climbUpStand: 'climbup',
  settle: 'hang', drop: 'drop', dropToHang: 'hang', hangAimEnter: 'hangAim', hangAim: 'hangAim', hangAimExit: 'hangAim',
  mantle: 'climbup', vault: 'climbup',
};
const ON_WALL = new Set(['hang', 'lean', 'lookBack', 'shimmy', 'corner']);

// ------------------------------------------------------------------------------------------------ params
// Every number from refs/climb-spec.md, with its section and confidence. [MEASURED-WA] marks values measured from
// footage downloaded with the yt-dlp workaround (spec top note: kuieMoIemgc, q4rzkzjAKt4, 1SnMfyV5hXM). They are
// grouped in one block below so they can be re-tagged [INFERRED] (and re-timed with protocol P5/P6) in one place.
export function defineClimbParams(P) {
  const d = (k, v, min, max, step, label) => P.define(k, v, { min, max, step, label });
  // --- [MEASURED-WA] block: workaround footage. Re-tag here if only normally-obtained data is kept. -------------
  d('climb.shimmy.speed', 1.3, 0.3, 3, 0.05, 'shimmy m/s');            // §3 kuieMoIemgc 6.2-7.6 s, ±30% [MEASURED-WA]
  d('climb.hangAim.enter', 0.18, 0.05, 0.6, 0.01, 'aim enter s');      // §5 kuieMoIemgc 10.27-10.43 s (0.15-0.20) [MEASURED-WA]
  d('climb.hangAim.exit', 0.30, 0.05, 0.8, 0.01, 'aim exit s');        // §5 kuieMoIemgc 4.53-4.83 s [MEASURED-WA]
  d('climb.hangAim.rise', 0.65, 0, 1.0, 0.01, 'aim body rise m');      // §5 11.45 s frame: chest at lip (hang drop 2.0 - chest 1.35) [MEASURED-WA rough]
  d('climb.dropToHang.time', 0.30, 0.1, 1, 0.01, 'drop-to-hang s');    // §2 proxy = the hang-aim exit (kuieMoIemgc) [MEASURED-WA proxy]
  // --- [MEASURED] normal-client footage (h2KpeldU3nU first 55 s, Spv14WGA9MU) --------------------------------------
  d('climb.reach.shift', 0.05, 0, 0.2, 0.01, 'reach weight shift s');  // §7 beat split of the 0.43 s cycle [INFERRED split]
  d('climb.reach.lead', 0.25, 0.1, 0.6, 0.01, 'reach lead hand s');    // §3 0.25-0.30 lead; §7 0.05-0.30 [MEASURED h2K]
  d('climb.reach.follow', 0.13, 0, 0.4, 0.01, 'reach follow hand s');  // §3 follow lag 0.10-0.15; cycle 0.43 total [MEASURED h2K]
  d('climb.reach.gain', 0.6, 0.2, 1.2, 0.05, 'typical gain m');        // §1 ≈0.6 m per reach (cycle measured at this gain) [MEASURED h2K ±25%]
  d('climb.climbUp.crouch', 0.65, 0.3, 1.5, 0.01, 'to crouch s');      // §3 h2K 52.40-53.05 s [MEASURED ±0.05]
  d('climb.climbUp.stand', 1.0, 0.5, 2, 0.01, 'to standing s');       // §3 0.9-1.2, h2K + pillar [MEASURED]
  d('climb.jumpGrab.timeMin', 0.20, 0.1, 0.5, 0.01, 'grab air s (low)');// §2 hop-to-wall catch h2K 50.87-51.07 s [MEASURED ±0.033]
  d('climb.jumpGrab.load', 0.10, 0, 0.3, 0.01, 'takeoff load s');      // §4 crouch-load 0.10-0.15 (gap jump) [MEASURED rough]
  d('climb.hang.drop', 2.0, 1.5, 2.4, 0.01, 'hands-to-feet m');        // spec protocol: hanging hands-to-feet ≈2.0 m [MEASURED calibration]
  // --- [DEV] ------------------------------------------------------------------------------------------------------
  d('climb.entry.jumpGrabMax', 3.5, 2, 4.5, 0.05, 'jump-grab max m');  // §2 Schatz via 80.lv [DEV]
  d('climb.entry.deadMin', 3.25, 2.5, 4.5, 0.05, 'dead zone from m');  // §2 Schatz via 80.lv [DEV]
  d('climb.entry.deadMax', 4.0, 3, 5, 0.05, 'dead zone to m');         // §2 Schatz via 80.lv [DEV]
  // --- [INFERRED] / [WIKI] ----------------------------------------------------------------------------------------
  d('climb.entry.stepMax', 0.5, 0.2, 0.8, 0.01, 'step-up max m');      // §2 "knee-height" [WIKI, value INFERRED]
  d('climb.entry.avoidMin', 0.5, 0, 1, 0.05, 'avoid band from m');     // §2 ND ambiguity rule (TLOU2) [INFERRED]
  d('climb.entry.avoidMax', 0.8, 0, 1.5, 0.05, 'avoid band to m');     // §2 [INFERRED]
  d('climb.entry.vaultMax', 1.1, 0.6, 1.6, 0.05, 'vault max m');       // §2 [INFERRED]
  d('climb.entry.vaultDepth', 0.8, 0.2, 2, 0.05, 'vault max depth m'); // §2 "thin obstacle" [INFERRED]
  d('climb.entry.vaultSpeed', 2.5, 0.5, 6, 0.1, 'vault min speed');    // §2 "running" [INFERRED]
  d('climb.entry.mantleMax', 1.6, 1, 2.2, 0.05, 'mantle max m');       // §2 mantle 0.8-1.6, low-ledge choice ≤1.6 [INFERRED]
  d('climb.entry.mantleReach', 0.6, 0.2, 1.5, 0.05, 'mantle reach m'); // §2 facing wall within 0.6 m [INFERRED]
  d('climb.entry.jumpGrabMin', 1.6, 1, 2.5, 0.05, 'jump-grab min m');  // §2 below this it is a mantle [INFERRED]
  d('climb.entry.reachStand', 1.0, 0.3, 2, 0.05, 'grab reach stand m');// §2 ≤1.0 standing [INFERRED]
  d('climb.entry.reachRun', 2.0, 0.5, 3, 0.05, 'grab reach run m');    // §2 ≤2.0 running [INFERRED]
  d('climb.entry.runSpeed', 2.5, 0.5, 6, 0.1, 'running from m/s');     // threshold for the run reach [INFERRED]
  d('climb.entry.facingCone', 60, 10, 90, 1, 'facing cone deg');       // [INFERRED]
  d('climb.jumpGrab.time3m', 0.45, 0.2, 0.9, 0.01, 'grab air s @3 m'); // §2 takeoff -> hands set, 3 m edge [INFERRED]
  d('climb.catch.handHeight', 2.1, 1.6, 2.5, 0.01, 'hands above feet m');// arms-up hand height while falling [INFERRED]
  d('climb.catch.band', 0.35, 0.1, 0.8, 0.01, 'catch band m');         // §2 hands 0..+0.35 above the edge [INFERRED]
  d('climb.catch.front', 0.5, 0.1, 1, 0.01, 'catch front m');          // §2 ≤0.5 m in front of the chest [INFERRED]
  d('climb.catch.maxFall', 7, 2, 20, 0.5, 'catch max fall m/s');       // §2 until fall speed > 7 m/s [INFERRED]
  d('climb.catch.settle', 0.10, 0, 0.4, 0.01, 'catch settle s');       // air catch blend into the hang [INFERRED]
  d('climb.catch.regrabDelay', 0.3, 0, 1, 0.01, 'regrab delay s');     // ignore the edge just released [INFERRED]
  d('climb.catch.dropTopBack', 0.8, 0.2, 1.5, 0.05, 'drop-from-top reach m'); // how far back from the lip a drop works [INFERRED]
  d('climb.hang.offset', 0.30, 0, 0.6, 0.01, 'body out from lip m');   // feet line out from the grip line [INFERRED]
  d('climb.hang.barOffset', 0.0, -0.2, 0.4, 0.01, 'bar body offset m');// free hang under a bar [INFERRED]
  d('climb.hang.handSpread', 0.45, 0.1, 0.8, 0.01, 'hand spread m');   // shoulder-width grip [INFERRED]
  d('climb.move.deadzone', 0.3, 0.05, 0.8, 0.01, 'stick deadzone');    // §1 [INFERRED]
  d('climb.reach.coneHalf', 40, 10, 80, 1, 'search cone half deg');    // §1 [INFERRED]
  d('climb.reach.classHalf', 30, 10, 45, 1, 'dir class half deg');     // §1 up/down/side ±30 [spec rule]
  d('climb.reach.wAng', 1, 0, 3, 0.05, 'score angle weight');          // §1 score [INFERRED]
  d('climb.reach.wDist', 1, 0, 3, 0.05, 'score dist weight');          // §1 score [INFERRED]
  d('climb.reach.maxUp', 0.9, 0.3, 1.5, 0.05, 'reach max up m');       // §1 [INFERRED]
  d('climb.reach.maxSide', 0.8, 0.3, 1.5, 0.05, 'reach max side m');   // §1 [INFERRED]
  d('climb.reach.maxDown', 0.7, 0.3, 1.5, 0.05, 'reach max down m');   // §1 [INFERRED]
  d('climb.reach.maxDiag', 0.8, 0.3, 1.5, 0.05, 'reach max diag m');   // §1 [INFERRED]
  d('climb.reach.smallScale', 0.7, 0.3, 1, 0.05, 'small-hold speed x');// §1 slower on small holds [DEV behaviour, INFERRED value]
  d('climb.reach.bulge', 0.12, 0, 0.3, 0.01, 'hand arc bulge m');      // §7 0.10-0.15 [INFERRED]
  d('climb.lunge.maxUp', 1.6, 0.8, 3, 0.05, 'lunge max up m');         // §1 [INFERRED]
  d('climb.lunge.maxSide', 2.0, 0.8, 3, 0.05, 'lunge max side m');     // §1 [INFERRED]
  d('climb.lunge.maxDown', 2.5, 0.8, 4, 0.05, 'lunge max down m');     // §1 [INFERRED]
  d('climb.lunge.maxDiag', 1.6, 0.8, 3, 0.05, 'lunge max diag m');     // not in spec: min(up, side) [INFERRED]
  d('climb.lunge.load', 0.10, 0, 0.3, 0.01, 'lunge load s');           // §3 anticipation [INFERRED]
  d('climb.lunge.airMin', 0.35, 0.15, 0.8, 0.01, 'lunge air s @1 m');  // §3 0.35-0.45 for 1-2 m [INFERRED]
  d('climb.lunge.airMax', 0.45, 0.15, 0.9, 0.01, 'lunge air s @2 m');  // §3 [INFERRED]
  d('climb.lunge.catchLag', 0.12, 0, 0.3, 0.01, 'second hand lag s');  // §7 0.10-0.15 [INFERRED]
  d('climb.shimmy.accel', 0.15, 0.01, 0.6, 0.01, 'shimmy accel s');    // §3 [INFERRED]
  d('climb.shimmy.stop', 0.10, 0.01, 0.6, 0.01, 'shimmy stop s');      // §3 [INFERRED]
  d('climb.shimmy.probe', 0.2, 0, 0.5, 0.01, 'obstacle probe m');      // §3 the private reference project 12/22 cm probes [INFERRED]
  d('climb.shimmy.step', 0.3, 0.1, 0.6, 0.01, 'hand step m');          // hand-over-hand step length [INFERRED]
  d('climb.jumpBuffer', 0.2, 0, 0.5, 0.01, 'jump buffer s');           // §3 the private reference project 0.2 s impulse [INFERRED]
  d('climb.climbUp.lock', 0.25, 0, 1, 0.01, 'cancel window s');        // §3 not cancellable after 0.25 s [INFERRED]
  d('climb.climbUp.inset', 0.4, 0.1, 1, 0.01, 'stand inset m');        // spec data format: 0.4 m inward [INFERRED]
  d('climb.jumpBack.delay', 0.15, 0, 0.6, 0.01, 'look-back delay s');  // §3 [INFERRED]
  d('climb.jumpBack.maxDist', 2.5, 0.5, 4, 0.05, 'jump-back max m');   // §3 [INFERRED]
  d('climb.jumpBack.safeDrop', 6.0, 0.5, 10, 0.1, 'safe drop m');      // §4 hard land 2-6 m has no damage [INFERRED]
  d('climb.jumpBack.out', 2.5, 0, 6, 0.1, 'push-off out m/s');         // free leap velocity [INFERRED]
  d('climb.jumpBack.up', 3.5, 0, 6, 0.1, 'push-off up m/s');           // ~0.34 m rise at g 18 [INFERRED]
  d('climb.corner.blend', 0.25, 0.05, 0.6, 0.01, 'corner blend m');    // normal blend across a vertex [INFERRED]
  d('climb.mantle.time', 0.55, 0.2, 1.5, 0.01, 'mantle s');            // not in spec [INFERRED]
  d('climb.vault.time', 0.50, 0.2, 1.5, 0.01, 'vault s');              // not in spec [INFERRED]
  d('climb.hangAim.yaw', 70, 10, 120, 1, 'aim yaw limit deg');         // §5 ±70 from the wall normal [INFERRED]
  d('climb.hangAim.pitchMin', -20, -60, 0, 1, 'aim pitch min deg');    // §5 [INFERRED]
  d('climb.hangAim.pitchMax', 45, 0, 80, 1, 'aim pitch max deg');      // §5 [INFERRED]
  d('climb.hangAim.spread', 1.2, 1, 2, 0.05, 'aim spread x');          // §5 accuracy ×1.2 (weapons read it) [INFERRED]
  d('climb.anim.pendK0', 25, 1, 120, 1, 'swing stiffness idle');       // §7 Mach loose profile [DEV concept, INFERRED value]
  d('climb.anim.pendK1', 60, 1, 200, 1, 'swing stiffness active');     // §7 stiff profile [DEV concept, INFERRED value]
  d('climb.anim.pendZ0', 0.25, 0, 1.5, 0.01, 'swing damping idle');    // §7 [INFERRED]
  d('climb.anim.pendZ1', 0.5, 0, 1.5, 0.01, 'swing damping active');   // §7 [INFERRED]
  d('climb.anim.kick', 0.6, 0, 2, 0.05, 'swing kick scale');           // move velocity injected into the swing [INFERRED]
  d('climb.anim.footBand0', 0.9, 0.3, 2, 0.05, 'foothold band from m');// §7 0.9-1.3 below hands [INFERRED]
  d('climb.anim.footBand1', 1.3, 0.3, 2, 0.05, 'foothold band to m');  // §7 [INFERRED]
  d('climb.anim.leanMax', 0.08, 0, 0.2, 0.01, 'feedback lean m');      // §7 up to 8 cm [INFERRED]
  d('climb.anim.armExtend', 0.7, 0, 1, 0.05, 'feedback arm extend');   // §7 up to 70% toward the stick [INFERRED]
  d('climb.anim.reachOut', 0.3, 0.05, 0.6, 0.01, 'feedback hand max m');// a hanging arm is near straight: lift-off cap [INFERRED]
  d('climb.anim.handUp', 0.03, -0.1, 0.1, 0.005, 'hand above lip m');  // fingers over the lip (visual) [INFERRED]
  d('climb.anim.handIn', 0.04, -0.1, 0.15, 0.005, 'hand into wall m'); // (visual) [INFERRED]
  P.define('climb.highlight', true, { label: 'edge highlight' });      // §1 white line on every grab edge [DEV rule]
  d('climb.highlightOpacity', 0.32, 0, 1, 0.01, 'highlight opacity');  // "subtle" [INFERRED]
  P.define('climb.debug', false, { label: 'show move target' });
}

// Resolved numbers for one step (angles in radians). One object, refilled in place.
export function readClimbCfg(P, c = {}) { return readCfg(P, c); }
let _P = null;                                                       // no closure per step: readCfg runs every sim step
function g(k) { return _P.get(k); }
function readCfg(P, c) {
  _P = P;
  c.stepMax = g('climb.entry.stepMax'); c.avoidMin = g('climb.entry.avoidMin'); c.avoidMax = g('climb.entry.avoidMax');
  c.vaultMax = g('climb.entry.vaultMax'); c.vaultDepth = g('climb.entry.vaultDepth'); c.vaultSpeed = g('climb.entry.vaultSpeed');
  c.mantleMax = g('climb.entry.mantleMax'); c.mantleReach = g('climb.entry.mantleReach');
  c.jumpGrabMin = g('climb.entry.jumpGrabMin'); c.jumpGrabMax = g('climb.entry.jumpGrabMax');
  c.deadMin = g('climb.entry.deadMin'); c.deadMax = g('climb.entry.deadMax');
  c.reachStand = g('climb.entry.reachStand'); c.reachRun = g('climb.entry.reachRun'); c.runSpeed = g('climb.entry.runSpeed');
  c.facingCone = g('climb.entry.facingCone') * DEG;
  c.grabLoad = g('climb.jumpGrab.load'); c.grabTimeMin = g('climb.jumpGrab.timeMin'); c.grabTime3m = g('climb.jumpGrab.time3m');
  c.catchHandHeight = g('climb.catch.handHeight'); c.catchBand = g('climb.catch.band'); c.catchFront = g('climb.catch.front');
  c.catchMaxFall = g('climb.catch.maxFall'); c.catchSettle = g('climb.catch.settle'); c.regrabDelay = g('climb.catch.regrabDelay');
  c.dropTopBack = g('climb.catch.dropTopBack'); c.dropToHang = g('climb.dropToHang.time');
  c.hangDrop = g('climb.hang.drop'); c.hangOffset = g('climb.hang.offset'); c.barOffset = g('climb.hang.barOffset');
  c.handSpread = g('climb.hang.handSpread');
  c.moveDeadzone = g('climb.move.deadzone'); c.coneHalf = g('climb.reach.coneHalf') * DEG; c.classHalf = g('climb.reach.classHalf') * DEG;
  c.wAng = g('climb.reach.wAng'); c.wDist = g('climb.reach.wDist');
  c.reachUp = g('climb.reach.maxUp'); c.reachSide = g('climb.reach.maxSide'); c.reachDown = g('climb.reach.maxDown'); c.reachDiag = g('climb.reach.maxDiag');
  c.reachShift = g('climb.reach.shift'); c.reachLead = g('climb.reach.lead'); c.reachFollow = g('climb.reach.follow');
  c.reachGain = g('climb.reach.gain'); c.smallScale = g('climb.reach.smallScale'); c.bulge = g('climb.reach.bulge');
  c.lungeUp = g('climb.lunge.maxUp'); c.lungeSide = g('climb.lunge.maxSide'); c.lungeDown = g('climb.lunge.maxDown'); c.lungeDiag = g('climb.lunge.maxDiag');
  c.lungeLoad = g('climb.lunge.load'); c.lungeAirMin = g('climb.lunge.airMin'); c.lungeAirMax = g('climb.lunge.airMax'); c.catchLag = g('climb.lunge.catchLag');
  c.shimmySpeed = g('climb.shimmy.speed'); c.shimmyAccel = g('climb.shimmy.accel'); c.shimmyStop = g('climb.shimmy.stop');
  c.shimmyProbe = g('climb.shimmy.probe'); c.shimmyStep = g('climb.shimmy.step');
  c.jumpBuffer = g('climb.jumpBuffer');
  c.climbCrouch = g('climb.climbUp.crouch'); c.climbStand = g('climb.climbUp.stand'); c.climbLock = g('climb.climbUp.lock'); c.topInset = g('climb.climbUp.inset');
  c.jumpBackDelay = g('climb.jumpBack.delay'); c.jumpBackMax = g('climb.jumpBack.maxDist'); c.safeDrop = g('climb.jumpBack.safeDrop');
  c.jumpBackOut = g('climb.jumpBack.out'); c.jumpBackUp = g('climb.jumpBack.up');
  c.cornerBlend = g('climb.corner.blend');
  c.mantleTime = g('climb.mantle.time'); c.vaultTime = g('climb.vault.time');
  c.aimEnter = g('climb.hangAim.enter'); c.aimExit = g('climb.hangAim.exit'); c.aimRise = g('climb.hangAim.rise');
  c.aimYaw = g('climb.hangAim.yaw') * DEG; c.aimPitchMin = g('climb.hangAim.pitchMin') * DEG; c.aimPitchMax = g('climb.hangAim.pitchMax') * DEG;
  c.pendK0 = g('climb.anim.pendK0'); c.pendK1 = g('climb.anim.pendK1'); c.pendZ0 = g('climb.anim.pendZ0'); c.pendZ1 = g('climb.anim.pendZ1');
  c.kick = g('climb.anim.kick'); c.footBand0 = g('climb.anim.footBand0'); c.footBand1 = g('climb.anim.footBand1');
  c.leanMax = g('climb.anim.leanMax'); c.armExtend = g('climb.anim.armExtend'); c.reachOut = g('climb.anim.reachOut'); c.handUp = g('climb.anim.handUp'); c.handIn = g('climb.anim.handIn');
  return c;
}

// ------------------------------------------------------------------------------------------------ the mode
class ClimbMode {
  constructor(sys, actor) {
    this.sys = sys; this.game = sys.game; this.actor = actor;
    const V = (actor.pos && actor.pos.constructor) || Vec3;
    this.V = V;
    const v = () => new V(0, 0, 0);
    this.sub = 'none'; this.t = 0; this.dur = 0;
    this.edge = null; this.s = 0; this.spread = 0.45;
    this.vel = 0; this.phase = 0; this.lastLatched = 'R'; this.lastLead = 'R'; this.lead = 'L';
    this.toEdge = null; this.toS = 0; this.toSpread = 0.45; this.toDist = 0;
    this.tShift = 0; this.tLead = 0; this.tFollow = 0; this.load = 0; this.air = 0;
    this.p0 = v(); this.p1 = v(); this.p2 = v(); this.yaw0 = 0; this.yaw1 = 0;
    this.h0L = v(); this.h0R = v(); this.h1L = v(); this.h1R = v();
    this.jumpT = -1e9; this.awayT = 0; this.enterFrame = -1; this.ignoreEdge = null; this.ignoreUntil = -1e9;
    this.feedAmt = 0; this.feedU = 0; this.feedV = 0; this.feedEdge = null; this.feedS = 0;
    this.swing = { x: 0, vx: 0, z: 0, vz: 0 };
    this.exitTo = null; this.exitSpeed = 0; this.exitDirX = 0; this.exitDirZ = 0;
    this.move = { type: 'none', edge: null, s: 0, dist: 0, cls: 'none', needsJump: false, dir: 0, du: 0, dv: 0 };
    this.entry = { edge: null, s: 0, dist: 0, h: 0 };
    this.foot = { edge: null, s: 0 };
    this.slideOut = { s: 0, endReached: false };
    this.grab = {
      type: null, from: null, mode: 'climb', edge: null, edgeId: null, s: 0, height: 0, dist: 0,
      point: v(), normal: v(), standPos: v(), farPos: v(), top: 0, speed: 0, dirX: 0, dirZ: 1,
    };
    this._a = v(); this._b = v(); this._n = new Vec3(); this._r = new Vec3(); this._p = new Vec3(); this._q = new Vec3();
    this._ray = v(); this._rayDir = v();
    const anim = actor.anim || (actor.anim = {});
    this.anim = anim.climb = {
      active: false, pose: 'hang', move: 'none', t: 0, dir: v(), handL: v(), handR: v(), gripL: true, gripR: true,
      footL: v(), footR: v(), freeHang: false, normal: v(), swing: { x: 0, z: 0 }, extend: 0, lead: 'L', aim: 0, aimYaw: 0,
    };
    this.cam = actor.climbCam = { target: v(), normal: v(), moveDir: v() };
    this.limits = { centerYaw: 0, yaw: 70 * DEG, pitchMin: -20 * DEG, pitchMax: 45 * DEG };
    this.impl = {
      enter: (from, ctx) => this.enter(from, ctx),
      update: (dt) => this.update(dt),
      exit: (to) => this.exit(to),
      climb: this,
    };
  }

  get cfg() { return this.sys.cfg; }
  get data() { return this.sys.data; }
  input() { return this.actor.input || this.game.input; }

  setSub(name, dur = 0) {
    const from = this.sub;
    this.sub = name; this.t = 0; this.dur = dur;
    this.game.events.emit('state', { actor: this.actor, sys: 'climb', from, to: name, t: this.game.time, edge: this.edge ? this.edge.id : null });
  }

  // ---------------------------------------------------------------- geometry helpers
  facingYaw(n) { return Math.atan2(-n.x, -n.z); }

  // Feet position while hanging at grip centre s on edge (+ extra rise). Floor-clamped for low ledges.
  hangPos(edge, s, out, rise = 0) {
    const c = this.cfg, d = this.data;
    const p = d.pointAt(edge, s, this._p);
    const n = d.normalAt(edge, s, c.cornerBlend, this._n);
    let off = edge.kind === 'bar' ? c.barOffset : c.hangOffset;
    // keep clear of both walls near a polyline corner: offset / cos(blend angle)
    const g = edge.segs[d.segIndex(edge, s)];
    const cosA = n.x * g.nx + n.z * g.nz;
    if (cosA < 0.999) off /= Math.max(0.6, cosA);
    out.set(p.x + n.x * off, p.y - c.hangDrop + rise, p.z + n.z * off);
    const w = this.game.world;
    if (w && w.groundAt) {
      const gy = w.groundAt(out.x, out.z, p.y - 0.3);
      if (gy != null && out.y < gy + 0.02) out.y = gy + 0.02;
    }
    return out;
  }

  // World target of one hand gripping edge at centre s ('L' at s - spread/2, 'R' at s + spread/2).
  handPos(edge, s, side, spread, out, along = 0) {
    const c = this.cfg, d = this.data;
    const hs = s + (side === 'L' ? -spread / 2 : spread / 2) + along;
    const p = d.pointAt(edge, hs, this._q);
    const n = d.normalAt(edge, hs, c.cornerBlend, this._r);
    return out.set(p.x - n.x * c.handIn, p.y + c.handUp, p.z - n.z * c.handIn);
  }

  // Stick -> wall plane (spec §1): v = stick forward/back = up/down the wall, always (so "up" never drifts with the
  // camera yaw); u = stick left/right = along the wall as seen by the camera (sign flips only when the camera looks at
  // the wall from the other side). Camera right comes from B1's ctrl.camYaw, else the render camera, else the wall.
  wallStick(out) {
    const inp = this.input();
    const m = inp && inp.axis ? inp.axis('move') : null;
    out.x = 0; out.y = 0;
    if (!m || (m.x === 0 && m.y === 0)) return out;
    const n = this.data.normalAt(this.edge, this.s, this.cfg.cornerBlend, this._n);
    let rx = n.z, rz = -n.x;                                          // default: camera right = wall right
    const ctrl = this.actor.ctrl, cam = this.game.camera;
    if (ctrl && typeof ctrl.camYaw === 'number') { rx = -Math.cos(ctrl.camYaw); rz = Math.sin(ctrl.camYaw); }
    else if (cam && cam.matrixWorld) {
      const e = cam.matrixWorld.elements, l = Math.hypot(e[8], e[10]);
      if (l > 1e-3) { rx = e[10] / l; rz = -e[8] / l; }               // right = forward x up, forward = -column 2
    }
    const k = rx * n.z + rz * -n.x;                                   // dot(camera right, wall right)
    out.x = m.x * (k < -0.1 ? -1 : 1);
    out.y = m.y;
    return out;
  }

  // ---------------------------------------------------------------- mode interface
  enter(from, ctx) {
    const grab = (ctx && (ctx.grab || (ctx.type ? ctx : null))) || null;
    this.sys.refresh();
    // Sub-state clocks count steps after the entry step, whether or not the controller also updates this mode in the
    // entry step (B1 does after an air catch, not after a ground jump), so durations match the params exactly.
    this.enterFrame = this.game.frame;
    const a = this.actor;
    a.vel && a.vel.set(0, 0, 0);
    this.anim.active = true;
    this.swing.x = this.swing.vx = this.swing.z = this.swing.vz = 0;
    this.feedAmt = 0; this.vel = 0; this.awayT = 0; this.jumpT = -1e9; this.exitTo = null;
    if (!grab || !grab.type) {
      console.warn('[climb] setMode("climb") without a grab from game.climb.canGrab(); leaving');
      this.sub = 'none';
      this.requestExit('ground');
      return;
    }
    this.edge = grab.edge; this.s = grab.s;
    if (this.edge) this.spread = this.data.spreadOn(this.edge, this.cfg.handSpread);
    switch (grab.type) {
      case 'hang': grab.from === 'ground' ? this.startJumpGrab(grab) : this.startCatch(); break;
      case 'dropToHang': this.startDropToHang(); break;
      case 'mantle': this.startMantle(grab); break;
      case 'vault': this.startVault(grab); break;
      default: this.requestExit('ground');
    }
  }

  exit(to) {
    if (this.sub !== 'none') {
      const from = this.sub;
      this.sub = 'none';
      this.game.events.emit('state', { actor: this.actor, sys: 'climb', from, to: 'none', t: this.game.time, next: to });
    }
    const a = this.actor;
    a.hangAim = false; a.hangAimLimits = null; a.cameraProfile = null;
    this.anim.active = false; this.anim.aim = 0; this.anim.move = 'none';
  }

  requestExit(mode, ctx) {
    const ctrl = this.actor.ctrl;
    if (ctrl && ctrl.setMode) ctrl.setMode(mode, ctx || { from: 'climb', vel: this.actor.vel });
    else this.exit(mode);
  }

  // Returns true when the climb moved the actor this step (B1's convention: false lets the next mode run this step).
  update(dt) {
    if (this.sub === 'none') return false;
    this.sys.refresh();
    const inp = this.input();
    if (inp && inp.pressed && inp.pressed('jump')) this.jumpT = this.game.time;
    if (this.game.frame !== this.enterFrame) this.t += dt;
    this.step(dt);
    if (this.sub === 'none') return false;                           // exited this step
    this.writeOutputs(dt);
    return true;
  }

  step(dt) {
    switch (this.sub) {
      case 'jumpGrab': return this.updJumpGrab();
      case 'catch': return this.updCatch(dt);
      case 'settle': return this.updSettle(dt);
      case 'dropToHang': return this.updDropToHang(dt);
      case 'reach': return this.updReach(dt);
      case 'lunge': case 'jumpBack': return this.updLunge(dt);
      case 'climbUp': case 'climbUpStand': return this.updClimbUp(dt);
      case 'hangAimEnter': case 'hangAim': case 'hangAimExit': return this.updHangAim(dt);
      case 'mantle': return this.updMantle();
      case 'vault': return this.updVault();
      default: if (ON_WALL.has(this.sub)) return this.updWall(dt);
    }
  }

  // ---------------------------------------------------------------- on the wall: hang / lean / shimmy / corner
  updWall(dt) {
    const c = this.cfg, d = this.data, a = this.actor, inp = this.input();
    const g = this.game;
    if (inp.pressed('cover')) return this.doDrop();
    if (inp.down('aim')) { this.vel = 0; return this.startHangAim(); }
    const st = this.wallStick(this._stick || (this._stick = { x: 0, y: 0 }));
    let mv = d.findMove(this.edge, this.s, this.spread, st.x, st.y, c, this.move);
    const jumpBuf = g.time - this.jumpT <= c.jumpBuffer + EPS_T;
    if (mv.type === 'none' && jumpBuf && Math.hypot(st.x, st.y) < c.moveDeadzone) mv = d.findMove(this.edge, this.s, this.spread, 0, 1, c, this.move);
    let shimmyDir = 0, lean = false, look = false;
    this.feedEdge = null;
    switch (mv.type) {
      case 'climbUp':
        this.jumpT = -1e9;
        return this.startClimbUp();
      case 'reach':
        if (jumpBuf) { this.jumpT = -1e9; return this.startLunge(mv, 'lunge'); }
        return this.startReach(mv);
      case 'lunge':
        if (jumpBuf) { this.jumpT = -1e9; return this.startLunge(mv, 'lunge'); }
        lean = true; this.feedEdge = mv.edge; this.feedS = mv.s;
        break;
      case 'shimmy': shimmyDir = mv.dir; break;
      case 'jumpBack': {
        const offered = mv.edge || this.freeLeapOK();
        if (!offered) { lean = true; break; }
        this.awayT += dt;
        if (this.awayT >= c.jumpBackDelay - EPS_T) {
          look = true;
          if (jumpBuf) { this.jumpT = -1e9; return mv.edge ? this.startLunge(mv, 'jumpBack') : this.startFreeLeap(); }
        } else lean = true;
        break;
      }
      default:
        lean = Math.hypot(st.x, st.y) >= c.moveDeadzone;
    }
    if (mv.type !== 'jumpBack') this.awayT = 0;
    if (lean || look) { this.feedU = mv.du; this.feedV = mv.dv; }

    // shimmy: accelerate toward the target speed, slide, stop at ends and obstacles
    const size = this.edge.size === 'small' ? c.smallScale : 1;
    const mag = clamp01((Math.abs(st.x) - c.moveDeadzone) / Math.max(1e-3, 0.8 - c.moveDeadzone));
    const target = shimmyDir * c.shimmySpeed * size * (shimmyDir ? Math.max(mag, 0.35) : 0);
    const speedRef = c.shimmySpeed * size;
    const decel = target === 0 || Math.sign(target) !== Math.sign(this.vel) || Math.abs(target) < Math.abs(this.vel);
    const rate = speedRef / (decel ? c.shimmyStop : c.shimmyAccel);
    const dv = target - this.vel;
    this.vel += clamp(dv, -rate * dt, rate * dt);
    if (Math.abs(this.vel) > 1e-6) {
      const dir = this.vel > 0 ? 1 : -1;
      if (this.shimmyBlocked(dir)) this.vel = 0;
      else {
        const r = d.slide(this.edge, this.s, this.vel * dt, this.spread, this.slideOut);
        this.phase += Math.abs(r.s - this.s) / Math.max(0.05, c.shimmyStep);
        this.s = r.s;
        if (r.endReached) this.vel = 0;
        d.rightAt(this.edge, this.s, c.cornerBlend, this._r);
        this.cam.moveDir.set(this._r.x * dir, 0, this._r.z * dir);
        this.anim.dir.copy(this.cam.moveDir);
      }
    }
    let want;
    if (Math.abs(this.vel) > 1e-4) want = d.cornerAhead(this.edge, this.s, this.vel > 0 ? 1 : -1, c.cornerBlend) ? 'corner' : 'shimmy';
    else want = look ? 'lookBack' : lean ? 'lean' : 'hang';
    if (want !== this.sub) this.setSub(want);
    this.feedAmt += clamp((lean || look ? 1 : 0) - this.feedAmt, -dt / 0.15, dt / 0.15);
    this.placeOnEdge();
  }

  // Side probe before obstacles (spec §3: a capsule offset ahead along the move; here a ray at chest height).
  shimmyBlocked(dir) {
    const w = this.game.world, c = this.cfg;
    if (!w || !w.raycast || c.shimmyProbe <= 0) return false;
    if (this.data.cornerAhead(this.edge, this.s, dir, c.shimmyProbe + 0.5)) return false; // corners are walked around
    const a = this.actor, r = this.data.rightAt(this.edge, this.s, c.cornerBlend, this._r);
    this._ray.set(a.pos.x, a.pos.y + 1.35, a.pos.z);
    this._rayDir.set(r.x * dir, 0, r.z * dir);
    const o = this._probeOpts || (this._probeOpts = { ignore: a, hitActors: false });
    const hit = w.raycast(this._ray, this._rayDir, (a.radius ?? 0.35) * 0.6 + c.shimmyProbe, o);
    return !!hit;
  }

  freeLeapOK() {
    const w = this.game.world, a = this.actor;
    if (!w || !w.groundAt) return true;
    const n = this.data.normalAt(this.edge, this.s, 0, this._n);
    const gy = w.groundAt(a.pos.x + n.x * 1.2, a.pos.z + n.z * 1.2, a.pos.y);
    return gy != null && a.pos.y - gy <= this.cfg.safeDrop;
  }

  // Hang pose at (edge, s) with shimmy hand-over-hand, lean feedback and the pendulum swing (visual only).
  placeOnEdge() {
    const c = this.cfg, d = this.data, a = this.actor;
    this.hangPos(this.edge, this.s, a.pos);
    const n = d.normalAt(this.edge, this.s, c.cornerBlend, this._n);
    a.yaw = this.facingYaw(n);
    // hand-over-hand: within one hand step the leading hand moves first, then the trailing one
    let alongL = 0, alongR = 0;
    if (Math.abs(this.vel) > 1e-4) {
      const ph = this.phase % 1, A = c.shimmyStep;
      const lead = smooth(ph * 2) - 0.5, trail = smooth(ph * 2 - 1) - 0.5;
      if (this.vel > 0) { alongR = A * lead * 0.5; alongL = A * trail * 0.5; }
      else { alongL = -A * lead * 0.5; alongR = -A * trail * 0.5; }
    }
    this.handPos(this.edge, this.s, 'L', this.spread, this.anim.handL, alongL);
    this.handPos(this.edge, this.s, 'R', this.spread, this.anim.handR, alongR);
    this.anim.gripL = this.anim.gripR = true;
    // feedback: lean the body up to leanMax and extend the leading arm toward the stick / lunge target
    if (this.feedAmt > 1e-3) {
      const r = d.rightAt(this.edge, this.s, c.cornerBlend, this._r);
      const k = this.feedAmt;
      a.pos.x += r.x * this.feedU * c.leanMax * k; a.pos.z += r.z * this.feedU * c.leanMax * k;
      a.pos.y += this.feedV * c.leanMax * k;
      const side = this.feedU > 0.2 ? 'R' : this.feedU < -0.2 ? 'L' : (this.lastLead === 'L' ? 'R' : 'L');
      const h = side === 'L' ? this.anim.handL : this.anim.handR;
      let tx, ty, tz;
      if (this.feedEdge) {
        const tp = d.pointAt(this.feedEdge, this.feedS, this._q);
        tx = tp.x - h.x; ty = tp.y - h.y; tz = tp.z - h.z;
        const l = Math.hypot(tx, ty, tz), cap = c.reachOut / Math.max(l, 1e-3);
        const f = Math.min(c.armExtend, cap);
        tx *= f; ty *= f; tz *= f;
      } else {
        const L = c.reachOut * c.armExtend;
        tx = (r.x * this.feedU) * L; ty = this.feedV * L; tz = (r.z * this.feedU) * L;
      }
      h.x += tx * k; h.y += ty * k; h.z += tz * k;
      this.anim.lead = side;
      if (side === 'L') this.anim.gripL = k < 0.3; else this.anim.gripR = k < 0.3;
    }
    this.anim.extend = this.feedAmt;
  }

  // ---------------------------------------------------------------- entries
  startJumpGrab(grab) {
    const c = this.cfg, a = this.actor;
    this.p0.copy(a.pos);
    this.hangPos(this.edge, this.s, this.p1);
    this.yaw0 = a.yaw; this.yaw1 = this.facingYaw(this.data.normalAt(this.edge, this.s, 0, this._n));
    const h = this.edge.y - this.p0.y;
    // takeoff -> hands set: timeMin [MEASURED hop] at the lowest jump-grab, time3m [INFERRED] at a 3 m edge, linear
    const k = Math.max(0, h - c.jumpGrabMin) / Math.max(0.1, 3.0 - c.jumpGrabMin);
    this.air = c.grabTimeMin + (c.grabTime3m - c.grabTimeMin) * k;
    this.load = c.grabLoad;
    this.h0L.set(a.pos.x, a.pos.y + 1.0, a.pos.z); this.h0R.copy(this.h0L);
    this.handPos(this.edge, this.s, 'L', this.spread, this.h1L);
    this.handPos(this.edge, this.s, 'R', this.spread, this.h1R);
    this.setSub('jumpGrab', this.load + this.air);
  }

  updJumpGrab() {
    const a = this.actor, p0 = this.p0, p1 = this.p1;
    const tl = this.t - this.load;
    a.yaw = lerpAngle(this.yaw0, this.yaw1, smooth(this.t / Math.max(1e-3, this.load + this.air * 0.5)));
    if (tl <= 0) {
      a.pos.copy(p0);
      this.anim.handL.set(p0.x, p0.y + 1.0, p0.z); this.anim.handR.copy(this.anim.handL);
      this.anim.gripL = this.anim.gripR = false;
      return;
    }
    const u = clamp01(tl / this.air);
    const dy = p1.y - p0.y;
    a.pos.x = p0.x + (p1.x - p0.x) * u;
    a.pos.z = p0.z + (p1.z - p0.z) * u;
    a.pos.y = dy > 0.05 ? p0.y + dy * (2 * u - u * u) : p0.y + dy * u + 0.15 * 4 * u * (1 - u);  // arrive at the apex
    const e = 1 - (1 - u) * (1 - u);
    lerpV(this.anim.handL, this.h0L, this.h1L, e);
    lerpV(this.anim.handR, this.h0R, this.h1R, e);
    this.anim.gripL = this.anim.gripR = false;
    if (this.t >= this.dur - EPS_T) {
      a.pos.copy(p1); a.yaw = this.yaw1;
      this.swing.vz -= 0.6 * this.cfg.kick;                          // feet swing in under the catch
      this.lastLatched = 'R';
      this.setSub('hang');
      this.updWall(0);
    }
  }

  startCatch() {
    const a = this.actor;
    this.p0.copy(a.pos);
    this.hangPos(this.edge, this.s, this.p1);
    this.yaw0 = a.yaw; this.yaw1 = this.facingYaw(this.data.normalAt(this.edge, this.s, 0, this._n));
    this.swing.vz -= 0.8 * this.cfg.kick;
    this.setSub('catch', this.cfg.catchSettle);
  }

  updCatch() {
    const a = this.actor, u = smooth(this.dur > 0 ? this.t / this.dur : 1);
    lerpV(a.pos, this.p0, this.p1, u);                               // air catch: blend in; after a lunge p0 = p1
    a.yaw = lerpAngle(this.yaw0, this.yaw1, u);
    this.handPos(this.edge, this.s, 'L', this.spread, this.anim.handL);
    this.handPos(this.edge, this.s, 'R', this.spread, this.anim.handR);
    if (this.lungeCatch) {                                           // second hand lands catchLag after the first
      const trail = this.lead === 'L' ? this.anim.handR : this.anim.handL;
      lerpV(trail, this.lead === 'L' ? this.h0R : this.h0L, trail, u);
    }
    if (this.t >= this.dur - EPS_T) {
      this.lungeCatch = false;
      this.setSub('hang');
      this.updWall(0);
    }
  }

  startSettle() {
    this.p0.copy(this.actor.pos);
    this.hangPos(this.edge, this.s, this.p1);
    this.setSub('settle', 0.2);
  }

  updSettle() {
    lerpV(this.actor.pos, this.p0, this.p1, smooth(this.t / this.dur));
    this.handPos(this.edge, this.s, 'L', this.spread, this.anim.handL);
    this.handPos(this.edge, this.s, 'R', this.spread, this.anim.handR);
    if (this.t >= this.dur - EPS_T) { this.setSub('hang'); this.updWall(0); }
  }

  startDropToHang() {
    const a = this.actor;
    this.p0.copy(a.pos);
    this.hangPos(this.edge, this.s, this.p1);
    this.yaw0 = a.yaw; this.yaw1 = this.facingYaw(this.data.normalAt(this.edge, this.s, 0, this._n));
    this.setSub('dropToHang', this.cfg.dropToHang);
  }

  updDropToHang() {
    const a = this.actor, u = clamp01(this.t / this.dur);
    const uh = smooth(Math.min(1, u * 1.6)), uv = smooth(u);
    a.pos.x = this.p0.x + (this.p1.x - this.p0.x) * uh;
    a.pos.z = this.p0.z + (this.p1.z - this.p0.z) * uh;
    a.pos.y = this.p0.y + (this.p1.y - this.p0.y) * uv;
    a.yaw = lerpAngle(this.yaw0, this.yaw1, smooth(u * 1.3));
    this.handPos(this.edge, this.s, 'L', this.spread, this.anim.handL);
    this.handPos(this.edge, this.s, 'R', this.spread, this.anim.handR);
    this.anim.gripL = this.anim.gripR = u > 0.35;
    if (this.t >= this.dur - EPS_T) {
      a.pos.copy(this.p1); a.yaw = this.yaw1;
      this.swing.vz += 0.5 * this.cfg.kick;
      this.setSub('hang');
      this.updWall(0);
    }
  }

  // ---------------------------------------------------------------- reach (static, stick only)
  startReach(mv) {
    const c = this.cfg, d = this.data, a = this.actor;
    this.toEdge = mv.edge; this.toS = mv.s; this.toSpread = d.spreadOn(mv.edge, c.handSpread); this.toDist = mv.dist;
    // side moves lead with the hand on that side; up/down alternate (Kotaku 2016: hands alternate). With the follow
    // hand matching onto the same hold, "opposite of the last-latched hand" would repeat the lead, so alternate leads.
    this.lead = Math.abs(mv.du) > 0.5 ? (mv.du > 0 ? 'R' : 'L') : (this.lastLead === 'L' ? 'R' : 'L');
    this.lastLead = this.lead;
    let k = clamp(Math.sqrt(mv.dist / Math.max(0.1, c.reachGain)), 0.8, 1.3);
    if (mv.edge.size === 'small') k /= c.smallScale;
    this.tShift = c.reachShift; this.tLead = c.reachLead * k; this.tFollow = c.reachFollow * k;
    this.p0.copy(a.pos);
    this.hangPos(mv.edge, mv.s, this.p1);
    this.yaw0 = a.yaw; this.yaw1 = this.facingYaw(d.normalAt(mv.edge, mv.s, c.cornerBlend, this._n));
    this.h0L.copy(this.anim.handL); this.h0R.copy(this.anim.handR);
    this.handPos(mv.edge, mv.s, 'L', this.toSpread, this.h1L);
    this.handPos(mv.edge, mv.s, 'R', this.toSpread, this.h1R);
    const dx = this.p1.x - this.p0.x, dy = this.p1.y - this.p0.y, dz = this.p1.z - this.p0.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    this.cam.moveDir.set(dx / l, dy / l, dz / l); this.anim.dir.copy(this.cam.moveDir);
    this.feedAmt = 0; this.vel = 0;
    this.setSub('reach', this.tShift + this.tLead + this.tFollow);
  }

  updReach() {
    const c = this.cfg, a = this.actor, d = this.data;
    const uL = clamp01((this.t - this.tShift) / this.tLead);
    const uF = clamp01((this.t - this.tShift - this.tLead) / Math.max(1e-3, this.tFollow));
    const b = 0.6 * smooth(uL) + 0.4 * smooth(uF);                    // pelvis rises ~60% with the lead hand (§7)
    lerpV(a.pos, this.p0, this.p1, b);
    // weight shift toward the follow hand's side before the lead hand leaves
    const r = d.rightAt(this.edge, this.s, c.cornerBlend, this._r);
    const sh = 0.03 * Math.sin(Math.PI * clamp01(this.t / (this.tShift + this.tLead))) * (this.lead === 'R' ? -1 : 1);
    a.pos.x += r.x * sh; a.pos.z += r.z * sh;
    a.yaw = lerpAngle(this.yaw0, this.yaw1, b);
    const n = d.normalAt(this.edge, this.s, c.cornerBlend, this._n);
    const leadH = this.lead === 'L' ? this.anim.handL : this.anim.handR;
    const folH = this.lead === 'L' ? this.anim.handR : this.anim.handL;
    const bl = Math.sin(Math.PI * uL), bf = Math.sin(Math.PI * uF);
    lerpV(leadH, this.lead === 'L' ? this.h0L : this.h0R, this.lead === 'L' ? this.h1L : this.h1R, smooth(uL));
    leadH.x += n.x * c.bulge * bl; leadH.z += n.z * c.bulge * bl; leadH.y += 0.05 * bl;
    lerpV(folH, this.lead === 'L' ? this.h0R : this.h0L, this.lead === 'L' ? this.h1R : this.h1L, smooth(uF));
    folH.x += n.x * c.bulge * 0.5 * bf; folH.z += n.z * c.bulge * 0.5 * bf; folH.y += 0.03 * bf;
    this.anim.gripL = this.lead === 'L' ? uL >= 1 : uF <= 0 || uF >= 1;
    this.anim.gripR = this.lead === 'R' ? uL >= 1 : uF <= 0 || uF >= 1;
    this.anim.lead = this.lead;
    if (this.t >= this.dur - EPS_T) {
      const ru = (this.p1.x - this.p0.x) * r.x + (this.p1.z - this.p0.z) * r.z;
      this.swing.vx += ru * c.kick * 1.5;
      this.edge = this.toEdge; this.s = this.toS; this.spread = this.toSpread; this.toEdge = null;
      this.lastLatched = this.lead === 'L' ? 'R' : 'L';               // the follow hand latched last
      this.setSub('hang');
      this.updWall(0);                                               // chain: a held stick starts the next reach now
    }
  }

  // ---------------------------------------------------------------- lunge / targeted jump-back (Jump)
  startLunge(mv, kind) {
    const c = this.cfg, d = this.data, a = this.actor;
    this.toEdge = mv.edge; this.toS = mv.s; this.toSpread = d.spreadOn(mv.edge, c.handSpread); this.toDist = mv.dist;
    this.lead = Math.abs(mv.du) > 0.5 ? (mv.du > 0 ? 'R' : 'L') : (this.lastLead === 'L' ? 'R' : 'L');
    this.lastLead = this.lead;
    this.air = c.lungeAirMin + (c.lungeAirMax - c.lungeAirMin) * clamp01(mv.dist - 1.0);
    this.load = c.lungeLoad;
    this.p0.copy(a.pos);
    this.hangPos(mv.edge, mv.s, this.p1);
    this.yaw0 = a.yaw; this.yaw1 = this.facingYaw(d.normalAt(mv.edge, mv.s, c.cornerBlend, this._n));
    this.h0L.copy(this.anim.handL); this.h0R.copy(this.anim.handR);
    this.handPos(mv.edge, mv.s, 'L', this.toSpread, this.h1L);
    this.handPos(mv.edge, mv.s, 'R', this.toSpread, this.h1R);
    const dx = this.p1.x - this.p0.x, dy = this.p1.y - this.p0.y, dz = this.p1.z - this.p0.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    this.cam.moveDir.set(dx / l, dy / l, dz / l); this.anim.dir.copy(this.cam.moveDir);
    if (kind === 'jumpBack') { this.ignoreEdge = this.edge; this.ignoreUntil = this.game.time + c.regrabDelay; }
    this.feedAmt = 0; this.vel = 0;
    this.setSub(kind, this.load + this.air);
  }

  updLunge() {
    const c = this.cfg, a = this.actor, d = this.data;
    const n = d.normalAt(this.edge, this.s, c.cornerBlend, this._n);
    if (this.t < this.load) {                                        // load: compress toward the wall (§7)
      const k = smooth(this.t / this.load);
      a.pos.x = this.p0.x - n.x * 0.06 * k; a.pos.z = this.p0.z - n.z * 0.06 * k; a.pos.y = this.p0.y - 0.06 * k;
      return;
    }
    const u = clamp01((this.t - this.load) / this.air);
    const dy = this.p1.y - this.p0.y;
    const sx = this.p0.x - n.x * 0.06, sz = this.p0.z - n.z * 0.06, sy = this.p0.y - 0.06;
    a.pos.x = sx + (this.p1.x - sx) * u;
    a.pos.z = sz + (this.p1.z - sz) * u;
    const dyy = this.p1.y - sy;
    a.pos.y = dy > 0.2 ? sy + dyy * (2 * u - u * u) : sy + dyy * u + (dy > -0.2 ? 0.2 : 0.12) * 4 * u * (1 - u);
    a.yaw = this.sub === 'jumpBack' ? lerpAngle(this.yaw0, this.yaw1, smooth(u * 1.4)) : lerpAngle(this.yaw0, this.yaw1, u);
    const e = 1 - (1 - u) * (1 - u);
    const leadL = this.lead === 'L';
    lerpV(this.anim.handL, this.h0L, this.h1L, leadL ? e : e * 0.8);
    lerpV(this.anim.handR, this.h0R, this.h1R, leadL ? e * 0.8 : e);
    this.anim.gripL = this.anim.gripR = false;
    if (this.t >= this.dur - EPS_T) {
      const r = d.rightAt(this.edge, this.s, c.cornerBlend, this._r);
      const ru = ((this.p1.x - this.p0.x) * r.x + (this.p1.z - this.p0.z) * r.z) / this.air;
      this.swing.vx += ru * c.kick * 0.5; this.swing.vz -= 0.5 * c.kick;
      // second hand: lands catchLag later (h0 of the trailing hand = its pose at the catch)
      (leadL ? this.h0R : this.h0L).copy(leadL ? this.anim.handR : this.anim.handL);
      this.edge = this.toEdge; this.s = this.toS; this.spread = this.toSpread; this.toEdge = null;
      this.lastLatched = this.lead === 'L' ? 'R' : 'L';
      a.pos.copy(this.p1); a.yaw = this.yaw1; this.yaw0 = this.yaw1;
      this.p0.copy(this.p1);
      this.lungeCatch = true;
      this.setSub('catch', c.catchLag);
    }
  }

  // Free leap backward off the wall (no edge behind, floor within the safe drop): exits to 'air'.
  startFreeLeap() {
    const c = this.cfg, a = this.actor;
    const n = this.data.normalAt(this.edge, this.s, 0, this._n);
    this.ignoreEdge = this.edge; this.ignoreUntil = this.game.time + c.regrabDelay;
    a.yaw = this.facingYaw(n) + Math.PI;
    if (a.vel) a.vel.set(n.x * c.jumpBackOut, c.jumpBackUp, n.z * c.jumpBackOut);
    this.setSub('jumpBack');
    this.requestExit('air', { from: 'climb', reason: 'jumpBack', vel: a.vel });
  }

  // ---------------------------------------------------------------- climb-up (top edges)
  startClimbUp() {
    const c = this.cfg, d = this.data, a = this.actor;
    this.p0.copy(a.pos);
    d.topSurface(this.edge, this.s, c.topInset, this.p2);
    const w = this.game.world;
    if (w && w.groundAt) { const gy = w.groundAt(this.p2.x, this.p2.z, this.edge.y + 0.1); if (gy != null && Math.abs(gy - this.edge.y) < 0.3) this.p2.y = gy; }
    const p = d.pointAt(this.edge, this.s, this._p), n = d.normalAt(this.edge, this.s, c.cornerBlend, this._n);
    this.p1.set(p.x - n.x * 0.1, this.edge.y, p.z - n.z * 0.1);      // knee just over the lip
    this.yaw0 = this.yaw1 = this.facingYaw(n);
    this.h0L.copy(this.anim.handL); this.h0R.copy(this.anim.handR);
    this.feedAmt = 0; this.vel = 0;
    this.cam.moveDir.set(0, 1, 0); this.anim.dir.set(0, 1, 0);
    this.setSub('climbUp', c.climbCrouch);
  }

  updClimbUp() {
    const c = this.cfg, a = this.actor;
    if (this.sub === 'climbUp') {
      const T = this.dur, knee = T * (0.45 / 0.65);                  // §7 beat: knee on top at 0.45 of 0.65 s
      if (this.t < c.climbLock) {
        const st = this.wallStick(this._stick || (this._stick = { x: 0, y: 0 }));
        if (st.y < -0.5) return this.startSettle();                  // cancellable only in the first climbLock s
      }
      if (this.t <= knee) {
        const u = this.t / knee;
        a.pos.y = this.p0.y + (this.p1.y - this.p0.y) * smooth(u);
        const uh = smooth(clamp01((u - 0.25) / 0.75));
        a.pos.x = this.p0.x + (this.p1.x - this.p0.x) * uh;
        a.pos.z = this.p0.z + (this.p1.z - this.p0.z) * uh;
      } else lerpV(a.pos, this.p1, this.p2, smooth((this.t - knee) / (T - knee)));
      this.anim.handL.copy(this.h0L); this.anim.handR.copy(this.h0R);
      this.anim.gripL = this.anim.gripR = this.t < knee;
      if (this.t >= T - EPS_T) {
        a.pos.copy(this.p2);
        this.setSub('climbUpStand', Math.max(0, c.climbStand - c.climbCrouch));
      }
      return;
    }
    a.pos.copy(this.p2);
    this.anim.handL.set(a.pos.x, a.pos.y + 0.9, a.pos.z); this.anim.handR.copy(this.anim.handL);
    this.anim.gripL = this.anim.gripR = false;
    if (this.t >= this.dur - EPS_T) this.requestExit('ground', { from: 'climb', reason: 'climbUp' });
  }

  // ---------------------------------------------------------------- drop (Circle / `cover`)
  doDrop() {
    const c = this.cfg, a = this.actor;
    this.ignoreEdge = this.edge; this.ignoreUntil = this.game.time + c.regrabDelay;
    if (a.vel) a.vel.set(0, 0, 0);
    this.setSub('drop');
    this.requestExit('air', { from: 'climb', reason: 'drop', vel: a.vel });
  }

  // ---------------------------------------------------------------- hang-aim (spec §5)
  startHangAim() {
    const c = this.cfg, a = this.actor;
    this.hangPos(this.edge, this.s, this.p0);
    this.hangPos(this.edge, this.s, this.p1, c.aimRise);
    this.aimFrom = this.anim.aim;
    a.hangAim = true;
    const L = this.limits;
    L.centerYaw = a.yaw; L.yaw = c.aimYaw; L.pitchMin = c.aimPitchMin; L.pitchMax = c.aimPitchMax;
    a.hangAimLimits = L;
    this.feedAmt = 0;
    this.setSub('hangAimEnter', c.aimEnter);
  }

  startAimExit() {
    this.actor.hangAim = false;
    this.aimFrom = this.anim.aim;
    this.setSub('hangAimExit', this.cfg.aimExit);
  }

  // Force exit (hit / grip break). Called by the damage listener.
  forceAimExit() { if (this.sub === 'hangAimEnter' || this.sub === 'hangAim') this.startAimExit(); }

  updHangAim() {
    const a = this.actor, inp = this.input();
    let blend;
    if (this.sub === 'hangAimEnter') {
      const u = clamp01(this.t / this.dur);
      blend = this.aimFrom + (1 - this.aimFrom) * smooth(u);
      if (!inp.down('aim')) return this.startAimExit();
      if (this.t >= this.dur - EPS_T) { blend = 1; this.setSub('hangAim'); }
    } else if (this.sub === 'hangAim') {
      blend = 1;
      if (inp.pressed('cover')) { this.actor.hangAim = false; return this.doDrop(); }
      if (!inp.down('aim')) return this.startAimExit();
    } else {
      const u = clamp01(this.t / this.dur);
      blend = this.aimFrom * (1 - smooth(u));
      if (this.t >= this.dur - EPS_T) {
        this.anim.aim = 0;
        this.setSub('hang');
        this.placeOnEdge();
        return;
      }
    }
    this.anim.aim = blend;
    const caps = a.ctrl && a.ctrl.caps;                               // B1 resets caps every step; the active mode sets them
    if (caps && this.sub !== 'hangAimExit') {
      caps.allowFire = true; caps.fireReady = this.sub === 'hangAim'; caps.allowReload = true; caps.fireMode = 'aim';
    }
    lerpV(a.pos, this.p0, this.p1, blend);
    // left hand stays on the lip; the right (gun) hand leaves it on frame 1 (§7) and the weapon owns it
    this.handPos(this.edge, this.s, 'L', this.spread, this.anim.handL);
    this.handPos(this.edge, this.s, 'R', this.spread, this.anim.handR);
    const n = this.data.normalAt(this.edge, this.s, 0, this._n);
    const yaw = this.game.cameraRig && typeof this.game.cameraRig.yaw === 'number' ? this.game.cameraRig.yaw : a.yaw;
    this.anim.aimYaw = clamp(wrapPi(yaw - this.limits.centerYaw), -this.limits.yaw, this.limits.yaw);
    const ay = this.limits.centerYaw + this.anim.aimYaw;
    const chestY = a.pos.y + 1.35;
    const gx = a.pos.x + Math.sin(ay) * 0.5 * blend - n.x * 0.05, gz = a.pos.z + Math.cos(ay) * 0.5 * blend - n.z * 0.05;
    lerpV3(this.anim.handR, this.anim.handR, gx, chestY + 0.05, gz, blend);
    this.anim.gripL = true; this.anim.gripR = blend < 0.05;
  }

  // ---------------------------------------------------------------- mantle / vault (from the ground)
  startMantle(grab) {
    const a = this.actor;
    this.p0.copy(a.pos);
    this.p2.copy(grab.standPos);
    this.p1.set(grab.point.x - grab.normal.x * 0.05, grab.top, grab.point.z - grab.normal.z * 0.05);
    this.yaw0 = a.yaw; this.yaw1 = Math.atan2(-grab.normal.x, -grab.normal.z);
    const rx = -grab.normal.z, rz = grab.normal.x;                   // along the wall
    this.h1L.set(grab.point.x - rx * 0.2, grab.top + 0.02, grab.point.z - rz * 0.2);
    this.h1R.set(grab.point.x + rx * 0.2, grab.top + 0.02, grab.point.z + rz * 0.2);
    this.setSub('mantle', this.cfg.mantleTime);
  }

  updMantle() {
    const a = this.actor, u = clamp01(this.t / this.dur);
    const rise = smooth(u / 0.6);
    a.pos.y = this.p0.y + (this.p2.y - this.p0.y) * rise;
    if (u < 0.6) {
      const uh = smooth(clamp01((u - 0.2) / 0.4));
      a.pos.x = this.p0.x + (this.p1.x - this.p0.x) * uh;
      a.pos.z = this.p0.z + (this.p1.z - this.p0.z) * uh;
    } else {
      const uh = smooth((u - 0.6) / 0.4);
      a.pos.x = this.p1.x + (this.p2.x - this.p1.x) * uh;
      a.pos.z = this.p1.z + (this.p2.z - this.p1.z) * uh;
    }
    a.yaw = lerpAngle(this.yaw0, this.yaw1, smooth(u * 3));
    this.anim.handL.copy(this.h1L); this.anim.handR.copy(this.h1R);
    this.anim.gripL = this.anim.gripR = u < 0.75;
    if (this.t >= this.dur - EPS_T) { a.pos.copy(this.p2); this.requestExit('ground', { from: 'climb', reason: 'mantle' }); }
  }

  startVault(grab) {
    const a = this.actor;
    this.p0.copy(a.pos);
    this.p2.copy(grab.farPos);
    this.vTop = grab.top;
    this.exitSpeed = grab.speed; this.exitDirX = grab.dirX; this.exitDirZ = grab.dirZ;
    this.yaw0 = a.yaw; this.yaw1 = Math.atan2(grab.dirX, grab.dirZ);
    const rx = -grab.normal.z, rz = grab.normal.x;
    this.h1L.set(grab.point.x - rx * 0.18 - grab.normal.x * 0.1, grab.top + 0.02, grab.point.z - rz * 0.18 - grab.normal.z * 0.1);
    this.h1R.set(grab.point.x + rx * 0.18 - grab.normal.x * 0.1, grab.top + 0.02, grab.point.z + rz * 0.18 - grab.normal.z * 0.1);
    this.setSub('vault', this.cfg.vaultTime);
  }

  updVault() {
    const a = this.actor, u = clamp01(this.t / this.dur);
    a.pos.x = this.p0.x + (this.p2.x - this.p0.x) * u;
    a.pos.z = this.p0.z + (this.p2.z - this.p0.z) * u;
    const peak = this.vTop + 0.1 - 0.55;                             // feet clear the top with the legs tucked
    a.pos.y = u < 0.45 ? this.p0.y + (Math.max(peak, this.p0.y) - this.p0.y) * smooth(u / 0.45)
      : Math.max(peak, this.p0.y) + (this.p2.y - Math.max(peak, this.p0.y)) * smooth((u - 0.45) / 0.55);
    a.yaw = lerpAngle(this.yaw0, this.yaw1, smooth(u * 4));
    this.anim.handL.copy(this.h1L); this.anim.handR.copy(this.h1R);
    this.anim.gripL = this.anim.gripR = u > 0.2 && u < 0.6;
    if (this.t >= this.dur - EPS_T) {
      a.pos.copy(this.p2);
      if (a.vel) a.vel.set(this.exitDirX * this.exitSpeed, 0, this.exitDirZ * this.exitSpeed);
      this.requestExit('ground', { from: 'climb', reason: 'vault', vel: a.vel });
    }
  }

  // ---------------------------------------------------------------- outputs: anim, feet, swing, camera hint
  writeOutputs(dt) {
    const c = this.cfg, d = this.data, a = this.actor, an = this.anim;
    if (a.anim) a.anim.mode = 'climb';                                 // the active mode sets anim.mode (as B1's modes do)
    an.pose = POSE[this.sub] || 'hang';
    an.move = this.sub;
    if (this.sub === 'climbUp' || this.sub === 'climbUpStand') {      // one 0..1 clock over the whole climb-up (animator)
      an.t = clamp01(((this.sub === 'climbUpStand' ? c.climbCrouch : 0) + this.t) / Math.max(1e-3, c.climbStand));
    } else an.t = this.dur > 0 ? clamp01(this.t / this.dur) : (this.sub === 'shimmy' || this.sub === 'corner' ? this.phase % 1 : 0);
    an.lead = this.lead;
    const onEdge = this.edge && this.sub !== 'mantle' && this.sub !== 'vault';
    if (onEdge) d.normalAt(this.edge, this.s, c.cornerBlend, an.normal);
    an.freeHang = !!(this.edge && (this.edge.kind === 'bar' || this.edge.feet === false));
    // pendulum swing of the pelvis below the hands (§7): loose idle, stiff while the stick is held
    const inp = this.input();
    const m = inp && inp.axis ? inp.axis('move') : null;
    const active = m && (m.x !== 0 || m.y !== 0);
    const k = active ? c.pendK1 : c.pendK0, z = active ? c.pendZ1 : c.pendZ0, w = Math.sqrt(k);
    const sw = this.swing;
    sw.vx += (-k * sw.x - 2 * z * w * sw.vx) * dt; sw.x = clamp(sw.x + sw.vx * dt, -0.35, 0.35);
    sw.vz += (-k * sw.z - 2 * z * w * sw.vz) * dt; sw.z = clamp(sw.z + sw.vz * dt, -0.25, 0.25);
    an.swing.x = sw.x; an.swing.z = sw.z;
    // feet: a foothold edge 0.9-1.3 m below the hands, else planted on the wall face, else dangling (free hang)
    if (onEdge && ON_WALL.has(this.sub) || this.sub === 'reach' || this.sub === 'catch' || this.sub === 'settle' || this.sub.startsWith('hangAim')) {
      const r = d.rightAt(this.edge, this.s, c.cornerBlend, this._r), n = an.normal;
      const fh = an.freeHang ? null : d.foothold(this.edge, this.s, c.footBand0, c.footBand1, this.foot);
      if (fh) {
        d.pointAt(fh.edge, fh.s - 0.15, this._q); an.footL.set(this._q.x + n.x * 0.04, this._q.y + 0.03, this._q.z + n.z * 0.04);
        d.pointAt(fh.edge, fh.s + 0.15, this._q); an.footR.set(this._q.x + n.x * 0.04, this._q.y + 0.03, this._q.z + n.z * 0.04);
      } else {
        const p = d.pointAt(this.edge, this.s, this._q);
        const out = an.freeHang ? c.barOffset + sw.z : 0.06;
        const y = a.pos.y + (an.freeHang ? 0.05 : 0.2);
        an.footL.set(p.x - r.x * 0.14 + n.x * out + r.x * sw.x, y, p.z - r.z * 0.14 + n.z * out + r.z * sw.x);
        an.footR.set(p.x + r.x * 0.14 + n.x * out + r.x * sw.x, y, p.z + r.z * 0.14 + n.z * out + r.z * sw.x);
      }
    } else {
      an.footL.set(a.pos.x, a.pos.y, a.pos.z); an.footR.copy(an.footL);
    }
    // camera hint (B1's rig reads cameraProfile; spec §6 rules use target/normal/moveDir)
    a.cameraProfile = this.sub === 'hangAimEnter' || this.sub === 'hangAim' ? 'hangAim'
      : this.sub === 'mantle' || this.sub === 'vault' ? null : 'climb';
    this.cam.target.set((an.handL.x + an.handR.x) / 2, (an.handL.y + an.handR.y) / 2, (an.handL.z + an.handR.z) / 2);
    if (onEdge) this.cam.normal.copy(an.normal);
    if (a.vel) a.vel.set(0, 0, 0);
  }
}

function lerpV(out, a, b, t) { return out.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t); }
function lerpV3(out, a, x, y, z, t) { return out.set(a.x + (x - a.x) * t, a.y + (y - a.y) * t, a.z + (z - a.z) * t); }

// ------------------------------------------------------------------------------------------------ the system
export class ClimbSystem {
  constructor(game) {
    this.game = game;
    this.name = 'climb';
    this.order = ORDER.player - 1;                                   // before the controller: lazy attach, cfg refresh
    defineClimbParams(game.params);
    this.cfg = readCfg(game.params, {});
    this._cfgFrame = -1;
    this.data = null;
    this._markup = undefined;
    this.highlight = null;
    this._hlPending = false;
    this._modes = new WeakMap();
    this._offs = [game.events.on('damage', (e) => {
      const m = e && e.target && this._modes.get(e.target);
      if (m) m.forceAimExit();
    })];
    this.ensureData();
  }

  refresh() {
    if (this._cfgFrame === this.game.frame) return this.cfg;
    this._cfgFrame = this.game.frame;
    readCfg(this.game.params, this.cfg);
    this.ensureData();
    return this.cfg;
  }

  // (Re)build the query layer from game.level.climb when it appears or changes identity.
  ensureData() {
    const lvl = this.game.level;
    const raw = lvl ? lvl.climb : null;
    if (this.data && raw === this._markup) return this.data;
    this._markup = raw;
    this.data = new ClimbData(raw || { edges: [] });
    for (const w of this.data.warnings) console.warn(`[climb] ${w.msg}`);
    if (raw && this.game.world && this.game.world.groundAt) {
      const C = this.cfg, w = this.game.world;
      const issues = this.data.validate({
        floorAt: (x, z, y) => w.groundAt(x, z, y) ?? 0, deadMin: C.deadMin, deadMax: C.deadMax, avoidMin: C.avoidMin, avoidMax: C.avoidMax,
      });
      for (const i of issues) console.warn(`[climb] edge ${i.id}: ${i.h} m above the floor in front is inside the ${i.rule} (spec authoring rules)`);
      this.data.issues = issues;
    }
    if (this.highlight) { this.highlight.dispose(); this.highlight = null; }
    return this.data;
  }

  rebuild() { this._markup = undefined; this.data = null; return this.ensureData(); }

  modeFor(actor) {
    let m = this._modes.get(actor);
    if (!m) { m = new ClimbMode(this, actor); this._modes.set(actor, m); }
    return m;
  }

  createMode(actor) { actor._climbAttached = true; return this.modeFor(actor).impl; }
  mode(actor) { return this.createMode(actor); }

  attach(actor) {
    const impl = this.createMode(actor);
    if (actor.ctrl && actor.ctrl.registerMode) actor.ctrl.registerMode('climb', impl);
    return impl;
  }

  state(actor) { const m = this._modes.get(actor); return m ? m.sub : 'none'; }
  isClimbing(actor) { return this.state(actor) !== 'none'; }

  // ---------------------------------------------------------------- entry query (spec §2)
  canGrab(actor, opts) {
    const fromAir = !!(opts && opts.fromAir), intentDir = (opts && opts.intentDir) || null, dropFromTop = !!(opts && opts.dropFromTop);
    const c = this.refresh(), d = this.data, m = this.modeFor(actor), g = this.game;
    if (m.sub !== 'none' || !actor.pos) return null;
    const feet = actor.pos;
    let fx, fz;
    const il = intentDir ? Math.hypot(intentDir.x, intentDir.z) : 0;
    if (il > 0.1) { fx = intentDir.x / il; fz = intentDir.z / il; } else { fx = Math.sin(actor.yaw || 0); fz = Math.cos(actor.yaw || 0); }
    const vel = actor.vel || ZERO;
    const speed = Math.hypot(vel.x, vel.z);
    const ignore = g.time < m.ignoreUntil ? m.ignoreEdge : null;
    const grab = m.grab;
    grab.type = null; grab.edge = null; grab.edgeId = null; grab.mode = 'climb'; grab.speed = speed; grab.dirX = fx; grab.dirZ = fz;
    if (dropFromTop) {
      const e = d.findEntry('dropFromTop', feet, fx, fz, speed, c, ignore, m.entry);
      return e ? this.fillEdge(m, e, 'dropToHang', 'top') : null;
    }
    if (fromAir) {
      if (vel.y > 0 || -vel.y > c.catchMaxFall) return null;        // only while descending, inside the catch window
      if (actor === g.player && g.input && g.input.down && g.input.down('cover')) return null; // held drop ignores grips
      const e = d.findEntry('fall', feet, fx, fz, speed, c, ignore, m.entry);
      return e ? this.fillEdge(m, e, 'hang', 'air') : null;
    }
    // ground: a low obstacle right in front -> vault / mantle; else a grab edge in the jump band -> jump-to-grab.
    // B1's controller runs its own mantle/vault (ctrl.tryMantle) before calling canGrab: then it owns those.
    const low = actor.ctrl && actor.ctrl.tryMantle ? null : this.probeLow(actor, fx, fz, speed, grab);
    if (low) return low;
    const e = d.findEntry('jump', feet, fx, fz, speed, c, ignore, m.entry);
    return e ? this.fillEdge(m, e, 'hang', 'ground') : null;
  }

  fillEdge(m, e, type, from) {
    const grab = m.grab, d = this.data;
    grab.type = type; grab.from = from; grab.edge = e.edge; grab.edgeId = e.edge.id; grab.s = e.s; grab.height = e.h; grab.dist = e.dist;
    d.pointAt(e.edge, e.s, m._p); grab.point.set(m._p.x, m._p.y, m._p.z);
    d.normalAt(e.edge, e.s, 0, m._n); grab.normal.set(m._n.x, 0, m._n.z);
    grab.top = e.edge.y;
    return grab;
  }

  // Mantle / vault detection against world geometry (world.probeWall). Heights from the feet (spec §2).
  probeLow(actor, fx, fz, speed, grab) {
    const w = this.game.world, c = this.cfg;
    if (!w || !w.probeWall) return null;
    const feet = actor.pos, r = actor.radius ?? 0.35;
    const m = this.modeFor(actor);
    m._rayDir.set(fx, 0, fz);
    const hit = w.probeWall(feet, m._rayDir, r + c.mantleReach, c.stepMax + 0.05, PROBE_LOW);
    if (!hit) return null;
    const h = hit.top - feet.y;
    if (h <= c.stepMax || h > c.mantleMax) return null;
    if (-(fx * hit.normal.x + fz * hit.normal.z) < Math.cos(c.facingCone)) return null;
    const nx = hit.normal.x, nz = hit.normal.z, col = hit.collider;
    const px = hit.point.x, pz = hit.point.z, top = hit.top;
    grab.from = 'ground'; grab.edge = null; grab.edgeId = null; grab.s = 0; grab.height = h; grab.dist = hit.dist; grab.top = top;
    grab.point.set(px, top, pz); grab.normal.set(nx, 0, nz);
    // vault: running, low enough, thin, and lower ground on the far side
    if (speed >= c.vaultSpeed && h <= c.vaultMax) {
      const D = c.vaultDepth + 0.05;
      m._ray.set(px - nx * D, feet.y + c.stepMax + 0.05, pz - nz * D);
      m._rayDir.set(nx, 0, nz);
      const back = w.raycast(m._ray, m._rayDir, D, RAY_STATIC);
      if (back && back.collider === col) {
        const thick = D - back.dist;
        const lx = px - nx * (thick + 0.5), lz = pz - nz * (thick + 0.5);
        const gy = w.groundAt(lx, lz, top - 0.3);                     // null = a drop behind: land at the take-off
        if (gy == null || top - gy >= 0.4) {                           // level and let the air mode take over
          grab.type = 'vault'; grab.farPos.set(lx, gy == null ? feet.y : Math.max(gy, feet.y - 0.6), lz);
          return grab;
        }
      }
    }
    // mantle: standing room on top
    const sx = px - nx * c.topInset, sz = pz - nz * c.topInset;
    const gy = w.groundAt(sx, sz, top + 0.05);
    grab.type = 'mantle';
    grab.standPos.set(sx, gy != null && Math.abs(gy - top) < 0.15 ? gy : top, sz);
    return grab;
  }

  // ---------------------------------------------------------------- system hooks
  update(dt, game) {
    this.refresh();
    const p = game.player;
    if (p && p.ctrl && p.ctrl.registerMode && !p._climbAttached && !hasMode(p.ctrl, 'climb')) this.attach(p);
  }

  frame(realDt, game) {
    const show = game.params.get('climb.highlight');
    if (this.highlight) { this.highlight.update(game, this); return; }
    if (!show || this._hlPending || !game.scene || typeof window === 'undefined' || !this.data || !this.data.edges.length) return;
    this._hlPending = true;
    import('three').then((THREE) => {
      this._hlPending = false;
      if (!this.highlight) this.highlight = buildHighlight(THREE, game.scene, this.data, game.params);
    }).catch((err) => { console.warn('[climb] highlight disabled:', err && err.message); });
  }

  dispose() { for (const off of this._offs) off(); if (this.highlight) this.highlight.dispose(); }
}

function hasMode(ctrl, name) {
  try {
    if (typeof ctrl.hasMode === 'function') return !!ctrl.hasMode(name);
    const m = ctrl.modes || ctrl._modes;
    if (!m) return false;
    return m instanceof Map ? m.has(name) : !!m[name];
  } catch { return false; }
}

// The U4 white-line rule (spec §1): a thin light strip along every grab edge, from the same data the controller
// queries, so visuals and controller never disagree. One merged mesh, one draw call. Param climb.highlight toggles it.
function buildHighlight(THREE, scene, data, params) {
  const pos = [];
  const H = 0.022, OUT = 0.012;
  for (const e of data.edges) {
    for (const g of e.segs) {
      const ax = g.ax + g.nx * OUT, az = g.az + g.nz * OUT, bx = g.bx + g.nx * OUT, bz = g.bz + g.nz * OUT;
      const y0 = e.y - H, y1 = e.y + 0.003;
      pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
      // a sliver on top of the lip too, so it reads from above
      const ix = -g.nx * 0.03, iz = -g.nz * 0.03, yt = e.y + 0.004;
      pos.push(ax, yt, az, bx + ix, yt, bz + iz, bx, yt, bz, ax, yt, az, ax + ix, yt, az + iz, bx + ix, yt, bz + iz);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mat = new THREE.MeshBasicMaterial({
    color: 0xf2ebdc, transparent: true, opacity: params.get('climb.highlightOpacity'), depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'climb-highlight'; mesh.renderOrder = 2; mesh.frustumCulled = false;
  scene.add(mesh);
  // debug: the current move target (climb.debug)
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffb454, toneMapped: false }));
  marker.visible = false; marker.name = 'climb-target';
  scene.add(marker);
  return {
    mesh, marker,
    update(game, sys) {
      mesh.visible = !!game.params.get('climb.highlight');
      mat.opacity = game.params.get('climb.highlightOpacity');
      marker.visible = false;
      if (!game.params.get('climb.debug') || !game.player) return;
      const m = sys._modes.get(game.player);
      if (!m || m.sub === 'none') return;
      const mv = m.move;
      const e = m.toEdge || ((mv.type === 'reach' || mv.type === 'lunge' || mv.type === 'jumpBack') && mv.edge);
      if (!e) return;
      sys.data.pointAt(e, m.toEdge ? m.toS : mv.s, m._q);
      marker.position.set(m._q.x, m._q.y, m._q.z);
      marker.material.color.setHex(mv.needsJump && !m.toEdge ? 0x7fb2ff : 0xffb454);
      marker.visible = true;
    },
    dispose() { scene.remove(mesh, marker); geo.dispose(); mat.dispose(); marker.geometry.dispose(); marker.material.dispose(); },
  };
}

// Boot hook (src/main.js): sets game.climb and adds the system.
export function install(game) {
  const sys = new ClimbSystem(game);
  game.climb = sys;
  game.addSystem(sys);
  if (game.player && game.player.ctrl && !hasMode(game.player.ctrl, 'climb')) sys.attach(game.player);
  return sys;
}

export { ClimbData, Vec3 };
