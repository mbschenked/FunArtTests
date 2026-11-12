// AI scenario harness for tests/ai.html: a box stand-in courtyard (so the scenario geometry is fixed and every expected
// time below can be worked out by hand), a scripted dummy player read only through the Actor shape, and four
// scenarios (?scenario=notice|camp|flank|lost). ?room=real&scenario=free spawns the AI in level/room.js instead.
// Real-room scenarios (refs/ai-vantage.md): perch | vantage | hardpoint.
// Uses the real modules when they exist (nav.js, weapons/*, hud.js, character createCharacter) and ai/stubs.js if not.
//
// Each scenario logs its state transitions with sim times (window.__measure.log() and __ai.transitions) and
// __ai.report() checks them against the hand-computed expectations in SCENARIOS[*].expect.
import * as THREE from 'three';
import { Game, ORDER } from '../core/game.js';
import { createWorld } from '../core/world.js';
import { installMeasure } from '../debug/measure.js';
import { buildNav } from '../level/nav.js';
import { createAI } from './index.js';
import { defineAIParams } from './tuning.js';

// ------------------------------------------------------------------------------------------------ stand-in room
// North = −Z (as in room.js). Enemies spawn in the north and face south (yaw 0 faces +Z). Boxes: [id, cx, cz, sx, sy, sz, tag]
const BOXES = [
  ['LW1', 6, 3, 4, 1.0, 0.4, 'low'],       // camp / flank wall: the player crouches on its south side
  ['LW2', 1, -3, 5, 1.0, 0.4, 'low'],
  ['LW3', -9, -5, 3, 1.0, 0.4, 'low'],
  ['LW4', 9, -5.5, 3, 1.0, 0.4, 'low'],
  ['LW5', 11, 2, 0.4, 1.0, 3, 'low'],      // north-south run on the east side (flank cover)
  ['HN', 1.5, 7, 3, 2.2, 0.4, 'high'],     // notice: the player starts hidden behind it
  ['BK', -9, 4.5, 8, 2.2, 3, 'high'],      // lost: bunker, x −13..−5, z 3..6
  ['CL', -5, 7.75, 0.4, 2.2, 3.5, 'high'], // lost: closes the bunker pocket's east side (z 6..9.5), gap to the south wall
  ['PL', -9.5, 8.8, 1.2, 2.2, 1.2, 'high'], // lost: hides the final spot from the last known position
  ['P3', -2, -7, 1.2, 2.2, 1.2, 'high'],
  ['P4', 12, -1, 1.2, 2.2, 1.2, 'high'],
];
const ROOM = { x0: -15, x1: 15, z0: -11, z1: 11, wallH: 3 };
const SPAWNS = [
  { pos: { x: -5, y: 0, z: -9 }, yaw: 0 },    // enemy1
  { pos: { x: 5, y: 0, z: -9 }, yaw: 0 },     // enemy2
  { pos: { x: 0, y: 0, z: -10 }, yaw: 0 },    // enemy3
  { pos: { x: -10, y: 0, z: -9 }, yaw: 0 },   // enemy4 (ai.count 4)
];

function buildStandIn(game) {
  const { world, scene } = game;
  const records = [];
  const mats = {
    floor: new THREE.MeshStandardMaterial({ color: 0x77736a, roughness: 0.95 }),
    wall: new THREE.MeshStandardMaterial({ color: 0x8e8778, roughness: 0.9 }),
    low: new THREE.MeshStandardMaterial({ color: 0xa69a82, roughness: 0.85 }),
    high: new THREE.MeshStandardMaterial({ color: 0x8a7f6c, roughness: 0.85 }),
  };
  const add = (id, cx, cy, cz, sx, sy, sz, tags, mat) => {
    world.addBox({ center: [cx, cy, cz], size: [sx, sy, sz] }, { tags, material: 'stone' });
    records.push({ id, cx, cy, cz, hx: sx / 2, hy: sy / 2, hz: sz / 2, cos: 1, sin: 0, top: cy + sy / 2, bottom: cy - sy / 2, tags: new Set(tags) });
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    m.position.set(cx, cy, cz); m.castShadow = m.receiveShadow = true;
    scene.add(m);
  };
  add('floor', 0, -0.1, 0, 30, 0.2, 22, ['floor'], mats.floor);
  const H = ROOM.wallH;
  add('wallN', 0, H / 2, ROOM.z0 - 0.25, 31, H, 0.5, ['wall'], mats.wall);
  add('wallS', 0, H / 2, ROOM.z1 + 0.25, 31, H, 0.5, ['wall'], mats.wall);
  add('wallW', ROOM.x0 - 0.25, H / 2, 0, 0.5, H, 22, ['wall'], mats.wall);
  add('wallE', ROOM.x1 + 0.25, H / 2, 0, 0.5, H, 22, ['wall'], mats.wall);
  for (const [id, cx, cz, sx, sy, sz, kind] of BOXES) add(id, cx, sy / 2, cz, sx, sy, sz, ['cover-' + kind, 'cover'], kind === 'low' ? mats.low : mats.high);
  const grid = new THREE.GridHelper(30, 30, 0x5a5850, 0x5a5850); grid.scale.z = 22 / 30; grid.position.y = 0.003; scene.add(grid);

  // cover markup in room.js's shape: each face of each cover box, normal out of the wall, ends 'corner'
  const cover = [];
  for (const [id, cx, cz, sx, sy, sz, kind] of BOXES) {
    const hx = sx / 2, hz = sz / 2;
    const faces = [[0, 1, hz, hx], [0, -1, hz, hx], [1, 0, hx, hz], [-1, 0, hx, hz]];
    for (const [nx, nz, hn, ht] of faces) {
      if (2 * ht < 0.8) continue;
      const fx = cx + nx * hn, fz = cz + nz * hn, rx = -nz, rz = nx;
      cover.push({ id: `${id}:${nx}${nz}`, a: new THREE.Vector3(fx - rx * ht, 0, fz - rz * ht), b: new THREE.Vector3(fx + rx * ht, 0, fz + rz * ht),
        normal: new THREE.Vector3(nx, 0, nz), height: kind, top: sy, floorY: 0, ends: { a: 'corner', b: 'corner' } });
    }
  }
  const bounds = { min: new THREE.Vector3(ROOM.x0, -0.2, ROOM.z0), max: new THREE.Vector3(ROOM.x1, 4, ROOM.z1) };
  const nav = buildNav(records, bounds, { cell: 0.5, radius: 0.35 });
  return { cover, nav, bounds, spawns: { player: { pos: new THREE.Vector3(0, 0, 10), yaw: Math.PI }, enemies: SPAWNS }, standIn: true };
}

