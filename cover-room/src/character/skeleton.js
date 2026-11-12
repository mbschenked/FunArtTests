// character/skeleton.js: the SMPL / HumanML3D 22-joint skeleton, an original segmented mannequin mesh, a pistol and
// the sockets. Contract: refs/design.md "character/*: rig". Owner: A4.
//
// SKELETON   Joint names and order are the SMPL-22 / HumanML3D standard (JOINTS, PARENTS below), so text-to-motion
//            clips (refs/mocap-brief.md) drop onto it later through character/clips.js. Rest pose = the SMPL T-pose
//            with IDENTITY local rotations: every bone's rest frame equals the root frame (Y up, facing +Z, the
//            character's left = +X). SMPL axis-angle joint rotations therefore apply as local quaternions unchanged.
//            Rest offsets: the SMPL neutral template joints (J_regressor on v_template), mirrored to be exactly
//            left/right symmetric, scaled so the standing height (sole to crown) is 1.8 m, floor at y = 0 and the
//            pelvis joint on the root's vertical axis (x = z = 0).
// MESH       One SkinnedMesh per character, every vertex weighted 1.0 to one bone (rigid segments, mannequin look):
//            one draw call (+1 for the shadow pass) per character, plus one for the pistol. Vertex colours carry the
//            palette ('player': muted teal jacket, charcoal trousers; 'enemy': sand fatigues, dark vest, cap).
// SOCKETS    hand_r (pistol grip frame: +Z barrel, +Y up, +X gun-left), hand_l (left palm centre, wrist frame),
//            muzzle (on the pistol, +Z = shot direction), head (head centre, head frame), grenade_hand (left palm,
//            where a held grenade's centre sits). All are Object3D children of bones, so world transforms follow.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const JOINTS = [
  'pelvis', 'left_hip', 'right_hip', 'spine1', 'left_knee', 'right_knee', 'spine2', 'left_ankle', 'right_ankle',
  'spine3', 'left_foot', 'right_foot', 'neck', 'left_collar', 'right_collar', 'head', 'left_shoulder',
  'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
];
export const PARENTS = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19];
export const J = Object.freeze(Object.fromEntries(JOINTS.map((n, i) => [n, i])));

// SMPL neutral template joint positions (m, Y up, facing +Z), standard J_regressor output, 4 decimals.
const SMPL_J = [
  [-0.0018, -0.2233, 0.0282], [0.0695, -0.3143, 0.0237], [-0.0677, -0.3144, 0.0214], [-0.0025, -0.1037, -0.0138],
  [0.1046, -0.7200, 0.0181], [-0.1056, -0.7238, 0.0141], [0.0049, 0.0381, 0.0085], [0.0886, -1.1222, -0.0286],
  [-0.0919, -1.1190, -0.0297], [0.0031, 0.0887, 0.0314], [0.1193, -1.1784, 0.0922], [-0.1166, -1.1826, 0.0947],
  [-0.0134, 0.3028, -0.0136], [0.0717, 0.2000, -0.0049], [-0.0829, 0.1998, -0.0073], [0.0104, 0.3651, 0.0373],
  [0.1731, 0.2255, -0.0170], [-0.1753, 0.2248, -0.0196], [0.4340, 0.2149, -0.0371], [-0.4357, 0.2099, -0.0337],
  [0.6819, 0.2224, -0.0322], [-0.6878, 0.2210, -0.0372],
];
// The template is about 1.70 m tall: sole ~0.07 below the ankle joints, crown ~0.145 above the head joint.
const SOLE_BELOW_ANKLE = 0.07, CROWN_ABOVE_HEAD = 0.145;
export const HEIGHT = 1.8;

