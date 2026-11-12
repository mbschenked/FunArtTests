// character/skins.js: free CC0 figures worn over the SMPL-22 rig. Owner: lead (skins pass, 11 Nov).
//
// FIGURES   assets/figures/{hunter,soldier}.glb = Quaternius "Ultimate Modular Men" Adventurer / Swat (CC0 1.0, see
//           assets/figures/LICENSE-Quaternius-CC0.txt), animations stripped. Their own 62-bone rig (T-pose bind, Y up,
//           facing +Z, left = +X, same axes as our rest frame) is driven every step from the rig's SMPL-22 pose.
// RETARGET  ("A-space" = the figure's armature space = our root space / skin.scale)
//   rotation   R_t = Q_ours * A_t * B_t        Q_ours: our bone's root-space rotation (rest = identity, skeleton.js)
//                                              B_t: the figure bone's bind rotation; A_t: shortest arc taking the
//                                              figure's bind bone direction onto ours, so T-pose differences cancel
//   position   bind offsets down the chain (the figure keeps its own proportions); the body follows our pelvis
//   feet       two-bone IK onto our ankle frame (contact and stance hold), pole = our knee
//   hands      FK (its arms are ~23% shorter than ours); our wrist bones are then MOVED onto the figure's wrists, so
//              the pistol, magazine and grenade sockets ride in the figure's hands. Two-handed: the left hand keeps the
//              same offset from the gun hand as our rig's, through two-bone IK (pole = our elbow).
//   fingers    bind pose + a curl about the hand's palm axis: gun grip on the right, relaxed / support grip on the left
// The mannequin mesh stays on the rig, hidden; skin.on switches between the two. Hitboxes stay on our bones.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { JOINTS, J, PARENTS, REST, OFFSETS } from './skeleton.js';

export const FIGURES = { player: 'hunter.glb', enemy: 'soldier.glb' };
const san = (n) => THREE.PropertyBinding.sanitizeNodeName(n);

// figure bone -> our joint (rotation source). Body carries the position.
const MAP = {
  Body: 'pelvis', Hips: 'pelvis', Abdomen: 'spine1', Torso: 'spine2', Chest: 'spine3', Neck: 'neck', Head: 'head',
  'Shoulder.L': 'left_collar', 'UpperArm.L': 'left_shoulder', 'LowerArm.L': 'left_elbow', 'Wrist.L': 'left_wrist',
  'Shoulder.R': 'right_collar', 'UpperArm.R': 'right_shoulder', 'LowerArm.R': 'right_elbow', 'Wrist.R': 'right_wrist',
  'UpperLeg.L': 'left_hip', 'LowerLeg.L': 'left_knee', 'Foot.L': 'left_ankle',
  'UpperLeg.R': 'right_hip', 'LowerLeg.R': 'right_knee', 'Foot.R': 'right_ankle',
};
// Alignment pairs: figure bone -> [figure child, our joint, our child | direction vector]. Unlisted mapped bones: A = I.
const ALIGN = {
  Abdomen: ['Torso', 'spine1', 'spine2'], Torso: ['Chest', 'spine2', 'spine3'], Chest: ['Neck', 'spine3', 'neck'],
  Neck: ['Head', 'neck', 'head'],
  'Shoulder.L': ['UpperArm.L', 'left_collar', 'left_shoulder'], 'UpperArm.L': ['LowerArm.L', 'left_shoulder', 'left_elbow'],
  'LowerArm.L': ['Wrist.L', 'left_elbow', 'left_wrist'], 'Wrist.L': ['Middle1.L', 'left_wrist', [1, 0, 0]],
  'Shoulder.R': ['UpperArm.R', 'right_collar', 'right_shoulder'], 'UpperArm.R': ['LowerArm.R', 'right_shoulder', 'right_elbow'],
  'LowerArm.R': ['Wrist.R', 'right_elbow', 'right_wrist'], 'Wrist.R': ['Middle1.R', 'right_wrist', [-1, 0, 0]],
  'UpperLeg.L': ['LowerLeg.L', 'left_hip', 'left_knee'], 'LowerLeg.L': ['Foot.L', 'left_knee', 'left_ankle'],
  'UpperLeg.R': ['LowerLeg.R', 'right_hip', 'right_knee'], 'LowerLeg.R': ['Foot.R', 'right_knee', 'right_ankle'],
};
// The feet hang off Root in the figure's rig (Blender IK controls); for the retarget they hang off the shins.
const VPARENT = { 'Foot.L': 'LowerLeg.L', 'Foot.R': 'LowerLeg.R' };
const LEGS = [['UpperLeg.L', 'LowerLeg.L', 'Foot.L', 'left_hip', 'left_knee', 'left_ankle'],
  ['UpperLeg.R', 'LowerLeg.R', 'Foot.R', 'right_hip', 'right_knee', 'right_ankle']];
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'];

