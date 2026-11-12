// Enemy AI pure-logic tests (node:test). Run: node --test cover-room/tests/ai.test.mjs
// Every expected value comes from refs/ai-spec.md's numbers or from hand reasoning written next to it, never from
// re-running the module's own formula.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Params } from '../src/core/params.js';
import { defineAIParams, makeP } from '../src/ai/tuning.js';
import { halfAngleDeg, acquireTime, confirmTime, stepMeter } from '../src/ai/perception.js';
import { timeToAccuracy, rampSinceSpot, hitChance, distAccuracy } from '../src/ai/shooting.js';
import { scorePost, SELECTORS, refreshSelector, measureCheap } from '../src/ai/posts.js';
import { assignRoles, allocateTokens, DwellTimer, SampledDwell, oblongWeight } from '../src/ai/director.js';

const params = defineAIParams(new Params({ storageKey: null, search: '' }));
const P = makeP(params);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !== ${b} (±${eps})`);

// ------------------------------------------------------------------------------------------------ accuracy ramp §5
test('time to accuracy, light enemies: 5 m 3.0 s, 15 m 4.5 s, 30 m 6.0 s (G-deck p145)', () => {
  near(timeToAccuracy(5, P), 3.0);
  near(timeToAccuracy(15, P), 4.5);
  near(timeToAccuracy(30, P), 6.0);
  near(timeToAccuracy(10, P), 3.75);          // halfway between the 5 m and 15 m points
  near(timeToAccuracy(2, P), 3.0);            // clamped below 5 m
  near(timeToAccuracy(45, P), 6.0);           // clamped above 30 m
});

test('time to accuracy, medium enemies: 5 m 2.5 s, 15 m 4.0 s, 30 m 5.5 s (G-deck p145)', () => {
  params.set('ai.acc.class', 'medium');
  try {
    near(timeToAccuracy(5, P), 2.5);
    near(timeToAccuracy(15, P), 4.0);
    near(timeToAccuracy(30, P), 5.5);
  } finally { params.set('ai.acc.class', 'light'); }
});

test('ramp since spotting is linear from 0 to 1 over the time to accuracy', () => {
  near(rampSinceSpot(1.5, 5, P), 0.5);        // half of 3.0 s
  near(rampSinceSpot(3.0, 5, P), 1.0);
  near(rampSinceSpot(2.25, 15, P), 0.5);      // half of 4.5 s
  near(rampSinceSpot(3.0, 30, P), 0.5);       // half of 6.0 s
  near(rampSinceSpot(9, 30, P), 1.0);         // saturates
});

test('hit chance: UC2 rifle curve × ramp × pop-out × movement, clamped to the 0.05 floor', () => {
  const s = (dist, tSpot, extra = {}) => hitChance({ dist, tSpot, tExposed: Infinity, motion: 'stand', kind: 'rifle', ...extra }, P);
  near(distAccuracy('rifle', 5, P), 0.8);     // 4 m 90 %, 8 m 50 % → 5 m is a quarter of the way: 90 − 10 = 80 %
  near(s(5, 3.0), 0.8);                       // fully ramped at 5 m
  near(s(15, 4.5), 0.4);                      // 12 m and 20 m are both 40 %
  near(s(30, 6.0), 0.3);                      // 30 m point
  near(s(15, 2.25), 0.2);                     // half ramp at 15 m: 0.4 × 0.5
  near(s(5, 0), 0.05);                        // just spotted: floor
  near(s(30, 6.0, { motion: 'run' }), 0.27);  // running × 0.9
  near(s(30, 6.0, { motion: 'roll' }), 0.15); // rolling × 0.5
  near(s(5, 3.0, { tExposed: 1.75 }), 0.4);   // popped out 1.75 s ago: half of the 3.5 s pop-out ramp
  near(s(70, 99), 0.05);                      // 0 % past 60 m, held at the floor
});

// ------------------------------------------------------------------------------------------------ perception §1
test('view cone half angle = 300/d deg, clamped to 25..90 (spec: 90° at 3.3 m, 30° at 10 m)', () => {
  near(halfAngleDeg(10, P), 30);
  near(halfAngleDeg(3, P), 90);
  near(halfAngleDeg(20, P), 25);
  near(halfAngleDeg(6, P), 50);
});

test('notice meter: white phase then yellow phase at 12 m, never seen (hand: 2.25 s + 0.78 s)', () => {
  // acquire = (0.5 + 2.5 × 12/30) × 1.5 = 1.5 × 1.5 = 2.25 s; confirm = 0.3 + 1.2 × 0.4 = 0.78 s
  near(acquireTime(12, 30, 'unaware', false, P), 2.25);
  near(confirmTime(12, 30, P), 0.78);
  let a = 0, t = 0;
  const dt = 1 / 60;
  let tWhite = -1, tOrange = -1;
  while (t < 5 && tOrange < 0) {
    a = stepMeter(a, true, 12, 'unaware', false, dt, P);
    t += dt;
    if (tWhite < 0 && a >= 1) tWhite = t;
    if (a >= 2) tOrange = t;
  }
  near(tWhite, 2.25, dt + 1e-9);
  near(tOrange, 3.03, 2 * dt + 1e-9);
  // unseen: decays at 1.0 / s
  near(stepMeter(1.5, false, 12, 'unaware', false, 0.5, P), 1.0);
});

// ------------------------------------------------------------------------------------------------ roles §4.1
test('role assignment order: hard-point min, X engagers, Y ambushers, hard-point max, leftovers', () => {
  const npcs = [
    { id: 'A', distToPlayer: 10, distToAmbush: 30, hpDist: { hp1: 3 } },
    { id: 'B', distToPlayer: 6, distToAmbush: 25, hpDist: { hp1: 15 } },
    { id: 'C', distToPlayer: 8, distToAmbush: 20, hpDist: { hp1: 12 } },
    { id: 'D', distToPlayer: 20, distToAmbush: 4, hpDist: { hp1: 18 } },
    { id: 'E', distToPlayer: 25, distToAmbush: 15, hpDist: { hp1: 5 } },
    { id: 'F', distToPlayer: 30, distToAmbush: 22, hpDist: { hp1: 25 } },
  ];
  const { roles, warnings } = assignRoles(npcs, { engagers: 2, ambushers: 1, hardPoints: [{ id: 'hp1', min: 1, max: 2 }] });
  const r = (id) => roles.get(id).role;
  assert.equal(r('A'), 'defender');           // 1. closest to the hard point fills its minimum
  assert.equal(roles.get('A').hardPoint, 'hp1');
  assert.equal(r('B'), 'engager');            // 2. the two closest to the player of the rest
  assert.equal(r('C'), 'engager');
  assert.equal(r('D'), 'ambusher');           // 3. closest to the ambush point of the rest
  assert.equal(r('E'), 'defender');           // 4. hard point topped up to its max of 2
  assert.equal(r('F'), 'engager');            // 5. leftover → engager, with a warning
  assert.equal(warnings.length, 1);
});

test('role assignment: pins count toward X; a fully specified roster has no warning', () => {
  const npcs = [
    { id: 'A', distToPlayer: 30, distToAmbush: 5, hpDist: {}, pin: 'engager' },
    { id: 'B', distToPlayer: 5, distToAmbush: 25, hpDist: {} },
    { id: 'C', distToPlayer: 9, distToAmbush: 12, hpDist: {} },
  ];
  const { roles, warnings } = assignRoles(npcs, { engagers: 2, ambushers: 1, hardPoints: [] });
  assert.equal(roles.get('A').role, 'engager');   // pinned, though it's the farthest
  assert.equal(roles.get('B').role, 'engager');   // fills the second engager slot (closest)
  assert.equal(roles.get('C').role, 'ambusher');
  assert.equal(warnings.length, 0);
});

// ------------------------------------------------------------------------------------------------ tokens §4.2
const rec = (id, dist, o = {}) => ({ id, dist, eligible: true, canPeek: true, engaged: false, tok: false, tokT: -1, peekGrant: false, ...o });
const opts = (now = 0) => ({ min: 2, max: 3, now, losGrace: 1.0, engagedPreempts: true });
const holders = (recs) => recs.filter((r) => r.tok).map((r) => r.id).sort().join('');

test('tokens: max 3, closest first', () => {
  const recs = [rec('a', 20), rec('b', 5), rec('c', 12), rec('d', 8), rec('e', 30)];
  assert.equal(allocateTokens(recs, opts()), 3);
  assert.equal(holders(recs), 'bcd');
});

test('tokens: the NPC the player is engaging gets top priority', () => {
  const recs = [rec('a', 20), rec('b', 5), rec('c', 12), rec('d', 8), rec('e', 30, { engaged: true })];
  allocateTokens(recs, opts());
  assert.equal(holders(recs), 'bde');           // e (engaged, 30 m) first, then b (5) and d (8)
});

test('tokens: holders keep them; an engaged newcomer preempts the worst non-engaged holder', () => {
  const recs = [rec('a', 20, { tok: true }), rec('c', 12, { tok: true }), rec('d', 8, { tok: true }), rec('b', 5)];
  allocateTokens(recs, opts(1));
  assert.equal(holders(recs), 'acd');           // full: the closer newcomer waits (holders ∩ eligible kept)
  recs[3].engaged = true;
  allocateTokens(recs, opts(2));
  assert.equal(holders(recs), 'bcd');           // b engaged → takes a's token (a is the farthest holder)
});

test('tokens: released on reload / hit reaction / lost LOS, then passed on', () => {
  const recs = [rec('a', 5, { tok: true }), rec('b', 8, { tok: true }), rec('c', 12, { tok: true }), rec('d', 15)];
  recs[0].eligible = false; recs[0].canPeek = false;    // a reloads
  allocateTokens(recs, opts(3));
  assert.equal(holders(recs), 'bcd');
  recs[1].eligible = false;                              // b loses LOS (not a peek grant: released at once)
  allocateTokens(recs, opts(4));
  assert.equal(holders(recs), 'cd');
});

test('tokens: below the minimum, the closest NPC able to pop out gets a peek grant with a LOS grace', () => {
  const recs = [rec('a', 6), rec('b', 9, { eligible: false }), rec('c', 4, { eligible: false, canPeek: false })];
  allocateTokens(recs, opts(10));
  assert.equal(holders(recs), 'ab');           // a eligible; b (can peek) tops up to min 2; c can't peek
  assert.equal(recs[1].peekGrant, true);
  allocateTokens(recs, opts(10.5));             // inside the 1.0 s grace: kept
  assert.equal(holders(recs), 'ab');
  allocateTokens(recs, opts(11.2));             // grace over, still no LOS: released and not re-granted at once
  assert.equal(holders(recs), 'a');
});

// ------------------------------------------------------------------------------------------------ timers §4.3 §4.4 §6
test('advance / flank dwell timers: fire at 6.0 s, reset when the anchor moves past 6 m / 4 m', () => {
  const dt = 1 / 60;
  const t = new DwellTimer();
  t.start({ x: 0, z: 0 });
  for (let i = 0; i < 359; i++) t.update({ x: 0, z: 0 }, dt, 4.0);
  assert.equal(t.ready(6.0), false);            // 359 steps = 5.983 s
  t.update({ x: 0, z: 0 }, dt, 4.0);
  assert.equal(t.ready(6.0), true);             // 360 steps = 6.0 s
  t.consume();
  assert.equal(t.ready(6.0), false);
  for (let i = 0; i < 180; i++) t.update({ x: 3.9, z: 0 }, dt, 4.0);   // 3.9 m: inside the flank reset distance
  near(t.t, 3.0, 1e-9);
  t.update({ x: 4.1, z: 0 }, dt, 4.0);          // 4.1 m from the anchor: restart
  assert.equal(t.t, 0);
  assert.equal(t.resets, 1);
  const adv = new DwellTimer();
  adv.start({ x: 0, z: 0 });
  for (let i = 0; i < 120; i++) adv.update({ x: 4.1, z: 0 }, dt, 6.0); // the same 4.1 m does not reset the 6 m advance timer
  near(adv.t, 2.0, 1e-9);
  adv.update({ x: 6.2, z: 0 }, dt, 6.0);
  assert.equal(adv.t, 0);
});

test('grenade director dwell: sampled once a second, throws at 8 s, resets past the 4 m move radius', () => {
  const dt = 1 / 60;
  const g = new SampledDwell();
  g.start({ x: 0, z: 0 });
  for (let i = 0; i < 479; i++) g.update({ x: 0, z: 0 }, dt, 1.0, 4.0);
  assert.equal(g.t, 7);                         // 7.98 s: seven samples
  assert.equal(g.ready(8), false);
  g.update({ x: 0, z: 0 }, dt, 1.0, 4.0);       // 8.0 s: eighth sample
  assert.equal(g.ready(8), true);
  g.consume();
  for (let i = 0; i < 59; i++) g.update({ x: 5, z: 0 }, dt, 1.0, 4.0);  // moved, but no sample yet
  assert.equal(g.resets, 0);
  g.update({ x: 5, z: 0 }, dt, 1.0, 4.0);
  assert.equal(g.resets, 1);
  assert.equal(g.t, 0);
});

test('combat-vector oblong weight: 1 on the centre line, 0 at the half width and past the length', () => {
  const tgt = { x: 0, z: 0 }, cv = { x: 0, z: 1 };
  near(oblongWeight(0, 5, tgt, cv, 12, 4), 1);
  near(oblongWeight(2, 5, tgt, cv, 12, 4), 0.5);
  near(oblongWeight(4, 5, tgt, cv, 12, 4), 0);
  near(oblongWeight(0, 13, tgt, cv, 12, 4), 0);
  near(oblongWeight(0, -1, tgt, cv, 12, 4), 0);
});

// ------------------------------------------------------------------------------------------------ posts §3
const engage = refreshSelector(SELECTORS.engage, P);
const baseCtx = () => ({ npc: 'me', sel: engage, anchorDist: 10, anchorLimit: 25, pathLen: 5, facesThreat: true, canShoot: true,
  behindTarget: false, pathNearTarget: Infinity, gain: 0, offAxis: 90, targetDist: 10, allyDist: Infinity, seenByTarget: false, elevation: 0 });
const coverPost = { type: 'cover', claimedBy: null };

test('post filters reject outright (score 0)', () => {
  assert.ok(scorePost(coverPost, baseCtx(), P) > 0);
  assert.equal(scorePost({ type: 'cover', claimedBy: 'other' }, baseCtx(), P), 0);              // claimed by another NPC
  assert.equal(scorePost(coverPost, { ...baseCtx(), anchorDist: 25.5 }, P), 0);                 // outside the 25 m radius
  assert.equal(scorePost(coverPost, { ...baseCtx(), pathLen: Infinity }, P), 0);                // unreachable
  assert.equal(scorePost(coverPost, { ...baseCtx(), facesThreat: false }, P), 0);               // wall faces the wrong way
  assert.equal(scorePost(coverPost, { ...baseCtx(), canShoot: false }, P), 0);                  // no ray reaches the target
  assert.equal(scorePost(coverPost, { ...baseCtx(), behindTarget: true }, P), 0);               // behind the player
  assert.equal(scorePost(coverPost, { ...baseCtx(), pathNearTarget: 3 }, P), 0);                // path runs within 4 m of the player
  assert.equal(scorePost(coverPost, { ...baseCtx(), allyDist: 1.5 }, P), 0);                    // inside 2 m of an ally
  assert.ok(scorePost({ type: 'cover', claimedBy: 'me' }, baseCtx(), P) > 0);                   // its own claim is fine
});

test('post score = weighted geometric mean of the criteria (hand-computed)', () => {
  // engage: range(10 m) = 1, path(5 m) = 0.9, cover = 1, spacing = 1; weights 1 → (1 · 0.9 · 1 · 1)^(1/4)
  near(scorePost(coverPost, baseCtx(), P), Math.pow(0.9, 0.25), 1e-9);              // 0.97400
  // open post: cover term 0.4 → (0.9 · 0.4)^(1/4) = 0.36^0.25
  near(scorePost({ type: 'open', claimedBy: null }, baseCtx(), P), Math.pow(0.36, 0.25), 1e-9);  // 0.77460
  // 5 m from the player: range 0.3 → (0.3 · 0.9)^(1/4)
  near(scorePost(coverPost, { ...baseCtx(), targetDist: 5 }, P), Math.pow(0.27, 0.25), 1e-9);
});

test('cover facing and behind-the-player measures from geometry', () => {
  // wall normal +Z (the NPC stands on the +Z side); threat 10 m to −Z → the wall is between: faces
  const post = { type: 'cover', x: 0, y: 0, z: 0, nx: 0, nz: 1, node: -1, claimedBy: null };
  const q = { target: { x: 0, y: 0, z: -10 }, anchor: { x: 0, y: 0, z: -10 }, anchorLimit: 25, npc: { pos: { x: 0, y: 0, z: 2 } },
    cv: { x: 0, z: 1 }, selfDist: 12, field: null, tools: null, allies: [], sel: engage };
  const ctx = {};
  measureCheap(post, q, ctx, P);
  assert.equal(ctx.facesThreat, true);
  assert.equal(ctx.behindTarget, false);         // on the enemies' side of the player
  near(ctx.targetDist, 10);
  q.target = { x: 0, y: 0, z: 10 };              // threat on the open side
  q.cv = { x: 0, z: -1 };
  measureCheap(post, q, ctx, P);
  assert.equal(ctx.facesThreat, false);
  q.target = { x: 0, y: 0, z: -10 }; q.cv = { x: 0, z: -1 };   // enemies are beyond the player at −Z…
  measureCheap(post, q, ctx, P);
  assert.equal(ctx.behindTarget, true);          // …so this post, 10 m on the other side, is behind the player
});
