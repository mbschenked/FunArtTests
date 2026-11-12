// Game: fixed-step simulation loop, system registry, seeded RNG, debug time scale.
// Contract: refs/design.md "core/game.js". Rendering is owned by core/render.js (game.render).
import { Events } from './events.js';
import { Params, STORAGE_KEY } from './params.js';

// System order from the contract (refs/design.md "core/game.js"). Use these instead of bare numbers.
export const ORDER = Object.freeze({
  input: 0, player: 10, ai: 20, weapons: 30, projectiles: 40, physics: 50, actors: 50,
  animation: 60, camera: 70, vfx: 80, hud: 90, measure: 100,
});

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Game {
  // test: headless mode (?test). Params are not persisted, so every run starts from defaults + ?set=.
  constructor({ seed = 1, test = false, storageKey = STORAGE_KEY } = {}) {
    this.dt = 1 / 60;          // fixed sim step (s)
    this.time = 0;             // sim time (s)
    this.frame = 0;            // sim steps taken
    this.timeScale = 1;        // debug slow-mo
    this.paused = false;
    this.stepOnce = false;     // debug: advance exactly one step while paused
    this.maxStepsPerFrame = 4; // drop time rather than spiral
    this.test = test;
    this.seed = seed >>> 0;

    this.rng = mulberry32(this.seed);
    this.events = new Events();
    this.params = new Params({ storageKey: test ? null : storageKey });

    // Filled in by modules during boot (see src/main.js):
    this.scene = null; this.camera = null; this.render = null;
    this.world = null; this.level = null; this.input = null;
    this.hud = null; this.vfx = null;
    this.actors = []; this.player = null; this.enemies = [];
    this.modules = {};         // name -> loaded module namespace (main.js), e.g. game.modules.skeleton.createCharacter
    this.boot = { loaded: [], missing: [], failed: [] };

    this.systems = [];
    this._acc = 0;
    this._last = 0;
    this._running = false;
  }

  addSystem(sys) {
    if (typeof sys.order !== 'number') sys.order = 50;
    if (this.systems.includes(sys)) return sys;
    this.systems.push(sys);
    this.systems.sort((a, b) => a.order - b.order);   // stable: equal orders keep insertion order
    return sys;
  }

  removeSystem(sys) {
    const i = this.systems.indexOf(sys);
    if (i >= 0) this.systems.splice(i, 1);
  }

  getSystem(name) {
    for (const s of this.systems) if (s.name === name) return s;
    return null;
  }

  // One fixed simulation step. Exposed so headless tests can step deterministically.
  step() {
    const dt = this.dt;
    const sys = this.systems;
    for (let i = 0; i < sys.length; i++) if (sys[i].update) sys[i].update(dt, this);
    for (let i = 0; i < sys.length; i++) if (sys[i].lateUpdate) sys[i].lateUpdate(dt, this);
    this.time += dt;
    this.frame++;
  }

  stepN(n) { for (let i = 0; i < n; i++) this.step(); }

  // Per-frame work (camera smoothing, HUD, VFX animation) and one render, without advancing the sim.
  renderFrame(realDt = this.dt) {
    const sys = this.systems;
    for (let i = 0; i < sys.length; i++) if (sys[i].frame) sys[i].frame(realDt, this);
    if (this.render) this.render.draw();
  }

  // Advance the sim by real elapsed seconds (scaled), then run per-frame work and render.
  tick(realDt) {
    realDt = Math.min(realDt, 0.25);
    if (!this.paused) {
      this._acc += realDt * this.timeScale;
      let n = 0;
      while (this._acc >= this.dt && n < this.maxStepsPerFrame) {
        this.step();
        this._acc -= this.dt;
        n++;
      }
      if (n === this.maxStepsPerFrame) this._acc = 0;
    } else if (this.stepOnce) {
      this.step();
      this.stepOnce = false;
    }
    this.renderFrame(realDt);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    const loop = (now) => {
      if (!this._running) return;
      const realDt = (now - this._last) / 1000;
      this._last = now;
      this.tick(realDt);          // an exception here stops the loop on purpose: the error banner shows the first one
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() { this._running = false; }
}