// ------------------------------------------------------------------------------------------------ dummy player
// Scripted keyframes: {at, goto: [x, z], speed} | {at, cover: true|false} | {at, pose: 'popup'|'idle'}
//   | {at, place: [x, y, z], mode} (teleport, e.g. hanging on the climb wall) | {at, combat: true} (director combat at
//   the dummy, as if an NPC had spotted it: the scenario then starts from a known combat state)
function createDummy(game, start) {
  const V = THREE.Vector3;
  const d = {
    id: 'player', team: 'player', pos: new V(start[0], 0, start[1]), vel: new V(), yaw: Math.PI, height: 1.8, radius: 0.35,
    health: 100, maxHealth: 100, alive: true, rig: null, ctrl: { mode: 'ground' }, anim: { cover: { pose: 'idle' } }, state: {},
    hits: 0, damageTaken: 0,
    takeDamage(p) { d.hits++; d.damageTaken += (typeof p === 'number' ? p : p.amount) || 0; },  // god mode: logs only
  };
  game.world.addHitboxes(d, null);
  const mesh = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.33, 1.1, 4, 10), new THREE.MeshStandardMaterial({ color: 0x3f8fd8, roughness: 0.6 }));
  body.position.y = 0.88; body.castShadow = true;
  mesh.add(body);
  game.scene.add(mesh);
  d.mesh = mesh; d.body = body;
  return d;
}

function scriptSystem(game, dummy, script, logT) {
  let i = 0, target = null, speed = 0;
  const delta = new THREE.Vector3();
  const setMode = (mode) => {
    if (dummy.ctrl.mode === mode) return;
    game.events.emit('state', { actor: dummy, sys: 'move', from: dummy.ctrl.mode, to: mode, t: game.time });
    dummy.ctrl.mode = mode;
  };
  return {
    name: 'dummy', order: ORDER.player,
    update(dt) {
      while (i < script.length && game.time >= script[i].at - 1e-9) {
        const k = script[i++];
        if (k.goto) { target = { x: k.goto[0], z: k.goto[1] }; speed = k.speed; setMode(speed > 3 ? 'run' : 'walk'); logT('player', `goto (${k.goto}) at ${speed} m/s`); }
        if (k.cover === true) { setMode('cover'); dummy.anim.cover.pose = 'idle'; dummy.height = 1.1; logT('player', 'crouch in cover'); }
        if (k.cover === false) { setMode('ground'); dummy.height = 1.8; logT('player', 'leave cover'); }
        if (k.pose) { dummy.anim.cover.pose = k.pose; dummy.height = k.pose === 'popup' ? 1.8 : 1.1; logT('player', 'cover pose ' + k.pose); }
        if (k.place) { dummy.pos.set(k.place[0], k.place[1], k.place[2]); dummy.vel.set(0, 0, 0); target = null; setMode(k.mode || 'ground'); logT('player', `place (${k.place}) ${k.mode || ''}`); }
        if (k.combat && game.ai) { game.ai.enterCombat(null, dummy.pos, 'scripted'); game.ai.lastPerceivedT = game.time; logT('player', 'combat (scripted)'); }
        if (k.search && game.ai) { game.ai.enterSearch(); logT('player', 'lost (scripted search)'); }
      }
      if (target) {
        const dx = target.x - dummy.pos.x, dz = target.z - dummy.pos.z, dd = Math.hypot(dx, dz);
        const stepLen = speed * dt;
        if (dd <= stepLen) { dummy.vel.set(dx / dt, 0, dz / dt); delta.set(dx, 0, dz); target = null; }
        else { dummy.vel.set(dx / dd * speed, 0, dz / dd * speed); delta.set(dx / dd * stepLen, 0, dz / dd * stepLen); }
        game.world.moveCapsule(dummy, delta, { stepHeight: 0.35, snapDown: 0.3 });
        dummy.yaw = Math.atan2(dx, dz);
        if (!target) { dummy.vel.set(0, 0, 0); if (dummy.ctrl.mode === 'walk' || dummy.ctrl.mode === 'run') setMode('ground'); logT('player', 'stop'); }
      }
      dummy.mesh.position.copy(dummy.pos);
      dummy.body.scale.y = dummy.height / 1.8;
      dummy.body.position.y = 0.88 * dummy.height / 1.8;
    },
  };
}

