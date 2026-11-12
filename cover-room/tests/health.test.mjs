// Player health unit tests: node --test cover-room/tests/health.test.mjs
// Expected values come from Max (12 Nov 2026: "player can take 10 shots, we regenerate health over time, but
// regeneration stops when we are shot") and refs/player-spec.md §7 (regen starts 1.5 s after the last hit; F1 shows
// full recovery about 2.3 s after the last hit), never from the code under test.
// The chain is the real one: an enemy rifle's fireAt -> applyDamage -> 'damage' event -> player/health.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { createWorld } from '../src/core/world.js';
import { createWeapon, Vec3 } from '../src/weapons/weapon.js';
import { createHealth } from '../src/player/health.js';

const DT = 1 / 60;

function setup() {
  const game = new Game({ seed: 1, test: true });
  game.Vector3 = Vec3;
  game.world = createWorld({ Vector3: Vec3, cellSize: 2 });
  game.world.addBox({ center: [0, -0.5, 0], size: [120, 1, 120] }, { tags: ['floor'] });
  game.addSystem({ name: 'hitboxes', order: 65, update: () => game.world.updateHitboxes() });
  game.weapons = { list: [] };
  game.addSystem({ name: 'weapons', order: 30, update: (dt) => { for (const w of game.weapons.list) w.update(dt); } });

  const player = { id: 'p', team: 'player', pos: new Vec3(0, 0, 12), vel: new Vec3(), yaw: 0, height: 1.8,
    radius: 0.35, health: 100, maxHealth: 100, alive: true, state: {},
    anim: { hit: { dir: new Vec3(), part: null, t: 0 } } };
  game.player = player; game.actors.push(player);
  game.world.addHitboxes(player, null); game.world.updateHitboxes();
  const ctrl = { mode: 'move', lastCombatT: 0, respawn() {},
    setMode(m) { this.mode = m; if (m === 'dead') player.alive = false; } };
  const health = createHealth(game, player, ctrl);
  game.addSystem({ name: 'player', order: 10, update: (dt) => health.update(dt) });

  const enemy = { id: 'e1', team: 'enemy', pos: new Vec3(0, 0, 0), vel: new Vec3(), yaw: 0, height: 1.8,
    radius: 0.35, health: 100, maxHealth: 100, alive: true, state: {} };
  const rifle = createWeapon(game, enemy, 'rifle', { spread: 0 });
  const hits = [];
  game.events.on('damage', (e) => { if (e.target === player) hits.push(e.amount); });
  const deaths = [];
  game.events.on('death', (e) => deaths.push(e.actor));
  return { game, player, health, rifle, aim: new Vec3(0, 1.2, 12), hits, deaths };
}

// Fire the rifle as soon as its fire interval allows; returns once one round has landed on the player.
function hitOnce(s) {
  const n = s.hits.length;
  for (let i = 0; i < 120 && s.hits.length === n; i++) { s.rifle.fireAt(s.aim); s.game.step(); }
  assert.equal(s.hits.length, n + 1, 'the rifle round should hit the player');
}

const wait = (s, seconds) => { for (let i = 0; i < Math.round(seconds / DT); i++) s.game.step(); };

test('the player survives 9 enemy hits in a row and dies on the 10th (Max, 12 Nov)', () => {
  const s = setup();
  for (let i = 0; i < 9; i++) hitOnce(s);
  assert.equal(s.health.dead, false, 'alive after 9 hits');
  assert.ok(s.health.hp > 0);
  assert.deepEqual(s.deaths, []);
  hitOnce(s);
  assert.equal(s.health.dead, true, 'dead on the 10th hit');
  assert.deepEqual(s.deaths, [s.player]);
});

test('health comes back over time once the player stops getting hit (spec §7: 1.5 s delay, full by ~2.3 s)', () => {
  const s = setup();
  hitOnce(s);
  const hurt = s.health.hp;
  assert.ok(hurt < 100);
  wait(s, 1.4);
  assert.equal(s.health.hp, hurt, 'no regen inside the 1.5 s delay');
  wait(s, 1.1);                                      // 2.5 s after the hit
  assert.equal(s.health.hp, 100, 'full again ~2.3 s after the last hit');
});

test('a hit while health is coming back stops the regen and restarts the delay (Max, 12 Nov)', () => {
  const s = setup();
  for (let i = 0; i < 5; i++) hitOnce(s);
  wait(s, 1.6);                                      // regen has started
  const rising = s.health.hp;
  wait(s, 0.05);
  assert.ok(s.health.hp > rising && s.health.hp < 100, 'regenerating before the new hit');
  hitOnce(s);
  const afterHit = s.health.hp;
  wait(s, 1.4);
  assert.equal(s.health.hp, afterHit, 'regen stays stopped for the delay after the new hit');
  wait(s, 1.1);
  assert.equal(s.health.hp, 100, 'then it comes back');
});
