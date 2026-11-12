// Climbing unit tests (node:test, no browser): node --test cover-room/tests/climb.test.mjs
// Seams per refs/design.md "Test seams": every expected value comes from refs/climb-spec.md tables or from the
// hand-placed geometry below, never recomputed the way climb.js computes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { Input } from '../src/core/input.js';
import { createWorld } from '../src/core/world.js';
import { ClimbData, Vec3 } from '../src/player/climb-data.js';
import { install, defineClimbParams, readClimbCfg } from '../src/player/climb.js';
import { Params } from '../src/core/params.js';

const N = [0, 0, 1];                         // wall face at z = 0, climber on +z, facing -z (right = +x)
const hold = (id, x, y, w = 0.25, extra = {}) => ({ id, kind: 'hold', pts: [[x - w / 2, y, 0], [x + w / 2, y, 0]], normal: N, ...extra });
const ledge = (id, x0, x1, y, extra = {}) => ({ id, kind: 'ledge', pts: [[x0, y, 0], [x1, y, 0]], normal: N, ...extra });

function cfg() {
  const P = new Params({ storageKey: null, search: '' });
  defineClimbParams(P);
  return readClimbCfg(P);
}

// ---------------------------------------------------------------------------------------------- hold search
test('hold search: the stick direction picks the hold in that direction', () => {
  const c = cfg();
  const d = new ClimbData({ edges: [
    ledge('L', -1, 1, 2.0),
    hold('UP', 0, 2.6),          // 0.6 m straight up
    hold('UR', 0.5, 2.5),        // up and to the right (~53 deg from horizontal)
    hold('UL', -0.7, 2.3),       // up-left, shallow
  ] });
  const L = d.get('L'), mv = {};
  const s0 = 1.0;                // grip centre at x = 0
  // stick straight up -> the hold straight above
  d.findMove(L, s0, 0.45, 0, 1, c, mv);
  assert.equal(mv.type, 'reach'); assert.equal(mv.edge.id, 'UP');
  // stick up-right at 53 deg (0.6, 0.8): UR lies on that ray; UP is ~47 deg off (outside the 40 deg cone)
  d.findMove(L, s0, 0.45, 0.6, 0.8, c, mv);
  assert.equal(mv.type, 'reach'); assert.equal(mv.edge.id, 'UR');
  // stick up-left (-0.6, 0.8): UL (dx -0.7, dy 0.3 from the grip centre) is in the cone, UP is not
  d.findMove(L, s0, 0.45, -0.6, 0.8, c, mv);
  assert.equal(mv.edge && mv.edge.id, 'UL');
  // horizontal stick on a ledge that continues -> shimmy, never a reach
  d.findMove(L, s0, 0.45, 1, 0, c, mv);
  assert.equal(mv.type, 'shimmy'); assert.equal(mv.dir, 1);
  // inside the stick deadzone (spec §1) -> no move
  d.findMove(L, s0, 0.45, 0.1, 0.1, c, mv);
  assert.equal(mv.type, 'none');
});

test('hold search: a reachable hold beats a nearer-angle lunge hold; Jump is needed only for the lunge tier', () => {
  const c = cfg();
  const d = new ClimbData({ edges: [ledge('L', -1, 1, 2.0), hold('FAR', 0, 3.2), hold('NEAR', 0.25, 2.6)] });
  const mv = {};
  d.findMove(d.get('L'), 1.0, 0.45, 0, 1, c, mv);
  assert.equal(mv.edge.id, 'NEAR'); assert.equal(mv.needsJump, false);
  const d2 = new ClimbData({ edges: [ledge('L', -1, 1, 2.0), hold('FAR', 0, 3.2)] });
  d2.findMove(d2.get('L'), 1.0, 0.45, 0, 1, c, mv);
  assert.equal(mv.type, 'lunge'); assert.equal(mv.edge.id, 'FAR'); assert.equal(mv.needsJump, true);
});

