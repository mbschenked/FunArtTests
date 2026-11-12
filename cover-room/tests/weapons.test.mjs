// Weapons (B2) unit tests: node --test cover-room/tests/weapons.test.mjs
// Expected values come from refs/player-spec.md §5/§6 (fire interval 0.200 s, magazine 12 / 60 total, reload 0.85 s,
// apex rule, blast radii 3 / 6 m and 150 max damage) or from hand computation, never from the code under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { createWorld } from '../src/core/world.js';
import { createWeapon, Vec3 } from '../src/weapons/weapon.js';
import { createGrenades, blastFalloff } from '../src/weapons/grenades.js';

const DT = 1 / 60;
const DEG = Math.PI / 180;

function hudStub() {
  const calls = { ammo: [], grenades: [], hit: [], reticle: 0 };
  return {
    calls,
    setAmmo(mag, reserve, vis, magSize) { calls.ammo.push([mag, reserve, vis, magSize]); },
    setGrenades(n) { calls.grenades.push(n); },
    hitMarker(k) { calls.hit.push(k); },
    setReticle() { calls.reticle++; },
  };
}

function makeGame({ floor = true } = {}) {
  const game = new Game({ seed: 1, test: true });
  game.Vector3 = Vec3;
  game.world = createWorld({ Vector3: Vec3, cellSize: 2 });
  if (floor) game.world.addBox({ center: [0, -0.5, 0], size: [120, 1, 120] }, { tags: ['floor'] });
  game.addSystem({ name: 'hitboxes', order: 65, update: () => game.world.updateHitboxes() });
  game.weapons = { list: [] };
  game.addSystem({ name: 'weapons', order: 30, update: (dt) => { for (const w of game.weapons.list) w.update(dt); } });
  game.hud = hudStub();
  game.log = { shots: [], explode: [], throw: [], damage: [] };
  game.events.on('shot', (e) => game.log.shots.push({ t: game.time, spread: e.spread, first: e.first,
    hit: e.hit ? { x: e.hit.point.x, y: e.hit.point.y, z: e.hit.point.z, actor: e.hit.actor, collider: e.hit.collider, part: e.hit.part } : null }));
  game.events.on('grenade:explode', (e) => game.log.explode.push({ t: game.time, x: e.pos.x, y: e.pos.y, z: e.pos.z, r: e.radius }));
  game.events.on('grenade:throw', (e) => game.log.throw.push({ t: game.time }));
  game.events.on('damage', (e) => game.log.damage.push({ target: e.target, amount: e.amount, kind: e.kind, part: e.part }));
  return game;
}

function actor(id, team, x, y, z, extra = {}) {
  return { id, team, pos: new Vec3(x, y, z), vel: new Vec3(), yaw: 0, height: 1.8, radius: 0.35,
    health: 100, maxHealth: 100, alive: true, state: {}, ...extra };
}

// A camera rig stub whose aim ray is fixed (origin, dir) until changed.
function rigStub(origin, target) {
  const rig = {
    o: new Vec3(...origin), d: new Vec3(), kicks: 0,
    aimAt(t) { this.d.set(t[0] - this.o.x, t[1] - this.o.y, t[2] - this.o.z).normalize(); },
    aimRay(out) { out.origin.copy(this.o); out.dir.copy(this.d); return out; },
    kick() { this.kicks++; },
  };
  rig.aimAt(target);
  return rig;
}

function playerWithPistol(game, overrides = {}) {
  const pl = actor('player', 'player', 0, 0, 0);
  game.player = pl;
  game.actors.push(pl);
  pl.weapon = createWeapon(game, pl, 'pistol', overrides);
  return pl;
}

