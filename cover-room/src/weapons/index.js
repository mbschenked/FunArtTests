// Weapons module boot (B2). main.js calls install(game). Logic lives in weapon.js and grenades.js (node-testable, no
// 'three'); this file adds the systems, the player's input driver and the three.js views (arc preview, live grenades).
//
//   install(game) -> game.weapons = {create(owner, kind, overrides), list}
//     - game.grenades (createGrenades), system 'grenades' at ORDER.projectiles
//     - system 'weapons' (ORDER.weapons): weapon.update(dt) for every weapon in game.weapons.list (idempotent per step)
//     - system 'weapons.input' (ORDER.weapons - 1): gives game.player its pistol (player.weapon) as soon as the player
//       exists, and maps game.input to it (aim, fire, reload, grenade hold/release, cover cancels the arc) ONLY when no
//       player controller drives them: weapon.player.autoInput 'auto' (default) stands down as soon as game.player.ctrl
//       is B1's controller (it has setMode/registerMode or grenadeAiming), whose weaponsStep gates fire on cover
//       pop-up timing. 'on' forces this driver, 'off' disables it. Test pages without a controller rely on 'auto'.
//     - system 'weapons.view' (frame, ORDER.vfx): the arc preview (dotted line + landing ring) and live grenades (red
//       glow that pulses faster as the fuse runs down). Pooled geometry, no allocation per frame.
import * as THREE from 'three';
import { ORDER } from '../core/game.js';
import { createWeapon, defineWeaponParams, applyDamage } from './weapon.js';
import { createGrenades, blastFalloff, solveLob, easeInOut } from './grenades.js';

export { createWeapon, createGrenades, applyDamage, blastFalloff, solveLob, easeInOut };

const VIEW_PARAMS = [
  ['weapon.player.autoInput', 'auto', { options: ['auto', 'on', 'off'], label: 'weapons read player input' }], // [ASSUMED] see header
  ['weapon.player.rollCancelsReload', true, { label: 'roll cancels reload' }],             // player-spec §5 rule (open question 7)
  ['grenade.preview.line', true, { label: 'arc line' }],                                   // §6 [MEASURED F4 (yt-workaround), MP] thin white line
  ['grenade.preview.dots', true, { label: 'arc dots' }],                                   // [ASSUMED] our own look: beads along the line
  ['grenade.preview.dotSpacing', 0.45, { min: 0.1, max: 2, step: 0.05, label: 'dot spacing (m)' }], // [ASSUMED]
  ['grenade.preview.dotSize', 6, { min: 1, max: 20, step: 0.5, label: 'dot size (px)' }],  // [ASSUMED]
  ['grenade.preview.flow', 0.9, { min: 0, max: 5, step: 0.05, label: 'dot flow (m/s)' }],  // [ASSUMED] subtle drift toward the landing
  ['grenade.preview.ringRadius', 0.2, { min: 0.05, max: 1, step: 0.01, label: 'landing ring (m)' }], // §6 [MEASURED F4 (yt-workaround)] small ring
  ['grenade.preview.blastRing', true, { label: 'show blast radius' }],                     // Max 11 Nov: "radius around the land point so i know where it will damage" (not in U4)
  ['grenade.preview.blastColor', '#ff5a36', { label: 'blast radius colour' }],             // [ASSUMED] our own look
  ['grenade.preview.blastFill', 0.13, { min: 0, max: 0.6, step: 0.01, label: 'blast fill opacity' }],   // [ASSUMED]
  ['grenade.preview.blastEdge', 0.75, { min: 0, max: 1, step: 0.05, label: 'blast edge opacity' }],     // [ASSUMED]
  ['grenade.preview.color', '#f6f3ec', { label: 'arc colour' }],                           // §6 [MEASURED F4 (yt-workaround)] white
  ['grenade.preview.opacity', 0.9, { min: 0.1, max: 1, step: 0.05, label: 'arc opacity' }], // [ASSUMED]
  ['grenade.view.glowSize', 0.5, { min: 0, max: 2, step: 0.05, label: 'red glow size (m)' }], // §6 [WIKI] red glow; size [ASSUMED]
  ['grenade.view.beepSlow', 0.6, { min: 0.05, max: 2, step: 0.05, label: 'glow pulse at fuse start (s)' }], // §6 beeping speeds up [WIKI]; values [ASSUMED]
  ['grenade.view.beepFast', 0.12, { min: 0.03, max: 1, step: 0.01, label: 'glow pulse at the end (s)' }],   // [ASSUMED]
];