export function defineSkinParams(params) {
  if (!params || params.has('skin.on')) return;
  params.define('skin.on', true, { label: 'figures (off = mannequin)' });
  params.define('skin.scale', 1.0, { min: 0.85, max: 1.15, step: 0.005, label: 'figure scale' });                 // [ASSUMED] legs match at 1.0
  params.define('skin.grip.x', 0.0, { min: -0.1, max: 0.1, step: 0.002, label: 'gun in hand x (wrist, m)' });      // [ASSUMED] art
  params.define('skin.grip.y', 0.0, { min: -0.1, max: 0.1, step: 0.002, label: 'gun in hand y (wrist, m)' });
  params.define('skin.grip.z', 0.0, { min: -0.1, max: 0.1, step: 0.002, label: 'gun in hand z (wrist, m)' });
  params.define('skin.curl.gun', 1.0, { min: 0, max: 1.6, step: 0.02, label: 'gun hand finger curl (rad)' });       // [ASSUMED] art
  params.define('skin.curl.relaxed', 0.3, { min: 0, max: 1.2, step: 0.02, label: 'free hand finger curl (rad)' });
  params.define('skin.curl.support', 0.85, { min: 0, max: 1.6, step: 0.02, label: 'support hand curl (rad)' });
  params.define('skin.support.near', 0.2, { min: 0.05, max: 0.6, step: 0.01, label: 'two-hand IK full within (m)' }); // wrist gap
  params.define('skin.climb.shift', 1.0, { min: 0, max: 1, step: 0.05, label: 'climb: lift figure to its hands' });  // [ASSUMED]
  params.define('skin.support.far', 0.32, { min: 0.1, max: 0.8, step: 0.01, label: 'two-hand IK off beyond (m)' });
}