// ------------------------------------------------------------------------------------------------ pistol
test('fire-rate gate: mashing gives at most 5 shots in 1.0 s, 0.200 s apart (spec §5 [MEASURED])', () => {
  for (const pattern of ['every-step', 'every-other-step']) {
    const game = makeGame();
    game.cameraRig = rigStub([0.5, 1.6, -1], [0, 1.5, 30]);
    const pl = playerWithPistol(game, { startTotal: 60 });
    const w = pl.weapon;
    for (let i = 0; i < 60; i++) {               // 60 steps = 1.0 s
      if (pattern === 'every-step') { w.setTrigger(false); w.setTrigger(true); } else w.setTrigger(i % 2 === 0);
      game.step();
    }
    const n = game.log.shots.length;
    assert.equal(n, 5, `${pattern}: ${n} shots in 1.0 s`);
    for (let i = 1; i < n; i++) {
      const gap = game.log.shots[i].t - game.log.shots[i - 1].t;
      assert.ok(Math.abs(gap - 0.200) < 1e-9, `${pattern}: gap ${gap}`);
    }
  }
});

test('semi-auto: holding the trigger fires once', () => {
  const game = makeGame();
  game.cameraRig = rigStub([0.5, 1.6, -1], [0, 1.5, 30]);
  const pl = playerWithPistol(game);
  pl.weapon.setTrigger(true);
  for (let i = 0; i < 60; i++) game.step();
  assert.equal(game.log.shots.length, 1);
});

function fireN(game, w, n, gapSteps = 13) {
  let fired = 0;
  for (let guard = 0; fired < n && guard < 10000; guard++) {
    const before = game.log.shots.length;
    w.setTrigger(true); game.step(); w.setTrigger(false);
    fired += game.log.shots.length - before;
    if (game.log.shots.length > before) for (let k = 0; k < gapSteps - 1; k++) game.step();
  }
  return fired;
}
const stepFor = (game, s) => { for (let i = 0; i < Math.round(s / DT); i++) game.step(); };

test('magazine and reserve bookkeeping across reloads (12 / 60, spec §5)', () => {
  const game = makeGame();
  game.cameraRig = rigStub([0.5, 1.6, -1], [0, 1.5, 30]);
  const pl = playerWithPistol(game, { startTotal: 60 });
  const w = pl.weapon, s = w.state;
  assert.deepEqual([s.mag, s.reserve, s.total], [12, 48, 60]);

  assert.equal(fireN(game, w, 12), 12);
  assert.equal(s.mag, 0);
  assert.equal(s.reloading, true, 'auto reload on empty');
  stepFor(game, 0.9);
  assert.deepEqual([s.mag, s.reserve, s.reloading], [12, 36, false]);       // 60 - 12 = 48 total

  assert.equal(fireN(game, w, 5), 5);
  assert.equal(s.mag, 7);
  assert.equal(w.reload(), true);
  stepFor(game, 0.9);
  assert.deepEqual([s.mag, s.reserve], [12, 31]);                           // 48 - 5 = 43 total
  assert.equal(w.reload(), false, 'full magazine: no reload');
  const last = game.hud.calls.ammo.at(-1);
  assert.deepEqual([last[0], last[1], last[3]], [12, 31, 12], 'HUD gets mag, reserve, magSize (it shows mag + reserve = 43)');

  // running dry: 15 total -> 12 + 3
  const game2 = makeGame();
  game2.cameraRig = rigStub([0.5, 1.6, -1], [0, 1.5, 30]);
  const w2 = playerWithPistol(game2, { startTotal: 15 }).weapon, s2 = w2.state;
  assert.deepEqual([s2.mag, s2.reserve], [12, 3]);
  fireN(game2, w2, 12); stepFor(game2, 0.9);
  assert.deepEqual([s2.mag, s2.reserve], [3, 0]);
  fireN(game2, w2, 3); stepFor(game2, 0.2);
  assert.deepEqual([s2.mag, s2.reserve, s2.reloading], [0, 0, false]);
  assert.equal(w2.reload(), false, 'nothing to reload with');
  assert.equal(fireN(game2, w2, 1), 0, 'dry: no shot');
  assert.equal(w2.addAmmo(100), 60, 'pickup capped at 60 total');
  stepFor(game2, 0.9);
  assert.deepEqual([s2.mag, s2.reserve], [12, 48]);
});