export function install(game) {
  defineWeaponParams(game.params);
  for (const [k, v, o] of VIEW_PARAMS) game.params.define(k, v, o);
  const weapons = game.weapons && Array.isArray(game.weapons.list) ? game.weapons : { list: [] };
  weapons.create = (owner, kind, overrides) => createWeapon(game, owner, kind, overrides);
  game.weapons = weapons;
  if (!game.grenades) createGrenades(game);

  game.addSystem({ name: 'weapons.input', order: ORDER.weapons - 1, update: (dt) => drivePlayer(game, dt) });
  game.addSystem({
    name: 'weapons', order: ORDER.weapons,
    update: (dt) => { const l = weapons.list; for (let i = 0; i < l.length; i++) l[i].update(dt); },
  });
  if (game.scene) {
    const view = createView(game);
    weapons.view = view;
    game.addSystem({ name: 'weapons.view', order: ORDER.vfx, frame: (realDt, g) => view.frame(g.paused ? 0 : realDt * (g.timeScale ?? 1)) });
  }
  ensurePlayerWeapon(game);
  return weapons;
}

export function ensurePlayerWeapon(game) {
  const pl = game.player;
  if (pl && !pl.weapon) pl.weapon = createWeapon(game, pl, 'pistol');
  return pl ? pl.weapon : null;
}

// Input -> pistol + grenades for game.player (player-spec §1, §5, §6).
const BLOCKING_MODES = new Set(['roll', 'mantle', 'dead']);
let lookScaled = false;
function drivePlayer(game) {
  const pl = ensurePlayerWeapon(game) && game.player;
  if (!pl) return;
  const mode0 = game.params.get('weapon.player.autoInput');
  if (mode0 === 'off' || mode0 === false) return;
  const c = pl.ctrl;
  if (mode0 === 'auto' && c && (typeof c.setMode === 'function' || typeof c.registerMode === 'function' || 'grenadeAiming' in c)) return;
  const inp = game.input;
  if (!inp || typeof inp.down !== 'function') return;
  const w = pl.weapon, gr = game.grenades;
  const mode = pl.ctrl && pl.ctrl.mode;
  const blocked = pl.alive === false || BLOCKING_MODES.has(mode);

  if (mode === 'roll' && w.state.reloading && game.params.get('weapon.player.rollCancelsReload')) w.cancelReload();

  // grenade: hold to aim, release to throw, cover cancels
  if (gr) {
    if (inp.pressed('grenade') && !blocked) gr.beginAim(pl);
    if (gr.isAiming(pl)) {
      if (blocked || inp.pressed('cover')) gr.cancel(pl);
      else if (!inp.down('grenade')) gr.release(pl);
      else gr.updateAim(pl);
    }
  }
  const grenadeBusy = gr ? gr.stateOf(pl).phase !== 'none' : false;
  // slower look while the arc is up (player-spec §6 grenade.aimLookScale); only written on a change, so other writers
  // of cameraRig.lookScale are not stomped every step
  const rig = game.cameraRig;
  if (rig && 'lookScale' in rig && gr) {
    const aimingNow = gr.isAiming(pl);
    if (aimingNow !== lookScaled) { rig.lookScale = aimingNow ? gr.lookScale(pl) : 1; lookScaled = aimingNow; }
  }

  const aim = inp.down('aim') && !grenadeBusy;
  w.setAim(aim);
  w.setBlind(mode === 'cover' && !aim);
  w.setTrigger(inp.down('fire') && !blocked && !grenadeBusy);
  if (inp.pressed('reload') && !blocked) w.reload();
}