// Walk the scripted polyline from (x, z) at constant speed; returns the first time the dummy is farther than `dist`
// from `p` (pure geometry: the expectation for the snuck-away rule).
// Only times after `after` (the LKP's time) count: the path may start far from where the player is last seen.
function crossingTime(start, legs, p, dist, after) {
  let x = start[0], z = start[1];
  for (const leg of legs) {
    const [tx, tz] = leg.goto, L = Math.hypot(tx - x, tz - z), n = Math.max(1, Math.ceil(L / 0.01));
    for (let k = 1; k <= n; k++) {
      const px = x + (tx - x) * k / n, pz = z + (tz - z) * k / n, t = leg.at + (L * k / n) / leg.speed;
      if (t > after && Math.hypot(px - p.x, pz - p.z) > dist) return t;
    }
    x = tx; z = tz;
  }
  return Infinity;
}

// ------------------------------------------------------------------------------------------------ scenarios
// Hand-computed expectations (refs/ai-spec.md §1.2 meter, §4 timers, §2 lost-player rule; geometry of BOXES above).
// meter: acquire(d) = (0.5 + 2.5·d/30) × 1.5 (never seen), confirm(d) = 0.3 + 1.2·d/30, range 30 m.
const SCENARIOS = {
  notice: {
    title: 'notice: the player steps out from behind a high wall into view at ~17 m',
    duration: 9, player: [1.5, 8.0], set: {},
    script: [{ at: 1.0, goto: [4.5, 8.0], speed: 1.6 }],
    cam: { pos: [6, 21, 17], look: [2, 0, -1.5] },
    // enemy2 (5, −9) faces +Z. Its eye→chest line clears HN's east end (x = 3 at z ≈ 7.2) once the player passes
    // x ≈ 2.9: 1.4 m into the 1.6 m/s walk → first sight ≈ 1.0 + 0.88 = 1.88 s at d ≈ 17.1 m.
    // white: acquire(17.1) = (0.5 + 1.425) × 1.5 = 2.89 s → suspicious ≈ 4.77 s;
    // yellow: confirm(17) = 0.3 + 0.68 = 0.98 s → combat ≈ 5.75 s, and every NPC is in combat at that moment.
    expect: (r) => [
      r.check('enemy2 first sees the player (s)', r.first('see', 'enemy2'), 1.88, 0.1),
      r.check('enemy2 → suspicious (s)', r.firstState('enemy2', 'ai', 'suspicious'), 4.77, 0.12),
      r.check('enemy2 → combat (s)', r.firstState('enemy2', 'ai', 'combat'), 5.75, 0.15),
      r.check('white phase = acquire(17.1) (s)', r.firstState('enemy2', 'ai', 'suspicious') - r.first('see', 'enemy2'), 2.89, 0.1),
      r.check('enemy1 (player 29° off its axis) joins combat by broadcast at the same step', r.firstState('enemy1', 'ai', 'combat') - r.firstState('enemy2', 'ai', 'combat'), 0, 1e-6),
      r.check('enemy1 never saw the player before combat', r.first('see', 'enemy1') < r.firstState('enemy2', 'ai', 'combat') ? 0 : 1, 1, 0),
    ],
  },
  camp: {
    title: 'camp: spotted at ~12.7 m, the player crouches behind a low wall and stays',
    duration: 16, player: [6, 3.6], set: {},
    script: [{ at: 3.6, cover: true }],
    cam: { pos: [8, 22, 19], look: [3, 0, -1] },
    // enemy2 sees the standing player from t = 0 at d ≈ 12.7: acquire = (0.5 + 1.058) × 1.5 = 2.34, confirm = 0.81
    // → combat ≈ 3.14 s. From combat start the LKP stays put, so: advance and flank fire at +6.0 s (G-deck p114),
    // the grenade director (sampled each 1.0 s) at +8.0 s, and the grenade leaves the hand barkLead 0.6 s later.
    expect: (r) => {
      const c = r.firstState('director', 'ai.director', 'combat');
      return [
        r.check('combat starts (s)', c, 3.14, 0.12),
        r.check('advance timer fires (s after combat)', r.firstState('director', 'ai.timer', 'advance') - c, 6.0, 0.02),
        r.check('flank timer fires (s after combat)', r.firstState('director', 'ai.timer', 'flank') - c, 6.0, 0.02),
        r.check('grenade director fires (s after combat)', r.firstState('director', 'ai.timer', 'grenade') - c, 8.0, 0.02),
        r.check('grenade released (s after the director)', r.firstAny('ai.throw', 'release') - r.firstState('director', 'ai.timer', 'grenade'), 0.6, 0.02),
        r.check('an advance was dispatched to an NPC', r.firstAny('ai.director', 'advance') > 0 ? 1 : 0, 1, 0),
        r.check('a flanker was dispatched', r.firstAny('ai.director', 'flank') > 0 ? 1 : 0, 1, 0),
        r.check('shooters never exceed max 3', r.maxShooters, 3, 3, 'le'),
      ];
    },
  },
  flank: {
    title: 'flank: the player camps behind a low wall; one NPC routes around the combat vector',
    duration: 22, player: [6, 3.6], set: { 'ai.grenade.on': false, 'ai.advance.wait': 99 },
    script: [{ at: 3.6, cover: true }],
    cam: { pos: [9, 22, 18], look: [5, 0, -0.5] },
    expect: (r) => {
      const c = r.firstState('director', 'ai.director', 'combat');
      const fl = r.flank;
      return [
        r.check('flank timer fires (s after combat)', r.firstState('director', 'ai.timer', 'flank') - c, 6.0, 0.02),
        r.check('flank dispatched within 0.2 s of the request', r.firstAny('ai.director', 'flank') - r.firstState('director', 'ai.timer', 'flank'), 0.1, 0.1),
        r.check('flank route rating ≥ min 0.5', fl ? fl.rating : 0, 0.5, 0, 'ge'),
        r.check('flank post off the combat vector ≥ 60° (deg)', fl ? fl.offAxis : 0, 60, 0, 'ge'),
        r.check('flanker arrived', fl && fl.arrivedT ? 1 : 0, 1, 0),
        r.check('flanker fired from the flank post', fl ? fl.shotsAfter : 0, 1, 0, 'ge'),
      ];
    },
  },
  lost: {
    title: 'lost: the player breaks line of sight behind the bunker and moves > 8 m away → search',
    duration: 22, player: [-1, 1], set: {},
    script: [],          // filled at combat start (the run starts 1.0 s after combat)
    route: [[-3, 10.1], [-6, 10.2], [-12, 10.3], [-14, 7.5]], runSpeed: 4.0,
    cam: { pos: [-3, 23, 18], look: [-5, 0, 0] },
    // combat ≈ 2.83 s (enemy1 sees the player 21.8° off axis at d = 10.77: acquire = (0.5 + 0.898) × 1.5 = 2.10,
    // confirm = 0.3 + 0.431 = 0.73; enemy3 at 11.05 m is a little slower). The LKP freezes where the last NPC lost
    // sight. Snuck-away (U4 default 8 m): confirm-LKP starts the step the scripted path is 8 m from that LKP (pure
    // geometry, crossingTime). Hand check: sight breaks entering the pocket at x ≈ −5.7, z ≈ 10.2 (CL blocks the
    // east, BK the north); the run ends at (−14, 7.5), 8.7 m from there, behind PL as seen from the LKP; the 8 m
    // crossing is ~71% down the last leg. The checker walks to the LKP, finds nothing → all search.
    expect: (r) => {
      const conf = r.firstState('director', 'ai.director', 'confirmLKP');
      return [
        r.check('combat starts (s)', r.firstState('director', 'ai.director', 'combat'), 2.83, 0.1),
        r.check('confirm-LKP when the player is 8 m from the LKP (s)', conf, r.lost ? r.lost.expectConfirm : NaN, 0.05),
        r.check('LKP frozen from confirm to search (m moved)', r.lost && r.lost.lkpAtSearch ? Math.hypot(r.lost.lkpAtSearch.x - r.lost.lkp.x, r.lost.lkpAtSearch.z - r.lost.lkp.z) : NaN, 0, 1e-6),
        r.check('search starts after the checker reaches the LKP', r.firstState('director', 'ai.director', 'search') > conf ? 1 : 0, 1, 0),
        r.check('every live NPC searches (at the same step as the director)', r.allSearchT - r.firstState('director', 'ai.director', 'search'), 0, 1e-6),
      ];
    },
  },
  free: { title: 'free: the AI in the real room (level/room.js), dummy player at the gate', duration: 6, player: null, set: {}, script: [], cam: { pos: [0, 24, 22], look: [0, 0, -1] }, expect: () => [] },

  // ---- real room (refs/ai-vantage.md). Expected values come from the room geometry (LAYOUT numbers copied here) and
  // from fresh raycasts in the observer, never from the AI's own cached measures.
  perch: {
    title: 'perch: the player climbs the rampart wall under the north-rampart defender, who leans over the rail to aim down',
    real: true, duration: 12, player: [-7.5, 2], set: { 'ai.grenade.on': false, 'ai.advance.wait': 99, 'ai.flank.wait': 99 },
    // combat from a known state at 0.2 s; at 4 s the player hangs on the climb wall (L1..H2 band, 2.6 m) 0.45 m off the
    // rampart face (z = −8), right under the climb gap, and is spotted there.
    script: [{ at: 0.2, combat: true }, { at: 4.0, place: [-7.5, 2.6, -7.55], mode: 'climb' }, { at: 4.0, combat: true }],
    climbAt: 4.0,
    cam: { pos: [-2.5, 10.5, 3.5], look: [-5.5, 4.2, -8.2] },
    expect: (r) => {
      const p = r.perch || {};
      const inRampart = p.pos && p.pos[0] >= -10 && p.pos[0] <= 9 && p.pos[2] >= -11.2 && p.pos[2] <= -7.9 && Math.abs(p.pos[1] - 6) < 0.5;
      return [
        r.check('enemy2 defends the designer hard point hp-north-rampart', p.hp === 'hp-north-rampart' ? 1 : 0, 1, 0),
        r.check('no perch mode before the climb (player 9.7 m from the edge)', p.perchBefore ? 1 : 0, 0, 0),
        r.check('perch mode after the climb (s after climbing; noLof 1.0 + re-score 0.5)', p.onT - 4.0, 1.5 + 0.05, 0, 'le'),
        r.check('at a perch post in perch mode (s after climbing)', p.arriveT - 4.0, 6, 0, 'le'),
        r.check('the perch is on the north rampart, inside the hard point (bounds from LAYOUT)', inRampart ? 1 : 0, 1, 0),
        r.check('fresh ray: lean-out point → climbing player chest is clear', p.los ? 1 : 0, 1, 0),
        r.check('enemy2 sees the player from the perch', p.seeT > p.arriveT ? 1 : 0, 1, 0),
        r.check('enemy2 fires from the lean-out point (shots)', p.shots || 0, 1, 0, 'ge'),
        r.check('shot origin = lean-out point − 0.1 m (max m off)', p.originErr ?? NaN, 0.05, 0, 'le'),
      ];
    },
  },
  vantage: {
    title: 'vantage: the stair-foot defender loses vantage when the player moves, relocates in its zone, then searches from it',
    real: true, duration: 20, player: [-13.8, 8.3],
    // 1 engager, no ambusher → enemy2 is pinned to hp-north-rampart and the leftover fills hp-stair-foot (both designer)
    set: { 'ai.roles.engagers': 1, 'ai.roles.ambushers': 0, 'ai.grenade.on': false, 'ai.advance.wait': 99, 'ai.flank.wait': 99 },
    // A (south-west yard) → B (north-west, behind the column line) at 8 s, spotted there; lost at 14 s → search.
    // At 14 s the player is lifted out of the room (y −30: nobody can re-spot it) and the director goes to search.
    script: [{ at: 0.2, combat: true }, { at: 8.0, place: [-9.8, 0, -5.7], mode: 'ground' }, { at: 8.0, combat: true },
      { at: 14.0, place: [-9.8, -30, -5.7], mode: 'ground' }, { at: 14.0, search: true }],
    moveAt: 8.0, searchAt: 14.0,
    cam: { pos: [4, 21, 21], look: [3, 0, 0] },
    expect: (r) => {
      const v = r.vant || {};
      const inStair = (q) => q && q[0] >= 10.4 && q[0] <= 15 && q[2] >= 3.4 && q[2] <= 8.9 && q[1] < 1;
      return [
        r.check('a leftover NPC fills the designer hard point hp-stair-foot', v.hp === 'hp-stair-foot' ? 1 : 0, 1, 0),
        r.check('enemy2 (overwatch spawn inside the designer zone) holds hp-north-rampart, no auto hard point', v.enemy2Hp === 'hp-north-rampart' && v.autoHps === 0 ? 1 : 0, 1, 0),
        r.check('its post at the move is inside the stair-foot zone (bounds from LAYOUT)', inStair(v.oldPos) ? 1 : 0, 1, 0),
        r.check('fresh rays: vantage of that post over B\'s reach < min 0.15', v.oldV, 0.15, 0, 'le'),
        r.check('relocates within 4 s of the move (s)', v.newT - 8.0, 4, 0, 'le'),
        r.check('new post inside the stair-foot zone', inStair(v.newPos) ? 1 : 0, 1, 0),
        r.check('fresh rays: new post vantage ≥ min 0.15', v.newV, 0.15, 0, 'ge'),
        r.check('defend search starts with the search (s after it)', v.searchT - 14.0, 0.05, 0, 'le'),
        r.check('in search the defender walks no loop and stays in its zone', v.stayed ? 1 : 0, 1, 0),
        r.check('it looks outward: distinct look directions after the search', v.looks || 0, 2, 0, 'ge'),
      ];
    },
  },
};
// The same run with a 30 s minimum dwell: the defend selector's vantage term can't move the defender, so the combat
// fallback must: no vantage + no line of fire for ai.vantage.lostT (2 s) → defend search (forced, ignores the dwell).
SCENARIOS.vantageDwell = {
  ...SCENARIOS.vantage,
  title: 'vantageDwell: as vantage, but dwell 30 s — the blind defender\'s defend search moves it in combat',
  set: { ...SCENARIOS.vantage.set, 'ai.posts.minDwell': 30 },
  expect: (r) => {
    const v = r.vant || {};
    const ds = r.transitions.find((x) => x.actor === v.npc && x.sys === 'ai.defend' && x.to === 'search');
    const inStair = (q) => q && q[0] >= 10.4 && q[0] <= 15 && q[2] >= 3.4 && q[2] <= 8.9 && q[1] < 1;
    return [
      r.check('fresh rays: post at the move has vantage < min 0.15', v.oldV, 0.15, 0, 'le'),
      // LKP moves at 8 s; vantage is measured that step; no line of fire for 2 s (lostT) → the next re-score (≤ 0.5 s)
      r.check('defend search in combat (s after the move; lostT 2 + re-score 0.5)', ds ? ds.t - 8.0 : NaN, 2.5 + 0.05, 0, 'le'),
      r.check('relocates (s after the move)', v.newT - 8.0, 6, 0, 'le'),
      r.check('new post inside the stair-foot zone', inStair(v.newPos) ? 1 : 0, 1, 0),
      r.check('fresh rays: new post vantage ≥ min 0.15', v.newV, 0.15, 0, 'ge'),
    ];
  },
};

