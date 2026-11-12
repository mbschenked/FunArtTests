// character/animator.js: procedural animator for the SMPL-22 mannequin. Contract: refs/design.md "character/*: rig".
// Owner: A4. The controllers own movement (no root motion); this only poses the skeleton under rig.root.
//
// PIPELINE (per rig.update(dt, animState); all scratch preallocated, nothing allocated per frame)
//   1. Root kinematics: world position / yaw are read from rig.root (placed by the animation system). Velocity,
//      acceleration and yaw rate are MEASURED from root motion, so feet never skate even when the controller's
//      intended velocity and its actual motion disagree (sliding along a wall, blocked by a crate).
//   2. Mode evaluation into a TargetPose: pelvis (root-space position + yaw/pitch/roll + an optional whole-body
//      pre-rotation), spine totals distributed over spine1..3, neck/head with a look-at, collars, foot targets (ball
//      joint + orientation + knee pole) and hand targets (wrist position + orientation + elbow pole). Pistol hand
//      targets come from the desired GUN transform through the fixed grip socket, so the muzzle points exactly where
//      the pose puts the gun.
//   3. Solve: FK for pelvis/spine, look-at split over neck + head, analytic two-bone IK for legs and arms (with an
//      automatic collar raise/protraction from the hand target).
//   4. Dead blending (Holden 2023) on mode / sub-pose switches: the last output pose is extrapolated with its own
//      decaying angular velocity and cross-faded into the new pose over anim.blend.<mode> seconds.
//   5. Write local quaternions to rig.bones (SMPL local rotations, rest = identity T-pose).
//
// GAIT  World-locked feet. A phase cycle advanced by cadence(speed) times when each foot lifts and lands; a planted
//       foot stays on its world point; a swinging foot flies from its lift-off point to a landing point re-predicted
//       every step (root position + measured velocity * time-to-mid-stance, body offset rotated by the predicted yaw).
//       Stride = speed / cadence, so stride always matches speed. When stopped, a re-step planner squares the feet up
//       one foot at a time (stop settle step, turn-in-place, cover side swap, stance changes, hit stagger).
//
// CLIP HOOK  animator.sources[mode] = {evaluate(animState, dt, pose), upperBody?} overrides a mode's base pose.
//       pose.p = pelvis position (root space), pose.q[22] = SMPL local quaternions. Unless upperBody === false, the
//       aim / reload / throw arm layer is applied over it. src/character/clips.js plugs in here later.
//
// animState FIELDS READ (all optional except mode). See refs/design.md for the shape.
//   mode                  'locomotion'|'cover'|'roll'|'jump'|'fall'|'land'|'mantle'|'climb'|'hitreact'|'death'
//   modeT                 0..1 progress for roll / jump / land / mantle (else time-in-mode / anim.<mode>.duration)
//   aim {on, yaw, pitch, weight}  yaw/pitch (rad) RELATIVE to the root's facing: +yaw = toward the character's
//                         left (three.js rotation.y sense), +pitch = up. weight 0..1 when the controller owns the
//                         aim-in timing; otherwise `on` is smoothed with anim.aim.blend.
//   fireT                 s since the last shot (recoil additive). Missing or > 1 = none.
//   action {type, t}      'reload' (t 0..1), 'throwAim' (wind-up hold), 'throw' (t 0..1: release at anim.throw.release)
//   cover {height, side, pose, t, top?}  root +Z must face INTO the wall; side +1 = the character looks/moves to its
//                         right (root -X) along the wall, -1 = left; t 0..1 = progress of popup/lean/blind/enter/exit;
//                         top = world Y of the cover's top edge (default anim.cover.lowTop above the root).
//   climb {pose, handL, handR, t, normal?}  handL/handR = world points on the hold edge (palm goes there); root +Z
//                         faces the wall unless normal (out of the wall) is given. t 0..1 for climbup / drop.
//   mantle {height?, dist?}  ledge top above the root at mode start / horizontal distance to the edge (m).
//   hit {dir, part, t}    dir = world travel direction of the bullet; part 'head'|'torso'|'limb'; t = s since hit.
//   death {dir, t}        dir = world travel direction of the killing shot; t = s since death.
//   speed / localVel / turnRate are not needed: they are measured from root motion.
import * as THREE from 'three';
import { J, PARENTS, OFFSETS, REST, GRIP_R, SUPPORT_L, PALM_L, HAND_R_AXES, HAND_L_AXES } from './skeleton.js';

const N = 22;
const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ease = (t) => sstep(0, 1, t);
const frac = (x) => x - Math.floor(x);
const wrapPi = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);
const lerpAngle = (a, b, t) => a + wrapPi(b - a) * t;
const dampK = (halflife, dt) => (halflife <= 1e-5 ? 1 : 1 - Math.pow(2, -dt / halflife));
const bump = (a, b, x) => (x <= a || x >= b ? 0 : Math.sin(Math.PI * (x - a) / (b - a)));
// Alpha-function impulse: 0 at t = 0, peak 1 at t = peak, smooth decay (~95 % gone by 5 * peak).
const pulse = (t, peak) => (t < 0 ? 0 : (t / peak) * Math.exp(1 - t / peak));

// --- params -------------------------------------------------------------------------------------------------------------
// [key (under anim.), default, min, max, step]. refs/player-spec.md and refs/climb-spec.md did not exist when this was
// built, so every value is [INFERRED] (human-motion biomechanics norms + footage feel); TODO(spec) marks the ones a spec
// number should replace. Units: s, m, rad, Hz, steps/s.
const PARAM_DEFS = [
  // Dead-blend times per destination mode (s). [INFERRED] TODO(spec)
  ['blend.locomotion', 0.22, 0, 1, 0.01], ['blend.cover', 0.2, 0, 1, 0.01], ['blend.coverSub', 0.14, 0, 1, 0.01],
  ['blend.roll', 0.08, 0, 1, 0.01], ['blend.jump', 0.08, 0, 1, 0.01], ['blend.fall', 0.2, 0, 1, 0.01],
  ['blend.land', 0.05, 0, 1, 0.01], ['blend.mantle', 0.1, 0, 1, 0.01], ['blend.climb', 0.15, 0, 1, 0.01],
  ['blend.climbSub', 0.12, 0, 1, 0.01], ['blend.hitreact', 0.06, 0, 1, 0.01], ['blend.death', 0.08, 0, 1, 0.01],
  ['blend.takedown', 0.12, 0, 1, 0.01],                 // into a stealth takedown (src/player/stealth.js) [INFERRED]
  ['blend.velDecay', 0.06, 0.005, 0.5, 0.005],          // dead-blend velocity halflife (s)
  // Gait: cadence anchors (steps/s) at 0.3 / 1.5 / 4.5 / 6.5 m/s, gait biomechanics norms. [INFERRED]
  ['gait.cadenceMin', 1.3, 0.5, 3, 0.05], ['gait.cadenceWalk', 1.95, 1, 3, 0.05],
  ['gait.cadenceRun', 2.95, 1.5, 4, 0.05], ['gait.cadenceSprint', 3.3, 2, 4.5, 0.05],
  ['gait.dutyWalk', 0.62, 0.5, 0.8, 0.01], ['gait.dutyRun', 0.3, 0.2, 0.55, 0.01],    // stance fraction of the cycle (run: at 4.5 m/s, shrinks faster)
  ['gait.runFrom', 2.0, 0.5, 5, 0.1], ['gait.runTo', 3.2, 1, 6, 0.1],                   // walk->run style blend (m/s)
  ['gait.landAheadWalk', 0.5, 0.2, 0.8, 0.01], ['gait.landAheadRun', 0.48, 0.2, 0.8, 0.01], // contact share ahead of hip
  ['gait.swingMatchWalk', 0.25, 0, 1, 0.01], ['gait.swingMatch', 0.55, 0, 1, 0.01], ['gait.retract', 0.3, 0, 1, 0.01],   // swing ground-speed match at lift-off (walk / run) and touch-down
  ['gait.clearWalk', 0.07, 0, 0.3, 0.005], ['gait.clearRun', 0.24, 0, 0.6, 0.01],       // swing height (m)
  ['gait.width', 0.085, 0.02, 0.25, 0.005], ['gait.widthRun', 0.05, 0, 0.2, 0.005], ['gait.toeOut', 0.12, 0, 0.5, 0.01],
  ['gait.bobWalk', 0.024, 0, 0.08, 0.001], ['gait.bobRun', 0.04, 0, 0.1, 0.001],
  ['gait.dropRun', 0.06, 0, 0.2, 0.005], ['gait.dropWalk', 0.012, 0, 0.2, 0.002], ['gait.kneeBend', 0.008, 0, 0.1, 0.001],
  ['gait.pelvisYaw', 0.13, 0, 0.5, 0.01], ['gait.pelvisRoll', 0.07, 0, 0.3, 0.01], ['gait.sway', 0.028, 0, 0.1, 0.002],
  ['gait.armSwing', 0.4, 0, 1.2, 0.01], ['gait.armSwingRun', 0.62, 0, 1.5, 0.01], ['gait.elbowRun', 1.4, 0, 2.2, 0.01],
  ['gait.leanSpeed', 0.02, 0, 0.1, 0.001],              // rad per m/s of forward speed
  ['gait.leanAccel', 0.03, 0, 0.1, 0.001],              // rad per m/s^2 (start / stop / turn bank)
  ['gait.leanFreq', 2.0, 0.5, 6, 0.1], ['gait.leanDamp', 0.5, 0.1, 1.5, 0.01], ['gait.leanMax', 0.35, 0, 0.8, 0.01],
  ['gait.startSpeed', 0.2, 0.02, 1, 0.01], ['gait.stopSpeed', 0.1, 0.01, 1, 0.01],
  ['gait.restepDist', 0.15, 0.03, 0.5, 0.01], ['gait.restepYaw', 0.55, 0.1, 1.5, 0.01],
  ['gait.restepTime', 0.3, 0.1, 1, 0.01], ['gait.restepLift', 0.06, 0, 0.2, 0.005],
  ['gait.reachMax', 0.985, 0.9, 1, 0.001],              // leg extension limit before the pelvis is lowered
  // Idle.
  ['idle.width', 0.13, 0.05, 0.3, 0.005],               // idle stance: ball joints +- this from the body line
  ['idle.breathRate', 0.24, 0.05, 1, 0.01], ['idle.breathAmp', 0.018, 0, 0.08, 0.001],
  ['idle.swayPeriod', 5.5, 1, 15, 0.1], ['idle.swayAmp', 0.016, 0, 0.06, 0.001],
  ['idle.exertRise', 0.12, 0, 1, 0.01], ['idle.exertFall', 0.04, 0, 1, 0.005],
  // Aim offset and pistol holds. TODO(spec): player-spec aim-in time.
  ['aim.blend', 0.07, 0.01, 0.5, 0.005],                // aim-in halflife when animState.aim.weight is absent
  // Pistol aim: gun further out and at eye level, per refs/stealth-measured.md "Pistol aim pose" (U4 frames, low confidence:
  // shoulder->grip ~0.96 of arm reach, ~160 deg at the gun elbow). Was 0.6 / 0.06 / 0.03 [ASSUMED].
  ['aim.gunDist', 0.68, 0.2, 0.8, 0.005], ['aim.gunDrop', 0.02, -0.1, 0.3, 0.005], ['aim.gunRight', 0.0, -0.15, 0.15, 0.005],
  ['aim.spineYaw', 0.8, 0, 1, 0.01], ['aim.spinePitch', 0.45, 0, 1, 0.01], ['aim.maxTwist', 1.3, 0.3, 2, 0.01],
  ['aim.lookW', 0.75, 0, 1, 0.01], ['aim.hipTwist', 0.45, 0, 1, 0.01],
  ['aim.pointHold', 0.8, 0, 3, 0.05],                  // s the gun stays pointed after a hip (non-aimed) shot. TODO(spec)
  ['aim.pointDist', 0.55, 0.3, 0.75, 0.005],           // one-hand point shooting: gun distance from the shoulder
  // Recoil additive from fireT. TODO(spec): player-spec pistol recoil.
  ['recoil.kick', 0.16, 0, 0.6, 0.005], ['recoil.back', 0.035, 0, 0.1, 0.001], ['recoil.peak', 0.035, 0.005, 0.15, 0.001],
  ['recoil.body', 0.035, 0, 0.2, 0.001], ['recoil.oneHand', 1.7, 1, 3, 0.05],
  // Hit react.
  ['hit.amp', 0.3, 0, 1, 0.01], ['hit.peak', 0.07, 0.01, 0.3, 0.005], ['hit.stagger', 0.16, 0, 0.5, 0.01],
  // Cover. TODO(spec): player-spec cover pose heights.
  ['cover.wallDist', 0.35, 0.1, 0.8, 0.01], ['cover.lowPelvis', 0.52, 0.3, 0.8, 0.01], ['cover.lowTop', 1.0, 0.6, 1.4, 0.01],
  ['cover.highPelvis', 0.99, 0.8, 1.05, 0.005], ['cover.popPelvis', 0.84, 0.5, 1.05, 0.01], ['cover.leanOut', 0.32, 0, 0.7, 0.01],
  ['cover.turn', 0.45, 0, 1.2, 0.01], ['cover.kneel', 0.95, 0, 1.4, 0.01],   // turn: low-cover body angled away from the wall (back/shoulder on it, player-spec §4)
  ['cover.rootIntoWall', 1, 0, 1, 1],                   // without cover.normal: 1 = root +Z faces into the wall, 0 = root faces away
  // Roll / jump / land / mantle (fallback durations when animState.modeT is absent). TODO(spec)
  ['roll.duration', 0.8, 0.3, 2, 0.01], ['roll.ballH', 0.42, 0.25, 0.7, 0.01],
  ['jump.takeoff', 0.14, 0.02, 0.5, 0.01],
  ['land.duration', 0.4, 0.1, 1.5, 0.01], ['land.depth', 0.035, 0, 0.1, 0.001], ['land.maxDepth', 0.32, 0, 0.6, 0.01],
  ['mantle.duration', 0.75, 0.2, 2, 0.01], ['mantle.height', 1.2, 0.4, 2, 0.01], ['mantle.dist', 0.45, 0.1, 1, 0.01],
  // Climb. TODO(spec): climb-spec hang geometry and shimmy cadence.
  ['climb.hangDrop', 1.12, 0.8, 1.5, 0.01], ['climb.wallOff', 0.24, 0.05, 0.6, 0.01],
  ['climb.handStep', 0.2, 0.08, 0.6, 0.01], ['climb.handThresh', 0.11, 0.03, 0.4, 0.01], ['climb.braced', 1, 0, 1, 1],
  ['climb.swingFreq', 1.5, 0.3, 4, 0.05], ['climb.swingDamp', 0.3, 0.05, 1, 0.01],
  ['climb.feetBelow', 0.88, 0.6, 1.1, 0.01],            // hanging pelvis above the feet; with B3's climb.hang.drop sets the hang
  ['climb.aimIn', 0.18, 0.02, 0.6, 0.01],               // hang-aim blend-in when climb.aim is absent (climb-spec §5 enter 0.18 s)
  // Reload / throw phase breakpoints (normalized action.t). TODO(spec): pistol reload + throw timings.
  ['reload.out', 0.14, 0, 1, 0.01], ['reload.grab', 0.38, 0, 1, 0.01], ['reload.insert', 0.7, 0, 1, 0.01], ['reload.rack', 0.88, 0, 1, 0.01],
  ['throw.release', 0.32, 0.05, 0.9, 0.01],
  // Death.
  ['death.duration', 1.25, 0.5, 3, 0.01], ['death.slide', 0.45, 0, 1.2, 0.01],
  // Stretch goal: plant feet on game.world.groundAt() when it exists (steps, uneven floor).
  ['ik.ground', 1, 0, 1, 1],
];
const STRING_PARAMS = [['throw.hand', 'left', ['left', 'right']]];   // TODO(spec): which hand throws grenades

class LocalParams {   // stand-in registry when the game object has no params
  constructor() { this.defs = new Map(); }
  define(k, v) { if (!this.defs.has(k)) this.defs.set(k, { value: v }); return this.defs.get(k).value; }
  get(k) { return this.defs.get(k).value; }
  has(k) { return this.defs.has(k); }
}
export function defineAnimParams(params) {
  for (const [k, v, min, max, step] of PARAM_DEFS) params.define('anim.' + k, v, { min, max, step });
  for (const [k, v, options] of STRING_PARAMS) params.define('anim.' + k, v, { options });
}
const PARAM_FIELDS = PARAM_DEFS.map(([k]) => ['anim.' + k, k.replace('.', '_')])
  .concat(STRING_PARAMS.map(([k]) => ['anim.' + k, k.replace('.', '_')]));

// --- scratch -------------------------------------------------------------------------------------------------------------
// _v / _q are for mode-level code. Low-level helpers have their own private scratch so they never clobber a caller's.
const _v = Array.from({ length: 16 }, () => new THREE.Vector3());
const _q = Array.from({ length: 10 }, () => new THREE.Quaternion());
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const UP = new THREE.Vector3(0, 1, 0), X_AXIS = new THREE.Vector3(1, 0, 0);

const qEuler = (q, pitch, yaw, roll) => q.setFromEuler(_e.set(pitch, yaw, roll, 'YXZ'));
// (x, y, z) rotated by yaw about +Y, into out.
const yawVec = (out, yaw, x, y, z) => { const c = Math.cos(yaw), s = Math.sin(yaw); return out.set(x * c + z * s, y, -x * s + z * c); };

function qLog(q, out) {   // quaternion -> scaled axis (rad)
  let x = q.x, y = q.y, z = q.z, w = q.w;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-9) return out.set(2 * x, 2 * y, 2 * z);
  const a = 2 * Math.atan2(s, w) / s;
  return out.set(x * a, y * a, z * a);
}
function qExp(v, out) {   // scaled axis -> quaternion
  const a = v.length();
  if (a < 1e-9) return out.set(v.x / 2, v.y / 2, v.z / 2, 1).normalize();
  const s = Math.sin(a / 2) / a;
  return out.set(v.x * s, v.y * s, v.z * s, Math.cos(a / 2));
}

// --- rest constants ------------------------------------------------------------------------------------------------------
const L_ARM1 = OFFSETS[J.left_elbow].length(), L_ARM2 = OFFSETS[J.left_wrist].length();
const L_LEG1 = OFFSETS[J.left_knee].length(), L_LEG2 = OFFSETS[J.left_ankle].length();
const BALL_H = REST[J.left_foot].y;
const PELVIS_H = REST[J.pelvis].y;
// Per side (0 = left, +X; 1 = right, -X): foot geometry relative to the ball joint (rest foot frame = root frame).
const FOOT = [0, 1].map((k) => {
  const an = REST[k === 0 ? J.left_ankle : J.right_ankle], ba = REST[k === 0 ? J.left_foot : J.right_foot];
  const heel = new THREE.Vector3(an.x, 0, an.z - 0.072);
  return {
    ankleFromBall: an.clone().sub(ba),
    heelFromBallGround: new THREE.Vector3(heel.x - ba.x, 0, heel.z - ba.z),
    ballFromHeel: ba.clone().sub(heel),
    ballZ: ba.z, ballX: ba.x,
  };
});

// IK chains: rest frames from the rest bone directions and the rest pole (the way the middle joint points).
function makeChain(upper, lower, end, pole) {
  const x = OFFSETS[lower].clone().normalize();
  const y = pole.clone().addScaledVector(x, -pole.dot(x)).normalize();
  const h = new THREE.Vector3().crossVectors(x, y);
  // SMPL's lower offset is not exactly in the upper bone's bend plane: orthonormalize the lower rest frame on its own
  // (its hinge axis hl differs from h by a few degrees), so the basis is a true rotation and x2 is hit exactly.
  const xl = OFFSETS[end].clone().normalize();
  const hl = h.clone().addScaledVector(xl, -h.dot(xl)).normalize();
  const yl = new THREE.Vector3().crossVectors(hl, xl).normalize();
  const qU = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, h)).invert();
  const qL = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xl, yl, hl)).invert();
  return { upper, lower, end, l1: OFFSETS[lower].length(), l2: OFFSETS[end].length(), qUinv: qU, qLinv: qL };
}
const ARM = [makeChain(J.left_shoulder, J.left_elbow, J.left_wrist, new THREE.Vector3(0, 0, -1)),
  makeChain(J.right_shoulder, J.right_elbow, J.right_wrist, new THREE.Vector3(0, 0, -1))];