// ---------------------------------------------------------------------------------------------- reach limits
// climb-spec §1 table: reach max up 0.9 / side 0.8 / down 0.7; lunge max up 1.6 / side 2.0 / down 2.5 [INFERRED].
// Distances are hand-to-hold. Test values sit 0.1 m inside/outside each limit (hand-room slop is <= 0.03 m).
test('reach limits per direction class (spec §1 table)', () => {
  const c = cfg();
  const mv = {};
  const up = (dy) => {
    const d = new ClimbData({ edges: [hold('A', 0, 2.0), hold('B', 0, 2.0 + dy)] });
    return d.findMove(d.get('A'), d.get('A').len / 2, 0.45, 0, 1, c, mv).type;
  };
  assert.equal(up(0.8), 'reach');
  assert.equal(up(1.0), 'lunge');
  assert.equal(up(1.5), 'lunge');
  assert.equal(up(1.7), 'none');
  // side: from a single hold (no shimmy room) to a hold at the same height; d = right hand to the target's grip
  const side = (gap) => {
    // right hand sits at x = +0.1 on a 0.25 m hold (hands 0.2 apart); target grip point (centre - 0.025) at 0.1 + gap
    const d = new ClimbData({ edges: [hold('A', 0, 2.0), hold('B', 0.1 + gap + 0.025, 2.0)] });
    return d.findMove(d.get('A'), d.get('A').len / 2, 0.45, 1, 0, c, mv).type;
  };
  assert.equal(side(0.7), 'reach');
  assert.equal(side(0.9), 'lunge');
  assert.equal(side(1.9), 'lunge');
  assert.equal(side(2.1), 'none');
  const down = (dy) => {
    const d = new ClimbData({ edges: [hold('A', 0, 3.0), hold('B', 0, 3.0 - dy)] });
    return d.findMove(d.get('A'), d.get('A').len / 2, 0.45, 0, -1, c, mv).type;
  };
  assert.equal(down(0.6), 'reach');
  assert.equal(down(0.8), 'lunge');
  assert.equal(down(2.4), 'lunge');
  assert.notEqual(down(2.6), 'reach');
  assert.notEqual(down(2.6), 'lunge');
});

// ---------------------------------------------------------------------------------------------- dead zone
// climb-spec §2: jump-to-ledge <= 3.5 m above the floor; designers keep no edges 3.25-4.0 m (dead zone) [DEV, Schatz];
// avoid band 0.5-0.8 m [INFERRED].
test('dead-zone rule: the validator flags edges 3.25-4.0 m (and 0.5-0.8 m) above the floor in front', () => {
  const d = new ClimbData({ edges: [
    ledge('h3.2', 0, 1, 3.2), ledge('h3.3', 2, 3, 3.3), ledge('h3.9', 4, 5, 3.9), ledge('h4.1', 6, 7, 4.1),
    ledge('h0.6', 8, 9, 0.6), ledge('h2.2', 10, 11, 2.2),
  ] });
  const issues = d.validate({ floorAt: () => 0 });
  const dead = issues.filter((i) => i.rule === 'dead-zone').map((i) => i.id).sort();
  const avoid = issues.filter((i) => i.rule === 'avoid-band').map((i) => i.id);
  assert.deepEqual(dead, ['h3.3', 'h3.9']);
  assert.deepEqual(avoid, ['h0.6']);
  // a floor raised under an edge changes its height: 4.1 m edge over a 0.5 m step is 3.6 m -> dead zone
  const raised = d.validate({ floorAt: (x) => (x >= 6 && x <= 7 ? 0.5 : 0) });
  assert.ok(raised.some((i) => i.id === 'h4.1' && i.rule === 'dead-zone'));
});

test('jump-to-grab band: 1.6-3.5 m above the feet, measured from the feet', () => {
  for (const [h, want] of [[1.4, false], [2.2, true], [3.0, true], [3.45, true], [3.6, false]]) {
    const { game, actor } = rig({ edges: [ledge('E', -2, 2, h)] });
    actor.pos.set(0, 0, 0.7); actor.yaw = Math.PI;               // 0.7 m from the wall, facing it
    const g = game.climb.canGrab(actor, { fromAir: false });
    assert.equal(!!(g && g.type === 'hang'), want, `edge at ${h} m`);
  }
  // same edge, feet raised 1 m: a 4.1 m edge is now 3.1 m above the feet -> grabbable (heights from the feet)
  const { game, actor } = rig({ edges: [ledge('E', -2, 2, 4.1)] });
  actor.pos.set(0, 1.0, 0.7); actor.yaw = Math.PI;
  assert.equal(game.climb.canGrab(actor, {}).type, 'hang');
});

