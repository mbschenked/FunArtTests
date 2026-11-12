// character/index.js: createCharacter(game, opts) -> rig. Contract: refs/design.md "character/*: rig". Owner: A4.
//
//   const rig = createCharacter(game, {palette: 'player'|'enemy', seed, castShadow = true, scene?})
//   rig.root                 Object3D at the actor's feet; the animation system sets position + rotation.y (yaw)
//   rig.bones[name]          THREE.Bone per SMPL-22 joint (JOINTS order); rig.list = the same in index order
//   rig.getBoneWorld(name, out) / rig.getBoneWorldQuat(name, out)   world transforms (valid after rig.update)
//   rig.socket('hand_r'|'hand_l'|'muzzle'|'head'|'grenade_hand') -> Object3D
//   rig.update(dt, animState)  pose + refresh world matrices (the animation system in animator.js calls this)
//   rig.animator.sources[mode] = clipPlayer    mocap override hook (character/clips.js, later)
//   rig.mesh (SkinnedMesh), rig.gun (pistol Mesh), rig.mag (reload magazine, toggled by the animator)
//   rig.setVisible(bool), rig.dispose()
// One draw call for the body + one for the pistol (+ shadow passes). Geometry and materials are shared and cached.
import { buildRig, JOINTS, J, PARENTS, REST, OFFSETS, HEIGHT } from './skeleton.js';
import { Animator, defineAnimParams, MODES } from './animator.js';

export function createCharacter(game, opts = {}) {
  const { palette = 'player', seed = 1, castShadow = true } = opts;
  const params = game && game.params;
  let throwHand = opts.throwHand;
  if (!throwHand && params) {
    defineAnimParams(params);
    try { throwHand = params.get('anim.throw.hand'); } catch { throwHand = 'left'; }
  }
  const parts = buildRig({ palette, seed, castShadow, throwHand: throwHand === 'right' ? 'right' : 'left' });
  const { root, bones, list, mesh, gun, mag, sockets } = parts;

  const rig = {
    root, bones, list, mesh, gun, mag, sockets, palette, seed,
    animator: null,
    autoUpdate: true,      // false: the animation system skips this rig (a caller drives rig.update itself)
    socket(name) { return sockets[name] || null; },
    getBoneWorld(name, out) {
      const b = bones[name];
      return b ? out.setFromMatrixPosition(b.matrixWorld) : out;
    },
    getBoneWorldQuat(name, out) {
      const b = bones[name];
      return b ? out.setFromRotationMatrix(b.matrixWorld) : out;
    },
    update(dt, animState) {
      rig.animator.update(dt, animState);
      root.updateMatrixWorld(true);
    },
    setVisible(v) { root.visible = !!v; },
    dispose() { if (root.parent) root.parent.remove(root); mesh.skeleton.dispose(); },
  };
  rig.animator = new Animator(game, rig);
  if (opts.scene) opts.scene.add(root);
  return rig;
}

export { JOINTS, J, PARENTS, REST, OFFSETS, HEIGHT, MODES };
