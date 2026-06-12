// main.js — game loop, frozen step order, single hitstop freeze point,
// window.__game debug surface. Integration layer (P2).

import { CONFIG } from './config.js';
import { RNG, EventBus } from './utils.js';
import { InputSystem, ACTIONS } from './input.js';
import { Fighter, STATES } from './fighter.js';
import { PlayerController } from './player.js';
import { BossAI } from './boss.js';
import { CombatSystem } from './combat.js';
import { Renderer } from './render.js';
import { HUD } from './hud.js';
import { AudioSystem } from './audio.js';

const EVENT_RING_SIZE = 200;
const DEFAULT_SEED = 1;

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.bus = new EventBus();
    this.rng = new RNG(DEFAULT_SEED);          // SIM randomness (boss AI, combat)
    this.renderRng = new RNG(DEFAULT_SEED + 1); // visual-only randomness — never the sim's

    this.input = new InputSystem(CONFIG);
    this.input.attach(window);

    this.renderer = new Renderer(canvas, CONFIG, this.bus, this.renderRng);
    this.hud = new HUD(CONFIG);
    this.audio = new AudioSystem(this.bus);
    this.input.onFirstInteraction = () => this.audio.resume();

    // Tuning baseline for dumpTuning(): deep clone of load-time CONFIG
    this._configDefaults = JSON.parse(JSON.stringify(CONFIG));
    this._tuned = new Map(); // path → true

    // Event ring buffer — every bus event, tick-stamped
    this.eventLog = [];
    this.bus.on('*', (e) => {
      this.eventLog.push({ ...e, tick: e.tick ?? this.tick });
      if (this.eventLog.length > EVENT_RING_SIZE) this.eventLog.shift();
    });

    // Loop state
    this.timescale = 1;
    this.paused = false;
    this.pendingStepFrames = 0;
    this._acc = 0;
    this._lastTs = null;
    this._raf = null;

    this._seed = DEFAULT_SEED;
    this._buildWorld(DEFAULT_SEED);

    // R restarts after a fight ends (UI control, not a combat action)
    window.addEventListener('keydown', (e) => {
      if ((e.key === 'r' || e.key === 'R') && this.over) this.reset(this._seed);
      if (e.key === 'h' || e.key === 'H') this.hud.showHelp = !this.hud.showHelp;
    });
  }

  /** (Re)create the sim world. Presentation objects persist across resets. */
  _buildWorld(seed) {
    this._seed = seed;
    this.rng.reseed(seed);
    this.renderRng.reseed(seed + 1);
    this.tick = 0;
    this.eventLog.length = 0;
    this.over = false;
    this.banner = null;
    this._phase2Fired = false;
    this.input.clear();
    this.renderer?.resetTransient?.();

    this.player = new Fighter({
      id: 'player', config: CONFIG.PLAYER,
      x: CONFIG.ARENA.playerSpawnX, facing: 1, bus: this.bus,
    });
    this.boss = new Fighter({
      id: 'boss', config: CONFIG.BOSS,
      x: CONFIG.ARENA.bossSpawnX, facing: -1, bus: this.bus,
    });
    this.combat = new CombatSystem({ config: CONFIG, bus: this.bus, rng: this.rng });
    this.playerController = new PlayerController({
      fighter: this.player, input: this.input, config: CONFIG, bus: this.bus,
    });
    this.bossAI = new BossAI({
      fighter: this.boss, config: CONFIG, rng: this.rng, bus: this.bus,
    });
  }

  start() {
    const loop = (ts) => {
      this._raf = requestAnimationFrame(loop);
      if (this._lastTs === null) this._lastTs = ts;
      const realDt = Math.min(0.1, (ts - this._lastTs) / 1000);
      this._lastTs = ts;

      if (!this.paused) {
        this._acc += realDt * 1000 * this.timescale;
        // Spiral-of-death guard: never simulate more than 6 ticks per frame
        let safety = 6;
        while (this._acc >= CONFIG.TIMING.fixedDtMs && safety-- > 0) {
          this._acc -= CONFIG.TIMING.fixedDtMs;
          this.step();
        }
        if (safety <= 0) this._acc = 0;
      } else if (this.pendingStepFrames > 0) {
        while (this.pendingStepFrames-- > 0) this.step();
        this.pendingStepFrames = 0;
      }

      this.render(this._acc / CONFIG.TIMING.fixedDtMs, realDt);
    };
    this._raf = requestAnimationFrame(loop);
  }

  /** FROZEN ORDER — see docs/TDD.md §3.3. */
  step() {
    const dt = CONFIG.TIMING.fixedDtMs / 1000;
    this.tick++;
    this.input.update(this.tick);                                   // 1

    if (this.combat.hitstop > 1e-9) {                               // 2 — the ONE freeze point
      this.combat.hitstop -= dt;
      return;
    }

    const ctxP = { boss: this.boss, combat: this.combat };
    const ctxB = { player: this.player, combat: this.combat };
    if (!this.over || this.player.state !== STATES.DEAD) {
      this.playerController.update(dt, ctxP);                       // 3
    }
    if (!this.over || this.boss.state !== STATES.DEAD) {
      this.bossAI.update(dt, ctxB);                                 // 4
    }
    this.player.update(dt);                                         // 5
    this.boss.update(dt);
    this.combat.update(dt, this.player, this.boss);                 // 6

    // 7 — outcome checks
    if (!this._phase2Fired && this.boss.hp <= CONFIG.BOSS.phases[2].hpThreshold * CONFIG.BOSS.hpMax && this.boss.state !== STATES.DEAD) {
      this._phase2Fired = true;
      this.bossAI.setPhase(2);
      this.banner = { text: 'ARELIUS UNBOUND', untilTick: this.tick + 240 };
    }
    if (!this.over) {
      if (this.boss.state === STATES.DEAD) {
        this.over = true;
        this.banner = { text: 'THE THREAD IS CUT', untilTick: Infinity, sub: 'R — face him again' };
      } else if (this.player.state === STATES.DEAD) {
        this.over = true;
        this.banner = { text: 'FATE RECLAIMED', untilTick: Infinity, sub: 'R — defy fate once more' };
      }
    }
  }

  _finisherAvailableFor() {
    const d = Math.abs(this.player.x - this.boss.x);
    if (this.boss.state === STATES.STAGGERED && d <= CONFIG.COMBAT.finisherSnapMax) return 'player';
    if (this.player.state === STATES.STAGGERED && d <= CONFIG.COMBAT.finisherSnapMax) return 'boss';
    return null;
  }

  _chargeLevel() {
    const a = this.player.attack;
    if (a && a.def.chargeable && a._chargeHeld) return a.chargeLevel;
    return null;
  }

  render(alpha, realDt) {
    this.renderer.render(this.player, this.boss, this.combat.projectiles, alpha, realDt, {
      hitstop: this.combat.hitstop, tick: this.tick,
    });
    this.hud.render(this.renderer.ctx, this.player, this.boss, {
      phase: this.bossAI.phase,
      finisherAvailableFor: this._finisherAvailableFor(),
      banner: this.banner && this.tick <= this.banner.untilTick ? this.banner : null,
      tick: this.tick,
      chargeLevel: this._chargeLevel(),
    });
  }

  reset(seed = this._seed) {
    this.combat.hitstop = 0;
    this._acc = 0;
    this._buildWorld(seed);
  }
}

