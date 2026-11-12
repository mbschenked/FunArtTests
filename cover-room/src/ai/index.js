// Enemy AI module entry (B4). main.js calls install(game).
//
//   install(game) / createAI(game, opts) -> game.ai (the encounter director, ai/director.js)
//     - defines every `ai.*` param (ai/tuning.js, each with its ai-spec source)
//     - generates tactical posts from level.cover + level.nav (ai/posts.js), converts rails over drops and adds ledge
//       perches, adds the level's designer posts (ai/layout.js) and two search loops
//     - hard points: the level's designer ones (level.hardPoints) + an auto one per 'overwatch' spawn (ai/layout.js)
//     - the vantage manager (ai/vantage.js): reach set, per-post vantage, perch / defend-search selector swaps
//     - spawns min(ai.count, spawns) enemies from level.spawns.enemies (createEnemy, ai/enemy.js); adds them to
//       game.actors and game.enemies
//     - system 'ai' (ORDER.ai): director pre-step → each brain → director post-step (tokens, timers, lost-player,
//       staggered post queries, grenade flight)
//     - system 'ai.rigs' (ORDER.animation) only for rigs nobody else updates (no animator system loaded)
//     - stub grenades (ai/stubs.js) only if game.grenades is missing; system 'ai.grenades' (ORDER.projectiles)
//     - debug overlay (ai/debug.js), toggled with F2 (param ai.debug)
//   createEnemy(game, spawn, {director, index}) -> actor
//
// Events used: listens to 'noise' (hearing), 'shot' (the player engaging an NPC); emits 'state' (sys 'ai', 'ai.role',
// 'ai.token', 'ai.behavior', 'ai.cover', 'ai.director', 'ai.timer', 'ai.throw', 'ai.investigate'), 'death' (from
// actor.takeDamage, which weapons' applyDamage calls) and 'bark' {actor, line}.
import { ORDER } from '../core/game.js';
import { defineAIParams, makeP } from './tuning.js';
import { generatePosts, PostQuery } from './posts.js';
import { addPerchPosts, addDesignerPosts, renumberPosts, loadHardPoints } from './layout.js';
import { VantageManager } from './vantage.js';
import { createNavTools } from './navtools.js';
import { Director } from './director.js';
import { createEnemy, findExport } from './enemy.js';
import { createStubGrenades } from './stubs.js';
import { createDebug } from './debug.js';

export { createEnemy };
export { scorePost, SELECTORS } from './posts.js';

// §2 search loops [INFERRED: 2 loops, perimeter + centre]: rectangles inset in the level bounds, snapped to nav nodes.
export function generateSearchLoops(level, nav, P) {
  const b = level && level.bounds;
  if (!b || !nav || !nav.nearest) return [];
  const inset = P('ai.search.loopInset'), step = P('ai.search.loopStep');
  const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
  const hx = (b.max.x - b.min.x) / 2, hz = (b.max.z - b.min.z) / 2;
  const floorY = 0.2;                                    // [ASSUMED] courtyard floor at y = 0 (design.md)
  const rects = [[hx - inset, hz - inset], [hx * 0.35, hz * 0.35]];
  const loops = [];
  for (const [rx, rz] of rects) {
    if (rx <= 0.5 || rz <= 0.5) continue;
    const corners = [[cx - rx, cz - rz], [cx + rx, cz - rz], [cx + rx, cz + rz], [cx - rx, cz + rz]];
    const pts = [];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
      const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / step));
      for (let k = 0; k < n; k++) {
        const x = ax + (bx - ax) * k / n, z = az + (bz - az) * k / n;
        const node = nav.nearest({ x, y: floorY, z });
        if (!node || Math.hypot(node.x - x, node.z - z) > 1.5) continue;
        const last = pts[pts.length - 1];
        if (last && Math.hypot(last.x - node.x, last.z - node.z) < 1.0) continue;
        pts.push({ x: node.x, y: node.y, z: node.z });
      }
    }
    if (pts.length >= 3) loops.push(pts);
  }
  return loops;
}