// Rest joint positions in root space (THREE.Vector3[22]) and local offsets from the parent joint.
export const REST = (() => {
  const pts = SMPL_J.map((p) => p.slice());
  // Mirror pairs exactly (left = +x).
  for (let i = 0; i < 22; i++) {
    const n = JOINTS[i];
    if (n.startsWith('left_')) {
      const k = J['right_' + n.slice(5)];
      const a = pts[i], b = pts[k];
      const x = (a[0] - b[0]) / 2, y = (a[1] + b[1]) / 2, z = (a[2] + b[2]) / 2;
      pts[i] = [x, y, z]; pts[k] = [-x, y, z];
    } else if (!n.startsWith('right_')) pts[i][0] = 0;
  }
  const ankleY = pts[J.left_ankle][1];
  const floor = ankleY - SOLE_BELOW_ANKLE, crown = pts[J.head][1] + CROWN_ABOVE_HEAD;
  const s = HEIGHT / (crown - floor);
  const pz = pts[J.pelvis][2];
  return pts.map((p) => new THREE.Vector3(p[0] * s, (p[1] - floor) * s, (p[2] - pz) * s));
})();
export const OFFSETS = REST.map((p, i) => (PARENTS[i] < 0 ? p.clone() : p.clone().sub(REST[PARENTS[i]])));

// --- sockets (bone-local transforms; rest bone frames equal the root frame) --------------------------------------------
// Right hand: rest long axis (wrist -> knuckles) -X, palm normal -Y, thumb +Z. Left hand: long +X, palm -Y, thumb +Z.
// The pistol grip frame inside the right hand: hand long axis = barrel tilted 17 deg down, palm faces gun-left (+X_g),
// thumb up-forward. GRIP_R.quat maps gun-local vectors into right-wrist-local vectors.
function basisQuat(x, y, z) {
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
// Rotation taking the rest hand axes (long, palm, thumb) onto the given ones (all in one target space).
export function handAxesQuat(long, palm, thumb, restLong, restPalm, restThumb, out = new THREE.Quaternion()) {
  const m1 = new THREE.Matrix4().makeBasis(long, palm, thumb);
  const m0 = new THREE.Matrix4().makeBasis(restLong, restPalm, restThumb);
  return out.setFromRotationMatrix(m1.multiply(m0.transpose()));
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);
export const HAND_R_AXES = { long: V(-1, 0, 0), palm: V(0, -1, 0), thumb: V(0, 0, 1) };
export const HAND_L_AXES = { long: V(1, 0, 0), palm: V(0, -1, 0), thumb: V(0, 0, 1) };

// Gun-in-wrist: rotation R with R * (gun-axis vector) = wrist-local vector.
export const GRIP_R = (() => {
  const L = V(0, -0.3, 1).normalize(), P = V(1, 0, 0), T = new THREE.Vector3().crossVectors(L, P);
  // q_wg maps rest hand axes -> gun-space axes; the socket rotation is its inverse (gun -> wrist).
  const qwg = handAxesQuat(L, P, T, HAND_R_AXES.long, HAND_R_AXES.palm, HAND_R_AXES.thumb);
  return { pos: V(-0.083, -0.036, 0.004), quat: qwg.clone().invert() };
})();
// Left support hand on the pistol, in gun space: palm on the grip's left side facing it, fingers forward-down over
// the right hand's fingers, thumb forward along the frame. PALM_L is the palm centre in left-wrist space.
export const PALM_L = V(0.078, -0.022, 0.0);
export const PALM_R = V(-0.078, -0.022, 0.0);
export const SUPPORT_L = (() => {
  const L = V(0, -0.55, 0.85).normalize(), P = V(-1, 0, 0);
  const T = new THREE.Vector3().crossVectors(P, L);   // left hand: thumb = palm x long
  return { pos: V(0.034, -0.03, 0.012), quat: handAxesQuat(L, P, T, HAND_L_AXES.long, HAND_L_AXES.palm, HAND_L_AXES.thumb) };
})();
export const MUZZLE_LOCAL = V(0, 0.062, 0.142);          // in the gun frame
export const GRENADE_LOCAL = V(0.082, -0.06, 0.0);       // grenade centre in left-wrist space (under the palm)

// --- palettes -----------------------------------------------------------------------------------------------------------
// sRGB hex; converted to linear for the vertex colour attribute. Original mannequin look: no faces, no signature gear.
export const PALETTES = {
  player: {
    skin: 0xb4a28c, jacket: 0x3f6d69, jacketDark: 0x2c4d4a, shirt: 0x3a5f5c, trousers: 0x383b40,
    belt: 0x1f1f21, boots: 0x2f2822, sole: 0x1a1816, vest: null, cap: null,
  },
  enemy: {
    skin: 0xa8957e, jacket: 0xb09e74, jacketDark: 0x8d7d58, shirt: 0xa69568, trousers: 0xa3936a,
    belt: 0x2a271f, boots: 0x3b3127, sole: 0x1c1915, vest: 0x3a3c33, cap: 0x46453a,
  },
};
const GUN_COLORS = { slide: 0x2a2c30, frame: 0x575043, grip: 0x3b362d, sight: 0xb8b0a0 };

// --- skeleton ----------------------------------------------------------------------------------------------------------
export function buildBones() {
  const list = JOINTS.map((name, i) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.copy(OFFSETS[i]);
    return b;
  });
  for (let i = 1; i < 22; i++) list[PARENTS[i]].add(list[i]);
  const bones = {};
  JOINTS.forEach((n, i) => { bones[n] = list[i]; });
  return { list, bones };
}

