// Boot: create the Game, load every module with a guarded dynamic import, install them in dependency order.
// Contract: refs/design.md. Query flags:
//   ?test        headless mode: no pointer lock, no game.start() (tools/play.mjs steps the sim), seed 1, params not
//                persisted, tuning panel built but hidden, window.__ready = true once booted
//   ?seed=N      RNG seed (default: 1 in ?test, random otherwise; the seed is logged so a run can be repeated)
//   ?set=k:v,..  param overrides (core/params.js)
//   ?skip=a,b    treat these modules (MODULES names, e.g. render,hud) as not built: isolates a module, tests fallbacks
//
// Module boot convention (for module owners): export `install(game, ctx)` (may be async) that sets its game field
// (game.world, game.level, game.hud, ...) and adds its own systems with ORDER from core/game.js. If a module has no
// install(), main.js calls the constructor named in MODULES below as fn(game, ...args) (`new` for a class), or through
// spec.call when the module takes other arguments, stores the result in the game field when the module didn't, runs
// spec.post, and adds the result as a system if it has update/frame and the module added no system itself.
// Every loaded namespace is kept in game.modules[name] (e.g. game.modules.skeleton.createCharacter).
import * as THREE from 'three';
import GUI from 'lil-gui';
import { Game, ORDER } from './core/game.js';
import { Input, installDebugKeys } from './core/input.js';
import { installMeasure } from './debug/measure.js';

const QP = new URLSearchParams(location.search);
const TEST = QP.has('test');
const seedQ = parseInt(QP.get('seed'), 10);
const seed = Number.isFinite(seedQ) ? seedQ : TEST ? 1 : (Math.random() * 0xffffffff) >>> 0;
const SKIP = new Set((QP.get('skip') || '').split(',').map((s) => s.trim()).filter(Boolean));
const canvas = document.getElementById('gl');

// Install order = dependency order. `order` is used only when a returned system has none.
const MODULES = [
  { name: 'render',     path: 'core/render.js',        field: 'render', ctor: ['createRender', 'Render'], args: () => [{ canvas, static: TEST }] },
  // world.js is node-testable and takes its vector class, not the game (see its header). Its hitbox capsules follow the
  // rigs through updateHitboxes(), once per step after animation (60) has posed them.
  { name: 'world',      path: 'core/world.js',         field: 'world',  ctor: ['createWorld', 'World'], order: ORDER.physics,
    call: (fn) => fn({ Vector3: THREE.Vector3, cellSize: 2 }),
    post: (world) => world && typeof world.updateHitboxes === 'function' && game.addSystem(
      { name: 'world.hitboxes', order: ORDER.animation + 5, update: () => world.updateHitboxes() }) },
  { name: 'room',       path: 'level/room.js',         field: 'level',  ctor: ['createRoom', 'createLevel', 'Room'], post: (lvl) => lvl?.build?.(game) },
  { name: 'nav',        path: 'level/nav.js' },
  { name: 'skeleton',   path: 'character/skeleton.js' },
  { name: 'animator',   path: 'character/animator.js', order: ORDER.animation },
  { name: 'clips',      path: 'character/clips.js' },
  // character/skins.js install(): loads the CC0 figures (assets/figures) that createCharacter dresses the rigs in.
  { name: 'skins',      path: 'character/skins.js' },
  // vfx/index.js wires muzzle, tracer, impact and explosion and hooks the 'shot' and 'grenade:explode' events.
  { name: 'vfx',        path: 'vfx/index.js',          field: 'vfx',    ctor: ['createVfx'], order: ORDER.vfx },
  { name: 'hud',        path: 'hud/hud.js',            field: 'hud',    ctor: ['createHud', 'createHUD', 'HUD', 'Hud'], order: ORDER.hud },
  { name: 'controller', path: 'player/controller.js',  order: ORDER.player },
  { name: 'camera',     path: 'player/camera.js',      order: ORDER.camera },
  { name: 'cover',      path: 'player/cover.js',       order: ORDER.player },
  { name: 'climb',      path: 'player/climb.js',       order: ORDER.player },
  // weapons/index.js install(): game.weapons, game.grenades, the player's pistol (after the controller made the player).
  { name: 'weapons',    path: 'weapons/index.js',      order: ORDER.weapons },
  // ai/index.js install(): game.ai (director), enemies from level.spawns, ai/debug.js overlay (F2).
  { name: 'ai',         path: 'ai/index.js',           order: ORDER.ai },
  // player/stealth.js install(): game.stealth, takedown prompt + 'takedown' player mode (after the player and the AI).
  { name: 'stealth',    path: 'player/stealth.js',     order: ORDER.player },
];