test('reload duration: last shot -> magazine full = 0.85 s (spec §5 [MEASURED]); manual reload 0.85 s; abort keeps the old mag', () => {
  const game = makeGame();
  game.cameraRig = rigStub([0.5, 1.6, -1], [0, 1.5, 30]);
  const pl = playerWithPistol(game, { startTotal: 60 });
  const w = pl.weapon, s = w.state;
  const states = [];
  game.events.on('state', (e) => { if (e.sys === 'weapon') states.push({ to: e.to, t: game.time }); });
  fireN(game, w, 12, 12);
  const lastShot = game.log.shots.at(-1).t;
  let refillT = null;
  for (let i = 0; i < 120 && refillT === null; i++) { game.step(); if (s.mag === 12) refillT = game.time - DT; }
  assert.ok(Math.abs(refillT - lastShot - 0.85) <= DT / 2 + 1e-9, `refill after ${refillT - lastShot}`);
  const r0 = states.find((e) => e.to === 'reloading'), r1 = states.find((e) => e.to === 'ready');
  assert.ok(Math.abs(r1.t - r0.t - 0.85) <= DT / 2 + 1e-9, `reload span ${r1.t - r0.t}`);
  assert.ok(Math.abs(r0.t - lastShot) < 1e-9, 'auto reload starts on the empty shot');

  // no firing during a reload; a press 0.3 s into it is not kept until the end (buffer 0.10 s)
  fireN(game, w, 2); w.reload();
  const n0 = game.log.shots.length;
  stepFor(game, 0.3); w.setTrigger(true); game.step(); w.setTrigger(false); stepFor(game, 0.7);
  assert.equal(game.log.shots.length, n0);
  assert.equal(s.mag, 12);

  // manual (tactical) reload: 0.85 s; cancel before commit leaves the magazine as it was
  fireN(game, w, 3);
  const t0 = game.time; w.reload();
  let tFull = null;
  for (let i = 0; i < 120 && tFull === null; i++) { game.step(); if (s.mag === 12) tFull = game.time - DT; }
  assert.ok(Math.abs(tFull - t0 - 0.85) <= DT + 1e-9, `manual reload ${tFull - t0}`);
  fireN(game, w, 4);
  w.reload(); stepFor(game, 0.5); w.cancelReload(); stepFor(game, 0.5);
  assert.equal(s.mag, 8, 'aborted reload: no refill');
});

test('first shot lands exactly on the reticle point; rapid follow-ups bloom; hip spread is wider (spec §5 [DEV G])', () => {
  const game = makeGame();
  const dummy = actor('d1', 'enemy', 0, 0, 10, { health: 1000 });
  game.actors.push(dummy);
  game.world.addHitboxes(dummy, null);              // upright fallback capsule
  game.world.updateHitboxes();
  game.cameraRig = rigStub([0.6, 1.6, -1.2], [0, 1.2, 10]);
  const pl = playerWithPistol(game, { startTotal: 60 });
  const w = pl.weapon;
  w.setAim(true);
  // the reticle point: where the camera ray meets the scene (world raycast, tested by A2's geometry seam)
  const h = game.world.raycast(game.cameraRig.o, game.cameraRig.d, 100, { ignore: pl });
  const reticle = new Vec3().copy(h.point);
  assert.equal(h.actor, dummy);

  fireN(game, w, 1, 12);                            // shot 1
  const s1 = game.log.shots[0];
  assert.equal(s1.first, true);
  assert.equal(s1.spread, 0);
  assert.equal(s1.hit.actor, dummy);
  const err = Math.hypot(s1.hit.x - reticle.x, s1.hit.y - reticle.y, s1.hit.z - reticle.z);
  assert.ok(err < 1e-6, `first shot off the reticle by ${err} m`);
  assert.equal(game.cameraRig.kicks, 1, 'recoil kick on the camera');

  fireN(game, w, 1, 12);                            // shot 2, 0.2 s later: bloom
  // spec §5: follow-up = min(bloomMax, aimBase + bloom); after one shot bloom = 0.35, aimBase 0.25 -> 0.60 deg
  assert.ok(Math.abs(game.log.shots[1].spread - 0.60 * DEG) < 1e-12, `second rapid shot spread ${game.log.shots[1].spread / DEG} deg`);
  assert.ok(game.log.shots[1].spread <= 1.5 * DEG + 1e-12, 'bloom capped at 1.5 deg');
  stepFor(game, 0.5);
  fireN(game, w, 1);                                // a pause > 0.35 s: first-shot rule again
  assert.equal(game.log.shots[2].spread, 0);

  w.setAim(false);
  assert.ok(Math.abs(w.currentSpread() - 3.5 * DEG) < 1e-12, 'hip spread 3.5 deg');
  pl.vel.set(4, 0, 0);
  assert.ok(Math.abs(w.currentSpread() - 5.0 * DEG) < 1e-12, 'hip spread + 1.5 deg when running');
  w.setAim(true);
  assert.ok(w.currentSpread() < 3.5 * DEG);

  // damage per spec §5: body 28; hit marker driven
  const bodyHits = game.log.damage.filter((d) => d.target === dummy && d.part === 'torso');
  assert.ok(bodyHits.length >= 1 && bodyHits.every((d) => d.amount === 28 && d.kind === 'bullet'));
  assert.ok(game.hud.calls.hit.includes('body'));
});