// --- mesh building: append transformed primitive geometries, each rigidly bound to one bone ------------------------------
class Builder {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.skin = []; this.idx = []; this.n = 0; }
  // geo: non-skinned BufferGeometry already in rest root space.
  add(geo, bone, hex, shade = 1) {
    const c = new THREE.Color(hex).multiplyScalar(shade);
    const p = geo.attributes.position, nr = geo.attributes.normal;
    const base = this.n;
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      this.nrm.push(nr.getX(i), nr.getY(i), nr.getZ(i));
      this.col.push(c.r, c.g, c.b);
      this.skin.push(bone);
    }
    if (geo.index) for (let i = 0; i < geo.index.count; i++) this.idx.push(base + geo.index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    this.n += p.count;
    geo.dispose();
  }
  build(skinned = true) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (skinned) {
      const si = new Uint16Array(this.n * 4), sw = new Float32Array(this.n * 4);
      for (let i = 0; i < this.n; i++) { si[i * 4] = this.skin[i]; sw[i * 4] = 1; }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    }
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _x = new THREE.Vector3();
const _y = new THREE.Vector3(), _z = new THREE.Vector3();

// Orient a geometry whose long axis is +Y so that +Y runs along dir, with its +X as close as possible to `side`.
function orient(geo, from, to, side = V(1, 0, 0), along = 0) {
  _y.subVectors(to, from).normalize();
  _x.copy(side).addScaledVector(_y, -side.dot(_y));
  if (_x.lengthSq() < 1e-6) _x.set(0, 0, 1).addScaledVector(_y, -_y.z);
  _x.normalize();
  _z.crossVectors(_x, _y);
  _m.makeBasis(_x, _y, _z).setPosition(from.x + _y.x * along, from.y + _y.y * along, from.z + _y.z * along);
  geo.applyMatrix4(_m);
  return geo;
}

// Tapered capsule from a to b, radius r1 at a and r2 at b; sx/sz scale the cross-section (ellipse), side orients sx.
function taper(a, b, r1, r2, { sx = 1, sz = 1, side, seg = 14, extendA = 0, extendB = 0 } = {}) {
  const L = a.distanceTo(b) + extendA + extendB;
  const pts = [];
  const N = 5;
  for (let i = 0; i <= N; i++) { const t = -Math.PI / 2 + (i / N) * Math.PI / 2; pts.push(new THREE.Vector2(Math.max(1e-4, r1 * Math.cos(t)), r1 * Math.sin(t))); }
  for (let i = 0; i <= N; i++) { const t = (i / N) * Math.PI / 2; pts.push(new THREE.Vector2(Math.max(1e-4, r2 * Math.cos(t)), L + r2 * Math.sin(t))); }
  const g = new THREE.LatheGeometry(pts, seg);
  g.scale(sx, 1, sz);
  g.translate(0, -extendA, 0);
  return orient(g, a, b, side || V(1, 0, 0));
}

