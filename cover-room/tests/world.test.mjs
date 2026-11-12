// Geometry seam tests for src/core/world.js (refs/design.md "Test seams" #2). Run: node --test cover-room/tests/
// Every expected value below is worked out by hand from the box/capsule geometry in the comment next to it,
// never by calling the code's own math. Tolerances: 1e-9 for closed-form geometry; the capsule mover's 1 mm skin
// width where the skin is the only difference from the exact contact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, bounce } from '../src/core/world.js';

// Minimal stand-in for THREE.Vector3: the only surface world.js may use.
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
const v = (x, y, z) => new V3(x, y, z);
const SQ2 = Math.SQRT2;
const SKIN = 0.001;

function near(a, b, tol = 1e-9, msg = '') {
  assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b}, got ${a} (tol ${tol})`);
}
function nearV(p, [x, y, z], tol = 1e-9, msg = '') {
  near(p.x, x, tol, msg + '.x'); near(p.y, y, tol, msg + '.y'); near(p.z, z, tol, msg + '.z');
}
function within(a, lo, hi, msg = '') {
  assert.ok(a >= lo - 1e-12 && a <= hi + 1e-12, `${msg} expected in [${lo}, ${hi}], got ${a}`);
}
const newWorld = (cellSize) => createWorld({ Vector3: V3, cellSize });
function floorWorld() { // 40 x 40 floor slab, top at y = 0
  const w = newWorld();
  w.addBox({ center: v(0, -0.5, 0), size: v(40, 1, 40) }, { tags: ['floor'] });
  return w;
}
function makeActor(x, y, z, extra = {}) {
  return { id: 'a', team: 'enemy', pos: v(x, y, z), vel: v(), yaw: 0, height: 1.8, radius: 0.35, alive: true, rig: null, ...extra };
}
const G_STEP = -9.81 / 3600; // one 1/60 s step of gravity from rest: -g dt^2 (m)

// ------------------------------------------------------------------------------------------------ raycast
test('raycast hits an axis-aligned box face', () => {
  const w = newWorld();
  const box = w.addBox({ center: v(5, 1, 0), size: v(2, 2, 2) }, { tags: 'crate' });
  // box spans x 4..6, y 0..2; a ray along +x at y=1 enters the x=4 face after 4 m.
  const hit = w.raycast(v(0, 1, 0), v(1, 0, 0), 100);
  assert.ok(hit);
  nearV(hit.point, [4, 1, 0]);
  nearV(hit.normal, [-1, 0, 0]);
  near(hit.dist, 4);
  assert.equal(hit.collider, box);
  assert.equal(hit.actor, null);
  // dir need not be unit length
  near(w.raycast(v(0, 1, 0), v(2, 0, 0), 100).dist, 4);
});

test('raycast hits a 45-degree yawed box on the correct face', () => {
  const w = newWorld();
  w.addBox({ center: v(0, 1, 10), size: v(2, 2, 2), yaw: Math.PI / 4 });
  // A 2x2 square turned 45 deg is a diamond with vertices (±√2, 0), (0, ±√2) about its centre.
  // Its south-east edge runs (0,-√2) -> (√2,0): the line x - z = √2 (centre-relative).
  // A ray along +z at x = 0.5 meets it at z = 0.5 - √2, i.e. world z = 10.5 - √2.
  // Outward normal of that edge: (1, 0, -1)/√2 (the box's local +X face).
  const hit = w.raycast(v(0.5, 1, 0), v(0, 0, 1), 100);
  assert.ok(hit);
  near(hit.dist, 10.5 - SQ2);
  nearV(hit.point, [0.5, 1, 10.5 - SQ2]);
  nearV(hit.normal, [1 / SQ2, 0, -1 / SQ2]);
});

test('yaw follows Object3D.rotation.y: a 90-degree yaw swaps the X and Z extents', () => {
  // size (4, 2, 1) yawed 90 deg covers x ±0.5 and z ±2 (local X maps to world -Z).
  const w = newWorld();
  w.addBox({ center: v(0, 1, 0), size: v(4, 2, 1), yaw: Math.PI / 2 });
  const hit = w.raycast(v(-5, 1, 1.5), v(1, 0, 0), 100);
  assert.ok(hit);
  near(hit.dist, 4.5); // reaches the x = -0.5 face
  nearV(hit.normal, [-1, 0, 0]);
  // the same box without yaw only reaches z ±0.5, so the ray at z = 1.5 misses
  const w2 = newWorld();
  w2.addBox({ center: v(0, 1, 0), size: v(4, 2, 1) });
  assert.equal(w2.raycast(v(-5, 1, 1.5), v(1, 0, 0), 100), null);
});

test('raycast misses: wrong direction, beyond maxDist, origin inside a box', () => {
  const w = newWorld();
  w.addBox({ center: v(5, 1, 0), size: v(2, 2, 2) });
  assert.equal(w.raycast(v(0, 1, 0), v(-1, 0, 0), 100), null);   // pointing away
  assert.equal(w.raycast(v(0, 1, 0), v(0, 1, 0), 100), null);    // straight up
  assert.equal(w.raycast(v(0, 1, 0), v(1, 0, 0), 3.99), null);   // face is 4 m away
  near(w.raycast(v(0, 1, 0), v(1, 0, 0), 4).dist, 4);            // exactly at maxDist still counts
  assert.equal(w.raycast(v(5, 1, 0), v(1, 0, 0), 100), null);    // starts inside: that box is not hit
});

test('raycast hits the fallback capsule of an actor without a rig', () => {
  const w = newWorld();
  const a = makeActor(0, 0, 5);
  w.addHitboxes(a, null);
  w.updateHitboxes();
  // fallback capsule: axis x=0,z=5 from y = 0.35 to y = 1.8 - 0.35 = 1.45, radius 0.35
  let hit = w.raycast(v(0, 1, 0), v(0, 0, 1), 100);
  assert.ok(hit);
  near(hit.dist, 5 - 0.35);
  nearV(hit.normal, [0, 0, -1]);
  assert.equal(hit.actor, a);
  assert.equal(hit.part, 'torso');
  assert.equal(hit.collider, null);
  // at y = 1.7 the ray passes 0.25 above the top sphere's centre (y 1.45): half-chord √(0.35² - 0.25²) = √0.06
  hit = w.raycast(v(0, 1.7, 0), v(0, 0, 1), 100);
  near(hit.dist, 5 - Math.sqrt(0.06));
  nearV(hit.normal, [0, 0.25 / 0.35, -Math.sqrt(0.06) / 0.35]);
  // 0.4 m to the side of the axis (> 0.35): miss
  assert.equal(w.raycast(v(0.4, 1, 0), v(0, 0, 1), 100), null);
  // the actor moves; hitboxes follow on the next update
  a.pos.set(1, 0, 5);
  w.updateHitboxes();
  near(w.raycast(v(1, 1, 0), v(0, 0, 1), 100).dist, 4.65);
});

test('raycast hits a rig-driven capsule placed from the bone world matrix', () => {
  // Bone at world (1, 1.6, 5), rotated +90 deg about Z: local +Y -> world -X. Column-major matrixWorld.
  const elements = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 1.6, 5, 1];
  const rig = {
    bones: { hand_r: { matrixWorld: { elements } } },
    getBoneWorld(name, out) { const e = this.bones[name].matrixWorld.elements; return out.set(e[12], e[13], e[14]); },
  };
  const w = newWorld();
  const a = makeActor(0, 0, 0, { rig });
  w.addHitboxes(a, [{ bone: 'hand_r', a: v(0, 0, 0), b: v(0, 0.3, 0), radius: 0.1, part: 'limb' }]);
  w.updateHitboxes();
  // capsule from A = (1, 1.6, 5) to B = (1 - 0.3, 1.6, 5) = (0.7, 1.6, 5), radius 0.1
  let hit = w.raycast(v(0.85, 1.6, 0), v(0, 0, 1), 100); // body, between A and B
  near(hit.dist, 4.9);
  nearV(hit.normal, [0, 0, -1]);
  assert.equal(hit.part, 'limb');
  assert.equal(hit.actor, a);
  hit = w.raycast(v(0.65, 1.6, 0), v(0, 0, 1), 100); // 0.05 past B: B's sphere, half-chord √(0.1² - 0.05²)
  near(hit.dist, 5 - Math.sqrt(0.0075));
  nearV(hit.normal, [-0.05 / 0.1, 0, -Math.sqrt(0.0075) / 0.1]);
  assert.equal(w.raycast(v(1.2, 1.6, 0), v(0, 0, 1), 100), null); // 0.2 past A: miss
  // a scaled bone matrix gives the same capsule (offsets stay in meters)
  elements.splice(0, 12, 0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0);
  w.updateHitboxes();
  near(w.raycast(v(0.65, 1.6, 0), v(0, 0, 1), 100).dist, 5 - Math.sqrt(0.0075));
  // rig removed -> fallback capsule at the feet (0,0,0): ray at x=0,y=1 along +z from z=-5 hits z = -0.35
  a.rig = null;
  w.updateHitboxes();
  near(w.raycast(v(0, 1, -5), v(0, 0, 1), 100).dist, 5 - 0.35);
});

test('raycast filters: ignore, hitActors, dead actors, tags, skipTags', () => {
  const w = newWorld();
  const glass = w.addBox({ center: v(2, 1, 0), size: v(0.1, 2, 2) }, { tags: ['glass'] }); // face x = 1.95
  const wall = w.addBox({ center: v(10, 1, 0), size: v(1, 2, 2) }, { tags: ['wall'] });   // face x = 9.5
  const a = makeActor(5, 0, 0);
  w.addHitboxes(a, null);
  w.updateHitboxes();
  const o = v(0, 1, 0), d = v(1, 0, 0);
  assert.equal(w.raycast(o, d, 100).collider, glass);
  assert.equal(w.raycast(o, d, 100, { skipTags: 'glass' }).actor, a);                  // 5 - 0.35 = 4.65
  near(w.raycast(o, d, 100, { skipTags: 'glass' }).dist, 4.65);
  assert.equal(w.raycast(o, d, 100, { skipTags: ['glass'], ignore: a }).collider, wall);
  assert.equal(w.raycast(o, d, 100, { skipTags: new Set(['glass']), hitActors: false }).collider, wall);
  assert.equal(w.raycast(o, d, 100, { ignore: new Set([glass, a]) }).collider, wall);
  assert.equal(w.raycast(o, d, 100, { tags: 'wall', hitActors: false }).collider, wall);
  assert.equal(w.raycast(o, d, 100, { mask: 'wall', hitActors: false }).collider, wall);
  a.alive = false;
  assert.equal(w.raycast(o, d, 100, { skipTags: 'glass' }).collider, wall);
  assert.equal(w.raycast(o, d, 100, { skipTags: 'glass', includeDead: true }).actor, a);
});

test('raycast reuses its result object unless opts.out is given', () => {
  const w = newWorld();
  w.addBox({ center: v(5, 1, 0), size: v(2, 2, 2) });
  const h1 = w.raycast(v(0, 1, 0), v(1, 0, 0), 100);
  const h2 = w.raycast(v(0, 1, 0), v(1, 0, 0), 100);
  assert.equal(h1, h2);
  const mine = w.makeHit();
  const h3 = w.raycast(v(0, 1, 0), v(1, 0, 0), 100, { out: mine });
  assert.equal(h3, mine);
  assert.ok(h3.point instanceof V3 && h3.normal instanceof V3);
});

// ------------------------------------------------------------------------------------------------ broadphase
test('grid broadphase: rays crossing many cells find the hand-placed target', () => {
  const w = newWorld(2);
  for (let i = 0; i < 12; i++) w.addBox({ center: v(i * 2.5, 1, 4), size: v(1, 2, 1) }); // decoy row at z=4
  w.addBox({ center: v(9, 1, 3), size: v(1, 2, 1) });                                     // z 2.5..3.5: off the ray
  const target = w.addBox({ center: v(21, 1, 0), size: v(1, 2, 1) });                     // face x = 20.5
  let hit = w.raycast(v(-3, 1, 0), v(1, 0, 0), 100);
  assert.equal(hit.collider, target);
  near(hit.dist, 23.5);
  hit = w.raycast(v(-50, 1, 0), v(1, 0, 0), Infinity); // starts outside the filled grid
  near(hit.dist, 70.5);
  // diagonal (away from the decoys): box x 9..11, z -12..-8. Along x = -z the ray reaches z = -8 at x = 8
  // (outside the x range), then x = 9 at z = -9 (inside the z range): hit (9, 1, -9), dist 9√2, normal -X.
  const diag = w.addBox({ center: v(10, 1, -10), size: v(2, 2, 4) });
  hit = w.raycast(v(0, 1, 0), v(1, 0, -1), 100);
  assert.equal(hit.collider, diag);
  near(hit.dist, 9 * SQ2);
  nearV(hit.point, [9, 1, -9]);
  nearV(hit.normal, [-1, 0, 0]);
  // a 30 m wall filed in many cells: ray along +z from z = -10 hits its z = -3.5 face
  w.addBox({ center: v(15, 1, -3), size: v(30, 2, 1) });
  hit = w.raycast(v(5, 1, -10), v(0, 0, 1), 100);
  near(hit.dist, 6.5);
  assert.ok(w.stats().cells > 20);
});

test('grid broadphase agrees with a single-cell world on 600 random rays (150 random yawed boxes)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const grid = newWorld(2), flat = newWorld(1000); // cellSize 1000: one cell, no traversal
  for (let i = 0; i < 150; i++) {
    const box = { center: v(rnd() * 30 - 15, rnd() * 2, rnd() * 22 - 11), size: v(0.2 + rnd() * 3, 0.2 + rnd() * 2, 0.2 + rnd() * 3), yaw: rnd() * Math.PI };
    grid.addBox(box); flat.addBox(box);
  }
  let hits = 0;
  for (let i = 0; i < 600; i++) {
    const o = v(rnd() * 40 - 20, rnd() * 3, rnd() * 30 - 15);
    const d = v(rnd() * 2 - 1, rnd() * 0.4 - 0.2, rnd() * 2 - 1);
    const a = grid.raycast(o, d, 60), b = flat.raycast(o, d, 60);
    assert.equal(!!a, !!b, `ray ${i}`);
    if (a) { hits++; near(a.dist, b.dist, 1e-9, `ray ${i}`); assert.equal(a.collider.id, b.collider.id); }
  }
  assert.ok(hits > 150, `only ${hits} hits: the comparison would not mean much`);
});

test('removeCollider and updateBox keep the broadphase in sync', () => {
  const w = newWorld();
  const near1 = w.addBox({ center: v(3, 1, 0), size: v(1, 2, 1) });   // face x = 2.5
  w.addBox({ center: v(8, 1, 0), size: v(1, 2, 1) });                 // face x = 7.5
  near(w.raycast(v(0, 1, 0), v(1, 0, 0), 100).dist, 2.5);
  w.updateBox(near1, { center: v(5, 1, 0) });                         // face moves to x = 4.5
  near(w.raycast(v(0, 1, 0), v(1, 0, 0), 100).dist, 4.5);
  w.updateBox(near1, { center: v(5, 1, 0), size: v(1, 2, 1), yaw: Math.PI / 4 }); // diamond: tip at x = 5 - √2/2
  near(w.raycast(v(0, 1, 0), v(1, 0, 0), 100).dist, 5 - SQ2 / 2);
  assert.ok(w.removeCollider(near1));
  near(w.raycast(v(0, 1, 0), v(1, 0, 0), 100).dist, 7.5);
  assert.equal(w.colliders.length, 1);
});

// ------------------------------------------------------------------------------------------------ moveCapsule
test('moveCapsule: 45-degree push into a wall keeps the exact tangential motion', () => {
  const w = floorWorld();
  const wall = w.addBox({ center: v(1.5, 1, 0), size: v(1, 2, 10) }); // face x = 1
  const a = makeActor(0, 0, 0);
  // delta (1, 0, 1). Contact when the centre is r = 0.35 from x = 1: x = 0.65 (z = 0.65 too).
  // The remaining (0.35, 0.35) loses its normal (x) part and keeps 0.35 of z: final z = 1.0.
  const res = w.moveCapsule(a, v(1, 0, 1));
  near(a.pos.z, 1.0, 1e-9, 'z');
  within(a.pos.x, 0.65 - SKIN - 1e-6, 0.65, 'x');
  near(a.pos.y, 0);
  assert.ok(res.hitWall);
  assert.equal(res.wallCollider, wall);
  nearV(res.wallNormal, [-1, 0, 0]);
  assert.ok(res.grounded);
});

test('moveCapsule: sliding along a wall yawed 45 degrees', () => {
  const w = floorWorld();
  w.addBox({ center: v(0, 1, 3), size: v(10, 2, 1), yaw: Math.PI / 4 });
  // The wall's local -Z face has world normal n = (-1, 0, -1)/√2 and lies on x + z = 3 - 0.5√2.
  // Moving +z from the origin, contact when x + z = 3 - 0.85√2 (0.35 m off the face), i.e. z_c = 3 - 0.85√2.
  // The rest, 0.85√2 along +z, keeps only its tangential part: 0.85√2 · cos45 = 0.85 along t = (-1, 0, 1)/√2.
  // Final centre (-0.85/√2, 3 - 0.85/√2), pushed a further 1 mm along n by the skin.
  // So the total motion along t is exactly the input's tangential part: (0,0,3)·t = 3/√2.
  const a = makeActor(0, 0, 0);
  const res = w.moveCapsule(a, v(0, 0, 3));
  const along = (-a.pos.x + a.pos.z) / SQ2;
  near(along, 3 / SQ2, 1e-9, 'tangential');
  const gap = (3 - 0.5 * SQ2 - (a.pos.x + a.pos.z)) / SQ2; // centre-to-face distance
  within(gap, 0.35, 0.35 + SKIN + 1e-6, 'gap');
  near(a.pos.x, -0.85 / SQ2 - SKIN / SQ2, 1e-6, 'x');
  near(a.pos.z, 3 - 0.85 / SQ2 - SKIN / SQ2, 1e-6, 'z');
  nearV(res.wallNormal, [-1 / SQ2, 0, -1 / SQ2]);
});

test('moveCapsule: two walls meeting at a corner stop the motion without jitter', () => {
  const w = floorWorld();
  w.addBox({ center: v(1.5, 1, 0), size: v(1, 2, 10) }); // face x = 1
  w.addBox({ center: v(0, 1, 1.5), size: v(10, 2, 1) }); // face z = 1
  const a = makeActor(0, 0, 0);
  for (let i = 0; i < 20; i++) w.moveCapsule(a, v(0.15, G_STEP, 0.15));
  within(a.pos.x, 0.65 - 2 * SKIN, 0.65, 'x'); // 1 - r on both axes, minus skin
  within(a.pos.z, 0.65 - 2 * SKIN, 0.65, 'z');
  near(a.pos.y, 0);
});

test('moveCapsule: steps up onto 0.3 m, is blocked by 0.4 m (stepHeight 0.35)', () => {
  // 9 m/s at 60 Hz = 0.15 m per step; 12 steps = 1.8 m. The box spans x 1..2.
  const up = floorWorld();
  up.addBox({ center: v(1.5, 0.15, 0), size: v(1, 0.3, 4) }); // top 0.3
  const a = makeActor(0, 0, 0);
  let stepped = false, res;
  for (let i = 0; i < 12; i++) { res = up.moveCapsule(a, v(0.15, G_STEP, 0)); stepped ||= res.stepped; }
  near(a.pos.x, 1.8, 1e-9, 'x');
  near(a.pos.y, 0.3, 1e-12, 'y on the step top');
  assert.ok(res.grounded && stepped && !res.hitWall);
  near(res.groundY, 0.3, 1e-12);

  const blocked = floorWorld();
  blocked.addBox({ center: v(1.5, 0.2, 0), size: v(1, 0.4, 4) }); // top 0.4
  const b = makeActor(0, 0, 0);
  for (let i = 0; i < 12; i++) res = blocked.moveCapsule(b, v(0.15, G_STEP, 0));
  within(b.pos.x, 0.65 - SKIN - 1e-6, 0.65, 'x stops r short of the face');
  near(b.pos.y, 0);
  assert.ok(res.hitWall && res.grounded);
  nearV(res.wallNormal, [-1, 0, 0]);
});

test('moveCapsule: no step-up where the head would not fit', () => {
  const w = floorWorld();
  w.addBox({ center: v(1.5, 0.15, 0), size: v(1, 0.3, 4) });  // 0.3 step, x 1..2
  w.addBox({ center: v(1.5, 2.25, 0), size: v(1, 0.5, 4) });  // ceiling bottom at 2.0 over the step only
  const a = makeActor(0, 0, 0);                                 // 1.8 tall: fits at y=0 (head 1.8), not at 0.3 (2.1)
  for (let i = 0; i < 12; i++) w.moveCapsule(a, v(0.15, G_STEP, 0));
  near(a.pos.y, 0);
  // stepping would start once the 0.175 m footprint reaches the step face at x = 1
  assert.ok(a.pos.x <= 1 - 0.175 + 1e-9, `x ${a.pos.x}`);
});

test('moveCapsule: snaps down a 0.2 m drop, falls off a 0.5 m drop', () => {
  // platform x -1..1; walking +x the 0.175 m footprint leaves it at x > 1.175; we end at x = 1.8.
  const w = floorWorld();
  w.addBox({ center: v(0, 0.1, 0), size: v(2, 0.2, 4) }); // top 0.2
  const a = makeActor(0, 0.2, 0);
  let res = w.moveCapsule(a, v(0, 0, 0));
  assert.ok(res.grounded);
  for (let i = 0; i < 12; i++) res = w.moveCapsule(a, v(0.15, 0, 0));
  near(a.pos.x, 1.8, 1e-9);
  near(a.pos.y, 0, 1e-12, 'snapped to the floor');
  assert.ok(res.grounded);

  const hi = floorWorld();
  hi.addBox({ center: v(0, 0.25, 0), size: v(2, 0.5, 4) }); // top 0.5 > snapDown 0.3
  const b = makeActor(0, 0.5, 0);
  hi.moveCapsule(b, v(0, 0, 0));
  for (let i = 0; i < 12; i++) res = hi.moveCapsule(b, v(0.15, 0, 0));
  near(b.pos.y, 0.5, 1e-12, 'stays at 0.5 (no gravity in delta)');
  assert.equal(res.grounded, false);
  near(res.groundY, 0, 1e-12);
});

test('moveCapsule: no tunnelling through a 0.2 m wall at 9 m/s, 60 Hz', () => {
  const w = floorWorld();
  w.addBox({ center: v(1.1, 1, 0), size: v(0.2, 2, 4) }); // faces x = 1.0 and 1.2
  const a = makeActor(0, 0, 0);
  for (let i = 0; i < 30; i++) {
    w.moveCapsule(a, v(0.15, G_STEP, 0));
    assert.ok(a.pos.x <= 0.65, `step ${i}: x ${a.pos.x}`);
  }
  within(a.pos.x, 0.65 - SKIN - 1e-6, 0.65);
  const b = makeActor(0, 0, 0);
  w.moveCapsule(b, v(10, 0, 0)); // one huge step
  within(b.pos.x, 0.65 - SKIN - 1e-6, 0.65);
});

test('moveCapsule: lands on the floor and stops at a ceiling', () => {
  const w = floorWorld();
  w.addBox({ center: v(0, 2.25, 0), size: v(4, 0.5, 4) }); // ceiling bottom y = 2.0
  const a = makeActor(0, 0, 0);
  const res = w.moveCapsule(a, v(0, 0.5, 0)); // head would reach 2.3
  near(a.pos.y, 2.0 - 1.8, 1e-12);
  assert.ok(res.hitCeiling && !res.grounded);
  const b = makeActor(5, 0.05, 0);
  const r2 = w.moveCapsule(b, v(0, -0.2, 0)); // falling 0.2 from 0.05 lands at 0
  near(b.pos.y, 0, 1e-12);
  assert.ok(r2.grounded);
});

test('moveCapsule pushes an actor out of a box it spawned inside', () => {
  const w = floorWorld();
  w.addBox({ center: v(0, 1, 0), size: v(2, 2, 2) }); // x -1..1
  const a = makeActor(0.9, 0, 0);                       // centre 0.1 inside the +x face
  w.moveCapsule(a, v(0, 0, 0));
  within(a.pos.x, 1 + 0.35, 1 + 0.35 + 2 * SKIN, 'pushed out through the nearest face');
});

// ------------------------------------------------------------------------------------------------ sweeps, bounce
test('sweepSphere: falling onto the floor, contact t', () => {
  const w = floorWorld();
  // r = 0.1 from y=1 to y=-1 (2 m): touches y=0 when the centre is at 0.1, after 0.9 m -> t = 0.45
  const hit = w.sweepSphere(v(0, 1, 0), v(0, -1, 0), 0.1);
  near(hit.t, 0.45);
  near(hit.dist, 0.9);
  nearV(hit.center, [0, 0.1, 0]);
  nearV(hit.point, [0, 0, 0]);
  nearV(hit.normal, [0, 1, 0]);
  assert.equal(w.sweepSphere(v(0, 1, 0), v(0, 0.5, 0), 0.1), null); // stops short
});

test('sweepSphere: edge and corner contacts', () => {
  const w = newWorld();
  w.addBox({ center: v(0, 0.5, 5), size: v(1, 1, 1) }); // x ±0.5, y 0..1, z 4.5..5.5
  // r = 0.2 at y = 1.1 along +z passes 0.1 above the top: hits the top-front edge (y=1, z=4.5)
  // when (z - 4.5)² + 0.1² = 0.2²  ->  z = 4.5 - √0.03. Path length 10.
  let hit = w.sweepSphere(v(0, 1.1, 0), v(0, 1.1, 10), 0.2);
  near(hit.t, (4.5 - Math.sqrt(0.03)) / 10);
  nearV(hit.point, [0, 1, 4.5]);
  nearV(hit.normal, [0, 0.1 / 0.2, -Math.sqrt(0.03) / 0.2]);
  // at x = 0.6 as well: 0.1 out in x and y from the corner (0.5, 1, 4.5): z = 4.5 - √(0.04 - 0.02)
  hit = w.sweepSphere(v(0.6, 1.1, 0), v(0.6, 1.1, 10), 0.2);
  near(hit.t, (4.5 - Math.sqrt(0.02)) / 10);
  nearV(hit.point, [0.5, 1, 4.5]);
  nearV(hit.normal, [0.5, 0.5, -Math.sqrt(0.02) / 0.2]);
  // 0.25 above the top: clears the box
  assert.equal(w.sweepSphere(v(0, 1.25, 0), v(0, 1.25, 10), 0.2), null);
});

test('sweepSphere: resting contact slides, pressing in hits at t=0, 30 m/s does not tunnel', () => {
  const w = floorWorld();
  assert.equal(w.sweepSphere(v(0, 0.1, 0), v(1, 0.1, 0), 0.1), null); // tangential slide on the floor
  const hit = w.sweepSphere(v(0, 0.1, 0), v(1, 0.05, 0), 0.1);         // pressing into it
  near(hit.t, 0);
  nearV(hit.normal, [0, 1, 0]);
  assert.equal(w.sweepSphere(v(0, 0.1, 0), v(0, 0.5, 0), 0.1), null); // lifting off
  w.addBox({ center: v(5.1, 1, 0), size: v(0.2, 2, 4) });              // 0.2 m wall, face x = 5
  // 30 m/s = 0.5 m per step: the step from x=4.7 to 5.2 with r=0.05 touches at x = 4.95 -> t = 0.25/0.5
  const g = w.sweepSphere(v(4.7, 1, 0), v(5.2, 1, 0), 0.05);
  near(g.t, 0.5);
  nearV(g.normal, [-1, 0, 0]);
});

test('sweepSphere can hit actor capsules when asked', () => {
  const w = newWorld();
  const a = makeActor(0, 0, 5);
  w.addHitboxes(a, null);
  w.updateHitboxes();
  // capsule radius 0.35 + sphere 0.1: centre stops 0.45 before the axis -> z = 4.55, t = 4.55 / 10
  assert.equal(w.sweepSphere(v(0, 1, 0), v(0, 1, 10), 0.1), null); // actors off by default
  const hit = w.sweepSphere(v(0, 1, 0), v(0, 1, 10), 0.1, { hitActors: true });
  near(hit.t, 0.455);
  assert.equal(hit.actor, a);
  nearV(hit.point, [0, 1, 4.65]);
  nearV(hit.normal, [0, 0, -1]);
});

test('bounce reflects and damps', () => {
  // v = (3,-4,0) on n = +Y: normal part (0,-4,0) -> (0, 2, 0) with e = 0.5; tangent (3,0,0) -> 2.4 with f = 0.2
  const vel = v(3, -4, 0);
  const out = bounce(vel, v(0, 1, 0), 0.5, 0.2);
  assert.equal(out, vel);
  nearV(vel, [2.4, 2, 0]);
  // pure reflection off a 45-degree normal: (0,-2,0) -> (2,0,0)
  nearV(bounce(v(0, -2, 0), v(1 / SQ2, 1 / SQ2, 0), 1, 0), [2, 0, 0]);
  // separating velocity is left alone
  nearV(bounce(v(1, 2, 3), v(0, 1, 0), 0.5, 0.5), [1, 2, 3]);
  // also available on the world
  const w = newWorld();
  nearV(w.bounce(v(0, -1, 0), v(0, 1, 0), 0.25, 0), [0, 0.25, 0]);
});

// ------------------------------------------------------------------------------------------------ queries
test('lineOfSight: blocked by a wall, clear over and beside it, actors only on request', () => {
  const w = floorWorld();
  w.addBox({ center: v(5, 1, 0), size: v(1, 2, 4) }); // x 4.5..5.5, y 0..2, z -2..2
  assert.equal(w.lineOfSight(v(0, 1.5, 0), v(10, 1.5, 0)), false);
  assert.equal(w.lineOfSight(v(0, 2.5, 0), v(10, 2.5, 0)), true);  // over the 2 m top
  assert.equal(w.lineOfSight(v(0, 1, 0), v(10, 1, 6)), true);      // at x 4.5..5.5 the line is at z 2.7..3.3
  assert.equal(w.lineOfSight(v(0, 1.5, 0), v(4, 1.5, 0)), true);   // stops short of the face
  const a = makeActor(2, 0, 3);
  w.addHitboxes(a, null);
  w.updateHitboxes();
  assert.equal(w.lineOfSight(v(0, 1, 3), v(4, 1, 3)), true);
  assert.equal(w.lineOfSight(v(0, 1, 3), v(4, 1, 3), { hitActors: true }), false);
});

test('groundAt returns the highest top at or below fromY', () => {
  const w = floorWorld(); // floor covers x,z ±20
  w.addBox({ center: v(0, 0.1, 0), size: v(2, 0.2, 4) }); // top 0.2
  near(w.groundAt(0, 0), 0.2);
  near(w.groundAt(5, 0), 0);
  near(w.groundAt(0, 0, 0.1), 0);
  assert.equal(w.groundAt(0, 0, -2), null);
  assert.equal(w.groundAt(100, 100), null);
});

test('overlapSphere returns actors whose capsules reach the sphere', () => {
  const w = newWorld();
  const a = makeActor(0, 0, 0), b = makeActor(3, 0, 0);
  w.addHitboxes(a, null); w.addHitboxes(b, null);
  w.updateHitboxes();
  // (1,1,0) is 1.0 from a's axis (x=0, y 0.35..1.45): touches when R + 0.35 >= 1.0; b's axis is 2.0 away
  assert.deepEqual(w.overlapSphere(v(1, 1, 0), 0.7), [a]);
  assert.deepEqual(w.overlapSphere(v(1, 1, 0), 0.6), []);
  assert.deepEqual(w.overlapSphere(v(1.5, 1, 0), 1.2), [a, b]);
  assert.deepEqual(w.overlapSphere(v(1.5, 1, 0), 1.2, { ignore: a }), [b]);
});

test('queryBoxes is exact for yawed boxes', () => {
  const w = newWorld();
  const box = w.addBox({ center: v(0, 1, 0), size: v(2, 2, 2), yaw: Math.PI / 4 }); // diamond, |x| + |z| <= √2
  // its world AABB is ±√2, but the corner (1.1, 1.1) has x + z = 2.2 > √2: outside the diamond
  assert.deepEqual(w.queryBoxes(v(1.1, 0, 1.1), v(2, 2, 2)), []);
  assert.deepEqual(w.queryBoxes(v(0.5, 0, 0.5), v(2, 2, 2)), [box]); // 0.5 + 0.5 = 1 < √2
  assert.deepEqual(w.queryBoxes(v(0, 2.5, 0), v(1, 3, 1)), []);        // above the 2 m top
});

test('closestPointOnColliders: face, edge, inside, out of range', () => {
  const w = newWorld();
  const box = w.addBox({ center: v(0, 1, 0), size: v(2, 2, 2) }); // x,z ±1, y 0..2
  let h = w.closestPointOnColliders(v(3, 1, 0), 5);
  nearV(h.point, [1, 1, 0]); nearV(h.normal, [1, 0, 0]); near(h.dist, 2); assert.equal(h.collider, box);
  h = w.closestPointOnColliders(v(2, 3, 0), 5); // nearest is the top +x edge at (1, 2, 0), √2 away
  nearV(h.point, [1, 2, 0]); near(h.dist, SQ2); nearV(h.normal, [1 / SQ2, 1 / SQ2, 0]);
  h = w.closestPointOnColliders(v(0.8, 1, 0), 5); // inside, 0.2 from the +x face
  nearV(h.point, [1, 1, 0]); near(h.dist, -0.2); nearV(h.normal, [1, 0, 0]);
  assert.equal(w.closestPointOnColliders(v(3, 1, 0), 1), null);
});

test('probeWall finds the wall normal, the box top and the stack top', () => {
  const w = floorWorld();
  const wall = w.addBox({ center: v(0, 0.5, 3), size: v(4, 1, 0.5) });   // low wall: face z = 2.75, top 1.0
  w.addBox({ center: v(1, 1.25, 3), size: v(1, 0.5, 0.5) });             // crate on it at x 0.5..1.5, top 1.5
  let h = w.probeWall(v(0, 0, 0), v(0, 0, 1), 5, 0.5);
  assert.equal(h.collider, wall);
  near(h.dist, 2.75);
  nearV(h.point, [0, 0.5, 2.75]);
  nearV(h.normal, [0, 0, -1]);
  near(h.boxTop, 1.0); near(h.top, 1.0);
  assert.equal(h.hits, 3); // side rays at ±0.35 rad reach it at 2.75 / cos(0.35) = 2.93 < 5
  h = w.probeWall(v(1, 0, 0), v(0, 0, 2), 5, 0.5); // in front of the crate
  near(h.boxTop, 1.0); near(h.top, 1.5);
  assert.equal(w.probeWall(v(0, 0, 0), v(0, 0, 1), 2.5, 0.5), null); // out of reach
  // at 1.2 m the rays pass over the 1.0 m wall; from x = -1 the +0.35 rad ray crosses the crate's z range
  // (2.75..3.25) at x = -1 + z·tan(0.35) = 0.0..0.19, short of the crate's x = 0.5
  assert.equal(w.probeWall(v(-1, 0, 0), v(0, 0, 1), 5, 1.2), null);
  // ...but from x = 0 the same ray meets the crate face z = 2.75 at x = 2.75·tan(0.35) = 1.0, at 2.75/cos(0.35)
  h = w.probeWall(v(0, 0, 0), v(0, 0, 1), 5, 1.2);
  near(h.dist, 2.75 / Math.cos(0.35)); near(h.top, 1.5);
  assert.equal(h.hits, 1);
});

test('addBox accepts arrays and tag lists; stats counts', () => {
  const w = newWorld();
  const c = w.addBox({ center: [1, 2, 3], size: [2, 2, 2] }, { tags: ['cover', 'low'], material: 'stone', owner: 'room' });
  assert.ok(c.center instanceof V3);
  nearV(c.min, [0, 1, 2]); nearV(c.max, [2, 3, 4]);
  near(c.top, 3); near(c.bottom, 1);
  assert.ok(c.tags.has('cover') && c.tags.has('low'));
  assert.equal(c.material, 'stone');
  const s = w.stats();
  assert.equal(s.colliders, 1);
});