test('a blocked muzzle line hits the blocker, not the reticle point', () => {
  const game = makeGame();
  const dummy = actor('d1', 'enemy', 0, 0, 10, { health: 1000 });
  game.actors.push(dummy);
  game.world.addHitboxes(dummy, null);
  game.world.updateHitboxes();
  const wall = game.world.addBox({ center: [0, 0.9, 3], size: [3, 1.8, 0.3] }, { tags: ['cover'] });
  game.cameraRig = rigStub([0.6, 2.6, -1.2], [0, 1.5, 10]);
  const pl = playerWithPistol(game);
  pl.weapon.setAim(true);
  const camHit = game.world.raycast(game.cameraRig.o, game.cameraRig.d, 100, { ignore: pl });
  assert.equal(camHit.actor, dummy, 'precondition: the camera sees the dummy over the wall');
  fireN(game, pl.weapon, 1);
  assert.equal(game.log.shots[0].hit.collider, wall);
  assert.equal(game.log.damage.length, 0);
});

test('headshot: x4 body damage kills a 100 HP enemy in one shot (spec §5), with a kill marker', () => {
  const game = makeGame();
  const dummy = actor('d1', 'enemy', 0, 0, 8);
  game.actors.push(dummy);
  // a rig stub: head capsule at 1.65 m, torso below
  const bone = (y) => ({ matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, y, 8, 1] } });
  dummy.rig = { bones: { head: bone(1.62), spine: bone(0.9) },
    getBoneWorld(n, out) { const e = this.bones[n].matrixWorld.elements; return out.set(e[12], e[13], e[14]); } };
  game.world.addHitboxes(dummy, [
    { bone: 'head', a: [0, 0, 0], b: [0, 0.12, 0], radius: 0.13, part: 'head' },
    { bone: 'spine', a: [0, -0.35, 0], b: [0, 0.45, 0], radius: 0.22, part: 'torso' },
  ]);
  game.world.updateHitboxes();
  game.cameraRig = rigStub([0.6, 1.7, -1.2], [0, 1.68, 8]);
  const pl = playerWithPistol(game);
  pl.weapon.setAim(true);
  const deaths = [];
  game.events.on('death', (e) => deaths.push(e.actor));
  fireN(game, pl.weapon, 1);
  assert.equal(game.log.shots[0].hit.part, 'head');
  assert.equal(game.log.damage[0].amount, 112);       // 28 x 4
  assert.equal(dummy.alive, false);
  assert.deepEqual(deaths, [dummy]);
  assert.equal(game.hud.calls.hit.at(-1), 'kill');
});