function rbox(center, size, { radius = 0.03, rot = null, seg = 3 } = {}) {
  const g = new RoundedBoxGeometry(size[0], size[1], size[2], seg, Math.min(radius, Math.min(...size) / 2 - 1e-4));
  if (rot) g.applyQuaternion(rot);
  g.translate(center.x, center.y, center.z);
  return g;
}

function ellipsoid(center, rx, ry, rz, rot = null, w = 18, h = 12) {
  const g = new THREE.SphereGeometry(1, w, h);
  g.scale(rx, ry, rz);
  if (rot) g.applyQuaternion(rot);
  g.translate(center.x, center.y, center.z);
  return g;
}

const R = (n) => REST[J[n]];
const eul = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));

// Small deterministic RNG for per-character palette variation.
function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function buildMannequinGeometry(paletteName = 'player', seed = 1) {
  const pal = PALETTES[paletteName] || PALETTES.player;
  const r = rng(seed * 7919 + 13);
  const vary = paletteName === 'enemy' ? () => 0.9 + r() * 0.2 : () => 1;
  const sk = vary(), jk = vary(), tr = vary();
  const b = new Builder();
  const add = (geo, joint, hex, shade = 1) => b.add(geo, J[joint], hex, shade);

  // Pelvis / hips (trousers) + belt.
  const pel = R('pelvis');
  add(rbox(V(0, pel.y - 0.045, -0.012), [0.33, 0.19, 0.205], { radius: 0.07 }), 'pelvis', pal.trousers, tr);
  add(rbox(V(0, pel.y + 0.06, -0.012), [0.315, 0.05, 0.2], { radius: 0.022 }), 'pelvis', pal.belt);
  // Buckle (small, reads as "front").
  add(rbox(V(0, pel.y + 0.06, 0.09), [0.045, 0.034, 0.014], { radius: 0.005 }), 'pelvis', pal.jacketDark, 0.8);

  // Torso: lower abdomen (spine1), upper abdomen (spine2), chest (spine3). Athletic V taper.
  const s1 = R('spine1'), s2 = R('spine2'), s3 = R('spine3'), nk = R('neck');
  add(rbox(V(0, s1.y + 0.03, 0.0), [0.29, 0.17, 0.19], { radius: 0.07 }), 'spine1', pal.shirt, jk);
  add(rbox(V(0, s2.y + 0.0, 0.012), [0.31, 0.15, 0.205], { radius: 0.07 }), 'spine2', pal.jacket, jk);
  add(rbox(V(0, s3.y + 0.1, 0.0), [0.37, 0.25, 0.225], { radius: 0.085 }), 'spine3', pal.jacket, jk);
  // Pecs / upper-back block widening to the shoulders.
  add(rbox(V(0, s3.y + 0.175, -0.012), [0.42, 0.11, 0.2], { radius: 0.05 }), 'spine3', pal.jacket, jk);
  // Jacket collar ring.
  add(taper(V(0, nk.y - 0.03, nk.z - 0.005), V(0, nk.y + 0.03, nk.z + 0.012), 0.072, 0.066, { sz: 0.95 }), 'spine3', pal.jacketDark, jk);
  if (pal.vest) {
    add(rbox(V(0, s3.y + 0.06, 0.006), [0.375, 0.3, 0.25], { radius: 0.06 }), 'spine3', pal.vest, vary());
    // Pouches on the vest front.
    for (const x of [-0.09, 0, 0.09]) add(rbox(V(x, s3.y - 0.03, 0.13), [0.07, 0.08, 0.04], { radius: 0.012 }), 'spine3', pal.vest, 0.8);
    add(rbox(V(0, s2.y - 0.01, 0.01), [0.33, 0.12, 0.225], { radius: 0.05 }), 'spine2', pal.vest, 0.92);
  } else {
    // Jacket front zip line + hem (player).
    add(rbox(V(0, s2.y + 0.05, 0.115), [0.012, 0.3, 0.01], { radius: 0.004 }), 'spine2', pal.jacketDark, 0.8);
    add(rbox(V(0, s1.y - 0.035, 0.0), [0.305, 0.06, 0.205], { radius: 0.025 }), 'spine1', pal.jacket, jk);
  }

  // Neck + head (featureless mannequin head with a jaw block so facing reads) + optional cap.
  const hd = R('head');
  add(taper(V(0, nk.y - 0.01, nk.z + 0.005), V(0, hd.y + 0.02, hd.z - 0.005), 0.052, 0.048), 'neck', pal.skin, sk);
  const hc = V(0, hd.y + 0.075, hd.z + 0.018);
  add(ellipsoid(hc, 0.084, 0.104, 0.097), 'head', pal.skin, sk);
  add(rbox(V(0, hd.y + 0.025, hd.z + 0.058), [0.088, 0.05, 0.06], { radius: 0.024 }), 'head', pal.skin, sk * 0.97);
  // Brow band: marks the eye line (and so the facing) without a face.
  add(rbox(V(0, hd.y + 0.092, hd.z + 0.098), [0.13, 0.018, 0.024], { radius: 0.008 }), 'head', pal.skin, sk * 0.88);
  if (pal.cap) {
    const dome = new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.52);
    dome.scale(0.092, 0.09, 0.104);
    dome.translate(hc.x, hc.y + 0.028, hc.z - 0.004);
    add(dome, 'head', pal.cap);
    add(rbox(V(0, hc.y + 0.02, hc.z + 0.12), [0.15, 0.012, 0.085], { radius: 0.005, rot: eul(0.12, 0, 0) }), 'head', pal.cap, 0.85);
  }

  // Arms: collar (trapezius), deltoid + upper arm, forearm, hand.
  for (const side of [1, -1]) {
    const L = side > 0 ? 'left_' : 'right_';
    const col = R(L + 'collar'), sh = R(L + 'shoulder'), el = R(L + 'elbow'), wr = R(L + 'wrist');
    add(taper(V(side * 0.03, col.y + 0.03, col.z - 0.005), V(sh.x * 0.92, sh.y + 0.025, sh.z), 0.062, 0.06, { sz: 0.9 }), L + 'collar', pal.jacket, jk);
    add(ellipsoid(V(sh.x + side * 0.012, sh.y + 0.008, sh.z), 0.078, 0.07, 0.072), L + 'shoulder', pal.jacket, jk);
    add(taper(sh, el, 0.06, 0.046, { sz: 0.94, extendB: -0.01 }), L + 'shoulder', pal.jacket, jk);
    add(taper(el, wr, 0.047, 0.036, { sz: 0.9, side: V(0, 0, 1), extendA: 0.0, extendB: -0.03 }), L + 'elbow', pal.jacket, jk);
    // Cuff.
    add(taper(V(wr.x - side * 0.05, wr.y, wr.z), V(wr.x - side * 0.005, wr.y, wr.z), 0.041, 0.04), L + 'elbow', pal.jacketDark, jk);
    // Hand: palm block, fingers (curled for the right/gun hand, half-open for the left), thumb.
    const ax = side; // long axis sign
    add(rbox(V(wr.x + ax * 0.06, wr.y - 0.006, wr.z), [0.1, 0.036, 0.086], { radius: 0.016 }), L + 'wrist', pal.skin, sk);
    if (side < 0) {
      add(rbox(V(wr.x + ax * 0.112, wr.y - 0.03, wr.z + 0.002), [0.036, 0.062, 0.082], { radius: 0.016 }), L + 'wrist', pal.skin, sk * 0.96);
    } else {
      add(rbox(V(wr.x + ax * 0.125, wr.y - 0.018, wr.z), [0.06, 0.03, 0.08], { radius: 0.013, rot: eul(0, 0, -0.5) }), L + 'wrist', pal.skin, sk * 0.96);
    }
    add(taper(V(wr.x + ax * 0.03, wr.y - 0.012, wr.z + 0.04), V(wr.x + ax * 0.085, wr.y - 0.004, wr.z + 0.064), 0.017, 0.014, { seg: 8 }), L + 'wrist', pal.skin, sk * 0.98);
  }

  // Legs: thigh, knee, shin with boot shaft, foot (boot), toes.
  for (const side of [1, -1]) {
    const L = side > 0 ? 'left_' : 'right_';
    const hp = R(L + 'hip'), kn = R(L + 'knee'), an = R(L + 'ankle'), ft = R(L + 'foot');
    add(taper(V(hp.x + side * 0.018, hp.y + 0.02, hp.z), kn, 0.08, 0.06, { sz: 1.08, extendB: 0.0 }), L + 'hip', pal.trousers, tr);
    add(taper(kn, an, 0.062, 0.043, { sz: 1.06, side: V(1, 0, 0), extendA: 0.0, extendB: -0.06 }), L + 'knee', pal.trousers, tr);
    // Calf bulge.
    add(ellipsoid(V(kn.x, kn.y - 0.12, kn.z - 0.022), 0.055, 0.11, 0.058), L + 'knee', pal.trousers, tr * 0.98);
    // Boot shaft on the lower shin.
    add(taper(V(an.x, an.y + 0.13, an.z - 0.004), V(an.x, an.y + 0.0, an.z - 0.004), 0.052, 0.05), L + 'knee', pal.boots);
    // Boot: from the heel to the ball, sole at y = 0.
    const heelZ = an.z - 0.072, ballZ = ft.z;
    add(rbox(V(an.x + side * 0.004, 0.045, (heelZ + ballZ) / 2), [0.098, 0.09, ballZ - heelZ + 0.02], { radius: 0.035 }), L + 'ankle', pal.boots);
    add(rbox(V(an.x + side * 0.004, 0.009, (heelZ + ballZ) / 2), [0.102, 0.018, ballZ - heelZ + 0.024], { radius: 0.008 }), L + 'ankle', pal.sole);
    // Toe cap.
    add(rbox(V(ft.x - side * 0.006, 0.03, ft.z + 0.045), [0.095, 0.06, 0.095], { radius: 0.03 }), L + 'foot', pal.boots);
    add(rbox(V(ft.x - side * 0.006, 0.007, ft.z + 0.045), [0.099, 0.014, 0.099], { radius: 0.006 }), L + 'foot', pal.sole);
  }
  return b.build(true);
}