const fallbackEl = document.getElementById('fallback');
function fatal(message) {
  if (!fallbackEl) return;
  fallbackEl.hidden = false;
  fallbackEl.textContent = message;
  fallbackEl.dataset.fatal = '1';          // the error surface (classic script in index.html) must not overwrite this
}

const isClass = (f) => typeof f === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(f));
const hasSystemHooks = (o) => o && typeof o === 'object' && (typeof o.update === 'function' || typeof o.frame === 'function');

// On the local python server, directory listings tell which module files exist, so missing ones are skipped without
// a 404 (each 404 is a console error). Elsewhere (GitHub Pages: no listings) returns null and every module is tried.
async function probeFiles() {
  const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
  if (!local) return null;
  const base = new URL('./', import.meta.url);
  const list = async (url) => {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok || !(r.headers.get('content-type') || '').includes('text/html')) return null;
      const html = await r.text();
      return new Set([...html.matchAll(/href="([^"?#]+)"/g)].map((m) => decodeURIComponent(m[1])));
    } catch { return null; }
  };
  const top = await list(base);
  if (!top || !top.has('main.js')) return null;
  const dirs = [...new Set(MODULES.map((m) => m.path.split('/')[0] + '/'))].filter((d) => top.has(d));
  const files = new Set();
  await Promise.all(dirs.map(async (d) => {
    const s = await list(new URL(d, base));
    if (s) for (const f of s) files.add(d + f);
  }));
  return files;
}

async function installOne(spec, mod) {
  game.modules[spec.name] = mod;
  const before = spec.field ? game[spec.field] : null;
  let fn = typeof mod.install === 'function' ? mod.install : typeof mod.default === 'function' ? mod.default : null;
  const viaInstall = !!fn;
  if (!fn) for (const n of spec.ctor || []) if (typeof mod[n] === 'function') { fn = mod[n]; break; }
  if (!fn) return;                                         // a library module (e.g. character/skeleton.js)
  const args = spec.args ? spec.args() : [];
  const nSystems = game.systems.length;
  const result = !viaInstall && spec.call ? await spec.call(fn, game)
    : isClass(fn) ? new fn(game, ...args) : await fn(game, ...args);
  const addedSystems = game.systems.length !== nSystems;
  if (spec.field && result && game[spec.field] === before) game[spec.field] = result;
  if (!viaInstall && spec.post) await spec.post(spec.field ? game[spec.field] : result);
  // A returned object with update/frame becomes a system only if the module didn't add one itself.
  if (!addedSystems && hasSystemHooks(result) && !game.systems.includes(result)) {
    if (typeof result.order !== 'number' && typeof spec.order === 'number') result.order = spec.order;
    if (!result.name) result.name = spec.name;
    game.addSystem(result);
  }
}

// Minimal stand-in while core/render.js isn't built: a plain WebGLRenderer and a PerspectiveCamera.
function fallbackRender() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: TEST });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1e25);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 300);
  const render = {
    renderer, scene, camera, composer: null, fallback: true,
    resize() {
      const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    draw() { renderer.render(scene, camera); },
    setGrade() {}, addPass() {}, look() {},
  };
  render.resize();
  window.addEventListener('resize', () => render.resize());
  game.render = render; game.scene = scene; game.camera = camera;
  console.info('[boot] core/render.js not available: using the fallback renderer');
}