// ---------------------------------------------------------------------------------------------- live mode rig
function rig(markup, { boxes = [] } = {}) {
  const game = new Game({ test: true });
  game.world = createWorld({ Vector3: Vec3 });
  game.world.addBox({ center: [0, -0.5, 0], size: [40, 1, 40] }, { tags: ['floor'] });   // floor top at y = 0
  for (const b of boxes) game.world.addBox(b);
  game.level = { climb: markup };
  game.input = game.addSystem(new Input(game, {}));
  const actor = { id: 'p', team: 'player', pos: new Vec3(), vel: new Vec3(), yaw: 0, height: 1.8, radius: 0.35, alive: true };
  const ctrl = {
    mode: 'ground', modes: {},
    registerMode(n, impl) { this.modes[n] = impl; },
    setMode(n, ctx) {
      const prev = this.mode;
      if (this.modes[prev] && this.modes[prev].exit) this.modes[prev].exit(n);
      this.mode = n;
      game.events.emit('state', { actor, sys: 'move', from: prev, to: n, t: game.time });
      if (this.modes[n] && this.modes[n].enter) this.modes[n].enter(prev, ctx);
    },
  };
  actor.ctrl = ctrl;
  game.player = actor; game.actors.push(actor);
  install(game);
  game.addSystem({ name: 'ctrl', order: 10, update(dt) { const m = ctrl.modes[ctrl.mode]; if (m && m.update) m.update(dt); } });
  const log = [];
  game.events.on('state', (e) => { if (e.sys === 'climb') log.push({ from: e.from, to: e.to, t: +game.time.toFixed(6) }); });
  return { game, actor, ctrl, log };
}

// Hang on `edgeId` at its x position via the air catch (hands just passing the edge while falling).
function hangOn(game, actor, ctrl, edgeY, x) {
  actor.pos.set(x, edgeY - 2.1 + 0.1, 0.35); actor.yaw = Math.PI; actor.vel.set(0, -1, 0);
  const g = game.climb.canGrab(actor, { fromAir: true });
  assert.ok(g, 'air catch should find the edge');
  ctrl.setMode('climb', { grab: g });
  game.stepN(12);                                                 // catch settle (0.1 s) -> hang
  assert.equal(game.climb.state(actor), 'hang');
}

const spans = (log, state) => {
  const out = [];
  for (let i = 0; i < log.length; i++) if (log[i].to === state) {
    const j = log.findIndex((e, k) => k > i && e.from === state);
    if (j > 0) out.push(+(log[j].t - log[i].t).toFixed(4));
  }
  return out;
};
const STEP = 1 / 60;

test('shimmy speed: steady state ≈1.3 m/s along the ledge (spec §3 [MEASURED-WA])', () => {
  const { game, actor, ctrl } = rig({ edges: [ledge('L', -5, 5, 2.2)] });
  hangOn(game, actor, ctrl, 2.2, -3);
  game.input.inject({ move: { x: 1, y: 0 } });
  game.stepN(30);                                                 // 0.5 s: past the 0.15 s acceleration
  const x0 = actor.pos.x;
  game.stepN(60);                                                 // exactly 1.0 s of sim
  const v = actor.pos.x - x0;
  assert.ok(Math.abs(v - 1.3) < 0.02, `shimmy ${v.toFixed(3)} m/s, spec 1.3`);
  assert.equal(game.climb.state(actor), 'shimmy');
  assert.ok(Math.abs(actor.pos.z - 0.30) < 1e-6, 'body stays on the hang line');
  game.input.inject(null);
  game.stepN(20);
  assert.equal(game.climb.state(actor), 'hang');
});

