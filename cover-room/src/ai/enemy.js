// createEnemy(game, spawn) -> actor (team 'enemy'). The Actor shape is design.md's; the AI state lives in actor.ai
// (see brain.js) and the animator reads actor.anim. Pieces come from the other modules when they exist, else from
// ai/stubs.js: the 'enemy' palette rig (createCharacter), the rifle (createWeapon), hitboxes on the rig's bones.
import { Brain } from './brain.js';
import { createStubRig, createStubWeapon, STUB_HITBOXES } from './stubs.js';

let _nextId = 1;

// Finds a function exported by any loaded module (main.js keeps every namespace in game.modules).
export function findExport(game, name) {
  if (typeof game[name] === 'function') return game[name];
  const mods = game.modules || {};
  for (const k in mods) if (mods[k] && typeof mods[k][name] === 'function') return mods[k][name];
  return null;
}

// SMPL-22 hitbox capsules in bone space (rest frames equal the root frame, character/skeleton.js), [ASSUMED] radii.
export function smplHitboxes(OFFSETS, J) {
  const off = (name) => { const o = OFFSETS && J ? OFFSETS[J[name]] : null; return o ? [o.x, o.y, o.z] : null; };
  const seg = (bone, child, r, part, fallback) => ({ bone, a: [0, 0, 0], b: off(child) || fallback, radius: r, part });
  return [
    { bone: 'pelvis', a: [0, -0.02, 0], b: [0, 0.22, 0], radius: 0.16, part: 'torso' },
    { bone: 'spine3', a: [0, -0.08, 0], b: [0, 0.16, 0], radius: 0.17, part: 'torso' },
    { bone: 'head', a: [0, -0.02, 0.01], b: [0, 0.12, 0.02], radius: 0.11, part: 'head' },
    seg('left_hip', 'left_knee', 0.085, 'limb', [0.04, -0.43, 0]), seg('right_hip', 'right_knee', 0.085, 'limb', [-0.04, -0.43, 0]),
    seg('left_knee', 'left_ankle', 0.07, 'limb', [0, -0.43, -0.03]), seg('right_knee', 'right_ankle', 0.07, 'limb', [0, -0.43, -0.03]),
    seg('left_shoulder', 'left_elbow', 0.06, 'limb', [0.27, 0, 0]), seg('right_shoulder', 'right_elbow', 0.06, 'limb', [-0.27, 0, 0]),
    seg('left_elbow', 'left_wrist', 0.05, 'limb', [0.26, 0, 0]), seg('right_elbow', 'right_wrist', 0.05, 'limb', [-0.26, 0, 0]),
  ];
}

export function createEnemy(game, spawn, opts = {}) {
  const P = opts.P || ((k) => game.params.get(k));
  const V = game.world.Vector3;
  const index = opts.index ?? 0;
  const pos = new V(spawn.pos.x ?? spawn.pos[0], spawn.pos.y ?? spawn.pos[1] ?? 0, spawn.pos.z ?? spawn.pos[2]);
  const actor = {
    id: `enemy${_nextId++}`, team: 'enemy', pos, vel: new V(), yaw: spawn.yaw || 0, height: 1.8, radius: 0.35,
    health: P('ai.health'), maxHealth: P('ai.health'), alive: true, rig: null, hitboxes: null, weapon: null,
    weaponKind: P('ai.shoot.weapon'), state: {},
    anim: {
      mode: 'locomotion', speed: 0, localVel: { x: 0, z: 0 }, turnRate: 0,
      aim: { on: false, yaw: 0, pitch: 0, weight: 0 }, fireT: 99, action: null,
      cover: { height: 'low', side: 1, pose: 'idle', t: 0, top: 1 },
      hit: { dir: null, part: 'torso', t: 0 }, death: { dir: null, t: 0 },
    },
  };
  actor.animState = actor.anim;

  // rig: the real mannequin if a character module provides createCharacter, else the stub
  const createCharacter = opts.createCharacter || findExport(game, 'createCharacter');
  let parts = null;
  if (createCharacter && opts.rig !== 'stub') {
    try {
      actor.rig = createCharacter(game, { palette: 'enemy', seed: 11 + index * 7 });
      const sk = game.modules && game.modules.skeleton;
      parts = actor.rig.hitboxParts || (sk && sk.HITBOXES) || smplHitboxes(sk && sk.OFFSETS, sk && sk.J);
    } catch (err) {
      console.warn('[ai] createCharacter failed, using the stub rig:', err && err.message);
      actor.rig = null;
    }
  }
  if (!actor.rig) { actor.rig = createStubRig(game, { seed: index }); parts = STUB_HITBOXES; actor.rig.ownUpdate = true; }
  if (actor.rig.root) {
    actor.rig.root.position.set(pos.x, pos.y, pos.z);
    actor.rig.root.rotation.set(0, actor.yaw, 0);
    if (game.scene && !actor.rig.root.parent) game.scene.add(actor.rig.root);
    actor.rig.root.updateMatrixWorld(true);
  }
  if (game.world && game.world.addHitboxes) game.world.addHitboxes(actor, parts);

  // spawn role hints from the level (room.js: 'hold' | 'overwatch' | 'flank'); overwatch holds a hard point there
  if (spawn.role === 'engager' || spawn.role === 'ambusher' || spawn.role === 'defender') actor.pinRole = spawn.role;
  if (spawn.role === 'overwatch') actor.pinRole = 'defender';

  const brain = new Brain(game, actor, opts.director, P, index);
  actor.ai.pin = actor.pinRole || null;
  // weapons' applyDamage calls this. Accepts takeDamage(payload) (weapons/weapon.js) and takeDamage(amount, info).
  const _dmg = { amount: 0, part: 'torso', dir: null, source: null, kind: 'bullet' };
  actor.takeDamage = (a, info) => {
    if (typeof a === 'number') { Object.assign(_dmg, { part: 'torso', dir: null, source: null, kind: 'bullet' }, info || {}); _dmg.amount = a; a = _dmg; }
    brain.takeDamage(a);
  };

  // weapon: weapons/* createWeapon (rifle), else the stub. Rounds leave from the post's pop-up/lean point while in cover
  // so the line of fire matches what the AI checked, whatever pose the animator has reached.
  const muzzle = (out) => brain.muzzle(out);
  const createWeapon = opts.createWeapon || findExport(game, 'createWeapon');
  try {
    actor.weapon = createWeapon ? createWeapon(game, actor, actor.weaponKind, { muzzle }) : createStubWeapon(game, actor, actor.weaponKind, P, muzzle);
  } catch (err) {
    console.warn('[ai] createWeapon failed, using the stub weapon:', err && err.message);
    actor.weapon = createStubWeapon(game, actor, actor.weaponKind, P, muzzle);
  }
  return actor;
}