// --- template: one parsed glTF per figure, with the bind data every clone shares ---------------------------------------
function prepTemplate(gltf) {
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  let skinned = null;
  scene.traverse((o) => { if (o.isSkinnedMesh && !skinned) skinned = o; });
  if (!skinned) throw new Error('figure has no skinned mesh');
  const bones = skinned.skeleton.bones;
  const names = bones.map((b) => b.name);
  const idx = new Map(names.map((n, i) => [n, i]));
  const m = new THREE.Matrix4(), s = new THREE.Vector3();
  const bindQ = [], bindP = [];
  bones.forEach((b, i) => {
    m.copy(skinned.skeleton.boneInverses[i]).invert().premultiply(skinned.bindMatrix);
    const q = new THREE.Quaternion(), p = new THREE.Vector3();
    m.decompose(p, q, s);
    bindQ.push(q); bindP.push(p);
  });
  const find = (n) => idx.has(san(n)) ? idx.get(san(n)) : -1;
  // virtual parents (bone indices; -1 = the armature)
  const vpar = bones.map((b) => {
    const named = Object.keys(VPARENT).find((k) => san(k) === b.name);
    if (named) return find(VPARENT[named]);
    return b.parent && b.parent.isBone ? idx.get(b.parent.name) : -1;
  });
  const order = [];
  const depth = (i) => (vpar[i] < 0 ? 0 : 1 + depth(vpar[i]));
  bones.forEach((_, i) => order.push(i));
  order.sort((a, b) => depth(a) - depth(b));
  // mapping + alignment
  const ours = bones.map(() => -1), A = bones.map(() => new THREE.Quaternion());
  for (const [fig, our] of Object.entries(MAP)) {
    const i = find(fig);
    if (i < 0) continue;
    ours[i] = J[our];
    const al = ALIGN[fig];
    if (!al) continue;
    const k = find(al[0]);
    if (k < 0) continue;
    const dFig = bindP[k].clone().sub(bindP[i]).normalize();
    const dOur = Array.isArray(al[2]) ? new THREE.Vector3(...al[2]) : REST[J[al[2]]].clone().sub(REST[J[al[1]]]);
    A[i].setFromUnitVectors(dFig, dOur.normalize());
  }
  // relative bind data
  const relQ = bones.map((_, i) => (vpar[i] < 0 ? bindQ[i].clone() : bindQ[vpar[i]].clone().invert().multiply(bindQ[i])));
  const relP = bones.map((_, i) => (vpar[i] < 0 ? bindP[i].clone()
    : bindP[i].clone().sub(bindP[vpar[i]]).applyQuaternion(bindQ[vpar[i]].clone().invert())));
  // fingers: per joint, the curl axis in the bone's local frame, the side and the segment
  const finger = bones.map(() => null);
  for (const side of ['L', 'R']) {
    const sgn = side === 'L' ? -1 : 1;                       // fingers +X (L) / -X (R) curl toward the palm (-Y)
    for (const f of FINGERS) for (let seg = 1; seg <= 4; seg++) {          // seg 1 = metacarpal (from the wrist), 2-4 phalanges
      const i = find(`${f}${seg}.${side}`);
      if (i >= 0) finger[i] = { side, seg, thumb: false, f, axis: new THREE.Vector3(0, 0, sgn).applyQuaternion(bindQ[i].clone().invert()) };
    }
    for (let seg = 1; seg <= 3; seg++) {
      const i = find(`Thumb${seg}.${side}`);
      if (i >= 0) finger[i] = { side, seg, thumb: true, f: 'Thumb', axis: new THREE.Vector3(1, 0, 0).applyQuaternion(bindQ[i].clone().invert()) };
    }
  }
  const legs = LEGS.map(([u, md, e, ou, om, oe]) => ({ u: find(u), m: find(md), e: find(e), ou: J[ou], om: J[om], oe: J[oe] }));
  const wrist = { L: find('Wrist.L'), R: find('Wrist.R') };
  const arm = { L: { u: find('UpperArm.L'), m: find('LowerArm.L') }, R: { u: find('UpperArm.R'), m: find('LowerArm.R') } };
  const desc = (root) => order.filter((i) => { for (let p = i; p >= 0; p = vpar[p]) if (p === root) return i !== root; return false; });
  return {
    scene, names, find, bindQ, bindP, relQ, relP, vpar, order, ours, A, finger, legs, wrist, arm,
    body: find('Body'), leftHandDesc: desc(wrist.L), rightHandDesc: desc(wrist.R),
  };
}

// --- per-rig instance ---------------------------------------------------------------------------------------------------
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3();
const _pole = new THREE.Vector3(), _d = new THREE.Vector3(), _n = new THREE.Vector3();
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

class Skin {
  constructor(game, rig, T) {
    this.game = game; this.rig = rig; this.T = T;
    this.root = cloneSkinned(T.scene);
    this.root.name = `figure-${rig.palette}`;
    const byName = new Map();
    this.root.traverse((o) => {
      if (o.isBone) byName.set(o.name, o);
      if (o.isMesh) { o.castShadow = rig.mesh.castShadow; o.receiveShadow = true; o.frustumCulled = false; }
    });
    this.bones = T.names.map((n) => byName.get(n));
    const N = this.bones.length;
    this.R = Array.from({ length: N }, () => new THREE.Quaternion());
    this.P = Array.from({ length: N }, () => new THREE.Vector3());
    this.oQ = Array.from({ length: 22 }, () => new THREE.Quaternion());
    this.oP = Array.from({ length: 22 }, () => new THREE.Vector3());
    this.curlQ = Array.from({ length: N }, () => new THREE.Quaternion());
    rig.root.add(this.root);
    this.moved = false;
    this.anchor = { L: 0, R: 0 };
  }