export function createAI(game, opts = {}) {
  if (game.ai && game.ai.isDirector) return game.ai;
  defineAIParams(game.params);
  const P = makeP(game.params);
  const level = game.level || {};
  const nav = level.nav || null;
  const tools = createNavTools(nav);
  if (!tools.ok) console.warn('[ai] level.nav has no CSR graph: post path distances fall back to straight lines');
  const posts = generatePosts(level, nav, P);
  const perch = addPerchPosts(posts, nav, game.world, P);
  const designerPosts = addDesignerPosts(posts, level, nav, game.world, P);
  renumberPosts(posts);
  const loops = generateSearchLoops(level, nav, P);

  if (!game.grenades) {
    game.grenades = createStubGrenades(game, P);
    game.addSystem({ name: 'ai.grenades', order: ORDER.projectiles, update: (dt) => game.grenades.update(dt) });
    console.info('[ai] game.grenades missing: using the AI stub grenades');
  }

  const director = new Director(game, { P, posts, tools, loops, Vector3: game.world.Vector3 });
  director.isDirector = true;
  director.nav = nav;
  director.layout = { perchRails: perch.rails, perchLedges: perch.ledges, designerPosts };
  director.vantage = new VantageManager(game, { P, posts, tools, director });
  game.ai = director;

  // spawn
  const spawns = (opts.spawns || (level.spawns && level.spawns.enemies) || []).slice(0, Math.max(0, P('ai.count')));
  if (!game.enemies) game.enemies = [];
  if (!game.actors) game.actors = [];
  spawns.forEach((sp, i) => {
    const npc = createEnemy(game, sp, { director, index: i, P, rig: opts.rig, createCharacter: opts.createCharacter, createWeapon: opts.createWeapon });
    npc.ai.query = new PostQuery(48);
    npc.ai.query.vantage = director.vantage;
    director.add(npc);
    game.enemies.push(npc);
    game.actors.push(npc);
  });
  director.hardPoints = loadHardPoints(level, spawns, director.npcs);   // designer zones + overwatch spawn hints

  // events
  const offs = [];
  offs.push(game.events.on('noise', (ev) => { if (!P('ai.enabled')) return; for (const n of director.npcs) n.ai.brain.onNoise(ev); }));
  offs.push(game.events.on('shot', (ev) => { if (!P('ai.enabled')) return; if (ev && ev.shooter && ev.shooter.team === 'player') for (const n of director.npcs) n.ai.brain.onShot(ev); }));

  // systems
  const sys = {
    name: 'ai', order: ORDER.ai,
    update(dt) {
      if (!P('ai.enabled')) return;
      director.preUpdate(dt);
      for (let i = 0; i < director.npcs.length; i++) director.npcs[i].ai.brain.update(dt);
      director.postUpdate(dt);
      const hud = game.hud;
      if (hud && typeof hud.setCombat === 'function') hud.setCombat(director.combat);
    },
  };
  game.addSystem(sys);
  game.addSystem({
    name: 'ai.rigs', order: ORDER.animation + 0.5,
    update(dt) {
      if (game.getSystem && game.getSystem('animation')) return;          // character/animator.js poses every actor's rig
      for (const n of director.npcs) {
        const rig = n.rig;
        if (!rig || !rig.root || typeof rig.update !== 'function') continue;
        rig.root.position.set(n.pos.x, n.pos.y, n.pos.z);
        rig.root.rotation.set(0, n.yaw, 0);
        rig.update(dt, n.anim);
        rig.root.updateMatrixWorld(true);
      }
    },
  });
  director.debug = game.scene ? createDebug(game, director, P) : null;
  director.dispose = () => { for (const off of offs) off(); };
  return director;
}

// main.js awaits this. createCharacter: game.createCharacter is set by character/animator.js through an async import
// that may not have resolved yet, so the character module is imported here directly when nothing provides it.
export async function install(game) {
  let createCharacter = findExport(game, 'createCharacter');
  if (!createCharacter) {
    try { createCharacter = (await import('../character/index.js')).createCharacter || null; } catch { createCharacter = null; }
  }
  return createAI(game, { createCharacter });
}