const LEG = [makeChain(J.left_hip, J.left_knee, J.left_ankle, new THREE.Vector3(0, 0, 1)),
  makeChain(J.right_hip, J.right_knee, J.right_ankle, new THREE.Vector3(0, 0, 1))];
const HAND_REST_INV = [HAND_L_AXES, HAND_R_AXES].map((a) => new THREE.Quaternion()
  .setFromRotationMatrix(new THREE.Matrix4().makeBasis(a.long, a.palm, a.thumb)).invert());
const GRIP_INV = GRIP_R.quat.clone().invert();
const PALM_R = new THREE.Vector3(-PALM_L.x, PALM_L.y, PALM_L.z);

// Wrist orientation (root space) from desired (long = wrist->knuckles, palm normal) directions. side 0 = left.
const _hq = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], _hqm = new THREE.Matrix4();
function handQuat(out, side, long, palm) {
  const L = _hq[0].copy(long).normalize();
  const P = _hq[1].copy(palm).addScaledVector(L, -palm.dot(L));
  if (P.lengthSq() < 1e-8) P.set(0, -1, 0).addScaledVector(L, -L.y);
  P.normalize();
  const T = side === 0 ? _hq[2].crossVectors(P, L) : _hq[2].crossVectors(L, P);
  out.setFromRotationMatrix(_hqm.makeBasis(L, P, T));
  return out.multiply(HAND_REST_INV[side]);
}

// --- target pose ---------------------------------------------------------------------------------------------------------
class HandT { constructor() { this.pos = new THREE.Vector3(); this.q = new THREE.Quaternion(); this.pole = new THREE.Vector3(0, -0.3, -1); } }
class FootT { constructor() { this.ball = new THREE.Vector3(); this.q = new THREE.Quaternion(); this.toe = 0; this.pole = new THREE.Vector3(0, 0, 1); } }
function copyHand(h, o) { h.pos.copy(o.pos); h.q.copy(o.q); h.pole.copy(o.pole); }
function lerpHand(h, o, t) {   // h = lerp(h, o, t)
  if (t <= 0) return;
  if (t >= 1) { copyHand(h, o); return; }
  h.pos.lerp(o.pos, t); h.q.slerp(o.q, t); h.pole.lerp(o.pole, t);
}
function lerpTarget(a, b, w) {   // a = lerp(a, b, w), field by field (takedown cross-fade into the death pose)
  if (w <= 0) return;
  a.pelvis.lerp(b.pelvis, w); a.pre.slerp(b.pre, w);
  a.pYaw = lerp(a.pYaw, b.pYaw, w); a.pPitch = lerp(a.pPitch, b.pPitch, w); a.pRoll = lerp(a.pRoll, b.pRoll, w);
  a.sPitch = lerp(a.sPitch, b.sPitch, w); a.sYaw = lerp(a.sYaw, b.sYaw, w); a.sRoll = lerp(a.sRoll, b.sRoll, w);
  a.nPitch = lerp(a.nPitch, b.nPitch, w); a.nYaw = lerp(a.nYaw, b.nYaw, w); a.nRoll = lerp(a.nRoll, b.nRoll, w);
  a.hPitch = lerp(a.hPitch, b.hPitch, w); a.hYaw = lerp(a.hYaw, b.hYaw, w); a.hRoll = lerp(a.hRoll, b.hRoll, w);
  a.look.lerp(b.look, w); if (a.look.lengthSq() < 1e-8) a.look.set(0, 0, 1);
  a.lookW = lerp(a.lookW, b.lookW, w); a.autoCollar = lerp(a.autoCollar, b.autoCollar, w);
  for (let i = 0; i < 2; i++) {
    a.cRaise[i] = lerp(a.cRaise[i], b.cRaise[i], w); a.cFwd[i] = lerp(a.cFwd[i], b.cFwd[i], w);
    const f = a.foot[i], g = b.foot[i];
    f.ball.lerp(g.ball, w); f.q.slerp(g.q, w); f.toe = lerp(f.toe, g.toe, w); f.pole.lerp(g.pole, w);
    lerpHand(a.hand[i], b.hand[i], w);
  }
}

class TargetPose {
  constructor() {
    this.pelvis = new THREE.Vector3(0, PELVIS_H, 0);
    this.pYaw = 0; this.pPitch = 0; this.pRoll = 0; this.pre = new THREE.Quaternion();
    this.sPitch = 0; this.sYaw = 0; this.sRoll = 0;
    this.nPitch = 0; this.nYaw = 0; this.nRoll = 0; this.hPitch = 0; this.hYaw = 0; this.hRoll = 0;
    this.look = new THREE.Vector3(0, 0, 1); this.lookW = 0;
    this.cRaise = [0, 0]; this.cFwd = [0, 0]; this.autoCollar = 1;
    this.foot = [new FootT(), new FootT()];
    this.hand = [new HandT(), new HandT()];
  }
  copy(o) {
    this.pelvis.copy(o.pelvis); this.pYaw = o.pYaw; this.pPitch = o.pPitch; this.pRoll = o.pRoll; this.pre.copy(o.pre);
    this.sPitch = o.sPitch; this.sYaw = o.sYaw; this.sRoll = o.sRoll;
    this.nPitch = o.nPitch; this.nYaw = o.nYaw; this.nRoll = o.nRoll; this.hPitch = o.hPitch; this.hYaw = o.hYaw; this.hRoll = o.hRoll;
    this.look.copy(o.look); this.lookW = o.lookW; this.autoCollar = o.autoCollar;
    for (let i = 0; i < 2; i++) {
      this.cRaise[i] = o.cRaise[i]; this.cFwd[i] = o.cFwd[i];
      const f = this.foot[i], g = o.foot[i]; f.ball.copy(g.ball); f.q.copy(g.q); f.toe = g.toe; f.pole.copy(g.pole);
      copyHand(this.hand[i], o.hand[i]);
    }
    return this;
  }
}

// Bone-space pose: pelvis position (root space) + 22 SMPL local quaternions.
export class Pose {
  constructor() { this.p = new THREE.Vector3(0, PELVIS_H, 0); this.q = Array.from({ length: N }, () => new THREE.Quaternion()); }
  copy(o) { this.p.copy(o.p); for (let i = 0; i < N; i++) this.q[i].copy(o.q[i]); return this; }
}

// A world-locked contact (foot ball point or hand on a hold) that steps to a target along an arc.
class Planter {
  constructor() {
    this.planted = true; this.anchor = new THREE.Vector3(); this.yaw = 0;
    this.from = new THREE.Vector3(); this.fromYaw = 0; this.target = new THREE.Vector3(); this.targetYaw = 0;
    this.u = 0; this.dur = 0.3; this.lift = 0.05; this.kind = 0;   // kind 0 = gait cycle swing, 1 = re-step
    this.pos = new THREE.Vector3(); this.outYaw = 0; this.pitch = 0; this.toe = 0; this.liftPitch = 0;
    this.relFrom = new THREE.Vector3(); this.relFromYaw = 0;   // cycle swing: lift-off point in the root frame
  }
  reset(p, yaw) { this.planted = true; this.anchor.copy(p); this.pos.copy(p); this.yaw = yaw; this.outYaw = yaw; this.u = 0; }
  startStep(kind, dur, lift) {
    this.planted = false; this.kind = kind; this.from.copy(this.pos); this.fromYaw = this.outYaw;
    this.u = 0; this.dur = dur; this.lift = lift; this.liftPitch = this.pitch;
  }
  land() { this.planted = true; this.anchor.copy(this.target); this.yaw = this.targetYaw; this.pos.copy(this.target); this.outYaw = this.yaw; }
}

// Keyframe tables (module constants: no per-frame arrays).
const K_MANTLE_U = [0, 0.2, 0.45, 0.7, 1];
const K_CLIMBUP_U = [0, 0.22, 0.42, 0.65, 1];   // hang, pull, press, crouch on top (climb-spec §3: 0.65 s of 1.0 s), stand
const K_VAULT_U = [0, 0.18, 0.45, 0.68, 1];
// Piecewise smoothstep through 5 keys.
function key5(U, u, a, b, c, d, e) {
  if (u <= U[0]) return a;
  if (u <= U[1]) return lerp(a, b, ease((u - U[0]) / (U[1] - U[0])));
  if (u <= U[2]) return lerp(b, c, ease((u - U[1]) / (U[2] - U[1])));
  if (u <= U[3]) return lerp(c, d, ease((u - U[2]) / (U[3] - U[2])));
  if (u <= U[4]) return lerp(d, e, ease((u - U[3]) / (U[4] - U[3])));
  return e;
}

// =========================================================================================================================
export class Animator {
  constructor(game, rig) {
    this.game = game || {};
    this.params = (game && game.params) || new LocalParams();
    defineAnimParams(this.params);
    this.rig = rig;
    this.bones = rig.list;
    this.P = {};
    this.sources = {};                // clip hook: mode -> {evaluate(animState, dt, pose), upperBody?}

    this.tp = new TargetPose(); this.tpB = new TargetPose();
    this.pose = new Pose(); this.out = new Pose(); this.prev = new Pose(); this.prev2 = new Pose(); this.src = new Pose();
    this.srcVel = Array.from({ length: N }, () => new THREE.Vector3()); this.srcPVel = new THREE.Vector3();
    this.blendT = 1; this.blendDur = 0; this.hasPrev = false; this.prevDt = 1 / 60;
    this.key = -1;
    this.rsP = Array.from({ length: N }, () => new THREE.Vector3());   // FK scratch (root space)
    this.rsQ = Array.from({ length: N }, () => new THREE.Quaternion());
    // Private scratch for helpers.
    this._ik = Array.from({ length: 9 }, () => new THREE.Vector3()); this._ikq = [new THREE.Quaternion(), new THREE.Quaternion()];
    this._ikm = [new THREE.Matrix4(), new THREE.Matrix4()];
    this._hv = Array.from({ length: 6 }, () => new THREE.Vector3()); this._hqq = new THREE.Quaternion();
    this._sup = new HandT(); this._hRel = new HandT(); this._hThr = new HandT(); this._hA = new HandT(); this._hB = new HandT();
    this._ubo = { run: 0, cycle: 0, aimW: 0, ready: 0, hipSwing: -1 };
    this._cs = { mode: 'cover', fireT: 99, action: null, hit: null, cover: null, modeT: undefined, aim: null };
    this._csAim = { on: false, yaw: 0, pitch: 0, weight: undefined };

    // Root kinematics.
    this.rootPos = new THREE.Vector3(); this.prevRootPos = new THREE.Vector3(); this.yaw = 0; this.prevYaw = 0;
    this.vel = new THREE.Vector3(); this.velS = new THREE.Vector3(); this.prevVelS = new THREE.Vector3(); this.acc = new THREE.Vector3();
    this.yawRate = 0; this.speed = 0; this.first = true; this.teleported = false;

    // Gait.
    this.feet = [new Planter(), new Planter()];
    this.phase = 0; this.moving = false; this.cycleW = 0; this.runness = 0; this.duty = 0.62; this.restepCool = 0;
    this.stance = [new THREE.Vector3(), new THREE.Vector3()]; this.stanceYaw = [0, 0]; this.stancePitch = [0, 0];
    this.bodyYaw = 0; this.guard = 0; this.contact = [1, 1];

    // Climb hands.
    this.hands = [new Planter(), new Planter()];
    this.handTarget = [new THREE.Vector3(), new THREE.Vector3()];
    this.climbM = new THREE.Vector3(); this.climbN = new THREE.Vector3(0, 0, -1);
    this.climbBody = new THREE.Vector3(); this.swingV = new THREE.Vector3(); this.climbInit = false;
    this.cuM = new THREE.Vector3(); this.cuInit = false;

    // Smoothed state.
    this.leanP = { x: 0, v: 0 }; this.leanR = { x: 0, v: 0 };
    this.aimW = 0; this.pointW = 0; this.exert = 0; this.breathPh = 0; this.idlePh = 0; this.time = 0;
    this.mode = ''; this.modeTime = 0; this.subTime = 0;
    this.airVy = 0; this.landVy = 0;
    this.mantleOrigin = new THREE.Vector3(); this.mantleYaw = 0;
    this.deathYaw = 0; this.deathBack = 1; this.hitSign = 1;
    this.gunPos = new THREE.Vector3(); this.gunQ = new THREE.Quaternion();
    this.magVisible = false;
  }

  readParams() {
    const P = this.P, ps = this.params;
    for (let i = 0; i < PARAM_FIELDS.length; i++) P[PARAM_FIELDS[i][1]] = ps.get(PARAM_FIELDS[i][0]);
  }

  ub(run, cycle, aimW, ready, hipSwing) {
    const o = this._ubo; o.run = run; o.cycle = cycle; o.aimW = aimW; o.ready = ready; o.hipSwing = hipSwing; return o;
  }

  // ---------------------------------------------------------------------------------------------------------------------
  update(dt, s) {
    if (!s) s = DEFAULT_STATE;
    this.readParams();
    if (!(dt > 0)) dt = 0;
    this.time += dt;
    this.readRoot(dt);

    let mode = MODE_IDX[s.mode] ? s.mode : 'locomotion';
    // B3 runs mantle / vault inside its climb mode: pose those with the mantle evaluator.
    if (mode === 'climb' && s.climb && (s.climb.move === 'mantle' || s.climb.move === 'vault')) mode = 'mantle';
    if (mode !== this.mode) { this.onModeEnter(mode, s); this.mode = mode; this.modeTime = 0; }
    else this.modeTime += dt;

    const key = poseKey(mode, s);
    if (key !== this.key) {
      if (this.key >= 0 && this.hasPrev && !this.teleported) this.startBlend(blendTime(this.P, key, this.key));
      this.key = key; this.subTime = 0;
    } else this.subTime += dt;

    this.updateShared(dt, s, mode);
    this.magVisible = false;

    const src = this.sources[mode];
    if (src && typeof src.evaluate === 'function') {
      src.evaluate(s, dt, this.pose);
      if (src.upperBody !== false) this.overlayUpperBody(s);
    } else {
      const tp = this.tp;
      switch (mode) {
        case 'cover': this.evalCover(tp, s, dt); break;
        case 'roll': this.evalRoll(tp, s, dt); break;
        case 'jump': this.evalAir(tp, s, dt, true); break;
        case 'fall': this.evalAir(tp, s, dt, false); break;
        case 'land': this.evalLand(tp, s, dt); break;
        case 'mantle': this.evalMantle(tp, s, dt); break;
        case 'climb':   // the ledge pull-down stays in mode 'climb' (the skin's hang correction keys on it)
          if (s.takedown && s.takedown.kind === 'ledge' && s.takedown.role === 'attacker' && s.takedown.T) this.evalTakedown(tp, s, dt);
          else this.evalClimb(tp, s, dt);
          break;
        case 'death': this.evalDeath(tp, s, dt); break;
        case 'takedown': this.evalTakedown(tp, s, dt); break;
        case 'hitreact': this.evalLocomotion(tp, s, dt, true); break;
        default: this.evalLocomotion(tp, s, dt, false);
      }
      if (s.reach && s.reach.w > 0 && mode !== 'takedown' && !s.takedown) this.reachCue(tp, s.reach);
      this.solve(tp, this.pose);
    }
    this.applyBlend(dt);
    this.writeBones();
    if (this.rig.mag) this.rig.mag.visible = this.magVisible;
  }

  // --- root kinematics ---------------------------------------------------------------------------------------------------
  readRoot(dt) {
    const root = this.rig.root;
    root.updateWorldMatrix(true, false);
    const e = root.matrixWorld.elements;
    this.prevRootPos.copy(this.rootPos); this.prevYaw = this.yaw;
    this.rootPos.set(e[12], e[13], e[14]);
    this.yaw = Math.atan2(e[8], e[10]);
    this.teleported = false;
    if (this.first) {
      this.first = false; this.prevRootPos.copy(this.rootPos); this.prevYaw = this.yaw; this.teleported = true;
      this.resetFeet();
    }
    if (dt <= 0) return;
    const d = _v[0].subVectors(this.rootPos, this.prevRootPos);
    if (d.lengthSq() > 1.44) {   // > 1.2 m in one step: a teleport, not motion
      this.teleported = true; this.vel.set(0, 0, 0); this.velS.set(0, 0, 0); this.acc.set(0, 0, 0); this.resetFeet(); return;
    }
    this.vel.copy(d).divideScalar(dt);
    this.prevVelS.copy(this.velS);
    this.velS.lerp(this.vel, dampK(0.04, dt));
    const a = _v[1].subVectors(this.velS, this.prevVelS).divideScalar(dt);
    this.acc.lerp(a, dampK(0.05, dt));
    this.yawRate = lerp(this.yawRate, wrapPi(this.yaw - this.prevYaw) / dt, dampK(0.05, dt));
    this.speed = Math.hypot(this.velS.x, this.velS.z);
  }