  // Our pose in root space, from the bone locals (exact, no matrix inverse).
  readOurs() {
    const { list } = this.rig, oQ = this.oQ, oP = this.oP;
    for (let i = 0; i < 22; i++) {
      const b = list[i], p = PARENTS[i];
      if (p < 0) { oQ[i].copy(b.quaternion); oP[i].copy(b.position); }
      else { oQ[i].copy(oQ[p]).multiply(b.quaternion); oP[i].copy(b.position).applyQuaternion(oQ[p]).add(oP[p]); }
    }
  }

  solveJoint(i, s) {
    const T = this.T, R = this.R, P = this.P, vp = T.vpar[i], o = T.ours[i];
    if (o >= 0) R[i].copy(this.oQ[o]).multiply(T.A[i]).multiply(T.bindQ[i]);
    else if (vp >= 0) R[i].copy(R[vp]).multiply(T.relQ[i]).multiply(this.curlQ[i]);
    else R[i].copy(T.bindQ[i]);
    if (i === T.body) {
      const pel = J.pelvis;
      _v.copy(T.bindP[i]).addScaledVector(REST[pel], -1 / s).applyQuaternion(this.oQ[pel]);
      P[i].copy(this.oP[pel]).multiplyScalar(1 / s).add(_v);
    } else if (vp >= 0) P[i].copy(T.relP[i]).applyQuaternion(R[vp]).add(P[vp]);
    else P[i].copy(T.bindP[i]);
  }

  // Two-bone IK in A-space: bones u -> m -> e reach target t, bending toward pole point.
  ik(u, m, e, target, pole) {
    const T = this.T, R = this.R, P = this.P;
    const la = T.bindP[m].distanceTo(T.bindP[u]), lb = T.bindP[e].distanceTo(T.bindP[m]);
    _a.copy(P[u]);
    _d.copy(target).sub(_a);
    let d = _d.length();
    if (d < 1e-5) return;
    _d.multiplyScalar(1 / d);
    d = Math.min(d, (la + lb) * 0.9995);
    const cosA = Math.min(1, Math.max(-1, (la * la + d * d - lb * lb) / (2 * la * d)));
    const sinA = Math.sqrt(1 - cosA * cosA);
    _n.copy(pole).sub(_a); _n.addScaledVector(_d, -_n.dot(_d));
    if (_n.lengthSq() < 1e-8) { _n.copy(P[m]).sub(_a); _n.addScaledVector(_d, -_n.dot(_d)); }
    _n.normalize();
    _b.copy(_a).addScaledVector(_d, cosA * la).addScaledVector(_n, sinA * la);   // new mid
    _c.copy(_a).addScaledVector(_d, d);                                         // new end
    // upper: swing its bone onto the new mid
    _v.copy(P[m]).sub(_a).normalize(); _v2.copy(_b).sub(_a).normalize();
    _q.setFromUnitVectors(_v, _v2);
    R[u].premultiply(_q); R[m].premultiply(_q);
    // mid: swing onto the new end
    _v.copy(T.relP[e]).applyQuaternion(R[m]).normalize(); _v2.copy(_c).sub(_b).normalize();
    _q.setFromUnitVectors(_v, _v2);
    R[m].premultiply(_q);
    P[m].copy(_b); P[e].copy(_c);
  }

  // 1 while our wrist is at its climb hold (handX: world palm point), fading out as the hand leaves it (reach, aim).
  anchorW(handWorld, ji) {
    const h = this.rig.root.worldToLocal(_c.copy(handWorld));
    return 1 - sstep(0.14, 0.26, h.distanceTo(this.oP[ji]));
  }

  setCurl(side, gun, support, w) {
    const T = this.T;
    for (let i = 0; i < T.finger.length; i++) {
      const f = T.finger[i];
      if (!f || f.side !== side) continue;
      let amt;
      if (side === 'R') amt = gun * (f.f === 'Index' ? 0.55 : 1);                    // trigger finger straighter
      else amt = this.relaxed + (support - this.relaxed) * w;
      const segMul = f.thumb ? [0, 0.35, 0.4, 0.3][f.seg] : [0, 0.1, 1.0, 0.95, 0.6][f.seg];
      this.curlQ[i].setFromAxisAngle(f.axis, amt * segMul);
    }
  }