// ------------------------------------------------------------------------------------------------ boot
export async function runTestbed({ canvas, query }) {
  const name = query.get('scenario') || 'notice';
  const S = SCENARIOS[name] || SCENARIOS.notice;
  const test = query.has('test');
  const realRoom = query.get('room') === 'real' || name === 'free' || !!S.real;
  const game = new Game({ seed: 1, test: true });
  game.world = createWorld({ Vector3: THREE.Vector3, cellSize: 2 });

  // renderer
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b2028);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  const resize = () => { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  resize(); addEventListener('resize', resize);
  scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x403a30, 1.4));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.0);
  sun.position.set(-8, 20, 6); sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 14, bottom: -14, near: 1, far: 50 });
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);
  game.scene = scene; game.camera = camera;
  game.render = { renderer, scene, camera, draw: () => renderer.render(scene, camera), setGrade() {}, addPass() {}, look() {} };
  camera.position.set(...S.cam.pos); camera.lookAt(...S.cam.look);

  // optional real modules, probed through the directory listing so a missing file never logs a 404
  const has = await listing(['../level/', '../weapons/', '../hud/', '../character/']);
  if (realRoom && has.has('../level/room.js')) {
    const room = await import('../level/room.js');
    room.install(game);
  } else {
    game.level = buildStandIn(game);
  }
  game.params.define('ai.debug', true, {});
  defineAIParams(game.params);
  for (const [k, v] of Object.entries(S.set)) game.params.set(k, v);
  let createWeapon = null;
  if (has.has('../weapons/index.js')) {
    const W = await import('../weapons/index.js');
    W.createGrenades(game);
    createWeapon = W.createWeapon;
  }
  if (has.has('../hud/hud.js')) {
    const H = await import('../hud/hud.js');
    game.hud = H.createHud(game);
  }
  let createCharacter = null;
  if (has.has('../character/index.js')) {
    try { const C = await import('../character/index.js'); createCharacter = C.createCharacter || null; } catch { createCharacter = null; }
    if (createCharacter && has.has('../character/animator.js')) { const A = await import('../character/animator.js'); A.install(game); }
  }

  // dummy player
  const start = S.player || [game.level.spawns.player.pos.x, game.level.spawns.player.pos.z];
  const dummy = createDummy(game, start);
  game.player = dummy;
  game.actors.push(dummy);

  // transitions log (ai.* state events + player script + derived 'see' events)
  const transitions = [];
  const logT = (actor, what) => transitions.push({ t: +game.time.toFixed(4), actor, what });
  game.events.on('state', (e) => {
    if (!e || !String(e.sys).startsWith('ai')) return;
    transitions.push({ t: +game.time.toFixed(4), actor: e.actor ? e.actor.id : null, sys: e.sys, from: e.from, to: e.to });
  });
  const script = S.script.slice();
  game.addSystem(scriptSystem(game, dummy, script, logT));
  installMeasure(game);

  const ai = createAI(game, { createWeapon, createCharacter, rig: createCharacter ? undefined : 'stub' });
  game.addSystem({ name: 'hitboxes', order: ORDER.animation + 1, update: () => game.world.updateHitboxes() });

  // per-step observers: 'see' edges, shooter count, flank bookkeeping, lost-scenario bookkeeping
  const seeWas = new Map();
  const obs = { maxShooters: 0, flank: null, lost: null, allSearch: false, lastSeenT: -1, perch: null, vant: null };
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), NO_ACT = { hitActors: false };
  const los = (a, b) => game.world.lineOfSight(va.set(a.x, a.y, a.z), vb.set(b.x, b.y, b.z), NO_ACT);
  // fresh vantage: own rays from a post's fire point to the manager's current reach points
  const freshV = (post) => { const pts = ai.vantage.pts; if (!post.fire || !pts.length) return 0; let k = 0; for (const p of pts) if (los(post.fire, p)) k++; return +(k / pts.length).toFixed(4); };
  const inStairZone = (p, m = 0) => p.x >= 10.4 - m && p.x <= 15 + m && p.z >= 3.4 - m && p.z <= 8.9 + m && p.y < 1;
  game.addSystem({
    name: 'observe', order: ORDER.ai + 1,
    update() {
      let tok = 0;
      for (const n of ai.npcs) {
        const was = seeWas.get(n) || false;
        if (n.ai.canSee !== was) { seeWas.set(n, n.ai.canSee); transitions.push({ t: +game.time.toFixed(4), actor: n.id, what: n.ai.canSee ? 'see' : 'lose sight' }); }
        if (n.ai.tok) tok++;
        if (n.ai.perceived) obs.lastSeenT = game.time;
        if (n.ai.flankRoute && !obs.flank) {
          const p = n.ai.flankPost, L = ai.lkp, cv = ai.cv;
          const dx = p.x - L.x, dz = p.z - L.z, d = Math.hypot(dx, dz) || 1;
          obs.flank = { npc: n, post: p.id, rating: +n.ai.flankRating.toFixed(3), offAxis: +(Math.acos(Math.max(-1, Math.min(1, (dx * cv.x + dz * cv.z) / d))) * 180 / Math.PI).toFixed(1), arrivedT: 0, shotsAfter: 0 };
        }
      }
      obs.maxShooters = Math.max(obs.maxShooters, tok);
      if (name === 'perch') {
        const e2 = ai.npcs.find((n) => n.id === 'enemy2'), a2 = e2 && e2.ai;
        const p = obs.perch || (obs.perch = { hp: null, perchBefore: false, onT: NaN, arriveT: NaN, pos: null, los: false, seeT: NaN, shots: 0, originErr: NaN, post: null });
        if (a2) {
          if (a2.hardPoint) p.hp = a2.hardPoint.id;
          if (a2.perchMode && game.time < S.climbAt) p.perchBefore = true;
          if (a2.perchMode && !(p.onT >= 0) && game.time >= S.climbAt) p.onT = game.time;
          if (!(p.arriveT >= 0) && a2.perchMode && a2.atPost && !a2.moving && a2.post && a2.post.type === 'perch') {
            const q = a2.post;
            p.arriveT = game.time; p.post = q; p.pos = [q.x, q.y, q.z];
            p.los = los(q.perchFire, { x: dummy.pos.x, y: dummy.pos.y + 1.3, z: dummy.pos.z });
          }
          if (p.arriveT >= 0 && !(p.seeT >= 0) && a2.canSee) p.seeT = game.time;
        }
      }
      if (name === 'vantage' || name === 'vantageDwell') {
        const v = obs.vant || (obs.vant = { hp: null, npc: null, enemy2Hp: null, autoHps: 0, old: null, oldPos: null, oldV: NaN, newPos: null, newV: NaN, newT: NaN, searchT: NaN, stayed: true, looks: 0, lookSet: new Set() });
        const def = ai.npcs.find((n) => n.alive && n.ai.role === 'defender' && n.ai.hardPoint && n.ai.hardPoint.id === 'hp-stair-foot');
        if (def && !v.npc) { v.npc = def; v.hp = 'hp-stair-foot'; }
        const e2 = ai.npcs.find((n) => n.id === 'enemy2');
        if (e2 && e2.ai.hardPoint) v.enemy2Hp = e2.ai.hardPoint.id;
        v.autoHps = ai.hardPoints.filter((h) => !h.designer).length;
        const d = v.npc && v.npc.ai;
        if (d && game.time >= S.moveAt && !v.oldPos && d.post) { v.old = d.post; v.oldPos = [d.post.x, d.post.y, d.post.z]; }
        if (d && v.old && !v.newPos && game.time < S.searchAt && d.atPost && !d.moving && d.post && d.post !== v.old) {
          v.newPos = [d.post.x, d.post.y, d.post.z]; v.newT = game.time;
          v.oldV = freshV(v.old); v.newV = freshV(d.post);       // the reach set is B's by now (rebuilt at 8 s)
        }
        if (d && game.time >= S.searchAt) {
          if (!(v.searchT >= 0) && d.defendState === 'search') v.searchT = game.time;
          if (d.searchLoop >= 0 || !inStairZone(v.npc.pos, 0.5)) v.stayed = false;
          if (d.lookAt != null) v.lookSet.add(Math.round(d.lookAt * 10));
          v.looks = v.lookSet.size;
        }
      }
      if (obs.flank && !obs.flank.arrivedT && !obs.flank.npc.ai.flankRoute) obs.flank.arrivedT = game.time;
      // lost: start the run 1.0 s after combat; record the frozen LKP once the snuck-away check fires
      if (name === 'lost') {
        if (ai.combat && !obs.lost) {
          const at = game.time + 1.0;
          let x = start[0], z = start[1], t = at;
          for (const g of S.route) { script.push({ at: t, goto: g, speed: S.runSpeed }); t += Math.hypot(g[0] - x, g[1] - z) / S.runSpeed; x = g[0]; z = g[1]; }
          obs.lost = { runAt: at, lkpT: NaN, lastSeenT: NaN, expectConfirm: NaN, lkp: null };
        }
        if (obs.lost && ai.confirm.active && !obs.lost.lkp) {
          obs.lost.lkp = { x: ai.lkp.x, z: ai.lkp.z };
          obs.lost.lkpT = +ai.lkp.t.toFixed(4);
          obs.lost.lastSeenT = +obs.lastSeenT.toFixed(4);
          // geometry: when does the scripted path first get 8 m from that LKP? (+ the 0.25 s unseen guard is already past)
          obs.lost.expectConfirm = +crossingTime(start, script.filter((k) => k.goto), obs.lost.lkp, game.params.get('ai.search.snuckAway'), ai.lkp.t).toFixed(4);
        }
        const all = ai.npcs.every((n) => !n.alive || n.ai.alert === 'search');
        if (all && !obs.allSearch) { obs.allSearch = true; obs.allSearchT = +game.time.toFixed(4); }
        if (obs.lost && obs.lost.lkp && !obs.lost.lkpAtSearch && all) obs.lost.lkpAtSearch = { x: ai.lkp.x, z: ai.lkp.z };
      }
    },
  });
  game.events.on('shot', (e) => {
    if (obs.flank && obs.flank.arrivedT && e.shooter === obs.flank.npc) obs.flank.shotsAfter++;
    const p = obs.perch;
    if (p && p.post && e.shooter && e.shooter.id === 'enemy2' && e.shooter.ai.post === p.post && e.shooter.ai.perchMode) {
      const o = e.origin || (e.muzzle && e.muzzle.pos), f = p.post.perchFire;
      if (o) { const err = Math.hypot(o.x - f.x, o.y - (f.y - 0.1), o.z - f.z); p.originErr = Math.max(p.originErr >= 0 ? p.originErr : 0, +err.toFixed(4)); p.shots++; }
    }
  });

  // shot lines + live grenades (visual only)
  addShotLines(game);

  const report = () => {
    const r = {
      transitions, maxShooters: obs.maxShooters, flank: obs.flank && { ...obs.flank, npc: obs.flank.npc.id }, lost: obs.lost, allSearch: obs.allSearch, allSearchT: obs.allSearchT,
      perch: obs.perch && { ...obs.perch, post: obs.perch.post && obs.perch.post.id },
      vant: obs.vant && { ...obs.vant, npc: obs.vant.npc && obs.vant.npc.id, old: obs.vant.old && obs.vant.old.id, lookSet: undefined },
      first: (what, actor) => { const e = transitions.find((x) => x.what === what && x.actor === actor); return e ? e.t : NaN; },
      firstState: (actor, sys, to) => { const e = transitions.find((x) => x.actor === actor && x.sys === sys && x.to === to); return e ? e.t : NaN; },
      firstAny: (sys, to) => { const e = transitions.find((x) => x.sys === sys && x.to === to); return e ? e.t : NaN; },
      check: (label, got, expected, tol, mode = 'near') => {
        const g = typeof got === 'number' ? +got.toFixed(4) : got;
        const pass = mode === 'ge' ? g >= expected : mode === 'le' ? g <= expected : Math.abs(g - expected) <= tol;
        return { label, got: g, expected: typeof expected === 'number' ? +expected.toFixed(4) : expected, tol, mode, pass: !!pass && Number.isFinite(g) };
      },
    };
    const checks = S.expect(r);
    return {
      scenario: name, title: S.title, simTime: +game.time.toFixed(3), pass: checks.every((c) => c.pass), checks,
      ...(r.perch ? { perch: r.perch } : {}), ...(r.vant ? { vantage: r.vant } : {}),
      transitions: transitions.filter((x) => x.sys !== 'ai.cover' && x.sys !== 'ai.behavior').slice(0, 120),
      director: ai.snapshot(), player: { hits: dummy.hits, damage: dummy.damageTaken },
      boot: { room: game.level.standIn ? 'stand-in' : 'level/room.js', weapons: !!createWeapon, hud: !!game.hud, rig: createCharacter ? 'character' : 'stub', posts: ai.posts.length, navNodes: game.level.nav ? game.level.nav.nodes.length : 0 },
    };
  };
  window.__game = game;
  window.__ai = { game, ai, report, transitions, scenario: name, duration: S.duration };
  document.getElementById('title').textContent = S.title;
  game.renderFrame(0);
  window.__ready = true;
  if (!test) runLive(game, S, report);
  return game;
}