test('rifle fireAt: gated by its fire interval, fires at the given point', () => {
  const game = makeGame();
  const target = actor('p', 'player', 0, 0, 12);
  game.player = target; game.actors.push(target);
  game.world.addHitboxes(target, null); game.world.updateHitboxes();
  const en = actor('e1', 'enemy', 0, 0, 0);
  const rifle = createWeapon(game, en, 'rifle', { spread: 0 });
  const aim = new Vec3(0, 1.2, 12);
  let n = 0;
  for (let i = 0; i < 60; i++) { if (rifle.fireAt(aim)) n++; game.step(); }
  assert.equal(n, 10, '600 rpm -> 10 rounds in 1.0 s');           // ai-spec §5 AR 600 rpm
  assert.equal(game.log.shots[0].hit.actor, target);
  assert.equal(game.log.damage[0].amount, 7);                    // player-spec §7 rifle hit on player
  assert.equal(rifle.state.mag, 20);
});

// ------------------------------------------------------------------------------------------------ grenades
function runUntil(game, pred, maxS = 10) {
  for (let i = 0; i < maxS / DT; i++) { if (pred()) return true; game.step(); }
  return pred();
}

test('throwAt: the solved lob lands within 0.25 m of a hand-picked target; high-arc apex follows the spec rule', () => {
  for (const arc of ['high', 'low']) {
    for (const target of [[6, 0, 9], [-4, 0, 15], [1, 0, 4]]) {
      const game = makeGame();
      const gr = createGrenades(game);
      const en = actor('e1', 'enemy', 0, 0, 0);
      game.actors.push(en);
      const tgt = new Vec3(...target);
      assert.equal(gr.throwAt(en, tgt, { arc }), true);
      const g = gr.live[0];
      let maxY = -Infinity, contact = null;
      runUntil(game, () => {
        if (g.contacts > 0 && !contact) contact = g.firstContact.clone();
        if (!contact) maxY = Math.max(maxY, g.pos.y);
        return !!contact;
      });
      assert.ok(contact, 'landed');
      const err = Math.hypot(contact.x - tgt.x, contact.z - tgt.z);
      assert.ok(err < 0.25, `${arc} ${target}: landed ${err.toFixed(4)} m off`);
      assert.ok(Math.abs(contact.y - 0) < 0.01);
      if (arc === 'high') {
        // hand (no socket): yaw 0 -> right is -X: (-0.22, 1.75, 0.1); apex = hand.y + 1.5 + 0.25 x range (spec §6)
        const R = Math.hypot(tgt.x + 0.22, tgt.z - 0.1);
        const apex = 1.75 + 1.5 + 0.25 * R;
        assert.ok(Math.abs(maxY - apex) < 0.01, `apex ${maxY.toFixed(3)} vs ${apex.toFixed(3)}`);
      }
    }
  }
});

test('preview landing == simulated landing (one launch velocity), on open ground and against a wall', () => {
  for (const scene of ['open', 'wall', 'moving']) {
    const game = makeGame();
    if (scene === 'wall') game.world.addBox({ center: [3, 4, 9], size: [8, 8, 0.4] }, { tags: ['wall'] });
    const gr = createGrenades(game);
    const pl = actor('player', 'player', 0, 0, 0);
    game.player = pl; game.actors.push(pl);
    if (scene === 'moving') pl.vel.set(1.5, 0, 2);      // inherited velocity is part of the one launch velocity
    const dir = new Vec3(Math.sin(0.3) * Math.cos(8 * DEG), Math.sin(8 * DEG), Math.cos(0.3) * Math.cos(8 * DEG));
    assert.equal(gr.beginAim(pl), true);
    for (let i = 0; i < 20; i++) { gr.updateAim(pl, dir); game.step(); }
    const pv = gr.preview;
    assert.equal(pv.visible, true);
    assert.equal(pv.hit, true);
    if (scene === 'wall') assert.equal(pv.onWall, true, 'the ring sits on the wall');
    const expect = pv.landing.clone();
    const tRelease = game.time;
    assert.equal(gr.release(pl), true);
    assert.equal(pv.visible, false, 'the arc goes on the release frame');
    let contact = null;
    runUntil(game, () => { const g = gr.live[0]; if (g && g.contacts > 0) contact = g.firstContact.clone(); return !!contact; });
    // the grenade leaves the hand throwReleaseT = 0.25 s after the release (spec §6 [INFERRED])
    assert.ok(Math.abs(game.log.throw[0].t - tRelease - 0.25) < 1e-9, `release -> throw ${game.log.throw[0].t - tRelease}`);
    const err = contact.distanceTo(expect);
    assert.ok(err < 1e-6, `${scene}: preview vs flight ${err} m`);
    assert.equal(gr.count(pl), 1, 'start 2, threw 1');
  }
});