  update(animState) {
    const T = this.T, P = this.P, R = this.R, rig = this.rig, par = this.game.params;
    const g = (k, d) => { try { return par.get(k); } catch { return d; } };
    const s = g('skin.scale', 1);
    this.root.scale.setScalar(s);
    this.readOurs();
    const oP = this.oP;
    // two-hand weight from our rig's wrist gap
    const gap = oP[J.left_wrist].distanceTo(oP[J.right_wrist]);
    const w = 1 - sstep(g('skin.support.near', 0.2), g('skin.support.far', 0.32), gap);
    this.relaxed = g('skin.curl.relaxed', 0.3);
    this.setCurl('R', g('skin.curl.gun', 1), 0, 0);
    this.setCurl('L', 0, g('skin.curl.support', 0.85), w);
    // FK pass, feet IK at the ankles
    const legEnd = new Map(T.legs.map((L) => [L.e, L]));
    for (const i of T.order) {
      if (legEnd.has(i)) {
        const L = legEnd.get(i);
        this.solveJoint(i, s);
        _t.copy(T.bindP[i]).addScaledVector(REST[L.oe], -1 / s).applyQuaternion(this.oQ[L.oe]).addScaledVector(oP[L.oe], 1 / s);
        _pole.copy(oP[L.om]).multiplyScalar(1 / s).sub(_v.copy(oP[L.ou]).multiplyScalar(1 / s)).add(P[L.u]);
        this.ik(L.u, L.m, i, _t, _pole);
        continue;
      }
      this.solveJoint(i, s);
    }
    // climbing: hands on a hold stay on it. The figure's arms are shorter, so it hangs higher: shift the whole figure
    // by the anchored hands' shortfall, re-plant the feet, then IK the anchored arms onto our wrists.
    const cl = animState && animState.mode === 'climb' ? animState.climb : null;
    let anchored = 0;
    if (cl && cl.handL && cl.handR) {
      const ar = this.anchor;
      ar.L = this.anchorW(cl.handL, J.left_wrist); ar.R = this.anchorW(cl.handR, J.right_wrist);
      const sw = ar.L + ar.R;
      if (sw > 1e-3) {
        anchored = Math.max(ar.L, ar.R);
        _d.set(0, 0, 0);
        for (const [side, ji] of [['L', J.left_wrist], ['R', J.right_wrist]]) {
          if (ar[side] <= 0) continue;
          _v.copy(oP[ji]).multiplyScalar(1 / s).sub(P[T.wrist[side]]);
          _d.addScaledVector(_v, ar[side] / sw);
        }
        _d.multiplyScalar(anchored * g('skin.climb.shift', 1));
        for (let i = 0; i < P.length; i++) P[i].add(_d);
        for (const L of T.legs) {
          _t.copy(T.bindP[L.e]).addScaledVector(REST[L.oe], -1 / s).applyQuaternion(this.oQ[L.oe]).addScaledVector(oP[L.oe], 1 / s);
          _pole.copy(oP[L.om]).sub(oP[L.ou]).multiplyScalar(1 / s).add(P[L.u]);
          this.ik(L.u, L.m, L.e, _t, _pole);
        }
        for (const [side, ji, si, ei] of [['L', J.left_wrist, J.left_shoulder, J.left_elbow], ['R', J.right_wrist, J.right_shoulder, J.right_elbow]]) {
          if (ar[side] <= 1e-3) continue;
          const wi = T.wrist[side];
          _t.copy(oP[ji]).multiplyScalar(1 / s);
          _t.lerpVectors(P[wi], _t, ar[side]);
          _pole.copy(oP[ei]).sub(oP[si]).multiplyScalar(1 / s).add(P[T.arm[side].u]);
          this.ik(T.arm[side].u, T.arm[side].m, wi, _t, _pole);
          for (const i of (side === 'L' ? T.leftHandDesc : T.rightHandDesc)) this.solveJoint(i, s);
        }
      }
    }
    // two-handed: the left wrist keeps our rig's offset from the gun hand
    if (!anchored && w > 1e-3 && T.wrist.L >= 0 && T.wrist.R >= 0) {
      const wl = T.wrist.L;
      _t.copy(oP[J.left_wrist]).sub(oP[J.right_wrist]).multiplyScalar(1 / s).add(P[T.wrist.R]);
      _t.lerpVectors(P[wl], _t, w);
      _pole.copy(oP[J.left_elbow]).sub(oP[J.left_shoulder]).multiplyScalar(1 / s).add(P[T.arm.L.u]);
      this.ik(T.arm.L.u, T.arm.L.m, wl, _t, _pole);
      for (const i of T.leftHandDesc) this.solveJoint(i, s);
    }
    // write the locals (actual parents)
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i], p = b.parent && b.parent.isBone ? T.names.indexOf(b.parent.name) : -1;
      if (p < 0) { b.quaternion.copy(R[i]); b.position.copy(P[i]); }
      else {
        _q2.copy(R[p]).invert();
        b.quaternion.copy(_q2).multiply(R[i]);
        b.position.copy(P[i]).sub(P[p]).applyQuaternion(_q2);
      }
      b.scale.set(1, 1, 1);
    }
    this.root.updateMatrixWorld(true);
    // our wrists (and the gun / mag / grenade sockets on them) ride the figure's hands
    const grip = _v2.set(g('skin.grip.x', 0), g('skin.grip.y', 0), g('skin.grip.z', 0));
    for (const [side, ji, pi] of [['R', J.right_wrist, J.right_elbow], ['L', J.left_wrist, J.left_elbow]]) {
      const fi = T.wrist[side];
      if (fi < 0) continue;
      _t.copy(P[fi]).multiplyScalar(s);
      if (side === 'R') _t.add(_v.copy(grip).applyQuaternion(this.oQ[ji]));
      _t.sub(oP[pi]).applyQuaternion(_q.copy(this.oQ[pi]).invert());
      rig.list[ji].position.copy(_t);
      rig.list[ji].updateMatrixWorld(true);
    }
    this.moved = true;
  }

  restore() {
    if (!this.moved) return;
    this.rig.list[J.right_wrist].position.copy(OFFSETS[J.right_wrist]);
    this.rig.list[J.left_wrist].position.copy(OFFSETS[J.left_wrist]);
    this.moved = false;
  }

  setOn(on) { this.root.visible = !!on; this.rig.mesh.visible = !on; }
  dispose() { if (this.root.parent) this.root.parent.remove(this.root); }
}