// Directory listings from the local python server (core/main.js does the same).
async function listing(dirs) {
  const out = new Set();
  await Promise.all(dirs.map(async (d) => {
    try {
      const r = await fetch(new URL(d, import.meta.url), { cache: 'no-store' });
      if (!r.ok) return;
      const html = await r.text();
      for (const m of html.matchAll(/href="([^"?#]+)"/g)) out.add(d + decodeURIComponent(m[1]));
    } catch { /* no listing */ }
  }));
  return out;
}

function addShotLines(game) {
  const N = 48;
  const pos = new Float32Array(N * 6), colArr = new Float32Array(N * 6), born = new Float32Array(N).fill(-99);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false }));
  lines.frustumCulled = false; lines.renderOrder = 1990;
  game.scene.add(lines);
  let k = 0;
  game.events.on('shot', (e) => {
    const o = e.origin || e.muzzle.pos, t = e.end || (e.hit && e.hit.point);
    if (!o || !t) return;
    const i = k++ % N;
    pos.set([o.x, o.y, o.z, t.x, t.y, t.z], i * 6);
    const c = e.shooter && e.shooter.team === 'enemy' ? [1, 0.55, 0.2] : [0.3, 0.7, 1];
    colArr.set([...c, ...c], i * 6);
    born[i] = game.time;
  });
  const balls = [];
  for (let i = 0; i < 4; i++) { const m = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff3020 })); m.visible = false; game.scene.add(m); balls.push(m); }
  game.addSystem({
    name: 'shotlines', order: 96,
    frame() {
      for (let i = 0; i < N; i++) {
        const age = game.time - born[i];
        if (age > 0.6) { pos[i * 6 + 3] = pos[i * 6]; pos[i * 6 + 4] = pos[i * 6 + 1]; pos[i * 6 + 5] = pos[i * 6 + 2]; }
      }
      geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
      const live = (game.grenades && game.grenades.live) || [];
      balls.forEach((b, i) => { const g = live[i]; b.visible = !!g; if (g) b.position.set(g.pos.x, g.pos.y, g.pos.z); });
    },
  });
}

function runLive(game, S, report) {
  let last = performance.now(), done = false;
  const loop = (now) => {
    game.tick((now - last) / 1000);
    last = now;
    if (!done && game.time >= S.duration) { done = true; const r = report(); console.info('[ai test]', r.pass ? 'PASS' : 'FAIL', JSON.stringify(r.checks)); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