// Stand-ins so the page shows something while level/room.js or player/camera.js isn't built:
// a grey 30 x 22 m floor with a 1 m grid and two lights, and a fixed camera looking at it.
function standIns() {
  if (!game.level) {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 22), new THREE.MeshStandardMaterial({ color: 0x6f6f6c, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    floor.name = 'standin-floor';
    const grid = new THREE.GridHelper(30, 30, 0x8a8a86, 0x5a5a58);
    grid.scale.z = 22 / 30;
    grid.position.y = 0.002;
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.0);
    sun.position.set(6, 12, -4);
    game.scene.add(floor, grid, new THREE.HemisphereLight(0xdfe8f5, 0x3a3630, 1.2), sun);
    console.info('[boot] no level: added a stand-in floor');
  }
  if (!game.modules.camera) {
    game.camera.position.set(0, 9, -17);
    game.camera.lookAt(0, 0, 0);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
const game = new Game({ seed, test: TEST });
console.info(`[boot] Cover Room, seed ${seed}${TEST ? ', test mode' : ''}`);
game.input = game.addSystem(new Input(game, { canvas, pointerLock: !TEST }));
installMeasure(game);

const exists = await probeFiles();
const loaded = await Promise.all(MODULES.map((spec) => {
  if (SKIP.has(spec.name) || (exists && !exists.has(spec.path))) return { missing: true };
  return import(`./${spec.path}`).then((mod) => ({ mod }), (err) => ({ err }));
}));

for (let i = 0; i < MODULES.length; i++) {
  const spec = MODULES[i], r = loaded[i];
  if (r.missing || (r.err && !exists && /Failed to fetch dynamically imported module/.test(String(r.err && r.err.message)))) {
    console.info(`[boot] module ${spec.path} ${SKIP.has(spec.name) ? 'skipped (?skip)' : 'not built yet'}`);
    game.boot.missing.push(spec.path);
  } else if (r.err) {
    console.error(`[boot] module ${spec.path} failed to load: ${r.err && r.err.stack || r.err}`);
    game.boot.failed.push(spec.path);
  } else {
    try {
      await installOne(spec, r.mod);
      game.boot.loaded.push(spec.path);
    } catch (err) {
      console.error(`[boot] module ${spec.path} failed to install: ${err && err.stack || err}`);
      game.boot.failed.push(spec.path);
    }
  }
  if (spec.name === 'render' && !game.render) {
    try { fallbackRender(); } catch (err) { fatal('WebGL could not start in this browser, so Cover Room cannot render.'); throw err; }
  }
}
if (!game.scene) game.scene = game.render.scene;
if (!game.camera) game.camera = game.render.camera;
standIns();

game.params.buildPanel(GUI, { title: 'Cover Room tuning', hidden: TEST });
installDebugKeys(game);

// "Click to play" hint while the mouse isn't captured (not in ?test).
const hint = document.getElementById('hint');
if (hint) {
  const sync = () => { hint.hidden = TEST || document.pointerLockElement === canvas; };
  document.addEventListener('pointerlockchange', sync);
  sync();
}

// Real play: the sim holds until the mouse is captured (click to play) and holds again when it is released (Esc, tab
// switch), so the fight never starts or runs on while nobody is playing. The death screen keeps running (it releases the
// mouse itself and R restarts there); after a restart the hold applies again. P still pauses on its own.
if (!TEST) {
  let held = false;
  const hold = () => {
    const locked = document.pointerLockElement === canvas;
    const dead = !!(game.player && game.player.health <= 0);
    if (!locked && !dead && !game.paused) { game.paused = true; held = true; }
    else if (locked && held) { game.paused = false; held = false; }
    requestAnimationFrame(hold);
  };
  hold();
}

if (fallbackEl && !fallbackEl.dataset.fatal) fallbackEl.hidden = true;
game.renderFrame(0);
window.__ready = true;
if (!TEST) game.start();