function deepSnapshot(game) {
  return {
    tick: game.tick,
    time: game.tick / CONFIG.TIMING.fps,
    hitstop: game.combat.hitstop,
    phase: game.bossAI.phase,
    banner: game.banner ? { ...game.banner } : null,
    over: game.over,
    player: {
      ...game.player.snapshot(),
      comboIndex: game.playerController.comboIndex,
      buffered: game.input.peekBuffered(),
    },
    boss: {
      ...game.boss.snapshot(),
      ai: game.bossAI.info(),
    },
    projectiles: game.combat.projectiles.map((p) => ({
      x: p.x, y: p.y, vx: p.vx, owner: p.owner, id: p.def.id,
      stuck: p.stuck, stuckX: p.stuckX,
    })),
  };
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in node)) throw new Error('tune: bad path ' + path);
    node = node[parts[i]];
  }
  const leaf = parts[parts.length - 1];
  if (!(leaf in node)) throw new Error('tune: bad path ' + path);
  node[leaf] = value;
}

function getPath(obj, path) {
  return path.split('.').reduce((n, k) => (n == null ? undefined : n[k]), obj);
}

export function installDebugApi(game) {
  window.__game = {
    state: () => JSON.parse(JSON.stringify(deepSnapshot(game))),
    events: (sinceTick = 0) => game.eventLog.filter((e) => e.tick >= sinceTick),

    input: {
      press: (a) => game.input.inject(a, 'down'),
      release: (a) => game.input.inject(a, 'up'),
      tap: (a, holdTicks = 3) => game.input.inject(a, 'tap', holdTicks),
      sequence: (steps) => steps.forEach((s) => game.input.inject(s.action, s.type, s.holdTicks)),
    },

    setTimescale: (s) => { game.timescale = Math.max(0.01, s); },
    pause: () => { game.paused = true; },
    resume: () => { game.paused = false; game._lastTs = null; },
    stepFrames: (n) => {
      if (!game.paused) game.paused = true;
      for (let i = 0; i < n; i++) game.step();
    },
    reset: (seed) => game.reset(seed ?? game._seed),
    seedRng: (seed) => { game.rng.reseed(seed); },

    boss: {
      forceAttack: (id) => game.bossAI.forceAttack(id),
      setPhase: (n) => game.bossAI.setPhase(n),
      setHp: (v) => { game.boss.hp = v; },
      setPoise: (v) => { game.boss.poise = v; },
      aiEnabled: (b) => { game.bossAI.enabled = b; },
    },
    player: {
      setHp: (v) => { game.player.hp = v; },
      setPoise: (v) => { game.player.poise = v; },
      invuln: (b) => { game.player.invulnerable = b; },
      teleport: (x) => { game.player.x = x; },
    },

    tune: (path, value) => { setPath(CONFIG, path, value); game._tuned.set(path, true); },
    dumpTuning: () => {
      const out = {};
      for (const path of game._tuned.keys()) {
        out[path] = {
          default: getPath(game._configDefaults, path),
          current: getPath(CONFIG, path),
        };
      }
      return out;
    },
    config: CONFIG,
  };
  return window.__game;
}

export function start(canvas) {
  const game = new Game(canvas);
  installDebugApi(game);
  game.start();
  return game;
}