// ------------------------------------------------------------------------------------------------ views
function dotTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0.0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,1)');
  grd.addColorStop(0.6, 'rgba(20,20,20,0.55)');      // a dark rim so the beads read on bright stone
  grd.addColorStop(1.0, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function glowTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.2, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

const MAX_DOTS = 160;
const LIVE_MESHES = 16;

export function createView(game) {
  const P = (k) => game.params.get(k);
  const gr = game.grenades;
  const root = new THREE.Group();
  root.name = 'weapons.view';
  game.scene.add(root);

  // --- arc line: draws straight from the preview's own buffer (zero copy)
  const pv = gr.preview;
  const lineGeo = new THREE.BufferGeometry();
  const lineAttr = new THREE.BufferAttribute(pv.points, 3);
  lineAttr.setUsage(THREE.DynamicDrawUsage);
  lineGeo.setAttribute('position', lineAttr);
  lineGeo.setDrawRange(0, 0);
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false });
  const line = new THREE.Line(lineGeo, lineMat);
  line.frustumCulled = false; line.renderOrder = 20;
  root.add(line);

  // --- dots along the arc
  const dotPos = new Float32Array(MAX_DOTS * 3);
  const dotGeo = new THREE.BufferGeometry();
  const dotAttr = new THREE.BufferAttribute(dotPos, 3);
  dotAttr.setUsage(THREE.DynamicDrawUsage);
  dotGeo.setAttribute('position', dotAttr);
  dotGeo.setDrawRange(0, 0);
  const dotMat = new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, map: dotTexture(), transparent: true,
    depthWrite: false, alphaTest: 0.02 });
  const dots = new THREE.Points(dotGeo, dotMat);
  dots.frustumCulled = false; dots.renderOrder = 21;
  root.add(dots);

  // --- landing ring (white ring over a dark one, plus a centre pip), oriented to the contact normal
  const ring = new THREE.Group();
  const ringMatW = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false,
    side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const ringMatD = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false,
    side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const ringW = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.0, 48), ringMatW);
  const ringD = new THREE.Mesh(new THREE.RingGeometry(0.7, 1.12, 48), ringMatD);
  const pip = new THREE.Mesh(new THREE.CircleGeometry(0.18, 20), ringMatW);
  ringW.renderOrder = 23; ringD.renderOrder = 22; pip.renderOrder = 23;
  ring.add(ringD, ringW, pip);
  ring.visible = false;
  root.add(ring);

  // --- blast radius on the ground around the landing point: a soft fill out to the blast radius, a stronger fill over
  // the full-damage radius, and an edge band on each (grenade.blast.radius / killRadius). Flat (world up), not tilted
  // with the contact normal, since the blast is a sphere and the grenade ends up on the floor.
  const blast = new THREE.Group();
  const mkMat = (o) => new THREE.MeshBasicMaterial({ color: 0xff5a36, transparent: true, opacity: o, depthWrite: false,
    side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const fillOutMat = mkMat(0.07), fillInMat = mkMat(0.13), edgeOutMat = mkMat(0.75), edgeInMat = mkMat(0.4);
  const disc = new THREE.CircleGeometry(1, 64);
  const fillOut = new THREE.Mesh(disc, fillOutMat), fillIn = new THREE.Mesh(disc, fillInMat);
  const edgeOut = new THREE.Mesh(new THREE.RingGeometry(1, 1, 96), edgeOutMat);    // radii set per frame (band in metres)
  const edgeIn = new THREE.Mesh(new THREE.RingGeometry(1, 1, 96), edgeInMat);
  for (const m of [fillOut, fillIn, edgeOut, edgeIn]) { m.rotation.x = -Math.PI / 2; m.renderOrder = 19; blast.add(m); }
  blast.visible = false;
  root.add(blast);
  let bandKey = '';
  const setBand = (mesh, r, w) => { mesh.geometry.dispose(); mesh.geometry = new THREE.RingGeometry(Math.max(0.01, r - w), r, 96); };

  // --- grenade bodies (pooled) + red glow sprites
  const bodyGeo = new THREE.SphereGeometry(1, 14, 10);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3d4535, roughness: 0.55, metalness: 0.35 });
  const glowMat = new THREE.SpriteMaterial({ map: glowTexture(), color: 0xff3020, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false });
  const meshes = [];
  for (let i = 0; i < LIVE_MESHES + 1; i++) {
    const m = new THREE.Mesh(bodyGeo, bodyMat);
    const s = new THREE.Sprite(glowMat.clone());
    s.renderOrder = 24;
    m.visible = false; s.visible = false;
    root.add(m, s);
    meshes.push({ m, s });
  }
  const held = meshes[LIVE_MESHES];     // the grenade in the hand while aiming / throwing

  const _q = new THREE.Quaternion(), _z = new THREE.Vector3(0, 0, 1), _n = new THREE.Vector3(), _hp = new THREE.Vector3();
  const _col = new THREE.Color();
  let clock = 0;

  function frame(dt) {
    clock += dt;
    const pl = game.player;
    const show = pv.visible && pv.owner === pl && pv.count > 1;

    // preview
    if (show) {
      _col.set(P('grenade.preview.color'));
      const op = P('grenade.preview.opacity');
      lineMat.color.copy(_col); lineMat.opacity = op * 0.85;
      line.visible = P('grenade.preview.line');
      lineGeo.setDrawRange(0, pv.count);
      lineAttr.needsUpdate = true;
      lineGeo.boundingSphere = null;

      dots.visible = P('grenade.preview.dots');
      if (dots.visible) {
        dotMat.size = P('grenade.preview.dotSize'); dotMat.color.copy(_col); dotMat.opacity = op;
        const sp = Math.max(0.05, P('grenade.preview.dotSpacing'));
        let next = (clock * P('grenade.preview.flow')) % sp, acc = 0, nd = 0;
        const pts = pv.points;
        for (let i = 1; i < pv.count && nd < MAX_DOTS; i++) {
          const o = i * 3, ax = pts[o - 3], ay = pts[o - 2], az = pts[o - 1];
          const dx = pts[o] - ax, dy = pts[o + 1] - ay, dz = pts[o + 2] - az;
          const L = Math.hypot(dx, dy, dz);
          while (next <= acc + L && nd < MAX_DOTS) {
            const f = L > 0 ? (next - acc) / L : 0;
            dotPos[nd * 3] = ax + dx * f; dotPos[nd * 3 + 1] = ay + dy * f; dotPos[nd * 3 + 2] = az + dz * f;
            nd++; next += sp;
          }
          acc += L;
        }
        dotGeo.setDrawRange(0, nd);
        dotAttr.needsUpdate = true;
      }

      ring.visible = true;
      _n.set(pv.normal.x, pv.normal.y, pv.normal.z);
      if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
      _n.normalize();
      _q.setFromUnitVectors(_z, _n);
      ring.quaternion.copy(_q);
      ring.position.set(pv.landing.x + _n.x * 0.012, pv.landing.y + _n.y * 0.012, pv.landing.z + _n.z * 0.012);
      const rr = P('grenade.preview.ringRadius');
      ringW.scale.setScalar(rr); ringD.scale.setScalar(rr); pip.scale.setScalar(rr);
      ringMatW.color.copy(_col);
      const br = P('grenade.preview.blastRing');
      blast.visible = br;
      if (br) {
        const R = P('grenade.blast.radius'), K = Math.min(R, P('grenade.blast.killRadius'));
        blast.position.set(pv.landing.x, pv.landing.y + 0.02, pv.landing.z);
        fillOut.scale.setScalar(R); fillIn.scale.setScalar(K);
        const key = R + ':' + K;
        if (key !== bandKey) { bandKey = key; setBand(edgeOut, R, 0.09); setBand(edgeIn, K, 0.05); }   // rebuilt only on a tuning change
        const c = P('grenade.preview.blastColor'), f = P('grenade.preview.blastFill'), e = P('grenade.preview.blastEdge');
        for (const m of [fillOutMat, fillInMat, edgeOutMat, edgeInMat]) m.color.set(c);
        fillOutMat.opacity = f * 0.55; fillInMat.opacity = f; edgeOutMat.opacity = e; edgeInMat.opacity = e * 0.55;
      }
    } else {
      line.visible = false; dots.visible = false; ring.visible = false; blast.visible = false;
    }

    // held grenade (from aim start until it leaves the hand)
    const ph = pl ? gr.stateOf(pl).phase : 'none';
    if (pl && ph !== 'none') {
      gr.handPos(pl, _hp);
      held.m.visible = true; held.m.position.copy(_hp); held.m.scale.setScalar(P('grenade.radius') * 1.15);
      held.s.visible = false;
    } else held.m.visible = false;

    // live grenades
    const live = gr.live;
    for (let i = 0; i < LIVE_MESHES; i++) {
      const v = meshes[i];
      const b = live[i];
      if (!b) { v.m.visible = false; v.s.visible = false; continue; }
      v.m.visible = true;
      v.m.position.copy(b.pos);
      v.m.scale.setScalar(b.bodyRadius * 1.15);
      v.m.rotation.x += Math.hypot(b.vel.x, b.vel.z) * dt * 6;
      // red glow: steady dim until the fuse runs, then a pulse whose period shrinks toward the end
      let k = 0.45;
      if (b.fuseStarted && b.fuse > 0) {
        const left = Math.max(0, b.fuseLeft) / b.fuse;
        const period = P('grenade.view.beepFast') + (P('grenade.view.beepSlow') - P('grenade.view.beepFast')) * left;
        const ph2 = ((b.fuse - b.fuseLeft) / period) % 1;
        k = ph2 < 0.35 ? 1 : 0.35;
      }
      const gs = P('grenade.view.glowSize');
      v.s.visible = gs > 0;
      v.s.position.copy(b.pos);
      v.s.scale.setScalar(gs * (0.6 + 0.4 * k));
      v.s.material.opacity = 0.35 + 0.65 * k;
    }
  }

  function dispose() {
    root.removeFromParent();
    lineGeo.dispose(); dotGeo.dispose(); bodyGeo.dispose(); circleGeo.dispose();
    for (const m of [lineMat, dotMat, ringMatW, ringMatD, bodyMat, blastMat, glowMat]) m.dispose();
  }

  return { root, frame, dispose };
}