test('fuse: player grenade explodes 2.0 s after first contact; AI grenade 2.5 s after the throw (spec §6, ai-spec §6)', () => {
  const game = makeGame();
  const gr = createGrenades(game);
  const pl = actor('player', 'player', 0, 0, 0);
  game.player = pl; game.actors.push(pl);
  gr.throwAt(pl, new Vec3(0, 0, 10));
  const g = gr.live[0];
  let tContact = null;
  runUntil(game, () => { if (tContact === null && g.contacts > 0) tContact = game.time - DT + g.firstContactT - (g.age - DT); return game.log.explode.length > 0; });
  const fuse = game.log.explode[0].t - tContact;
  assert.ok(Math.abs(fuse - 2.0) <= DT + 1e-9, `contact fuse ${fuse}`);

  const en = actor('e1', 'enemy', 0, 0, 30);
  game.actors.push(en);
  gr.throwAt(en, new Vec3(0, 0, 20));
  const tThrow = game.time;
  runUntil(game, () => game.log.explode.length > 1);
  const fuse2 = game.log.explode[1].t - tThrow;
  assert.ok(Math.abs(fuse2 - 2.5) <= DT + 1e-9, `AI throw fuse ${fuse2}`);
});

test('blast falloff: full inside 3 m, linear to 0 at 6 m, x0.6 to the player, blocked by walls (spec §6)', () => {
  // hand computation: 1 - (d - 3) / 3
  const cases = [[0, 1], [2, 1], [3, 1], [4.5, 0.5], [5.4, 0.2], [6, 0], [7.5, 0]];
  for (const [d, f] of cases) assert.ok(Math.abs(blastFalloff(d, 3, 6) - f) < 1e-12, `falloff(${d})`);

  const game = makeGame();
  const gr = createGrenades(game);
  const mk = (id, team, x, z) => { const a = actor(id, team, x, 0, z, { health: 1000 }); game.actors.push(a); return a; };
  const a2 = mk('a2', 'enemy', 2, 0), a45 = mk('a45', 'enemy', 0, 4.5), a54 = mk('a54', 'enemy', -5.4, 0), a7 = mk('a7', 'enemy', 0, -7);
  const pl = mk('player', 'player', 3.182, 3.182);       // 4.5 m away on the diagonal
  game.player = pl;
  const hidden = mk('hid', 'enemy', -2.5, -2.5);         // 3.54 m away, behind a tall wall
  game.world.addBox({ center: [-1.5, 1.5, -1.5], size: [3, 3, 0.3], yaw: Math.PI / 4 }, { tags: ['wall'] });
  gr.detonate(new Vec3(0, 1.0, 0), null);
  const dmg = (a) => game.log.damage.filter((d) => d.target === a).reduce((s, d) => s + d.amount, 0);
  assert.equal(dmg(a2), 150);
  assert.equal(dmg(a45), 75);
  assert.equal(dmg(a54), 30);
  assert.equal(dmg(a7), 0);
  assert.equal(dmg(pl), 45);                             // 75 x 0.6
  assert.equal(dmg(hidden), 0, 'no line of sight');
  assert.ok(game.log.damage.every((d) => d.kind === 'blast'));
  assert.equal(game.log.explode[0].r, 6);
});

test('carry: capped at 4, no aim without a grenade, HUD count follows', () => {
  const game = makeGame();
  const gr = createGrenades(game);
  const pl = actor('player', 'player', 0, 0, 0);
  game.player = pl; game.actors.push(pl);
  assert.equal(gr.count(pl), 2);
  gr.give(pl, 10);
  assert.equal(gr.count(pl), 4);
  game.step();
  assert.equal(game.hud.calls.grenades.at(-1), 4);
  gr.setCount(pl, 0);
  assert.equal(gr.beginAim(pl), false);
  game.step();
  assert.equal(game.hud.calls.grenades.at(-1), 0);
});