// Pistol geometry in the gun frame (origin = grip centre where the palm closes, +Z barrel, +Y up). Original design:
// squared slide with front serrations, tan polymer frame, raked grip.
export function buildPistolGeometry() {
  const b = new Builder();
  const slideY = 0.061;
  b.add(rbox(V(0, slideY, 0.044), [0.029, 0.033, 0.196], { radius: 0.006 }), 0, GUN_COLORS.slide);
  for (let i = 0; i < 4; i++) b.add(rbox(V(0, slideY + 0.004, -0.04 + i * 0.008), [0.031, 0.022, 0.003], { radius: 0.001, seg: 1 }), 0, GUN_COLORS.slide, 0.7);
  b.add(rbox(V(0, slideY - 0.027, 0.05), [0.027, 0.022, 0.16], { radius: 0.006 }), 0, GUN_COLORS.frame);
  // Grip raked ~17 deg (bottom further back).
  b.add(rbox(V(0, -0.008, -0.022), [0.03, 0.112, 0.048], { radius: 0.01, rot: eul(-0.3, 0, 0) }), 0, GUN_COLORS.grip);
  // Trigger guard + trigger.
  b.add(rbox(V(0, 0.012, 0.045), [0.014, 0.008, 0.05], { radius: 0.003, seg: 1 }), 0, GUN_COLORS.frame);
  b.add(rbox(V(0, 0.024, 0.07), [0.014, 0.024, 0.008], { radius: 0.003, seg: 1 }), 0, GUN_COLORS.frame);
  b.add(rbox(V(0, 0.027, 0.03), [0.006, 0.02, 0.006], { radius: 0.002, seg: 1 }), 0, GUN_COLORS.slide);
  // Sights.
  b.add(rbox(V(0, slideY + 0.02, 0.135), [0.006, 0.008, 0.008], { radius: 0.002, seg: 1 }), 0, GUN_COLORS.sight);
  b.add(rbox(V(0, slideY + 0.02, -0.045), [0.022, 0.008, 0.008], { radius: 0.002, seg: 1 }), 0, GUN_COLORS.slide);
  // Muzzle face (darker).
  b.add(rbox(V(0, slideY, 0.142), [0.02, 0.02, 0.004], { radius: 0.002, seg: 1 }), 0, 0x0c0c0d);
  return b.build(false);
}