test('reach cycle ≈0.43 s at a 0.6 m gain, hands alternate (spec §1 [MEASURED h2K], Kotaku)', () => {
  const edges = [ledge('L', -2, 2, 2.0)];
  for (let i = 1; i <= 4; i++) edges.push(hold('H' + i, 0, 2.0 + 0.6 * i));
  const { game, actor, ctrl, log } = rig({ edges });
  hangOn(game, actor, ctrl, 2.0, 0);
  const leads = [];
  game.events.on('state', (e) => { if (e.sys === 'climb' && e.to === 'reach') leads.push(game.climb.modeFor(actor).lead); });
  game.input.inject({ move: { x: 0, y: 1 } });
  game.stepN(120);
  const r = spans(log, 'reach');
  assert.equal(r.length, 4, `4 reaches, got ${r.length}`);
  for (const d of r) assert.ok(Math.abs(d - 0.43) <= STEP + 1e-6, `reach ${d} s vs spec 0.43`);
  for (let i = 1; i < leads.length; i++) assert.notEqual(leads[i], leads[i - 1], 'lead hand alternates');
  game.input.inject(null);
  game.stepN(20);                                                 // let the 8 cm lean feedback (§7) return
  assert.ok(Math.abs(actor.pos.y - (2.0 + 2.4 - 2.0)) < 1e-6, 'hanging from H4 (hands-to-feet 2.0 m)');
});

test('climb-up: crouched on top at 0.65 s, standing with control at 1.0 s (spec §3 [MEASURED h2K])', () => {
  const { game, actor, ctrl, log } = rig({ edges: [ledge('T', -2, 2, 2.4, { kind: 'top', top: true })] });
  hangOn(game, actor, ctrl, 2.4, 0);
  game.input.inject({ move: { x: 0, y: 1 } });
  game.stepN(80);
  const crouch = spans(log, 'climbUp')[0];
  const start = log.find((e) => e.to === 'climbUp').t, end = log.find((e) => e.to === 'none').t;
  assert.ok(Math.abs(crouch - 0.65) <= STEP + 1e-6, `to crouch ${crouch}`);
  assert.ok(Math.abs(end - start - 1.0) <= STEP + 1e-6, `to standing ${end - start}`);
  assert.equal(ctrl.mode, 'ground');
  assert.ok(Math.abs(actor.pos.y - 2.4) < 1e-6 && Math.abs(actor.pos.z - (-0.4)) < 1e-6, 'standing 0.4 m in from the lip');
});

test('hang-aim: enter 0.15-0.20 s, exit ≈0.30 s, actor.hangAim + camera hint (spec §5 [MEASURED-WA])', () => {
  const { game, actor, ctrl, log } = rig({ edges: [ledge('L', -2, 2, 2.4)] });
  hangOn(game, actor, ctrl, 2.4, 0);
  game.input.inject({ aim: true });
  game.stepN(30);
  assert.equal(actor.hangAim, true); assert.equal(actor.cameraProfile, 'hangAim'); assert.equal(actor.anim.climb.pose, 'hangAim');
  const enter = spans(log, 'hangAimEnter')[0];
  assert.ok(enter >= 0.15 - 1e-6 && enter <= 0.20 + STEP, `enter ${enter}`);
  game.input.inject(null);
  game.stepN(30);
  const exit = spans(log, 'hangAimExit')[0];
  assert.ok(Math.abs(exit - 0.30) <= STEP + 1e-6, `exit ${exit}`);
  assert.equal(actor.hangAim, false); assert.equal(actor.cameraProfile, 'climb');
});

test('drop and re-catch: the released edge is ignored, an edge below is caught', () => {
  const { game, actor, ctrl } = rig({ edges: [ledge('LOW', -2, 2, 3.0), ledge('HIGH', -2, 2, 4.4)] });
  hangOn(game, actor, ctrl, 4.4, 0);
  game.input.inject({ cover: true });
  game.step();
  game.input.inject(null);
  assert.equal(ctrl.mode, 'air');
  // minimal air mode: gravity 18 (spec §4 [INFERRED]) + the catch test every step, as B1's air mode will do
  let caught = null;
  for (let i = 0; i < 90 && !caught; i++) {
    actor.vel.y -= 18 * STEP; actor.pos.y += actor.vel.y * STEP;
    const g = game.climb.canGrab(actor, { fromAir: true });
    if (g) { caught = g.edgeId; ctrl.setMode('climb', { grab: g }); }
    game.step();
  }
  assert.equal(caught, 'LOW');
});