// Wrap a rig so it wears the figure for its palette. Returns the Skin or null (no template: mannequin stays).
export function attachSkin(game, rig, templates) {
  const T = templates && templates[rig.palette === 'enemy' ? 'enemy' : 'player'];
  if (!T) return null;
  const skin = new Skin(game, rig, T);
  const baseUpdate = rig.update;
  rig.update = (dt, animState) => {
    skin.restore();
    baseUpdate(dt, animState);
    if (skin.root.visible) skin.update(animState);
  };
  const baseDispose = rig.dispose;
  rig.dispose = () => { skin.dispose(); baseDispose(); };
  rig.skin = skin;
  let on = true;
  try { on = game.params.get('skin.on'); } catch { /* params not defined: on */ }
  skin.setOn(on);
  return skin;
}

// Boot module (main.js MODULES 'skins'): load both figures before the player and the enemies are created.
export async function install(game) {
  defineSkinParams(game.params);
  const loader = new GLTFLoader();
  const base = new URL('../../assets/figures/', import.meta.url);
  const templates = {};
  await Promise.all(Object.entries(FIGURES).map(async ([k, file]) => {
    try { templates[k] = prepTemplate(await loader.loadAsync(new URL(file, base).href)); }
    catch (err) { console.warn(`[skins] ${file} not loaded, the mannequin stays: ${err && err.message}`); }
  }));
  const rigs = [];
  game.skins = {
    templates,
    attach(rig) { const sk = attachSkin(game, rig, templates); if (sk) rigs.push(sk); return sk; },
    rigs,
  };
  game.params.onChange('skin.on', (v) => { for (const sk of rigs) sk.setOn(v); });
  console.info(`[skins] figures: ${Object.keys(templates).join(', ') || 'none'}`);
}