  resetFeet() {
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const p = yawVec(_v[2], this.yaw, side * (this.P.idle_width || 0.13), 0, FOOT[i].ballZ).add(this.rootPos);
      this.feet[i].reset(p, this.yaw + side * 0.12);
      this.feet[i].pitch = 0; this.feet[i].toe = 0;
    }
    this.moving = false; this.cycleW = 0;
  }

  onModeEnter(mode, s) {
    const prev = this.mode;
    if (mode === 'mantle') { this.mantleOrigin.copy(this.rootPos); this.mantleYaw = this.yaw; }
    if (mode === 'climb') this.climbInit = false;
    if (mode === 'jump') this.airVy = 0;
    if (mode === 'takedown') this.replantFromPose();   // gait planters start where the body is
    if (mode === 'land') this.landVy = Math.min(this.airVy, this.vel.y);
    if (mode === 'death') {
      const d = s.death && s.death.dir;
      let lx = 0, lz = -1;
      if (d) { const c = Math.cos(-this.yaw), sn = Math.sin(-this.yaw); lx = d.x * c + d.z * sn; lz = -d.x * sn + d.z * c; }
      const len = Math.hypot(lx, lz) || 1; lx /= len; lz /= len;
      // Fall along the push: onto the back unless pushed clearly forward; spin up to ~70 deg to line up with it.
      this.deathBack = lz <= 0.2 ? 1 : 0;
      const ang = Math.atan2(lx, lz);
      this.deathYaw = clamp(this.deathBack ? wrapPi(ang - Math.PI) : ang, -1.2, 1.2);
      this.hitSign = lx >= 0 ? 1 : -1;
    }
    // Coming out of a full-body mode: re-plant the feet where the output pose has them, so nothing pops.
    if (prev === 'jump' || prev === 'fall' || prev === 'climb' || prev === 'mantle' || prev === 'roll' || prev === 'death' || prev === 'takedown' || prev === '') {
      if (mode === 'locomotion' || mode === 'cover' || mode === 'land' || mode === 'hitreact') this.replantFromPose();
    }
  }

  replantFromPose() {
    if (!this.hasPrev) { this.resetFeet(); return; }
    this.fkPose(this.out);
    for (let i = 0; i < 2; i++) {
      const p = _v[3].copy(this.rsP[i === 0 ? J.left_foot : J.right_foot]);
      const w = this.rootToWorld(p.setY(0));
      w.y = this.groundY(w.x, w.z);
      const fz = _v[5].set(0, 0, 1).applyQuaternion(this.rsQ[i === 0 ? J.left_ankle : J.right_ankle]);
      this.feet[i].reset(w, this.yaw + Math.atan2(fz.x, fz.z));
      this.feet[i].pitch = 0; this.feet[i].toe = 0;
    }
    this.moving = false; this.cycleW = 0;
  }

  groundY(x, z) {
    const w = this.game.world;
    if (this.P.ik_ground && w && typeof w.groundAt === 'function') {
      const y = w.groundAt(x, z, this.rootPos.y + 0.6);
      if (typeof y === 'number' && Math.abs(y - this.rootPos.y) < 0.6) return y;
    }
    return this.rootPos.y;
  }

  // Aim weight, exertion / breathing, lean springs: shared by all modes.
  updateShared(dt, s, mode) {
    const P = this.P, aim = s.aim;
    if (aim && typeof aim.weight === 'number') this.aimW = aim.on === false ? 0 : clamp(aim.weight, 0, 1);
    else this.aimW = lerp(this.aimW, aim && aim.on ? 1 : 0, dampK(P.aim_blend, dt));
    // Hip fire (shooting without aiming) brings the gun up one-handed toward the aim direction for a moment.
    const firing = typeof s.fireT === 'number' && s.fireT >= 0 && s.fireT < P.aim_pointHold;
    this.pointW = lerp(this.pointW, firing ? 1 : 0, dampK(firing ? 0.025 : 0.12, dt));
    const run = sstep(P.gait_runFrom, P.gait_runTo, this.speed);
    this.exert = clamp(this.exert + (run > 0.5 ? P.idle_exertRise * run : -P.idle_exertFall) * dt, 0, 1);
    this.breathPh = frac(this.breathPh + dt * lerp(P.idle_breathRate, P.idle_breathRate * 2.4, this.exert));
    this.idlePh = frac(this.idlePh + dt / P.idle_swayPeriod);
    if (mode === 'jump' || mode === 'fall') this.airVy = Math.min(this.airVy, this.vel.y);
    else if (mode !== 'land') this.airVy = 0;
    // Lean springs from measured acceleration in the body frame (underdamped: overshoot on start / stop / turns).
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    const af = this.acc.x * sn + this.acc.z * c, al = this.acc.x * c - this.acc.z * sn;
    const vf = this.velS.x * sn + this.velS.z * c;
    spring(this.leanP, clamp(P.gait_leanAccel * af + P.gait_leanSpeed * Math.max(0, vf), -P.gait_leanMax, P.gait_leanMax), P.gait_leanFreq, P.gait_leanDamp, dt);
    spring(this.leanR, clamp(-P.gait_leanAccel * al, -P.gait_leanMax, P.gait_leanMax), P.gait_leanFreq, P.gait_leanDamp, dt);
  }

  // =====================================================================================================================
  // GAIT
  // Stance: per foot (wX = lateral, + = the body's left; fX = forward) in the BODY frame at bodyYaw, around (cx, cz)
  // in root space. pX = idle heel lift (kneeling crouch).
  setStance(bodyYaw, cx, cz, wL, fL, wR, fR, toeOut, pL = 0, pR = 0) {
    yawVec(this.stance[0], bodyYaw, wL, 0, fL); this.stance[0].x += cx; this.stance[0].z += cz;
    yawVec(this.stance[1], bodyYaw, wR, 0, fR); this.stance[1].x += cx; this.stance[1].z += cz;
    this.stanceYaw[0] = bodyYaw + toeOut; this.stanceYaw[1] = bodyYaw - toeOut;
    this.stancePitch[0] = pL; this.stancePitch[1] = pR;
  }

  cadence(v) {
    const P = this.P;
    if (v <= 0.3) return P.gait_cadenceMin;
    if (v <= 1.5) return lerp(P.gait_cadenceMin, P.gait_cadenceWalk, (v - 0.3) / 1.2);
    if (v <= 4.5) return lerp(P.gait_cadenceWalk, P.gait_cadenceRun, (v - 1.5) / 3);
    return lerp(P.gait_cadenceRun, P.gait_cadenceSprint, Math.min(1.5, (v - 4.5) / 2));
  }

  // Advance the feet. bodyYaw: root-space yaw of the body facing. crouch 0..1: shorter, quicker, lower steps.
  updateGait(dt, bodyYaw, crouch) {
    const P = this.P, feet = this.feet, v = this.speed;
    const wasMoving = this.moving;
    if (!this.moving && v > P.gait_startSpeed) this.moving = true;
    else if (this.moving && v < P.gait_stopSpeed) this.moving = false;
    const r = this.runness = sstep(P.gait_runFrom, P.gait_runTo, v) * (1 - crouch);
    const D = this.duty = lerp(P.gait_dutyWalk, P.gait_dutyRun * Math.pow(4.5 / Math.max(4.5, v), 0.6), r) + crouch * 0.06;
    const byw = this.yaw + bodyYaw;
    const vf = this.velS.x * Math.sin(byw) + this.velS.z * Math.cos(byw);
    const lat = v > 0.05 ? clamp(1 - Math.abs(vf) / v, 0, 1) : 0;   // sideways share: quicker, shorter steps
    const f = 0.5 * this.cadence(v) * (1 + 0.35 * lat) * (1 + 0.8 * crouch);
    this.cycleW = lerp(this.cycleW, this.moving ? 1 : 0, dampK(this.moving ? 0.08 : 0.12, dt));

    const anySwing = (!feet[0].planted && feet[0].kind === 0) || (!feet[1].planted && feet[1].kind === 0);
    if (this.moving && !wasMoving) {
      // Start: a running re-step becomes the first cycle swing; else the foot further behind (vs travel) lifts.
      let lead = -1;
      for (let i = 0; i < 2; i++) if (!feet[i].planted) lead = i;
      if (lead < 0) {
        const vx = this.velS.x / (v || 1), vz = this.velS.z / (v || 1);
        const dL = (feet[0].anchor.x - this.rootPos.x) * vx + (feet[0].anchor.z - this.rootPos.z) * vz;
        const dR = (feet[1].anchor.x - this.rootPos.x) * vx + (feet[1].anchor.z - this.rootPos.z) * vz;
        lead = dL <= dR ? 0 : 1;
        this.phase = frac(D + (lead === 1 ? 0.5 : 0) + 1e-4);
      } else {
        this.phase = frac(D + feet[lead].u * (1 - D) + (lead === 1 ? 0.5 : 0));
        feet[lead].kind = 0;
        this.setRelFrom(feet[lead], feet[lead].from, feet[lead].fromYaw);
      }
    }
    if (this.moving) this.phase = frac(this.phase + f * dt);
    else if (anySwing) this.phase = frac(this.phase + Math.max(f, 0.9) * dt);   // finish the step in the air

    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    const width = lerp(P.gait_width, P.gait_widthRun, r) + crouch * 0.03;
    const ahead = lerp(P.gait_landAheadWalk, P.gait_landAheadRun, r);
    for (let i = 0; i < 2; i++) {
      const ft = feet[i], side = i === 0 ? 1 : -1;
      const fp = frac(this.phase + (i === 1 ? 0.5 : 0));
      if (this.moving || (!ft.planted && ft.kind === 0)) {
        const inSwing = fp >= D;
        if (ft.planted && this.moving && inSwing && fp < D + 0.5 * (1 - D)) { ft.startStep(0, (1 - D) / f, 0); this.setRelFrom(ft, ft.pos, ft.outYaw); }
        else if (!ft.planted && ft.kind === 0 && !inSwing) { ft.target.copy(ft.pos); ft.target.y = this.groundY(ft.pos.x, ft.pos.z); ft.targetYaw = ft.outYaw; ft.land(); }
      }
      if (!ft.planted) {
        if (ft.kind === 0) {
          ft.u = clamp((fp - D) / (1 - D), 0, 1);
          // Landing offset relative to the root AT touch-down (root frame): body offset at the predicted yaw plus the
          // distance the root covers between touch-down and the stance's reference point (`ahead` of the stance).
          const tAhead = ahead * D / f;
          const dyaw = clamp(this.yawRate * ((1 - fp) / f + tAhead), -0.9, 0.9);
          const cy = Math.cos(bodyYaw + dyaw), sy = Math.sin(bodyYaw + dyaw);
          const lx = side * width, lz = FOOT[i].ballZ;
          // Root displacement over [touch-down, touch-down + tAhead] under the measured acceleration, without letting
          // braking reverse the velocity (so a stopping character's last step lands short instead of overshooting).
          const tLand = (1 - fp) / f;
          const alx = this.acc.x * c - this.acc.z * sn, alz = this.acc.x * sn + this.acc.z * c;
          const vl2 = this.velS.x * this.velS.x + this.velS.z * this.velS.z;
          const aAlong = vl2 > 1e-4 ? (alx * (this.velS.x * c - this.velS.z * sn) + alz * (this.velS.x * sn + this.velS.z * c)) / Math.sqrt(vl2) : 0;
          const tStop = aAlong < -0.5 ? Math.sqrt(vl2) / -aAlong : 1e9;    // time until braking would stop the root
          const t0 = Math.min(tLand, tStop), t1 = Math.min(tLand + tAhead, tStop);
          const disp = (t1 - t0) + 0.5 * (t1 * t1 - t0 * t0) * aAlong / Math.max(0.05, Math.sqrt(vl2));   // in units of v
          const vlx = this.velS.x * c - this.velS.z * sn, vlz = this.velS.x * sn + this.velS.z * c;
          ft.target.set(lx * cy + lz * sy + vlx * disp, 0, -lx * sy + lz * cy + vlz * disp);   // root frame
          ft.targetYaw = bodyYaw + dyaw + side * P.gait_toeOut;                                     // root frame
        } else {
          ft.u = clamp(ft.u + dt / ft.dur, 0, 1);
          const st = this.stance[i];
          ft.target.set(this.rootPos.x + st.x * c + st.z * sn, 0, this.rootPos.z - st.x * sn + st.z * c);
          ft.target.y = this.groundY(ft.target.x, ft.target.z);
          ft.targetYaw = this.yaw + this.stanceYaw[i];
        }
      }
      // Trajectory + foot pitch (+ heel up about the ball, - toe up about the heel).
      if (ft.planted) {
        ft.pos.copy(ft.anchor); ft.outYaw = ft.yaw;
        if (this.moving) {
          const sg = clamp(fp / D, 0, 1);
          const cp = lerp(-0.3, -0.06, r), ho = lerp(0.62, 0.95, r) * (1 - 0.3 * crouch), hs = lerp(0.5, 0.32, r);
          ft.pitch = (cp * (1 - sstep(0, 0.22, sg)) + ho * sstep(hs, 1, sg)) * this.cycleW;
        } else ft.pitch = lerp(ft.pitch, this.stancePitch[i], dampK(0.07, dt));
        ft.toe = -Math.max(0, ft.pitch);
      } else {
        const u = ft.u;
        let sh, sv, lift, px = 0, pz = 0;
        if (ft.kind === 0) {
          // Hermite in the root frame: starts at the lift-off point moving with the ground (relative velocity -v,
          // scaled by gait.swingMatch), ends at the landing offset retracting a little (gait.retract) so the foot
          // touches down nearly at ground speed. No velocity jump at lift-off, no world-space drift behind the hip.
          const Tsw = (1 - D) / f;
          const vlx = this.velS.x * c - this.velS.z * sn, vlz = this.velS.x * sn + this.velS.z * c;
          const u2 = u * u, u3 = u2 * u;
          const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
          const m0 = -Tsw * lerp(P.gait_swingMatchWalk, P.gait_swingMatch, r), m1 = -Tsw * P.gait_retract;
          px = h00 * ft.relFrom.x + h10 * m0 * vlx + h01 * ft.target.x + h11 * m1 * vlx;
          pz = h00 * ft.relFrom.z + h10 * m0 * vlz + h01 * ft.target.z + h11 * m1 * vlz;
          sh = u * u * u * (u * (u * 6 - 15) + 10);
          sv = lerp(Math.sin(Math.PI * Math.pow(u, 0.85)), Math.sin(Math.PI * Math.pow(u, 0.62)), r);
          lift = lerp(P.gait_clearWalk, P.gait_clearRun, r) * (1 - 0.45 * crouch) * (0.4 + 0.6 * this.cycleW);
          const peak = lerp(0.45, 1.25, r), cp = lerp(-0.3, -0.06, r);
          ft.pitch = u < 0.25 ? lerp(ft.liftPitch, peak, ease(u / 0.25)) : lerp(peak, cp, ease((u - 0.25) / 0.75));
          ft.toe = -Math.max(0, ft.liftPitch) * (1 - sstep(0, 0.3, u));
        } else {
          sh = ease(u); sv = Math.sin(Math.PI * u); lift = ft.lift;
          ft.pitch = lerp(ft.liftPitch, this.stancePitch[i], ease(u)) + 0.22 * Math.sin(Math.PI * u);
          ft.toe = -Math.max(0, ft.pitch) * (1 - Math.sin(Math.PI * u));
        }
        if (ft.kind === 0) {
          ft.pos.set(this.rootPos.x + px * c + pz * sn, 0, this.rootPos.z - px * sn + pz * c);
          ft.pos.y = lerp(ft.from.y, this.groundY(ft.pos.x, ft.pos.z), sh) + lift * sv;
          ft.outYaw = this.yaw + lerpAngle(ft.relFromYaw, ft.targetYaw, sh);
        } else {
          ft.pos.lerpVectors(ft.from, ft.target, sh);
          ft.pos.y += lift * sv;
          ft.outYaw = lerpAngle(ft.fromYaw, ft.targetYaw, sh);
          if (ft.u >= 1) ft.land();
        }
      }
    }

    // Re-step planner (stopped, both feet down): square up to the stance one foot at a time, worst foot first.
    this.restepCool = Math.max(0, this.restepCool - dt);
    if (!this.moving && feet[0].planted && feet[1].planted && this.restepCool <= 0) {
      let best = -1, bestScore = 1, bestDist = 0;
      for (let i = 0; i < 2; i++) {
        const st = this.stance[i];
        const tx = this.rootPos.x + st.x * c + st.z * sn, tz = this.rootPos.z - st.x * sn + st.z * c;
        const err = Math.hypot(feet[i].anchor.x - tx, feet[i].anchor.z - tz);
        const yerr = Math.abs(wrapPi(feet[i].yaw - (this.yaw + this.stanceYaw[i])));
        const score = Math.max(err / P.gait_restepDist, yerr / P.gait_restepYaw);
        if (score > bestScore) { bestScore = score; best = i; bestDist = err; }
      }
      if (best >= 0) {
        feet[best].startStep(1, P.gait_restepTime * (0.75 + 0.6 * Math.min(1, bestDist / 0.5)), P.gait_restepLift * (1 - 0.3 * crouch));
        this.restepCool = 0.05;
      }
    }
  }

  setRelFrom(ft, worldPos, worldYaw) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw), dx = worldPos.x - this.rootPos.x, dz = worldPos.z - this.rootPos.z;
    ft.relFrom.set(dx * c - dz * s, 0, dx * s + dz * c);
    ft.relFromYaw = wrapPi(worldYaw - this.yaw);
  }

  // Gait feet -> root-space foot targets. A planted foot that is out of the leg's reach first raises its heel (up to
  // 1.15 rad, pivoting on the ball) before the pelvis guard lowers the hips.
  gaitFeetToTargets(tp, pelvisYaw) {
    const pq = qEuler(this._hqq, tp.pPitch, tp.pYaw, tp.pRoll).premultiply(tp.pre);
    const maxR = (L_LEG1 + L_LEG2) * this.P.gait_reachMax;
    for (let i = 0; i < 2; i++) {
      const ft = this.feet[i], f = tp.foot[i];
      const lp = this.worldToRoot(_v[6].copy(ft.pos));
      const yaw = wrapPi(ft.outYaw - this.yaw);
      let pitch = ft.pitch;
      this.groundFoot(f, i, lp, yaw, pitch, ft.toe, 0, pelvisYaw);
      if (ft.planted) {
        const hip = this._hv[1].copy(OFFSETS[i === 0 ? J.left_hip : J.right_hip]).applyQuaternion(pq).add(tp.pelvis);
        for (let k = 0; k < 6; k++) {
          const ank = this._hv[2].copy(FOOT[i].ankleFromBall).applyQuaternion(f.q).add(f.ball);
          if (ank.distanceToSquared(hip) <= maxR * maxR || pitch >= 1.15) break;
          pitch = Math.min(1.15, Math.max(pitch, 0) + 0.2);
          this.groundFoot(f, i, lp, yaw, pitch, -pitch, 0, pelvisYaw);
        }
      }
      this.contact[i] = ft.planted ? 1 : 0;
    }
  }

  worldToRoot(p) {
    p.sub(this.rootPos);
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return p.set(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
  }
  rootToWorld(p) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return p.set(p.x * c + p.z * s + this.rootPos.x, p.y + this.rootPos.y, -p.x * s + p.z * c + this.rootPos.z);
  }

  // Foot target from a ground point under the ball (root space), yaw, pitch (+ heel up about the ball, - toe up about
  // the heel), toe bend and roll. The knee pole sits between the foot direction and the pelvis facing, a bit outward.
  groundFoot(f, side, g, yaw, pitch, toe, roll, pelvisYaw) {
    qEuler(f.q, pitch, yaw, roll);
    if (pitch >= 0) f.ball.set(g.x, g.y + BALL_H, g.z);
    else {
      const F = FOOT[side];
      const heel = yawVec(this._hv[0], yaw, F.heelFromBallGround.x, 0, F.heelFromBallGround.z).add(g);
      f.ball.copy(F.ballFromHeel).applyQuaternion(f.q).add(heel);
    }
    f.toe = toe;
    const sd = side === 0 ? 1 : -1;
    f.pole.set(Math.sin(yaw) + Math.sin(pelvisYaw) + sd * 0.15 * Math.cos(pelvisYaw), 0.05,
      Math.cos(yaw) + Math.cos(pelvisYaw) - sd * 0.15 * Math.sin(pelvisYaw)).normalize();
  }

  // Lower the pelvis so ground-contact legs can reach (rises instantly, relaxes smoothly).
  pelvisGuard(tp, dt) {
    const pq = qEuler(this._hqq, tp.pPitch, tp.pYaw, tp.pRoll).premultiply(tp.pre);
    const maxR = (L_LEG1 + L_LEG2) * this.P.gait_reachMax;
    let need = 0;
    for (let i = 0; i < 2; i++) {
      if (!this.contact[i]) continue;   // a swinging foot never drags the hips down
      const hip = this._hv[1].copy(OFFSETS[i === 0 ? J.left_hip : J.right_hip]).applyQuaternion(pq).add(tp.pelvis);
      const ank = this._hv[2].copy(FOOT[i].ankleFromBall).applyQuaternion(tp.foot[i].q).add(tp.foot[i].ball);
      const dx = ank.x - hip.x, dz = ank.z - hip.z, dy = hip.y - ank.y, dh2 = dx * dx + dz * dz;
      if (dh2 + dy * dy > maxR * maxR) need = Math.max(need, dy - (dh2 < maxR * maxR ? Math.sqrt(maxR * maxR - dh2) : 0));
    }
    this.guard = lerp(this.guard, need, dampK(need > this.guard ? 0.02 : 0.08, dt));
    tp.pelvis.y -= this.guard;
  }

  // =====================================================================================================================
  // FK / IK
  fkJoint(i, q) {
    const p = PARENTS[i];
    if (p < 0) { this.rsQ[i].copy(q); this.rsP[i].copy(this.pose.p); return; }
    this.rsQ[i].multiplyQuaternions(this.rsQ[p], q);
    this.rsP[i].copy(OFFSETS[i]).applyQuaternion(this.rsQ[p]).add(this.rsP[p]);
  }
  fkPose(pose) {
    for (let i = 0; i < N; i++) {
      const p = PARENTS[i];
      if (p < 0) { this.rsQ[i].copy(pose.q[i]); this.rsP[i].copy(pose.p); continue; }
      this.rsQ[i].multiplyQuaternions(this.rsQ[p], pose.q[i]);
      this.rsP[i].copy(OFFSETS[i]).applyQuaternion(this.rsQ[p]).add(this.rsP[p]);
    }
  }

  // Pelvis, spine, neck, head (pre-look) and rest collars/shoulders into this.pose + FK scratch.
  solveTrunk(tp) {
    const pose = this.pose, q = pose.q;
    pose.p.copy(tp.pelvis);
    qEuler(q[J.pelvis], tp.pPitch, tp.pYaw, tp.pRoll).premultiply(tp.pre);
    this.fkJoint(J.pelvis, q[J.pelvis]);
    qEuler(q[J.spine1], tp.sPitch * 0.28, tp.sYaw * 0.28, tp.sRoll * 0.28); this.fkJoint(J.spine1, q[J.spine1]);
    qEuler(q[J.spine2], tp.sPitch * 0.34, tp.sYaw * 0.34, tp.sRoll * 0.34); this.fkJoint(J.spine2, q[J.spine2]);
    qEuler(q[J.spine3], tp.sPitch * 0.38, tp.sYaw * 0.38, tp.sRoll * 0.38); this.fkJoint(J.spine3, q[J.spine3]);
    qEuler(q[J.neck], tp.nPitch, tp.nYaw, tp.nRoll); this.fkJoint(J.neck, q[J.neck]);
    qEuler(q[J.head], tp.hPitch, tp.hYaw, tp.hRoll); this.fkJoint(J.head, q[J.head]);
    q[J.left_collar].identity(); this.fkJoint(J.left_collar, q[J.left_collar]);
    q[J.right_collar].identity(); this.fkJoint(J.right_collar, q[J.right_collar]);
    const id = _q[9].identity();
    this.fkJoint(J.left_shoulder, id); this.fkJoint(J.right_shoulder, id);
  }

  solve(tp, pose) {
    const q = pose.q;
    this.solveTrunk(tp);
    // Look-at, split 40 % neck / 60 % head, clamped to 85 deg off the chest's forward.
    if (tp.lookW > 0.001) {
      const chestQ = this.rsQ[J.spine3];
      const up = _v[10].set(0, 1, 0).applyQuaternion(chestQ);
      const z = _v[11].copy(tp.look).normalize();
      const cf = _v[12].set(0, 0, 1).applyQuaternion(chestQ);
      const ang = Math.acos(clamp(cf.dot(z), -1, 1));
      if (ang > 1.48) { _q[1].setFromUnitVectors(cf, z); _q[2].identity().slerp(_q[1], 1.48 / ang); z.copy(cf).applyQuaternion(_q[2]); }
      const x = _v[12].crossVectors(up, z);
      if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
      x.normalize();
      const y = _v[10].crossVectors(z, x);
      const want = _q[3].setFromRotationMatrix(this._ikm[0].makeBasis(x, y, z));
      const dq = _q[4].copy(chestQ).invert().multiply(want);
      q[J.neck].slerp(_q[5].identity().slerp(dq, 0.4), tp.lookW);
      this.fkJoint(J.neck, q[J.neck]);
      q[J.head].slerp(_q[6].copy(this.rsQ[J.neck]).invert().multiply(want), tp.lookW);
      this.fkJoint(J.head, q[J.head]);
    }
    // Legs.
    for (let i = 0; i < 2; i++) {
      const f = tp.foot[i], ch = LEG[i];
      const ank = _v[9].copy(FOOT[i].ankleFromBall).applyQuaternion(f.q).add(f.ball);
      this.fkJoint(ch.upper, _q[9].identity());
      this.ik(ch, ank, f.pole, q);
      q[ch.end].copy(this.rsQ[ch.lower]).invert().multiply(f.q);
      this.fkJoint(ch.end, q[ch.end]);
      q[i === 0 ? J.left_foot : J.right_foot].setFromAxisAngle(X_AXIS, f.toe);
    }
    // Arms: auto collar (raise for overhead targets, protract for forward / across), IK, wrist orientation.
    const chestInv = _q[7].copy(this.rsQ[J.spine3]).invert();
    for (let i = 0; i < 2; i++) {
      const h = tp.hand[i], ch = ARM[i], col = i === 0 ? J.left_collar : J.right_collar, sd = i === 0 ? 1 : -1;
      const rel = _v[10].subVectors(h.pos, this.rsP[ch.upper]).applyQuaternion(chestInv);
      const reach = L_ARM1 + L_ARM2;
      const up = clamp(rel.y / reach, -0.2, 1), fw = clamp(rel.z / reach, -0.6, 1), across = clamp(-sd * rel.x / reach, 0, 1);
      const raise = tp.cRaise[i] + tp.autoCollar * (0.42 * Math.max(0, up) - 0.05 * Math.max(0, -up));
      const fwd = tp.cFwd[i] + tp.autoCollar * (0.22 * Math.max(0, fw) + 0.28 * across - 0.12 * Math.max(0, -fw));
      qEuler(q[col], 0, -sd * fwd, sd * raise);
      this.fkJoint(col, q[col]);
      this.fkJoint(ch.upper, _q[9].identity());
      this.ik(ch, h.pos, h.pole, q);
      q[ch.end].copy(this.rsQ[ch.lower]).invert().multiply(h.q);
      this.fkJoint(ch.end, q[ch.end]);
    }
  }

  // Analytic two-bone IK in root space: writes the local quats of upper and lower and FKs them.
  ik(ch, target, pole, q) {
    const S = this._ik, A = this.rsP[ch.upper], l1 = ch.l1, l2 = ch.l2;
    const d = S[0].subVectors(target, A);
    let dist = d.length();
    const dn = dist > 1e-6 ? d.divideScalar(dist) : d.set(0, -1, 0);
    dist = clamp(dist, Math.abs(l1 - l2) + 1e-4, (l1 + l2) * 0.9999);
    const pp = S[1].copy(pole).addScaledVector(dn, -pole.dot(dn));
    if (pp.lengthSq() < 1e-8) { pp.set(0, 0, 1).addScaledVector(dn, -dn.z); if (pp.lengthSq() < 1e-8) pp.set(1, 0, 0); }
    pp.normalize();
    const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
    const x1 = S[2].copy(dn).multiplyScalar(cosA).addScaledVector(pp, sinA);
    const B = S[3].copy(A).addScaledVector(x1, l1);
    const x2 = S[4].copy(A).addScaledVector(dn, dist).sub(B).divideScalar(l2);
    const h = S[5].crossVectors(dn, pp).normalize();
    const y1 = S[6].crossVectors(h, x1), y2 = S[7].crossVectors(h, x2);
    const qU = this._ikq[0].setFromRotationMatrix(this._ikm[0].makeBasis(x1, y1, h)).multiply(ch.qUinv);
    const qL = this._ikq[1].setFromRotationMatrix(this._ikm[1].makeBasis(x2, y2, h)).multiply(ch.qLinv);
    q[ch.upper].copy(this.rsQ[PARENTS[ch.upper]]).invert().multiply(qU);
    this.fkJoint(ch.upper, q[ch.upper]);
    q[ch.lower].copy(qU).invert().multiply(qL);
    this.fkJoint(ch.lower, q[ch.lower]);
  }

  // =====================================================================================================================
  // HAND TARGETS
  rightFromGun(h, gunPos, gunQ) {   // gun transform -> right wrist target (through the grip socket)
    h.q.copy(gunQ).multiply(GRIP_INV);
    h.pos.copy(GRIP_R.pos).applyQuaternion(h.q).negate().add(gunPos);
  }
  leftFromGun(h, gunPos, gunQ) {    // gun transform -> left support-hand wrist target
    h.q.copy(gunQ).multiply(SUPPORT_L.quat);
    const palm = this._hv[3].copy(SUPPORT_L.pos).applyQuaternion(gunQ).add(gunPos);
    h.pos.copy(PALM_L).applyQuaternion(h.q).negate().add(palm);
  }
  // Wrist target placing the palm centre at p, palm facing palmN, fingers along long.
  handAtPalm(h, side, p, palmN, long) {
    handQuat(h.q, side, long, palmN);
    h.pos.copy(side === 0 ? PALM_L : PALM_R).applyQuaternion(h.q).negate().add(p);
  }
  // Free arm from the shoulder in the chest frame: swing (+ forward), elbow flex, abduction. Palm toward the thigh.
  armSwing(h, side, swing, flex, abd) {
    const sd = side === 0 ? 1 : -1, chestQ = this.rsQ[J.spine3], S = this.rsP[ARM[side].upper];
    const ca = Math.cos(abd), sa = Math.sin(abd);
    const u = this._hv[3].set(sd * sa, -ca * Math.cos(swing), ca * Math.sin(swing)).applyQuaternion(chestQ);
    const f = this._hv[4].set(sd * sa * 0.5, -ca * Math.cos(swing + flex), ca * Math.sin(swing + flex)).normalize().applyQuaternion(chestQ);
    h.pos.copy(S).addScaledVector(u, L_ARM1 * 0.995).addScaledVector(f, L_ARM2 * 0.995);
    h.pole.set(sd * 0.35, -0.15, -1).applyQuaternion(chestQ);
    handQuat(h.q, side, f, this._hv[5].set(-sd, 0, 0.25).applyQuaternion(chestQ));
  }
  // Two-hand aim gun transform: neck-base pivot, rotated by the full aim yaw / pitch (root space).
  aimGun(outPos, outQ, yaw, pitch) {
    const P = this.P;
    qEuler(outQ, -pitch, yaw, 0);
    outPos.set(-P.aim_gunRight, -P.aim_gunDrop, P.aim_gunDist).applyQuaternion(outQ).add(this.rsP[J.neck]);
    outPos.y -= 0.02;
  }

  // Upper-body layer: hip (one hand) / ready (two hands, muzzle up) <-> aim (two hands), recoil, reload / throw.
  // Needs solveTrunk(tp) first. bodyYaw = pelvis facing (root space).
  upperBody(tp, s, bodyYaw, o) {
    const P = this.P;
    const act = s.action, type = act && act.type, throwing = type === 'throwAim' || type === 'throw';
    // While a grenade is held / thrown the pistol stays at the hip in the other hand.
    const r = o.run, cw = o.cycle, ph = this.phase, aimW = throwing ? 0 : o.aimW;
    const aimYaw = (s.aim && s.aim.yaw) || 0, aimPitch = (s.aim && s.aim.pitch) || 0;
    const hR = tp.hand[1], hL = tp.hand[0];
    const chestQ = this.rsQ[J.spine3];
    const cfw = _v[13].set(0, 0, 1).applyQuaternion(chestQ);
    const chestYaw = Math.atan2(cfw.x, cfw.z);
    const gunPos = this.gunPos, gunQ = this.gunQ;
    // Hip: right forearm forward, gun pointing forward-down; swings a little with the gait.
    const swingR = o.hipSwing >= 0 ? o.hipSwing : 0.12 + cw * lerp(0.12, 0.25, r) * Math.cos(TAU * ph) + r * 0.25;
    this.armSwing(hR, 1, swingR, lerp(0.75, 1.5, r), 0.18);
    gunPos.copy(GRIP_R.pos).applyQuaternion(hR.q).add(hR.pos);
    qEuler(gunQ, lerp(0.95, 0.62, r), chestYaw + 0.1, 0);
    if (o.ready > 0) {   // compact high-ready at the chest, muzzle up along the chest facing (cover)
      gunPos.set(-0.05, 0.1, 0.27).applyQuaternion(chestQ).add(this.rsP[J.spine3]);
      qEuler(gunQ, -o.ready, chestYaw, 0);
    }
    const pw = this.pointW * (1 - aimW) * (o.ready > 0 || throwing ? 0 : 1);
    if (pw > 0.001) {   // one-hand point shooting from the right shoulder
      const pq = qEuler(_q[2], -aimPitch, aimYaw, 0);
      const pp = _v[14].set(0.02, -0.05, P.aim_pointDist).applyQuaternion(pq).add(this.rsP[ARM[1].upper]);
      gunPos.lerp(pp, pw); gunQ.slerp(pq, pw);
    }
    if (aimW > 0) {
      const aimPos = _v[14], aimQ = _q[2];
      this.aimGun(aimPos, aimQ, aimYaw, aimPitch);
      gunPos.lerp(aimPos, aimW); gunQ.slerp(aimQ, aimW);
    }
    const twoHand = o.ready > 0 ? 1 : aimW;
    // Recoil: the gun kicks muzzle-up and back; the chest and head follow a little.
    if (typeof s.fireT === 'number' && s.fireT >= 0 && s.fireT < 1) {
      const k = pulse(s.fireT, P.recoil_peak) * lerp(P.recoil_oneHand, 1, twoHand);
      gunPos.addScaledVector(_v[12].set(0, 0, 1).applyQuaternion(gunQ), -P.recoil_back * k);
      gunPos.y += 0.012 * k;
      gunQ.multiply(_q[3].setFromAxisAngle(X_AXIS, -P.recoil_kick * k));
      tp.sPitch -= P.recoil_body * k * twoHand; tp.nPitch -= P.recoil_body * 0.6 * k;
    }
    if (type === 'reload') this.reloadGun(gunPos, gunQ, clamp(act.t || 0, 0, 1));
    this.rightFromGun(hR, gunPos, gunQ);
    hR.pole.set(-0.6, -1, -0.35).applyQuaternion(chestQ);
    // Left hand: free swing <-> support grip.
    // Arm swing opposite the legs, lagging a little: elbow tighter at the front, hand to the hip at the back, crossing
    // slightly toward the midline at the front of a run.
    const sw = -Math.cos(TAU * (ph - 0.04)), front = Math.max(0, sw) * cw, backS = Math.max(0, -sw) * cw;
    const swingL = cw * lerp(P.gait_armSwing, P.gait_armSwingRun, r) * sw - 0.12 * r * cw;
    const flexL = lerp(0.22, P.gait_elbowRun, r) + r * (0.22 * front - 0.12 * backS);
    this.armSwing(hL, 0, swingL, flexL, 0.12 + 0.05 * r - 0.14 * r * front);
    if (twoHand > 0.001) {
      const sup = this._sup;
      this.leftFromGun(sup, gunPos, gunQ);
      sup.pole.set(0.7, -1, -0.25).applyQuaternion(chestQ);
      lerpHand(hL, sup, twoHand);
    }
    if (type === 'reload') this.reloadLeft(tp, hL, gunPos, gunQ, clamp(act.t || 0, 0, 1));
    else if (type === 'throwAim' || type === 'throw') this.throwArm(tp, s, type === 'throw' ? clamp(act.t || 0, 0, 1) : -1);
  }

  // Reload: gun comes in to the chest and tilts its magwell toward the left hand; racks at the end.
  reloadGun(gunPos, gunQ, t) {
    const P = this.P, chestQ = this.rsQ[J.spine3];
    const inW = sstep(0, P.reload_out, t) * (1 - sstep(P.reload_rack + 0.02, 1, t));
    gunPos.lerp(_v[12].set(-0.06, -0.02, 0.32).applyQuaternion(chestQ).add(this.rsP[J.spine3]), inW);
    const tilt = qEuler(_q[3], -0.35, 0.25, 0.55).premultiply(chestQ);
    gunQ.slerp(tilt, inW);
    gunPos.addScaledVector(_v[12].set(0, 0, 1).applyQuaternion(gunQ), -0.03 * bump(P.reload_rack - 0.04, P.reload_rack + 0.06, t));
    gunQ.multiply(_q[3].setFromAxisAngle(X_AXIS, 0.25 * bump(P.reload_out * 0.5, P.reload_out + 0.08, t)));
  }
  // Left hand: to the belt pouch, grab, bring the mag up, palm-up insert into the grip, over the slide to rack, return.
  reloadLeft(tp, hL, gunPos, gunQ, t) {
    const P = this.P, h = this._hRel;
    const pouch = _v[8].set(0.13, 0.05, 0.1).applyQuaternion(this.rsQ[J.pelvis]).add(this.rsP[J.pelvis]);
    const well = _v[9].set(0, -0.15, -0.04).applyQuaternion(gunQ).add(gunPos);
    const wellIn = _v[10].set(0, -0.1, -0.03).applyQuaternion(gunQ).add(gunPos);
    const slide = _v[11].set(0.035, 0.075, -0.03).applyQuaternion(gunQ).add(gunPos);
    const gUp = _v[5].set(0, 1, 0).applyQuaternion(gunQ), gDown = _v[6].copy(gUp).negate(), gFwd = _v[7].set(0, 0, 1).applyQuaternion(gunQ);
    const t0 = P.reload_out, t1 = P.reload_grab, t2 = P.reload_insert, t3 = P.reload_rack, tm = (t0 + t1) / 2;
    let w = 1;
    if (t < tm) { w = ease(t / tm); this.handAtPalm(h, 0, pouch, _v[4].set(-0.3, -0.2, 0.6), _v[3].set(0, -1, 0.2)); }
    else if (t < t1) { this.handAtPalm(h, 0, pouch, _v[4].set(-0.3, -0.2, 0.6), _v[3].set(0, -1, 0.2)); }
    else if (t < t2) {
      const a = ease((t - t1) / (t2 - t1));
      const p = _v[12].lerpVectors(pouch, well, a); p.y += 0.06 * Math.sin(Math.PI * a);
      this.handAtPalm(h, 0, p, _v[4].set(-0.3, -0.2, 0.6).lerp(gUp, a), _v[3].set(0, -1, 0.2).lerp(gFwd, a));
      this.magVisible = true;
    } else if (t < t3) {
      const a = (t - t2) / (t3 - t2), ins = ease(clamp(a / 0.35, 0, 1)), toSlide = sstep(0.45, 1, a);
      const p = _v[12].lerpVectors(well, wellIn, ins).lerp(slide, toSlide);
      this.handAtPalm(h, 0, p, _v[4].copy(gUp).lerp(gDown, toSlide), gFwd);
      this.magVisible = a < 0.35;
    } else { w = 1 - sstep(t3, 1, t); this.handAtPalm(h, 0, slide, gDown, gFwd); }
    h.pole.set(0.8, -1, -0.2).applyQuaternion(this.rsQ[J.spine3]);
    lerpHand(hL, h, w);
    // Eyes on the gun.
    tp.look.lerp(_v[12].subVectors(gunPos, this.rsP[J.head]).normalize(), 0.7 * w).normalize();
    tp.lookW = Math.max(tp.lookW, 0.8 * w);
  }

  // Grenade: wind-up hold (t < 0) cocks the throwing hand behind and above the shoulder with the torso twisted back;
  // t 0..1 whips it over the shoulder to the release point (anim.throw.release) and follows through across the body.
  throwArm(tp, s, t) {
    const P = this.P;
    const side = P.throw_hand === 'right' ? 1 : 0, sd = side === 0 ? 1 : -1;
    const aimYaw = (s.aim && s.aim.yaw) || 0, aimPitch = (s.aim && s.aim.pitch) || 0;
    const R = P.throw_release;
    const aimQ = qEuler(_q[3], -aimPitch * 0.6, aimYaw, 0);
    const cock = _v[8].set(sd * 0.1, 0.16, -0.24), rel = _v[9].set(sd * 0.02, 0.3, 0.36), follow = _v[10].set(-sd * 0.3, -0.45, 0.3);
    let p;
    if (t < 0) p = cock;
    else if (t < R) p = cock.lerp(rel, ease(sstep(R * 0.2, R, t)));
    else p = rel.lerp(follow, ease(clamp((t - R) / Math.max(0.05, 0.65 - R), 0, 1)));
    const back = t < 0 ? 1 : 1 - ease(clamp(t / R, 0, 1));
    const done = t < 0 ? 0 : sstep(0.72, 1, t);
    const over = t < 0 ? 0 : sstep(R * 0.5, 0.7, t) * (1 - done);
    tp.sYaw += sd * (0.45 * back - 0.35 * over);
    tp.sPitch += -0.12 * back + 0.25 * over;
    tp.sRoll += -sd * 0.08 * back;
    const target = p.applyQuaternion(aimQ).add(this.rsP[ARM[side].upper]);
    const H = this._hThr;
    // Palm toward the throw (holding the grenade), fingers up.
    this.handAtPalm(H, side, target, _v[11].set(0, 0, 1).applyQuaternion(aimQ), _v[12].set(0, 1, -0.3).applyQuaternion(aimQ));
    H.pole.set(sd, -0.5 + 0.6 * back, -0.4).applyQuaternion(this.rsQ[J.spine3]);
    lerpHand(tp.hand[side], H, 1 - done);
    tp.lookW = Math.max(tp.lookW, 0.9);
  }

  // =====================================================================================================================
  // MODES
  baseTrunk(tp) {
    tp.pre.identity(); tp.pYaw = 0; tp.pPitch = 0; tp.pRoll = 0; tp.sPitch = 0; tp.sYaw = 0; tp.sRoll = 0;
    tp.nPitch = 0; tp.nYaw = 0; tp.nRoll = 0; tp.hPitch = 0; tp.hYaw = 0; tp.hRoll = 0;
    tp.cRaise[0] = tp.cRaise[1] = 0; tp.cFwd[0] = tp.cFwd[1] = 0; tp.autoCollar = 1; tp.lookW = 0;
  }
  lookAim(tp, s, w) {   // head looks along the aim / camera direction
    const yaw = (s.aim && s.aim.yaw) || 0, pitch = (s.aim && s.aim.pitch) || 0;
    tp.look.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    tp.lookW = w;
  }

  additives(tp, s, strong) {
    const P = this.P;
    // Breathing: chest and collars, stronger and faster after exertion.
    const b = Math.sin(TAU * this.breathPh) * P.idle_breathAmp * (1 + 1.6 * this.exert);
    tp.sPitch -= b * 0.6; tp.cRaise[0] += b * 0.9; tp.cRaise[1] += b * 0.9; tp.nPitch += b * 0.3;
    // Directional hit react: the torso is pushed along the bullet's travel, twisting away from the side it came from.
    const hit = s.hit;
    if (hit && hit.dir && typeof hit.t === 'number' && hit.t >= 0 && hit.t < 1.2) {
      const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
      let dx = hit.dir.x * c - hit.dir.z * sn, dz = hit.dir.x * sn + hit.dir.z * c;
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const k = pulse(hit.t, P.hit_peak) * P.hit_amp * (strong ? 1.8 : 1) * (hit.part === 'limb' ? 0.5 : 1);
      const head = hit.part === 'head' ? 1 : 0;
      tp.sPitch += dz * k * (1 - 0.5 * head);
      tp.sRoll += -dx * k * 0.8;
      tp.sYaw += (dx >= 0 ? 1 : -1) * k * 0.5;
      tp.nPitch += dz * k * (0.4 + 1.6 * head); tp.nRoll += -dx * k * (0.3 + head);
      tp.pelvis.x += dx * k * 0.08; tp.pelvis.z += dz * k * 0.08; tp.pelvis.y -= k * 0.05;
    }
  }

  // --- locomotion: idle / walk / run, aim offset, actions, stagger --------------------------------------------------------
  evalLocomotion(tp, s, dt, stagger) {
    const P = this.P;
    this.baseTrunk(tp);
    const aimW = this.aimW, aimYaw = (s.aim && s.aim.yaw) || 0, aimPitch = (s.aim && s.aim.pitch) || 0;
    // Body facing: forward. Aiming while moving sideways turns the hips partly toward travel (backpedal: square).
    let bodyYaw = 0;
    if (this.speed > 0.3 && aimW > 0) {
      const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
      const mv = Math.atan2(this.velS.x * c - this.velS.z * sn, this.velS.x * sn + this.velS.z * c);
      const toward = Math.abs(mv) < 2.1 ? mv : wrapPi(mv - Math.PI);
      bodyYaw = clamp(toward, -0.8, 0.8) * P.aim_hipTwist * aimW * sstep(0.3, 1.2, this.speed);
    }
    bodyYaw += aimW * clamp(aimYaw, -0.5, 0.5) * 0.3;
    this.bodyYaw = lerpAngle(this.bodyYaw, bodyYaw, dampK(0.1, dt));
    bodyYaw = this.bodyYaw;
    // Stance: square when relaxed; staggered (support foot forward) and wider when aiming.
    const st = aimW;
    this.setStance(bodyYaw, 0, 0, P.idle_width + 0.02 * st, FOOT[0].ballZ + 0.1 * st, -P.idle_width - 0.02 * st, FOOT[1].ballZ - 0.02 - 0.1 * st, P.gait_toeOut + 0.15 * st);
    if (stagger && s.hit && s.hit.dir && typeof s.hit.t === 'number' && s.hit.t < 0.6) {
      // A hard hit shoves the stance along the push so the planner takes a recovery step.
      const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
      const dx = s.hit.dir.x * c - s.hit.dir.z * sn, dz = s.hit.dir.x * sn + s.hit.dir.z * c;
      const l = Math.hypot(dx, dz) || 1, k = P.hit_stagger * sstep(0, 0.12, s.hit.t);
      this.stance[0].x += dx / l * k; this.stance[0].z += dz / l * k;
      this.stance[1].x += dx / l * k * 0.4; this.stance[1].z += dz / l * k * 0.4;
    }
    this.updateGait(dt, bodyYaw, 0);
    const r = this.runness, cw = this.cycleW, p = this.phase, phs = p - this.duty / 2;   // phs 0 = left mid-stance
    // Pelvis: bob (walk peaks / run dips at mid-stance), sway over the stance foot, hip yaw + drop, idle weight shift.
    const swayIdle = Math.sin(TAU * this.idlePh) * P.idle_swayAmp * (1 - cw);
    const hipYaw = cw * P.gait_pelvisYaw * (1 + 0.4 * r) * -Math.cos(TAU * p);
    const bob = cw * (P.gait_bobWalk * (1 - r) - P.gait_bobRun * r) * Math.cos(2 * TAU * phs);
    const sway = cw * P.gait_sway * (1 - 0.6 * r) * Math.cos(TAU * phs) + swayIdle;
    tp.pYaw = bodyYaw + hipYaw;
    tp.pRoll = cw * P.gait_pelvisRoll * (1 - 0.3 * r) * Math.cos(TAU * phs) + swayIdle * 2.5 + this.leanR.x * 0.5;
    tp.pPitch = 0.03 + 0.06 * r + this.leanP.x * 0.4;
    yawVec(tp.pelvis, bodyYaw, sway - this.leanR.x * 0.1, 0, this.leanP.x * 0.12);
    tp.pelvis.y = PELVIS_H - P.gait_kneeBend - lerp(P.gait_dropWalk * cw, P.gait_dropRun, r) - 0.02 * st + bob - Math.abs(swayIdle) * 0.4;
    // Spine: shoulders counter-rotate the hips; aiming holds the chest on the aim yaw.
    const lookFollow = (1 - cw) * clamp(aimYaw, -0.6, 0.6) * 0.2;
    const follow = Math.max(aimW, this.pointW * 0.7);
    const chestYaw = lerp(bodyYaw - 0.7 * hipYaw + lookFollow, clamp(aimYaw * P.aim_spineYaw, -P.aim_maxTwist, P.aim_maxTwist), follow);
    tp.sYaw = chestYaw - tp.pYaw;
    tp.sPitch = 0.02 + 0.03 * r + this.leanP.x * 0.6 + follow * (0.03 - aimPitch * P.aim_spinePitch);
    tp.sRoll = -tp.pRoll * 0.6 + this.leanR.x * 0.5;
    this.additives(tp, s, stagger);
    // Head tracks the camera direction (fades out when the camera looks far behind) and fully when aiming.
    this.lookAim(tp, s, lerp(P.aim_lookW * (1 - sstep(1.4, 2.4, Math.abs(aimYaw))), 1, follow));
    this.gaitFeetToTargets(tp, tp.pYaw);
    this.pelvisGuard(tp, dt);
    this.solveTrunk(tp);
    this.upperBody(tp, s, bodyYaw, this.ub(r, cw, aimW, 0, -1));
  }

  // --- cover: low (kneeling crouch, shoulder to the wall) / high (back to the wall), move, popup, lean, blind ------------
  // Posed in a WALL frame (+Z into the wall). With cover.normal (world, out of the wall) the root may face either way
  // (player-spec §4: the controller snaps the character facing away from the wall); without it the root's facing
  // decides: anim.cover.rootIntoWall 1 = root +Z into the wall (B1's cover.js today), 0 = root faces away.
  evalCover(tp, s, dt) {
    const cv = s.cover || DEFAULT_COVER, realYaw = this.yaw;
    let wallYaw = realYaw;
    if (cv.normal && (cv.normal.x || cv.normal.z)) wallYaw = Math.atan2(-cv.normal.x, -cv.normal.z);
    else if (!this.P.cover_rootIntoWall) wallYaw = realYaw + Math.PI;
    const off = wrapPi(wallYaw - realYaw);
    if (Math.abs(off) < 1e-4) { this.evalCoverWall(tp, s, dt); return; }
    // Proxy state: aim yaw re-expressed in the wall frame; everything else by reference.
    const cs = this._cs, ca = this._csAim, a = s.aim;
    cs.mode = s.mode; cs.fireT = s.fireT; cs.action = s.action; cs.hit = s.hit; cs.cover = cv; cs.modeT = s.modeT;
    if (a) { ca.on = a.on; ca.yaw = wrapPi((a.yaw || 0) - off); ca.pitch = a.pitch || 0; ca.weight = a.weight; cs.aim = ca; } else cs.aim = null;
    this.yaw = wallYaw;
    this.evalCoverWall(tp, cs, dt);
    this.yaw = realYaw;
    this.rotateTarget(tp, off);
    this.bodyYaw = wrapPi(this.bodyYaw + off);
  }
  // Rotate a whole target pose about the root's vertical axis (pelvis, feet, hands, look; spine/neck are local).
  rotateTarget(tp, ang) {
    const q = this._hqq.setFromAxisAngle(UP, ang);
    tp.pelvis.applyQuaternion(q); tp.pre.premultiply(q); tp.look.applyQuaternion(q);
    for (let i = 0; i < 2; i++) {
      const f = tp.foot[i], h = tp.hand[i];
      f.ball.applyQuaternion(q); f.q.premultiply(q); f.pole.applyQuaternion(q);
      h.pos.applyQuaternion(q); h.q.premultiply(q); h.pole.applyQuaternion(q);
    }
  }
  evalCoverWall(tp, s, dt) {
    const P = this.P, cv = s.cover || DEFAULT_COVER;
    const high = cv.height === 'high', side = cv.side < 0 ? -1 : 1, pose = cv.pose || 'idle';
    const t = clamp(typeof cv.t === 'number' ? cv.t : 1, 0, 1);
    const wall = P.cover_wallDist;
    const topY = typeof cv.top === 'number' ? cv.top - this.rootPos.y : high ? 2.0 : P.cover_lowTop;
    const aimYaw = (s.aim && s.aim.yaw) || 0, aimPitch = (s.aim && s.aim.pitch) || 0;
    this.baseTrunk(tp);
    const moveW = this.cycleW;
    let bodyYaw, pelY, pelZ, pelX = 0, pPitch, sPitch, sRoll, crouch;
    if (!high) {   // facing along the wall toward `side`, turned a little away from it
      bodyYaw = -side * (Math.PI / 2 + P.cover_turn);
      pelY = P.cover_lowPelvis; pelZ = wall - 0.2; pPitch = 0.42; sPitch = 0.5; sRoll = -side * 0.1; crouch = 1;
    } else {       // back to the wall, turned toward `side`
      bodyYaw = Math.PI + side * lerp(0.55, 0.95, moveW);
      pelY = P.cover_highPelvis; pelZ = wall - 0.15; pPitch = -0.03; sPitch = -0.04; sRoll = 0; crouch = 0;
    }
    const eT = ease(t);
    const pop = pose === 'popup' ? eT : 0, lean = pose === 'lean' ? eT : 0, blind = pose === 'blind' ? eT : 0;
    const exit = pose === 'exit' ? eT : 0, enter = pose === 'enter' ? t : -1;
    const expose = Math.max(pop, lean);
    if (pop > 0) {   // rise and turn to face over the wall toward the aim
      bodyYaw = lerpAngle(bodyYaw, clamp(aimYaw, -1.2, 1.2) * 0.6, pop);
      pelY = lerp(pelY, P.cover_popPelvis, pop); pelZ = lerp(pelZ, wall - 0.3, pop);
      pPitch = lerp(pPitch, 0.12, pop); sPitch = lerp(sPitch, 0.08, pop); sRoll = lerp(sRoll, 0, pop); crouch = lerp(crouch, 0.4, pop);
    }
    if (lean > 0) {  // step out past the corner and face forward, torso leaning out
      bodyYaw = lerpAngle(bodyYaw, clamp(aimYaw, -1, 1) * 0.5, lean);
      pelX = -side * P.cover_leanOut * lean; pelZ = lerp(pelZ, wall - 0.32, lean);
      pPitch = lerp(pPitch, 0.05, lean); sPitch = lerp(sPitch, 0.05, lean); sRoll = lerp(sRoll, side * 0.22, lean);
      if (!high) pelY = lerp(pelY, P.cover_lowPelvis + 0.06, lean);
    }
    if (blind > 0) {
      bodyYaw = high ? lerpAngle(bodyYaw, -side * (Math.PI / 2 + 0.3), blind) : lerpAngle(bodyYaw, -side * (Math.PI / 2 - 0.35), blind);
      sPitch += (high ? 0.12 : 0.25) * blind;
    }
    if (exit > 0) {  // stand up and turn to the root's facing
      bodyYaw = lerpAngle(bodyYaw, 0, exit); pelY = lerp(pelY, PELVIS_H - 0.03, exit); pelZ = lerp(pelZ, 0, exit);
      pPitch = lerp(pPitch, 0.04, exit); sPitch = lerp(sPitch, 0.03, exit); sRoll = lerp(sRoll, 0, exit); crouch = lerp(crouch, 0, exit);
    }
    this.bodyYaw = bodyYaw;
    // Stance around the pelvis' ground point. Low: wall-side foot forward flat, outer foot back on its ball.
    const cx = pelX, cz = pelZ - 0.02;
    if (!high && expose < 0.5 && exit < 0.5) {
      const a = 1 - moveW, kn = P.cover_kneel * a;
      if (side > 0) this.setStance(bodyYaw, cx, cz, 0.12, lerp(0.05, 0.2, a), -lerp(0.12, 0.15, a), lerp(0.03, -0.2, a), 0.18, 0, kn);
      else this.setStance(bodyYaw, cx, cz, lerp(0.12, 0.15, a), lerp(0.03, -0.2, a), -0.12, lerp(0.05, 0.2, a), 0.18, kn, 0);
    } else if (lean > 0.5) {
      if (side > 0) this.setStance(bodyYaw, cx * 0.5, cz, 0.11, 0.02, -0.33, 0.07, 0.2);
      else this.setStance(bodyYaw, cx * 0.5, cz, 0.33, 0.07, -0.11, 0.02, 0.2);
    } else this.setStance(bodyYaw, cx, cz, 0.13 + 0.03 * crouch, 0.06, -0.13 - 0.03 * crouch, 0.04, 0.15 + 0.15 * crouch);
    this.updateGait(dt, bodyYaw, crouch);
    const cw = this.cycleW, p = this.phase, phs = p - this.duty / 2;
    tp.pYaw = bodyYaw + cw * 0.06 * -Math.cos(TAU * p);
    tp.pPitch = pPitch; tp.pRoll = cw * 0.04 * Math.cos(TAU * phs);
    tp.pelvis.set(pelX, pelY + cw * 0.015 * Math.cos(2 * TAU * phs) - (high ? 0 : 0.02 * cw), pelZ);
    tp.sPitch = sPitch; tp.sRoll = sRoll - tp.pRoll * 0.5;
    if (enter >= 0) {   // impact on arrival: compress, then settle
      const imp = bump(0.45, 1.0, enter);
      tp.pelvis.y -= 0.05 * imp; tp.sPitch += 0.14 * imp; tp.pelvis.z += 0.03 * imp;
    }
    if (expose > 0) {
      tp.sYaw = lerp(tp.sYaw, wrapPi(aimYaw - bodyYaw) * P.aim_spineYaw, expose);
      tp.sPitch -= aimPitch * P.aim_spinePitch * expose;
    }
    this.additives(tp, s, false);
    // Head: along the wall toward the edge when hidden (drifting toward the camera direction), the aim when exposed.
    if (expose > 0.01) this.lookAim(tp, s, 1);
    else {
      const edgeYaw = -side * Math.PI / 2;
      const yaw = edgeYaw + clamp(wrapPi(aimYaw - edgeYaw), -1.0, 1.0) * 0.5;
      tp.look.set(Math.sin(yaw), high ? 0 : -0.05, Math.cos(yaw)).normalize(); tp.lookW = 0.85;
      if (blind > 0) tp.look.lerp(_v[0].set(-Math.sin(edgeYaw), -0.6, -Math.cos(edgeYaw)), blind * 0.6).normalize();
    }
    this.gaitFeetToTargets(tp, tp.pYaw);
    this.pelvisGuard(tp, dt);
    this.solveTrunk(tp);
    this.upperBody(tp, s, bodyYaw, this.ub(0, cw * 0.3, expose, exit < 0.5 ? (high ? 0.95 : 0.6) : 0, 0.3));
    if (exit > 0) {   // hands back to the hip pose
      const tmp = this.tpB.copy(tp);
      this.upperBody(tmp, s, bodyYaw, this.ub(0, 0, 0, 0, -1));
      lerpHand(tp.hand[0], tmp.hand[0], exit); lerpHand(tp.hand[1], tmp.hand[1], exit);
    }
    if (blind > 0) {  // gun over the top (low) / around the corner (high); left hand braced on the wall
      const gp = _v[13], gq = _q[2];
      if (!high) { gp.set(-0.12 * side - 0.05, topY + 0.13, wall + 0.1); qEuler(gq, -0.05 - aimPitch * 0.3, clamp(aimYaw, -0.8, 0.8) * 0.5, 0); }
      else { gp.set(-side * 0.62, 1.38, wall + 0.08); qEuler(gq, -aimPitch * 0.2, clamp(aimYaw, -0.6, 0.6) * 0.4 - side * 0.15, 0); }
      if (typeof s.fireT === 'number' && s.fireT >= 0 && s.fireT < 1) gq.multiply(_q[3].setFromAxisAngle(X_AXIS, -P.recoil_kick * 1.2 * P.recoil_oneHand * pulse(s.fireT, P.recoil_peak)));
      const H = this._hA;
      this.rightFromGun(H, gp, gq);
      H.pole.set(-0.8, -0.6, -0.3).applyQuaternion(this.rsQ[J.spine3]);
      lerpHand(tp.hand[1], H, blind);
      const L = this._hB;
      this.handAtPalm(L, 0, _v[14].set(0.18 * side + 0.05, high ? 1.25 : 0.72, wall - 0.02), _v[8].set(0, 0, 1), _v[7].set(0, 1, 0));
      L.pole.set(0.6, -1, -0.5);
      lerpHand(tp.hand[0], L, blind * 0.9);
    }
    if (enter >= 0 && enter < 1) {   // wall touch with the free left hand
      const reach = bump(0.25, 1.0, enter);
      if (reach > 0) {
        const L = this._hB;
        this.handAtPalm(L, 0, _v[14].set(0.15 * side, high ? 1.3 : 0.8, wall - 0.02), _v[8].set(0, 0, 1), _v[7].set(0, 1, 0.2));
        L.pole.set(0.6, -1, -0.5);
        lerpHand(tp.hand[0], L, reach * 0.8);
      }
    }
  }

  // --- roll: dive, tuck, 360 deg forward roll about the body's lateral axis, rise ---------------------------------------
  evalRoll(tp, s, dt) {
    const P = this.P;
    const u = clamp(typeof s.modeT === 'number' ? s.modeT : this.modeTime / P.roll_duration, 0, 1);
    this.baseTrunk(tp);
    const tuck = sstep(0.0, 0.16, u) * (1 - sstep(0.74, 0.95, u));
    const phi = TAU * ease(clamp((u - 0.1) / 0.66, 0, 1));
    const cy = lerp(PELVIS_H - 0.05, P.roll_ballH, tuck), cz = 0.05 * tuck;
    const rq = tp.pre.setFromAxisAngle(X_AXIS, phi);   // + = forward roll
    tp.pelvis.set(0, -0.06 * tuck, -0.16 * tuck).applyQuaternion(rq);
    tp.pelvis.y += cy; tp.pelvis.z += cz;
    tp.pPitch = lerp(0.1, 0.75, tuck); tp.sPitch = lerp(0.15, 1.05, tuck); tp.nPitch = lerp(0.1, 0.55, tuck); tp.hPitch = 0.1 * tuck;
    for (let i = 0; i < 2; i++) {   // knees to the chest in the rolling frame; out of the tuck the feet go back down
      const sd = i === 0 ? 1 : -1, f = tp.foot[i], stag = sd * 0.05;
      const tb = _v[0].set(sd * 0.12, -0.32 + stag, 0.2 + stag).applyQuaternion(rq);
      tb.y += cy; tb.z += cz;
      const sb = _v[1].set(sd * 0.1, BALL_H, FOOT[i].ballZ + sd * 0.15 * sstep(0.0, 0.1, u) * (1 - tuck));
      f.ball.lerpVectors(sb, tb, tuck);
      if (f.ball.y < BALL_H) f.ball.y = BALL_H;
      f.q.identity().slerp(_q[0].setFromAxisAngle(X_AXIS, phi + 0.5), tuck);
      f.toe = -0.2 * tuck;
      f.pole.set(sd * 0.1, 0.6 * tuck, 1).applyQuaternion(_q[1].identity().slerp(_q[0].setFromAxisAngle(X_AXIS, phi), tuck)).normalize();
    }
    this.solveTrunk(tp);
    for (let i = 0; i < 2; i++) {   // reach for the floor on the dive, then hug in
      const sd = i === 0 ? 1 : -1, h = tp.hand[i];
      const dive = bump(0.0, 0.3, u);
      h.pos.set(sd * 0.2, -0.05, 0.28).applyQuaternion(rq);
      h.pos.y += cy - 0.1 * dive; h.pos.z += cz + 0.15 * dive;
      h.pole.set(sd * 0.8, 0, -0.5).applyQuaternion(rq);
      handQuat(h.q, i, _v[3].set(0, -0.3, 1).applyQuaternion(rq), _v[4].set(-sd, -0.5, 0).applyQuaternion(rq));
    }
    if (tuck < 1) {
      const tmp = this.tpB.copy(tp);
      this.upperBody(tmp, s, 0, this.ub(0.5, 0, 0, 0, -1));
      lerpHand(tp.hand[0], tmp.hand[0], 1 - tuck); lerpHand(tp.hand[1], tmp.hand[1], 1 - tuck);
    }
  }

  // --- jump / fall ---------------------------------------------------------------------------------------------------------
  evalAir(tp, s, dt, jumping) {
    const P = this.P;
    this.baseTrunk(tp);
    const tIn = typeof s.modeT === 'number' && jumping ? s.modeT * 0.6 : this.modeTime;
    const fwd = clamp(this.speed / 5, 0, 1);
    const push = jumping ? 1 - sstep(0, P.jump_takeoff, tIn) : 0;
    const tuck = jumping ? sstep(P.jump_takeoff * 0.5, P.jump_takeoff * 2.2, tIn) : 0.35;
    const fall = clamp(-this.vel.y / 8, 0, 1);
    const fl = Math.sin(this.time * 4.1), fl2 = Math.sin(this.time * 3.3 + 1);
    tp.pelvis.set(0, PELVIS_H + 0.03 * push - 0.02, 0);
    tp.pPitch = 0.1 + 0.15 * fwd - 0.12 * fall; tp.sPitch = 0.08 + 0.12 * fwd * tuck - 0.12 * fall; tp.nPitch = 0.1 + 0.25 * fall;
    tp.sRoll = 0.03 * fl * fall;
    for (let i = 0; i < 2; i++) {   // push: extended; tuck: knees up (a stride when moving fast); fall: dangle apart
      const sd = i === 0 ? 1 : -1, f = tp.foot[i], lead = sd;
      const ty = lerp(BALL_H - 0.06, 0.38 + lead * 0.06 * fwd, tuck * (1 - fall * 0.6)) + 0.025 * fall * (i === 0 ? fl : fl2);
      const tz = FOOT[i].ballZ + lerp(0, 0.18 * lead * fwd + 0.08, tuck) - 0.1 * fall + 0.04 * fall * (i === 0 ? fl2 : fl);
      f.ball.set(sd * lerp(0.1, 0.16, fall), ty, tz);
      qEuler(f.q, lerp(0.6 * push, 0.35, tuck) + 0.25 * fall, sd * 0.1, 0);
      f.toe = -0.1;
      f.pole.set(sd * 0.15, 0.2, 1).normalize();
    }
    this.lookAim(tp, s, 0.5);
    tp.look.y -= 0.3 * fall; tp.look.normalize();
    this.solveTrunk(tp);
    this.upperBody(tp, s, 0, this.ub(0.6, 0, this.aimW, 0, 0.35));
    if (this.aimW < 0.5) {   // free arm up and out for balance, flailing a little when falling
      const H = this._hA;
      this.armSwing(H, 0, 0.5 + 0.3 * fall + 0.25 * fl * fall, 0.3, 0.8 + 0.5 * fall);
      lerpHand(tp.hand[0], H, 1 - this.aimW * 2);
    }
  }

  evalLand(tp, s, dt) {
    const P = this.P;
    const u = clamp(typeof s.modeT === 'number' ? s.modeT : this.modeTime / P.land_duration, 0, 1);
    const depth = clamp(-this.landVy * P.land_depth, 0.06, P.land_maxDepth);
    const k = u < 0.18 ? ease(u / 0.18) : 1 - ease((u - 0.18) / 0.82);   // fast compression, slower recovery
    const over = bump(0.6, 1, u) * 0.12;
    this.evalLocomotion(tp, s, dt, false);
    tp.pelvis.y -= depth * (k - over);
    tp.pPitch += 0.25 * k * (depth / 0.3);
    tp.sPitch += 0.35 * k * (depth / 0.3);
    tp.nPitch -= 0.15 * k;
    this.solveTrunk(tp);
    this.upperBody(tp, s, this.bodyYaw, this.ub(0, 0, this.aimW, 0, 0.2 + 0.4 * k));
    if (this.aimW < 0.5) {
      const H = this._hA;
      this.armSwing(H, 0, 0.35 + 0.5 * k, 0.5, 0.25 + 0.3 * k);
      lerpHand(tp.hand[0], H, k);
    }
  }

  // --- mantle / vault -----------------------------------------------------------------------------------------------------
  // Two drivers arrive here: B1's controller (mode 'mantle', animState.mantle {kind 'mantle'|'vault', height, dist},
  // modeT) and B3's climb mode (mode 'climb' with climb.move 'mantle'|'vault', climb.t, climb.handL/handR on the top).
  evalMantle(tp, s, dt) {
    const P = this.P, cl = s.climb, fromClimb = s.mode === 'climb' && !!cl && !!cl.handL && !!cl.handR;
    const kind = fromClimb ? cl.move : (s.mantle && s.mantle.kind) || 'mantle';
    let u, H, E;
    if (fromClimb) {
      u = clamp(typeof cl.t === 'number' ? cl.t : 0, 0, 1);
      const c = Math.cos(this.mantleYaw), sn = Math.sin(this.mantleYaw);
      const hx = (cl.handL.x + cl.handR.x) / 2 - this.mantleOrigin.x, hz = (cl.handL.z + cl.handR.z) / 2 - this.mantleOrigin.z;
      E = Math.max(0.15, hx * sn + hz * c - 0.05);
      H = (cl.handL.y + cl.handR.y) / 2 - 0.02 - this.mantleOrigin.y;
    } else {
      const m = s.mantle;
      u = clamp(typeof s.modeT === 'number' ? s.modeT : m && typeof m.t === 'number' ? m.t : this.modeTime / P.mantle_duration, 0, 1);
      H = m && typeof m.height === 'number' && m.height > 0 ? m.height : P.mantle_height;
      E = m && typeof m.dist === 'number' ? m.dist : P.mantle_dist;
    }
    if (kind === 'vault') this.evalVault(tp, s, u, H, E);
    else this.evalMantleUp(tp, s, u, H, E);
  }

  // Mantle: hands plant on the ledge, the body presses up and over, the feet step on top, stand.
  evalMantleUp(tp, s, u, H, E) {
    const U = K_MANTLE_U;
    this.baseTrunk(tp);
    // Mantle frame: origin = root at mode start, +Z toward the ledge.
    const mp = _v[0].set(0, key5(U, u, PELVIS_H - 0.03, PELVIS_H - 0.12, H + 0.15, H + 0.55, H + PELVIS_H - 0.03),
      key5(U, u, 0, 0.05, E - 0.1, E + 0.25, E + 0.5));
    this.mantleToRoot(mp);
    mp.lerp(_v[1].set(0, PELVIS_H - 0.03, 0), sstep(0.85, 1, u));   // hand over to the controller's root at the end
    tp.pelvis.copy(mp);
    tp.pPitch = key5(U, u, 0.05, 0.25, 0.85, 0.55, 0.05); tp.sPitch = key5(U, u, 0.05, 0.25, 0.7, 0.4, 0.03);
    tp.nPitch = -0.25 * bump(0.1, 0.6, u);
    tp.pYaw = wrapPi(this.mantleYaw - this.yaw);
    for (let i = 0; i < 2; i++) {   // left foot onto the ledge at ~0.5, right at ~0.7
      const sd = i === 0 ? 1 : -1, f = tp.foot[i];
      const t0 = i === 0 ? 0.32 : 0.42, t1 = i === 0 ? 0.58 : 0.72;
      const a = ease(clamp((u - t0) / (t1 - t0), 0, 1));
      const g = _v[2].set(sd * 0.11, 0, FOOT[i].ballZ).lerp(_v[3].set(sd * 0.11, H, E + 0.2 + (i === 0 ? 0.08 : 0.25) * sstep(0.7, 1, u)), a);
      g.y += (0.25 + (i === 0 ? 0.1 : 0.03)) * Math.sin(Math.PI * a);
      g.z -= 0.12 * Math.sin(Math.PI * a);
      this.mantleToRoot(g);
      g.lerp(_v[4].set(sd * 0.1, 0, FOOT[i].ballZ), sstep(0.85, 1, u));
      const push = sstep(0.12, 0.3, u) * (1 - a);
      this.groundFoot(f, i, g, tp.pYaw, 0.6 * Math.sin(Math.PI * a) + 0.35 * push, -0.3 * push, 0, tp.pYaw);
    }
    this.solveTrunk(tp);
    const plant = sstep(0.05, 0.2, u) * (1 - sstep(0.6, 0.78, u));
    const tmp = this.tpB.copy(tp);
    this.upperBody(tmp, s, tp.pYaw, this.ub(0, 0, 0, 0, -1));
    const fwd = _v[4].set(Math.sin(tp.pYaw), 0, Math.cos(tp.pYaw));
    for (let i = 0; i < 2; i++) {   // palms on the ledge top, fingers forward; blend from / back to the hip pose
      const sd = i === 0 ? 1 : -1, h = tp.hand[i];
      this.handAtPalm(h, i, this.mantleToRoot(_v[3].set(sd * 0.24, H + 0.025, E + 0.06)), _v[5].set(0, -1, 0), fwd);
      h.pole.set(sd * 0.8, 0.1, -0.6).applyQuaternion(_q[0].setFromAxisAngle(UP, tp.pYaw));
      const o = tmp.hand[i];
      h.pos.lerpVectors(o.pos, h.pos, plant); _q[1].copy(o.q).slerp(h.q, plant); h.q.copy(_q[1]); h.pole.lerpVectors(o.pole, h.pole, plant);
    }
  }

  // Vault (speed vault): run in, plant the left hand on the near edge, tuck the legs and swing them over on the right,
  // land beyond in a crouch. The controller's root path carries it (B1: root = feet, rises to top + 0.12 by u 0.45,
  // holds to 0.6, drops to the far floor by 1), so the body is posed root-relative; only the plant is world-locked.
  evalVault(tp, s, u, H, E) {
    const U = K_VAULT_U;
    this.baseTrunk(tp);
    const swing = bump(0.08, 0.92, u);
    const tuck = sstep(0.08, 0.3, u) * (1 - sstep(0.68, 0.92, u));
    tp.pelvis.set(0.04 * swing, key5(U, u, PELVIS_H - 0.06, PELVIS_H - 0.2, 0.36, 0.46, PELVIS_H - 0.16), 0.06 * swing);
    tp.pYaw = -0.55 * swing;                 // hips turn right: the legs pass the planted hand on the right side
    tp.pRoll = -0.35 * swing;                // body tilts onto the left (planted) arm, right hip up
    tp.pPitch = 0.1 + 0.3 * bump(0.05, 0.65, u);
    tp.sYaw = 0.45 * swing;                  // chest stays toward the travel direction
    tp.sPitch = 0.1 + 0.45 * bump(0.05, 0.65, u);
    tp.sRoll = -0.15 * swing;
    tp.look.set(0, -0.3 + 0.3 * u, 1).normalize(); tp.lookW = 0.8;
    for (let i = 0; i < 2; i++) {   // take-off stride -> tucked to the right over the top -> landing stance (lead foot first)
      const sd = i === 0 ? 1 : -1, f = tp.foot[i];
      const g = _v[2].set(sd * 0.11, 0, FOOT[i].ballZ + (i === 0 ? 0.14 : -0.2) * (1 - sstep(0, 0.22, u)));
      g.lerp(_v[3].set(-0.24 + sd * 0.07, 0.04 + (i === 0 ? 0.0 : 0.07), 0.1 + sd * 0.06), tuck);
      const land = sstep(i === 1 ? 0.7 : 0.78, i === 1 ? 0.9 : 0.97, u);
      g.lerp(_v[4].set(sd * 0.12, 0, FOOT[i].ballZ + (i === 1 ? 0.1 : -0.05)), land);
      this.groundFoot(f, i, g, lerp(sd * 0.1, -0.5 + sd * 0.1, tuck), 0.45 * tuck, 0, 0, tp.pYaw);
    }
    this.solveTrunk(tp);
    this.upperBody(tp, s, tp.pYaw, this.ub(0.3, 0, 0, 0, 0.6 * swing));
    // Left palm on the near edge of the top (world-locked), fingers forward.
    const plant = sstep(0.06, 0.2, u) * (1 - sstep(0.55, 0.7, u));
    if (plant > 0) {
      const H2 = this._hA, fwd = _v[4].set(Math.sin(wrapPi(this.mantleYaw - this.yaw)), 0, Math.cos(wrapPi(this.mantleYaw - this.yaw)));
      this.handAtPalm(H2, 0, this.mantleToRoot(_v[3].set(0.1, H + 0.025, E + 0.12)), _v[5].set(0, -1, 0), fwd);
      H2.pole.set(0.8, 0.2, -0.6);
      lerpHand(tp.hand[0], H2, plant);
    }
  }
  mantleToRoot(p) {   // mantle frame -> world -> root
    const c = Math.cos(this.mantleYaw), sn = Math.sin(this.mantleYaw);
    p.set(p.x * c + p.z * sn + this.mantleOrigin.x, p.y + this.mantleOrigin.y, -p.x * sn + p.z * c + this.mantleOrigin.z);
    return this.worldToRoot(p);
  }

  // --- climb: hang / shimmy / reach / climb-up / drop / one-hand hang aim ---------------------------------------------------
  // B3 (player/climb.js) puts the root (feet) climb.hang.drop below the hands; the pelvis hangs anim.climb.feetBelow
  // above that. Extras read when present: climb.normal, freeHang, footL/footR (foothold targets), swing {x, z}, aim
  // (0..1 hang-aim blend), aimYaw, gripL/gripR.
  evalClimb(tp, s, dt) {
    const P = this.P, cl = s.climb || DEFAULT_CLIMB, pose = cl.pose || 'hang';
    const t = clamp(typeof cl.t === 'number' ? cl.t : 0, 0, 1);
    this.baseTrunk(tp);
    const n = this.climbN;   // out of the wall
    if (cl.normal && (cl.normal.x || cl.normal.z)) n.set(cl.normal.x, 0, cl.normal.z).normalize(); else n.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const lat = _v[0].set(-n.z, 0, n.x);   // the character's left while facing the wall
    const ps = this.params;
    const drop = ps.has && ps.has('climb.hang.drop') ? ps.get('climb.hang.drop') - P.climb_feetBelow : P.climb_hangDrop;
    const tL = this.handTarget[0], tR = this.handTarget[1], hy = this.rootPos.y + drop + P.climb_feetBelow;
    if (cl.handL) tL.set(cl.handL.x, cl.handL.y, cl.handL.z); else tL.copy(this.rootPos).addScaledVector(lat, 0.24).addScaledVector(n, -0.3).setY(hy);
    if (cl.handR) tR.set(cl.handR.x, cl.handR.y, cl.handR.z); else tR.copy(this.rootPos).addScaledVector(lat, -0.24).addScaledVector(n, -0.3).setY(hy);
    const hs = this.hands, oneHand = pose === 'hangAim', cu = pose === 'climbup' ? Math.max(t, 1e-4) : 0;
    if (!this.climbInit) { hs[0].reset(tL, 0); hs[1].reset(tR, 0); this.climbInit = true; this.climbBody.set(0, 0, 0); this.swingV.set(0, 0, 0); }
    const aimW = oneHand ? (typeof cl.aim === 'number' ? clamp(cl.aim, 0, 1) : sstep(0, P.climb_aimIn, this.subTime)) : 0;
    // Hand planters: a hand stays on its hold until the desired hold drifts past the threshold, then reaches over; the
    // outward-moving (lead) hand goes first, never both at once. Frozen during climb-up; the gun hand stays in hang-aim.
    if (cu === 0 && hs[0].planted && hs[1].planted) {
      let best = -1, bestScore = P.climb_handThresh;
      for (let i = 0; i < 2; i++) {
        if (oneHand && i === 1) continue;
        const err = hs[i].anchor.distanceTo(this.handTarget[i]);
        const out = _v[1].subVectors(this.handTarget[i], this.handTarget[1 - i]);
        const mv = _v[2].subVectors(this.handTarget[i], hs[i].anchor);
        const score = err * (1 + 0.3 * Math.sign(out.dot(mv)));
        if (err > P.climb_handThresh && score > bestScore) { bestScore = score; best = i; }
      }
      if (best >= 0) {
        const err = hs[best].anchor.distanceTo(this.handTarget[best]);
        hs[best].startStep(1, P.climb_handStep * (0.8 + 1.2 * Math.min(1, err / 0.6)), 0.05 + 0.1 * Math.min(1, err / 0.6));
      }
    }
    for (let i = 0; i < 2; i++) {
      const hp = hs[i];
      if (hp.planted || cu > 0) { if (!hp.planted && cu > 0) hp.land(); hp.pos.copy(hp.anchor); continue; }
      hp.target.copy(this.handTarget[i]);
      hp.u = clamp(hp.u + dt / hp.dur, 0, 1);
      const arc = Math.sin(Math.PI * hp.u);
      hp.pos.lerpVectors(hp.from, hp.target, ease(hp.u)).addScaledVector(n, 0.07 * arc);
      hp.pos.y += hp.lift * arc;
      if (hp.u >= 1) hp.land();
    }
    // Ledge point: the hands' midpoint (toward the left hand in hang-aim); frozen where it was when climb-up began.
    const M = this.climbM;
    if (cu > 0) { if (!this.cuInit) { this.cuM.addVectors(hs[0].pos, hs[1].pos).multiplyScalar(0.5); this.cuInit = true; } M.copy(this.cuM); }
    else { this.cuInit = false; M.addVectors(hs[0].pos, hs[1].pos).multiplyScalar(0.5); if (aimW > 0) M.lerp(hs[0].pos, 0.5 * aimW); }
    const braced = P.climb_braced > 0.5 && !cl.freeHang && pose !== 'drop';
    // Body hangs below the ledge on a damped spring (pendulum lag on shimmy / reach), plus the controller's own swing,
    // and rises with the root when the controller pulls it up (hang-aim: head and shoulders over the lip).
    const rise = cu > 0 ? 0 : clamp(this.rootPos.y - (M.y - drop - P.climb_feetBelow), 0, 1.2);
    const want = _v[3].copy(M).addScaledVector(n, lerp(braced ? P.climb_wallOff : P.climb_wallOff * 0.8, 0.13, aimW));
    want.y += rise - drop;
    if (aimW > 0) want.addScaledVector(lat, 0.08 * aimW);
    if (cl.swing) want.addScaledVector(lat, -(cl.swing.x || 0)).addScaledVector(n, cl.swing.z || 0);
    if (this.climbBody.lengthSq() === 0) this.climbBody.copy(want);
    const w = TAU * P.climb_swingFreq;
    const acc = _v[4].subVectors(want, this.climbBody).multiplyScalar(w * w).addScaledVector(this.swingV, -2 * P.climb_swingDamp * w);
    this.swingV.addScaledVector(acc, dt);
    this.climbBody.addScaledVector(this.swingV, dt);
    if (this.climbBody.distanceTo(want) > 0.5) { this.climbBody.copy(want); this.swingV.set(0, 0, 0); }
    const pelW = _v[5].copy(this.climbBody);
    if (cu > 0) {   // pull, press over the lip, knee up, crouch on top at 0.65 (climb-spec §3), then stand on the root
      pelW.copy(M).addScaledVector(n, key5(K_CLIMBUP_U, cu, P.climb_wallOff, 0.14, 0.02, -0.34, -0.42));
      pelW.y = M.y + key5(K_CLIMBUP_U, cu, -drop, -0.6, -0.1, 0.52, 0.55);
      const rp = this.rootToWorld(_v[6].set(0, lerp(0.55, PELVIS_H - 0.03, sstep(0.65, 1, cu)), 0));
      pelW.lerp(rp, sstep(0.55, 0.72, cu));
    }
    const dropW = pose === 'drop' ? ease(t) : 0;
    if (dropW > 0) pelW.lerp(this.rootToWorld(_v[6].set(0, PELVIS_H + 0.02, 0)), dropW * 0.5);
    tp.pelvis.copy(this.worldToRoot(pelW));
    const faceYaw = wrapPi(Math.atan2(-n.x, -n.z) - this.yaw);
    const aimYaw = s.aim && s.aim.on ? s.aim.yaw || 0 : typeof cl.aimYaw === 'number' ? cl.aimYaw + faceYaw : (s.aim && s.aim.yaw) || 0;
    const aimPitch = (s.aim && s.aim.pitch) || 0;
    const fw2 = _v[11].set(Math.sin(faceYaw), 0, Math.cos(faceYaw));   // toward the wall (root space)
    const lat2 = _v[10].set(Math.cos(faceYaw), 0, -Math.sin(faceYaw)); // body left (root space)
    const ayRel = clamp(wrapPi(aimYaw - faceYaw), -1.3, 1.3);
    const bodyYaw = faceYaw + ayRel * 0.25 * aimW;
    tp.pYaw = bodyYaw;
    tp.pPitch = braced ? 0.05 : 0.0;
    tp.sPitch = braced ? 0.18 : 0.04;
    const latV = this.swingV.x * -n.z + this.swingV.z * n.x;
    tp.sRoll = clamp(-latV * 0.25, -0.3, 0.3);
    if (cu > 0) {
      tp.pPitch = key5(K_CLIMBUP_U, cu, tp.pPitch, 0.2, 0.55, 0.45, 0.04);
      tp.sPitch = key5(K_CLIMBUP_U, cu, tp.sPitch, 0.45, 0.5, 0.4, 0.03);
    }
    if (aimW > 0) {   // pulled up on the left arm, chest square to the lip, torso turning a little with the aim
      tp.sYaw = (ayRel - (bodyYaw - faceYaw)) * 0.6 * aimW;
      tp.sPitch += (-0.12 - aimPitch * 0.35) * aimW;
      tp.sRoll += -0.12 * aimW; tp.pRoll = -0.06 * aimW;
    }
    this.lookAim(tp, s, 0.7);
    if (aimW > 0) { tp.look.set(Math.sin(aimYaw) * Math.cos(aimPitch), Math.sin(aimPitch), Math.cos(aimYaw) * Math.cos(aimPitch)); tp.lookW = lerp(0.7, 1, aimW); }
    else {
      const moving = !hs[0].planted ? 0 : !hs[1].planted ? 1 : -1;
      if (moving >= 0) {
        const d = this.worldToRoot(_v[7].copy(hs[moving].pos)).sub(_v[8].set(tp.pelvis.x, tp.pelvis.y + 0.6, tp.pelvis.z)).normalize();
        tp.look.lerp(d, 0.8).normalize();
      }
      if (cu > 0) { tp.look.set(fw2.x, -0.3, fw2.z).normalize(); tp.lookW = 0.8; }
    }
    // Feet: braced on the wall face (on the controller's footholds when it gives them), or dangling.
    const Mr = this.worldToRoot(_v[12].copy(M));
    for (let i = 0; i < 2; i++) {
      const sd = i === 0 ? 1 : -1, f = tp.foot[i];
      if (braced && cu < 0.35) {
        const g = _v[9].copy(tp.pelvis).addScaledVector(lat2, sd * 0.13 - latV * 0.03);
        g.y = tp.pelvis.y - 0.62 + (i === 0 ? 0.08 : -0.04);
        const toWall = (Mr.x - g.x) * fw2.x + (Mr.z - g.z) * fw2.z;
        g.addScaledVector(fw2, toWall - 0.07);
        const fh = i === 0 ? cl.footL : cl.footR;
        if (fh && aimW < 0.5 && rise < 0.05) {
          const hold = this.worldToRoot(_v[13].set(fh.x, fh.y, fh.z));
          if (hold.distanceToSquared(g) < 0.45 * 0.45) g.copy(hold);
        }
        qEuler(f.q, -0.3, bodyYaw + sd * 0.1, 0);
        f.ball.copy(g);
        f.pole.copy(fw2).addScaledVector(lat2, sd * 0.4).normalize();
        f.toe = 0.15;
      } else {
        qEuler(f.q, 0.55, bodyYaw + sd * 0.08, 0);
        const ank = _v[9].copy(tp.pelvis).addScaledVector(lat2, sd * 0.11 - 0.05 * latV).addScaledVector(fw2, (i === 0 ? 0.04 : -0.06));
        ank.y = tp.pelvis.y - 0.09 - (L_LEG1 + L_LEG2) * 0.96;
        f.ball.copy(FOOT[i].ankleFromBall).applyQuaternion(f.q).negate().add(ank);
        f.pole.copy(fw2).addScaledVector(lat2, sd * 0.15).normalize();
        f.toe = 0;
      }
      if (cu > 0.28) {   // left knee onto the ledge first, both feet on top by the crouch (0.65), then the root stance
        const t0 = i === 0 ? 0.28 : 0.4, t1 = i === 0 ? 0.48 : 0.62;
        const a = ease(clamp((cu - t0) / (t1 - t0), 0, 1));
        const top = _v[13].copy(Mr).addScaledVector(fw2, 0.22 + (i === 0 ? 0.05 : 0.2) * sstep(0.6, 0.75, cu)).addScaledVector(lat2, sd * 0.11);
        top.lerp(_v[14].set(sd * 0.11, this.groundY(this.rootPos.x, this.rootPos.z) - this.rootPos.y, FOOT[i].ballZ), sstep(0.6, 0.75, cu));
        top.y += BALL_H + 0.18 * Math.sin(Math.PI * a);
        f.ball.lerp(top, a);
        f.q.slerp(qEuler(_q[2], 0, bodyYaw, 0), a);
        f.pole.lerp(_v[14].set(fw2.x, 0.3, fw2.z), a).normalize();
        f.toe *= 1 - a;
      }
    }
    this.solveTrunk(tp);
    for (let i = 0; i < 2; i++) {   // palms on the ledge, fingers over the edge, elbows out and back
      const sd = i === 0 ? 1 : -1, h = tp.hand[i];
      const hp = this.worldToRoot(_v[7].copy(hs[i].pos));
      hp.y += 0.02; hp.addScaledVector(fw2, 0.04);
      this.handAtPalm(h, i, hp, _v[8].set(0, -1, 0).addScaledVector(fw2, 0.25), fw2);
      h.pole.copy(lat2).multiplyScalar(sd * 0.7).addScaledVector(fw2, -0.7); h.pole.y = -0.4;
    }
    if (aimW > 0) {   // right hand off the lip into a one-handed aim from the shoulder (climb-spec §5)
      const aq = qEuler(_q[2], -aimPitch, aimYaw, 0);
      if (typeof s.fireT === 'number' && s.fireT >= 0 && s.fireT < 1) aq.multiply(_q[3].setFromAxisAngle(X_AXIS, -P.recoil_kick * P.recoil_oneHand * pulse(s.fireT, P.recoil_peak)));
      const gp = _v[13].set(0.02, -0.03, P.aim_pointDist).applyQuaternion(aq).add(this.rsP[J.right_shoulder]);
      const H = this._hA;
      this.rightFromGun(H, gp, aq);
      H.pole.set(-0.6, -1, -0.3).applyQuaternion(this.rsQ[J.spine3]);
      lerpHand(tp.hand[1], H, aimW);
    }
    if (cu > 0.42 || dropW > 0) {   // hands let go (climb-up: after the knee is on top) into the hip pose
      const tmp = this.tpB.copy(tp);
      this.upperBody(tmp, s, bodyYaw, this.ub(0, 0, 0, 0, -1));
      const fwd = _v[15].set(Math.sin(faceYaw), 0, Math.cos(faceYaw));   // fw2's slot may be reused by upperBody
      if (dropW > 0) for (let i = 0; i < 2; i++) { tp.hand[i].pos.addScaledVector(fwd, -0.15 * dropW); tp.hand[i].pos.y += 0.05 * dropW; }
      const k = cu > 0 ? sstep(0.42, 0.68, cu) : sstep(0.5, 1, dropW);
      lerpHand(tp.hand[0], tmp.hand[0], k); lerpHand(tp.hand[1], tmp.hand[1], k);
    }
  }

  // =====================================================================================================================
  // STEALTH TAKEDOWNS. src/player/stealth.js writes s.takedown and owns every root path (actor pos / yaw) and the world
  // points the hands go to; these methods pose the limbs around them (refs/stealth-spec.md). Original keyframes, all
  // [INFERRED] from how the moves read: no game animation data is used.
  //   s.takedown {kind 'rear'|'ledge'|'cover', role 'attacker'|'victim', t (s since the start), T {grab, kill, end, ...},
  //     dir (victim topple +1 forward / -1 back), pitch (victim body pitch, rad, + forward), pelvisW (victim pelvis in
  //     the world, or null), air (0..1 feet off the floor), land (0..1 into the lying death pose), deathT (the death
  //     clock of that pose, s), grabW / strikeW (world points for the attacker's hands), gap (rear: attacker behind, m)}
  //   The ledge attacker is posed from case 'climb' (anim.mode stays 'climb' with s.takedown set): the skins' climb
  //   pass (character/skins.js) lifts the shorter-armed figure onto the anchored hands only in mode 'climb'.

  // Takedown cue: U4 shows no icon, the free (left) arm lifts toward the enemy (stealth-measured.md §4 [WIKI]). Layered on
  // whatever mode posed the body. R = s.reach {w 0..1, x, y, z (world, the victim's chest), arm (false: hanging, so
  // only the look), dist (hand out from the shoulder, m)}. Not while aiming (the left hand is on the gun).
  reachCue(tp, R) {
    const W = this._rc || (this._rc = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]);
    const w = sstep(0, 1, R.w) * (1 - this.aimW);
    if (w <= 0) return;
    const g = this.worldToRoot(W[0].set(R.x, R.y, R.z));
    const look = W[3].set(tp.pelvis.x, tp.pelvis.y + 0.6, tp.pelvis.z);
    look.subVectors(g, look).normalize();
    tp.look.lerp(look, w).normalize(); tp.lookW = Math.max(tp.lookW, 0.7 * w);
    if (!R.arm) return;
    const sh = W[1].copy(this.rsP[ARM[0].upper]);
    const d = W[2].subVectors(g, sh), len = d.length();
    if (len < 1e-3) return;
    d.divideScalar(len);
    const p = W[0].copy(sh).addScaledVector(d, Math.min(len, R.dist || 0.45));
    p.y -= 0.08;   // a little below the line: forearm up, hand open, not a pointing arm
    const h = this._hA;
    this.handAtPalm(h, 0, p, W[3].set(d.x * 0.6, -0.8, d.z * 0.6).normalize(), W[1].set(d.x, d.y + 0.35, d.z).normalize());
    h.pole.set(0.8, -0.6, -0.2);
    lerpHand(tp.hand[0], h, w);
  }

  evalTakedown(tp, s, dt) {
    const td = s.takedown;
    if (!td || !td.T) { this.evalLocomotion(tp, s, dt, false); return; }
    if (!this._td) this._td = { v: Array.from({ length: 8 }, () => new THREE.Vector3()), q: new THREE.Quaternion(), s: { death: { t: 0, dir: null } } };
    if (td.role === 'attacker') {
      if (td.kind === 'ledge') this.tdLedgeAttacker(tp, s, td, dt);
      else if (td.kind === 'cover') this.tdCoverAttacker(tp, s, td, dt);
      else this.tdRearAttacker(tp, s, td, dt);
      return;
    }
    if (td.kind === 'rear') this.tdRearVictim(tp, s, td, dt);
    else this.tdFlightVictim(tp, s, td, dt);
    if (td.land > 0) {   // cross-fade into the death pose at the death clock the brain continues from
      const S = this._td.s;
      S.death.t = td.deathT || 0;
      this.deathBack = td.dir < 0 ? 1 : 0; this.deathYaw = 0; this.hitSign = 1;
      this.evalDeath(this.tpB, S, dt);
      lerpTarget(tp, this.tpB, clamp(td.land, 0, 1));
    }
  }

  // Rear choke frame shared by both roles (victim root space): hold 0..1, knees buckling, lean back (rad), neck point.
  tdChoke(t, T, out) {
    const hold = sstep(T.grab - 0.05, T.grab + 0.12, t);
    const buckle = sstep(T.grab, T.kill, t);
    const lean = 0.32 * hold;
    out.hold = hold; out.buckle = buckle; out.lean = lean;
    out.py = PELVIS_H - 0.03 - 0.12 * buckle; out.pz = -0.07 * hold;
    out.ny = out.py + 0.56 * Math.cos(lean); out.nz = out.pz - 0.56 * Math.sin(lean);
    return out;
  }

  tdRearAttacker(tp, s, td, dt) {
    const P = this.P, T = td.T, t = td.t, W = this._td.v;
    const c = this.tdChoke(t, T, this._tdc || (this._tdc = {}));
    const reach = sstep(0, T.grab, t);
    const hold = c.hold * (1 - sstep(T.kill + 0.05, T.kill + 0.35, t));
    const snap = bump(T.kill - 0.07, T.kill + 0.2, t);
    const rec = sstep(T.kill + 0.1, T.end, t);
    const strain = hold * (1 - sstep(T.kill - 0.25, T.kill, t));
    this.baseTrunk(tp);
    this.setStance(0, 0, 0, 0.17, FOOT[0].ballZ + 0.16 * hold, -0.17, FOOT[1].ballZ - 0.18 * hold, P.gait_toeOut + 0.12 * hold);
    this.updateGait(dt, 0, 0.3 * hold);
    const sq = 0.11 * hold + 0.05 * reach * (1 - rec);         // hips sink to take his weight
    tp.pelvis.set(0, PELVIS_H - 0.02 - sq, -0.05 * hold);
    tp.pYaw = -0.1 * hold - 0.2 * snap;
    tp.pPitch = 0.12 * reach * (1 - hold) * (1 - rec) - 0.04 * hold;
    tp.sPitch = 0.25 * reach * (1 - hold) * (1 - rec) + 0.06 * hold;
    tp.sYaw = 0.1 * hold - 0.5 * snap;                           // the twist that breaks the neck
    tp.sRoll = 0.1 * snap + 0.035 * Math.sin(TAU * 3.1 * t) * strain;
    tp.nPitch = 0.22 * hold;
    tp.look.set(0, -0.3, 1).normalize(); tp.lookW = 0.6 * hold;
    this.gaitFeetToTargets(tp, tp.pYaw);
    this.pelvisGuard(tp, dt);
    this.solveTrunk(tp);
    const tmp = this.tpB.copy(tp);
    this.upperBody(tmp, s, 0, this.ub(0, 0, 0, 0, -1));
    // left forearm across his throat (hand at the far side of the neck), right (gun) hand pushing the back of his head
    const g = td.gap || 0.5, ny = c.ny, nz = g + c.nz;
    const w = sstep(0, T.grab + 0.05, t) * (1 - sstep(T.kill + 0.05, T.kill + 0.45, t));
    const hL = tp.hand[0], hR = tp.hand[1];
    this.handAtPalm(hL, 0, W[0].set(-0.08, ny - 0.03, nz + 0.07), W[1].set(0.7, 0, -0.7), W[2].set(-0.75, 0.1, -0.65));
    hL.pole.set(1, -0.25, 0.35);
    this.handAtPalm(hR, 1, W[0].set(-0.05, ny + 0.07, nz - 0.1 + 0.03 * snap), W[1].set(0.15, 0, 1), W[2].set(-0.1, 1, 0.1));
    hR.pole.set(-1, -0.6, -0.2);
    lerpHand(hL, tmp.hand[0], 1 - w); lerpHand(hR, tmp.hand[1], 1 - w);
  }

  tdRearVictim(tp, s, td, dt) {
    const P = this.P, T = td.T, t = td.t, W = this._td.v;
    const c = this.tdChoke(t, T, this._tdc || (this._tdc = {}));
    const jolt = pulse(t - T.grab, 0.08);
    const dead = sstep(T.kill, T.kill + 0.1, t);
    const fight = c.hold * (1 - dead);
    this.baseTrunk(tp);
    this.setStance(0, 0, 0, 0.13, FOOT[0].ballZ + 0.04 * c.hold, -0.13, FOOT[1].ballZ + 0.02 * c.hold, P.gait_toeOut);
    this.updateGait(dt, 0, 0);
    const wob = Math.sin(TAU * 2.3 * t), wob2 = Math.sin(TAU * 1.7 * t + 1.1);
    tp.pelvis.set(0.025 * wob * fight, c.py, c.pz);
    tp.pPitch = -0.45 * c.lean; tp.sPitch = -0.55 * c.lean - 0.2 * jolt + 0.25 * dead;
    tp.sRoll = 0.09 * wob * fight; tp.sYaw = 0.12 * wob2 * fight;
    tp.nPitch = -0.3 * fight + 0.5 * dead; tp.hPitch = -0.15 * fight + 0.25 * dead; tp.hRoll = 0.55 * dead; tp.nRoll = 0.3 * dead;
    this.gaitFeetToTargets(tp, 0);
    this.pelvisGuard(tp, dt);
    this.solveTrunk(tp);
    const tmp = this.tpB.copy(tp);
    this.upperBody(tmp, s, 0, this.ub(0, 0, 0, 0, -1));
    // claw at the forearm across the throat; limp at the snap (arms hang)
    const k = sstep(T.grab, T.grab + 0.15, t) * (1 - dead);
    for (let i = 0; i < 2; i++) {
      const sd = i === 0 ? 1 : -1, h = tp.hand[i];
      this.handAtPalm(h, i, W[0].set(sd * 0.07 + 0.02 * Math.sin(TAU * 3 * t + i), c.ny - 0.06, c.nz + 0.11),
        W[1].set(0, -0.25, -1), W[2].set(-sd, 0.4, 0));
      h.pole.set(sd, -0.6, 0.2);
      if (dead > 0) { this.armSwing(this._hB, i, 0.05, 0.15, 0.12); lerpHand(h, this._hB, dead); }
      if (k < 1 && dead <= 0) lerpHand(h, tmp.hand[i], 1 - k);
    }
  }

  // Ledge / cover victims: grabbed, tipped over the edge or hauled over the wall, airborne, landing.
  tdFlightVictim(tp, s, td, dt) {
    const T = td.T, t = td.t, W = this._td.v, q = this._td.q;
    const dir = td.dir < 0 ? -1 : 1, th = td.pitch || 0, air = clamp(td.air || 0, 0, 1);
    const grab = sstep(T.grab, T.grab + 0.12, t);
    this.baseTrunk(tp);
    const rq = tp.pre.setFromAxisAngle(X_AXIS, th);
    if (td.pelvisW) tp.pelvis.copy(this.worldToRoot(W[0].copy(td.pelvisW))); else tp.pelvis.set(0, PELVIS_H - 0.03, 0);
    const ph = TAU * 1.5 * t;
    tp.sPitch = dir * 0.2 * grab - 0.15 * air * dir;              // folds toward the pull, then arches
    tp.sRoll = 0.14 * Math.sin(ph) * air;
    tp.nPitch = -dir * 0.3 * grab * (1 - air) + 0.15 * Math.sin(ph * 0.7) * air;
    for (let i = 0; i < 2; i++) {   // feet: on the floor while dragged (in the root frame), bicycling once airborne
      const sd = i === 0 ? 1 : -1, f = tp.foot[i];
      const stand = W[1].set(sd * 0.12, BALL_H, FOOT[i].ballZ + 0.04 * dir * grab);
      const kick = Math.sin(ph + i * Math.PI);
      const fly = W[2].set(sd * 0.13, -(L_LEG1 + L_LEG2) * 0.92 + 0.18 * (0.5 + 0.5 * kick), 0.12 * kick + 0.06).applyQuaternion(rq).add(tp.pelvis);
      f.ball.lerpVectors(stand, fly, air);
      f.q.identity().slerp(q.setFromAxisAngle(X_AXIS, th + 0.4), air);
      f.toe = 0.2 * air;
      f.pole.set(sd * 0.15, 0, 1).applyQuaternion(rq);
    }
    this.solveTrunk(tp);
    for (let i = 0; i < 2; i++) {   // arms thrown up and windmilling
      const sd = i === 0 ? 1 : -1, h = tp.hand[i], S = this.rsP[ARM[i].upper];
      const a = ph * 1.3 + i * 2.1;
      h.pos.set(sd * (0.32 + 0.08 * Math.sin(a)), 0.22 + 0.22 * Math.sin(a) * grab, 0.2 + 0.18 * Math.cos(a) * grab).applyQuaternion(this.rsQ[J.spine3]).add(S);
      h.pole.set(sd * 0.6, -0.5, -0.4).applyQuaternion(this.rsQ[J.spine3]);
      handQuat(h.q, i, W[3].set(sd * 0.3, 0.8, 0.3).applyQuaternion(this.rsQ[J.spine3]), W[4].set(-sd * 0.5, 0, 1).applyQuaternion(this.rsQ[J.spine3]));
    }
    if (grab < 1) {
      const tmp = this.tpB.copy(tp);
      this.upperBody(tmp, s, 0, this.ub(0, 0, 0, 0, -1));
      lerpHand(tp.hand[0], tmp.hand[0], 1 - grab); lerpHand(tp.hand[1], tmp.hand[1], 1 - grab);
    }
  }

  // Ledge attacker: the hang (s.climb keeps the last hang frame), the right hand off the lip to the victim's ankle.
  tdLedgeAttacker(tp, s, td, dt) {
    this.evalClimb(tp, s, dt);
    const T = td.T, t = td.t, W = this._td.v;
    const up = sstep(0.02, T.grab, t) * (1 - sstep(T.release + 0.05, T.end, t));
    const yank = bump(T.grab - 0.05, T.release + 0.12, t);
    tp.pelvis.y -= 0.1 * yank;
    tp.sPitch += 0.3 * yank; tp.sRoll -= 0.12 * up; tp.sYaw -= 0.15 * up;
    if (up > 0 && td.grabW) {
      const g = this.worldToRoot(W[0].copy(td.grabW));
      // hand pulls down and out through the yank
      g.y -= 0.35 * sstep(T.grab, T.release, t); g.z -= 0.15 * sstep(T.grab, T.release, t);
      const h = this._hA;
      this.handAtPalm(h, 1, g, W[1].set(0, 0.2, 1), W[2].set(0, 1, 0.15));
      h.pole.set(-1, -0.5, -0.4);
      lerpHand(tp.hand[1], h, up);
      tp.look.copy(g).sub(W[3].set(tp.pelvis.x, tp.pelvis.y + 0.6, tp.pelvis.z)).normalize(); tp.lookW = 0.9 * up;
    }
  }

  // Cover attacker: rise over the wall, both hands on his collar, haul him over, kneel beside him, one strike, back.
  tdCoverAttacker(tp, s, td, dt) {
    const P = this.P, T = td.T, t = td.t, W = this._td.v;
    const Tg = T.grab, Th = T.haul || T.grab + 0.15, To = T.over, Tk = T.kill, Te = T.end, Tm = (Th + To) / 2;
    this.baseTrunk(tp);
    const strike = bump(Tk - 0.16, Tk + 0.14, t);
    tp.pelvis.y = 0.58 + 0.22 * sstep(0, Tg, t) + 0.17 * sstep(Tg, Tm, t) - 0.2 * sstep(Tm, To, t)
      - 0.24 * sstep(To, Tk - 0.12, t) + 0.05 * sstep(Tk + 0.15, Te, t);
    tp.pelvis.z = 0.08 * sstep(0, Tg, t) - 0.2 * sstep(Tg, Tm, t) + 0.12 * sstep(Tm, To, t);
    tp.pPitch = 0.12 + 0.35 * sstep(0, Tg, t) - 0.5 * sstep(Tg, Tm, t) + 0.35 * sstep(Tm, To, t) - 0.2 * sstep(Tk + 0.1, Te, t);
    tp.sPitch = 0.12 + 0.55 * sstep(0, Tg, t) - 0.85 * sstep(Tg, Tm, t) + 0.5 * sstep(Tm, To, t) + 0.25 * strike - 0.3 * sstep(Tk + 0.1, Te, t);
    tp.sYaw = 0.35 * bump(Tk - 0.45, Tk - 0.1, t) - 0.3 * strike;   // wind up, then the blow
    tp.nPitch = 0.15 + 0.2 * sstep(To, Tk, t);
    const crouch = 1 - sstep(0, Tm, t) * (1 - sstep(Tm, To, t));
    this.setStance(0, 0, 0, 0.17, FOOT[0].ballZ + 0.18, -0.17, FOOT[1].ballZ - 0.2, P.gait_toeOut + 0.1);
    this.updateGait(dt, 0, clamp(crouch, 0, 1));
    if (td.grabW) { tp.look.copy(this.worldToRoot(W[5].copy(t < To ? td.grabW : td.strikeW))).sub(W[6].set(0, 1.4, 0)).normalize(); tp.lookW = 0.7; }
    this.gaitFeetToTargets(tp, tp.pYaw);
    this.pelvisGuard(tp, dt);
    this.solveTrunk(tp);
    const tmp = this.tpB.copy(tp);
    this.upperBody(tmp, s, 0, this.ub(0, 0, 0, 0, -1));
    const hL = tp.hand[0], hR = tp.hand[1];
    const gR = td.grabW ? this.worldToRoot(W[0].copy(td.grabW)) : W[0].set(0, 1.2, 0.8);
    // left hand: on the collar until after the strike
    this.handAtPalm(hL, 0, W[1].copy(gR).add(W[2].set(0.1, 0.02, 0)), W[3].set(0, -0.4, 1), W[4].set(-0.3, -0.8, 0.3));
    hL.pole.set(1, -0.4, -0.3);
    lerpHand(hL, tmp.hand[0], 1 - sstep(0, Tg * 0.9, t) * (1 - sstep(Tk + 0.1, Tk + 0.45, t)));
    // right hand: collar, wind up beside the head, the blow on his head, back to the hip
    const sR = td.strikeW ? this.worldToRoot(W[5].copy(td.strikeW)) : W[5].set(0, 0.1, 0.6);
    const wind = W[6].set(-0.28, tp.pelvis.y + 0.75, 0.05);
    const p = W[1].copy(gR).add(W[2].set(-0.1, 0.02, 0));
    p.lerp(wind, sstep(To - 0.1, Tk - 0.16, t));
    p.lerp(sR.add(W[7].set(0, 0.08, 0)), sstep(Tk - 0.16, Tk, t) * (1 - sstep(Tk + 0.03, Tk + 0.25, t)));
    this.handAtPalm(hR, 1, p, W[3].set(0, -1, 0.3), W[4].set(0.2, -0.3, 1));
    hR.pole.set(-1, -0.3, -0.5);
    lerpHand(hR, tmp.hand[1], 1 - sstep(0, Tg * 0.9, t) * (1 - sstep(Tk + 0.15, Te - 0.15, t)));
  }

  // --- death: jolt, knees buckle, topple along the shot, impact, limbs settle on the floor --------------------------------
  evalDeath(tp, s, dt) {
    const P = this.P;
    const T = (s.death && typeof s.death.t === 'number' ? s.death.t : this.modeTime) * (1.25 / P.death_duration);
    this.baseTrunk(tp);
    const back = this.deathBack, dir = back ? -1 : 1, hs = this.hitSign;
    const jolt = pulse(T, 0.06);
    const buckle = ease(clamp((T - 0.08) / 0.45, 0, 1));
    const topple = ease(clamp((T - 0.38) / 0.55, 0, 1));
    const impact = bump(0.9, 1.15, T);
    const settle = sstep(0.95, 1.6, T);
    const spin = this.deathYaw * ease(clamp(T / 0.9, 0, 1));
    const spinQ = _q[1].setFromAxisAngle(UP, spin);
    tp.pre.setFromAxisAngle(X_AXIS, dir * (Math.PI / 2) * topple * 0.98).premultiply(spinQ);
    const slide = P.death_slide * topple * dir;
    const ly = lerp(lerp(PELVIS_H - 0.02, 0.55, buckle), 0.11, topple) + 0.03 * impact;
    yawVec(tp.pelvis, spin, 0, 0, slide + 0.12 * dir * buckle * (1 - topple)).y = ly;
    tp.pPitch = 0.15 * buckle * (1 - topple);
    tp.sPitch = -dir * 0.25 * jolt + 0.35 * buckle * (1 - topple) - dir * 0.08 * topple - dir * 0.04 * impact;
    tp.sRoll = 0.12 * jolt * hs + 0.1 * settle * hs;
    tp.sYaw = 0.25 * jolt * hs;
    tp.nPitch = -dir * 0.4 * jolt + 0.3 * buckle * (1 - topple) + (back ? -0.2 : 0.1) * topple;
    tp.hRoll = 0.7 * settle * hs; tp.hYaw = 0.4 * settle * hs;
    for (let i = 0; i < 2; i++) {   // feet stay planted while buckling, then the legs lie along the floor, one knee bent
      const sd = i === 0 ? 1 : -1, f = tp.foot[i];
      const stand = yawVec(_v[1], spin * 0.3, sd * 0.11, BALL_H, FOOT[i].ballZ);
      const bent = (i === 0) === (hs > 0) ? 1 : 0;
      const lie = yawVec(_v[2], spin, sd * (0.16 + 0.06 * bent), 0.06 + 0.05 * bent, -dir * (0.85 - 0.3 * bent) + slide);
      f.ball.lerpVectors(stand, lie, topple);
      f.ball.y = Math.max(f.ball.y, lerp(BALL_H, 0.05, topple));
      qEuler(f.q, lerp(0.15 * buckle, back ? -1.25 : 1.35, topple), spin * lerp(0.3, 1, topple) + sd * 0.35 * topple, sd * 0.25 * topple);
      f.toe = 0;
      f.pole.set(sd * 0.25, lerp(0.1, back ? 1 : -1, topple), lerp(1, 0.2, topple)).applyQuaternion(spinQ).normalize();
    }
    this.solveTrunk(tp);
    for (let i = 0; i < 2; i++) {   // arms: flung by the jolt, hanging through the buckle, splayed on the floor
      const sd = i === 0 ? 1 : -1, h = tp.hand[i];
      const S = this.rsP[ARM[i].upper];
      const hang = _v[3].set(sd * 0.12, -0.5, 0.12 - 0.1 * jolt).applyQuaternion(this.rsQ[J.spine3]).add(S);
      const sp = _v[4].set(sd * 0.42, 0.05, dir * (i === 0 ? 0.25 : -0.05)).applyQuaternion(spinQ);
      sp.x += S.x; sp.z += S.z;
      h.pos.lerpVectors(hang, sp, topple);
      if (h.pos.y < 0.06) h.pos.y = 0.06;
      h.pole.set(sd * 0.5, -0.3 + 0.8 * topple, -0.6 * (1 - topple)).applyQuaternion(spinQ);
      handQuat(h.q, i, _v[5].set(sd * 0.5, -1 + topple, 0.2 * (1 - topple)).applyQuaternion(spinQ),
        _v[6].set(-sd, 0, 0).lerp(_v[7].set(0, back ? 1 : -1, 0), topple).applyQuaternion(spinQ));
    }
  }

  // =====================================================================================================================
  // Clip-source overlay: aim / actions on the arms over a clip pose (for the clips.js hook).
  overlayUpperBody(s) {
    const aimW = this.aimW, act = s.action && s.action.type;
    if (aimW < 0.01 && !act) return;
    const pose = this.pose, tp = this.tpB;
    const ay = ((s.aim && s.aim.yaw) || 0) * this.P.aim_spineYaw * aimW / 3;
    const ap = -((s.aim && s.aim.pitch) || 0) * this.P.aim_spinePitch * aimW / 3;
    const add = qEuler(_q[8], ap, ay, 0);
    pose.q[J.spine1].multiply(add); pose.q[J.spine2].multiply(add); pose.q[J.spine3].multiply(add);
    this.fkPose(pose);
    this.upperBody(tp, s, 0, this.ub(0, 0, aimW, 0, -1));
    for (let i = 0; i < 2; i++) {
      const h = tp.hand[i], ch = ARM[i];
      this.ik(ch, h.pos, h.pole, pose.q);
      pose.q[ch.end].copy(this.rsQ[ch.lower]).invert().multiply(h.q);
    }
  }

  // =====================================================================================================================
  // DEAD BLENDING
  startBlend(dur) {
    this.src.copy(this.out);
    const dtp = this.prevDt > 0 ? this.prevDt : 1 / 60;
    for (let i = 0; i < N; i++) {
      _q[0].copy(this.prev2.q[i]).invert().premultiply(this.out.q[i]);   // out * inv(prev2)
      qLog(_q[0], this.srcVel[i]).divideScalar(dtp);
      if (this.srcVel[i].lengthSq() > 625) this.srcVel[i].setLength(25);
    }
    this.srcPVel.subVectors(this.out.p, this.prev2.p).divideScalar(dtp);
    if (this.srcPVel.lengthSq() > 64) this.srcPVel.setLength(8);
    this.blendT = 0; this.blendDur = Math.max(1e-3, dur);
  }

  applyBlend(dt) {
    const out = this.out;
    this.prev2.copy(this.prev);
    if (this.blendT < 1 && this.hasPrev) {
      this.blendT = Math.min(1, this.blendT + (dt > 0 ? dt / this.blendDur : 0));
      const tau = this.blendT * this.blendDur, lam = Math.LN2 / this.P.blend_velDecay;
      const fI = (1 - Math.exp(-lam * tau)) / lam;
      const a = ease(this.blendT);
      for (let i = 0; i < N; i++) {
        qExp(_v[0].copy(this.srcVel[i]).multiplyScalar(fI), _q[0]).multiply(this.src.q[i]);
        out.q[i].copy(_q[0]).slerp(this.pose.q[i], a);
      }
      out.p.lerpVectors(_v[1].copy(this.src.p).addScaledVector(this.srcPVel, fI), this.pose.p, a);
    } else out.copy(this.pose);
    this.prev.copy(out);
    if (!this.hasPrev) { this.prev2.copy(out); this.hasPrev = true; }
    if (dt > 0) this.prevDt = dt;
  }

  writeBones() {
    const b = this.bones, out = this.out;
    for (let i = 0; i < N; i++) b[i].quaternion.copy(out.q[i]);
    b[0].position.copy(out.p);
  }
}