test('mantle and vault detection against world boxes (spec §2 bands)', () => {
  // 1.2 m block 0.5 m ahead -> mantle; 0.9 m thin wall while running -> vault; 0.4 m step -> nothing
  const block = { center: [0, 0.6, -1.0], size: [2, 1.2, 1.0] };
  let { game, actor } = rig({ edges: [] }, { boxes: [block] });
  actor.pos.set(0, 0, 0.1); actor.yaw = Math.PI;
  let g = game.climb.canGrab(actor, {});
  assert.equal(g && g.type, 'mantle');
  assert.ok(Math.abs(g.standPos.y - 1.2) < 1e-6);
  ({ game, actor } = rig({ edges: [] }, { boxes: [{ center: [0, 0.45, -0.6], size: [3, 0.9, 0.3] }] }));
  actor.pos.set(0, 0, 0.1); actor.yaw = Math.PI; actor.vel.set(0, 0, -4);
  g = game.climb.canGrab(actor, {});
  assert.equal(g && g.type, 'vault');
  assert.ok(g.farPos.z < -0.75, 'lands beyond the wall');
  ({ game, actor } = rig({ edges: [] }, { boxes: [{ center: [0, 0.2, -0.6], size: [3, 0.4, 1] }] }));
  actor.pos.set(0, 0, 0.1); actor.yaw = Math.PI;
  assert.equal(game.climb.canGrab(actor, {}), null);
});

test('markup adapter: design.md {a, b} edges, reversed polylines and corners', () => {
  const d = new ClimbData({ edges: [
    { id: 'AB', kind: 'ledge', a: { x: 2, y: 2, z: 0 }, b: { x: -2, y: 2, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
    { id: 'T1', kind: 'top', pts: [[-6, 6, -10.8], [6, 6, -10.8], [6, 6, 0]], normal: [0, 0, 1] },
    { id: 'OUT', kind: 'ledge', pts: [[0, 2, 0], [4, 2, 0], [4, 2, -3]], normal: [0, 0, 1] },
  ] });
  const ab = d.get('AB'), p = new Vec3();
  d.pointAt(ab, 0, p);
  assert.equal(p.x, -2, 'reversed so +s runs to the climber\'s right (+x when facing -z)');
  assert.equal(d.get('T1').corners[1], 'inner');
  assert.equal(d.get('OUT').corners[1], 'outer');
  d.normalAt(d.get('T1'), 13, 0, p);
  assert.deepEqual([p.x, p.z], [-1, 0], 'second segment faces -x (into the courtyard)');
});

test('outer corner: shimmy wraps around, emits a corner state, ends facing the side face', () => {
  // ledge along the front face (normal +z), turning 90 deg around an outer corner at x = 2.12 onto the side face (normal +x)
  const { game, actor, ctrl, log } = rig({ edges: [{ id: 'C', kind: 'ledge', pts: [[-1, 2.6, 0.12], [2.12, 2.6, 0.12], [2.12, 2.6, -3]], normal: [0, 0, 1] }] });
  hangOn(game, actor, ctrl, 2.6, 0.8);
  game.input.inject({ move: { x: 1, y: 0 } });
  game.stepN(150);                                                // 2.5 s at 1.3 m/s: well past the corner
  game.input.inject(null);
  game.stepN(20);
  assert.ok(log.some((e) => e.to === 'corner'), 'corner state emitted');
  assert.ok(Math.abs(wrapPi(actor.yaw - (-Math.PI / 2))) < 1e-6, `faces -x after the corner, yaw ${actor.yaw}`);
  assert.ok(actor.pos.z < -0.5, 'moved along the side face');
  assert.ok(Math.abs(actor.pos.x - (2.12 + 0.30)) < 1e-6, 'on the side face hang line (0.30 m out)');
});

function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