export function buildMagGeometry() {
  const b = new Builder();
  b.add(rbox(V(0, 0, 0), [0.024, 0.1, 0.034], { radius: 0.005 }), 0, 0x2a2b2e);
  b.add(rbox(V(0, -0.052, 0.0), [0.03, 0.012, 0.04], { radius: 0.004 }), 0, GUN_COLORS.frame);
  return b.build(false);
}

let _sharedMats = null;
function materials() {
  if (_sharedMats) return _sharedMats;
  _sharedMats = {
    body: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.0 }),
    gun: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.35 }),
  };
  return _sharedMats;
}

const _geoCache = new Map();
// Builds the full rig object tree (no animation): {root, bones, list, mesh, gun, mag, sockets}.
export function buildRig({ palette = 'player', seed = 1, castShadow = true, throwHand = 'left' } = {}) {
  const root = new THREE.Object3D();
  root.name = `character-${palette}-${seed}`;
  const { list, bones } = buildBones();
  root.add(list[0]);

  const key = palette === 'enemy' ? `enemy-${seed % 997}` : palette;
  let geo = _geoCache.get(key);
  if (!geo) { geo = buildMannequinGeometry(palette, seed); _geoCache.set(key, geo); }
  const mats = materials();
  const mesh = new THREE.SkinnedMesh(geo, mats.body);
  mesh.name = 'mannequin';
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;           // the bind-pose bounds don't cover a hanging / lying / rolling body
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(list));

  // Sockets.
  const sockets = {};
  const hand_r = new THREE.Object3D(); hand_r.name = 'hand_r';
  hand_r.position.copy(GRIP_R.pos); hand_r.quaternion.copy(GRIP_R.quat);
  bones.right_wrist.add(hand_r);
  const hand_l = new THREE.Object3D(); hand_l.name = 'hand_l';
  hand_l.position.copy(PALM_L);
  bones.left_wrist.add(hand_l);
  const head = new THREE.Object3D(); head.name = 'head';
  head.position.set(0, 0.075, 0.018);
  bones.head.add(head);
  const grenade_hand = new THREE.Object3D(); grenade_hand.name = 'grenade_hand';
  (throwHand === 'right' ? bones.right_wrist : bones.left_wrist).add(grenade_hand);
  grenade_hand.position.set(throwHand === 'right' ? -GRENADE_LOCAL.x : GRENADE_LOCAL.x, GRENADE_LOCAL.y, GRENADE_LOCAL.z);

  let gunGeo = _geoCache.get('pistol');
  if (!gunGeo) { gunGeo = buildPistolGeometry(); _geoCache.set('pistol', gunGeo); }
  const gun = new THREE.Mesh(gunGeo, mats.gun);
  gun.name = 'pistol';
  gun.castShadow = castShadow;
  hand_r.add(gun);
  const muzzle = new THREE.Object3D(); muzzle.name = 'muzzle';
  muzzle.position.copy(MUZZLE_LOCAL);
  gun.add(muzzle);

  let magGeo = _geoCache.get('mag');
  if (!magGeo) { magGeo = buildMagGeometry(); _geoCache.set('mag', magGeo); }
  const mag = new THREE.Mesh(magGeo, mats.gun);
  mag.name = 'mag';
  mag.visible = false;
  mag.castShadow = castShadow;
  // Held with its base against the left palm and its feed lips pointing out of the palm (wrist -Y), so with the palm
  // facing up under the grip it slides straight into the magwell.
  mag.position.set(0.08, -0.085, 0.0);
  mag.quaternion.setFromEuler(new THREE.Euler(Math.PI, 0, 0));
  bones.left_wrist.add(mag);

  Object.assign(sockets, { hand_r, hand_l, muzzle, head, grenade_hand });
  return { root, bones, list, mesh, gun, mag, sockets };
}