// --- helpers ---------------------------------------------------------------------------------------------------------------
const DEFAULT_STATE = { mode: 'locomotion' };
const DEFAULT_COVER = { height: 'low', side: 1, pose: 'idle', t: 1 };
const DEFAULT_CLIMB = { pose: 'hang', t: 0 };

function spring(st, target, freq, zeta, dt) {   // semi-implicit damped spring
  if (dt <= 0) return;
  const w = TAU * freq;
  st.v += ((target - st.x) * w * w - 2 * zeta * w * st.v) * dt;
  st.x += st.v * dt;
}

export const MODES = ['locomotion', 'cover', 'roll', 'jump', 'fall', 'land', 'mantle', 'climb', 'hitreact', 'death', 'takedown'];
const MODE_IDX = { locomotion: 1, cover: 2, roll: 3, jump: 4, fall: 5, land: 6, mantle: 7, climb: 8, hitreact: 9, death: 10, takedown: 11 };
const COVER_SUB = { idle: 0, move: 0, popup: 1, lean: 2, blind: 3, enter: 4, exit: 5 };
const KIND_SUB = { mantle: 0, vault: 1 };
const CLIMB_SUB = { hang: 0, shimmy: 0, reach: 0, climbup: 1, drop: 2, hangAim: 3 };
function poseKey(mode, s) {
  const m = MODE_IDX[mode] || 1;
  let sub = 0;
  if (mode === 'cover' && s.cover) sub = (COVER_SUB[s.cover.pose] || 0) + (s.cover.height === 'high' ? 8 : 0);
  else if (mode === 'climb' && s.climb) sub = CLIMB_SUB[s.climb.pose] || 0;
  else if (mode === 'mantle') sub = KIND_SUB[s.mode === 'climb' && s.climb ? s.climb.move : s.mantle && s.mantle.kind] || 0;
  return (m << 4) | sub;
}
const BLEND_FIELD = ['', 'blend_locomotion', 'blend_cover', 'blend_roll', 'blend_jump', 'blend_fall', 'blend_land',
  'blend_mantle', 'blend_climb', 'blend_hitreact', 'blend_death', 'blend_takedown'];
function blendTime(P, key, prevKey) {
  const m = key >> 4;
  if (m === prevKey >> 4) return m === MODE_IDX.climb ? P.blend_climbSub : P.blend_coverSub;
  const v = P[BLEND_FIELD[m]];
  return typeof v === 'number' ? v : 0.2;
}

// --- animation system: places each actor's rig at actor.pos / actor.yaw and poses it from actor.animState (order 60) ----
export function install(game) {
  const sys = {
    name: 'animation', order: 60,
    update(dt, g) {
      const actors = g.actors || [];
      for (let i = 0; i < actors.length; i++) {
        const a = actors[i], rig = a.rig;
        if (!rig || rig.autoUpdate === false || typeof rig.update !== 'function') continue;
        if (a.pos) rig.root.position.copy(a.pos);
        if (typeof a.yaw === 'number') rig.root.rotation.set(0, a.yaw, 0);
        rig.update(dt, a.animState || DEFAULT_STATE);
      }
    },
  };
  if (game && typeof game.addSystem === 'function') game.addSystem(sys);
  // createCharacter lives in character/index.js; expose it as game.createCharacter without a static import cycle.
  if (game) import('./index.js').then((m) => { game.createCharacter = m.createCharacter; }).catch(() => {});
  return sys;
}
