// input.js — keyboard + virtual input + the PLAYER-ONLY input buffer.
// STRUCTURAL RULE (TOG design): this module may be imported ONLY by player.js
// (and main.js for construction/update). The boss never touches input — the
// player-only buffer guarantee is enforced by the import graph, not politeness.
//
// WP-B implements this file. Contract is frozen; do not change signatures.

import { CONFIG } from './config.js';

export const ACTIONS = Object.freeze({
  LEFT: 'LEFT',
  RIGHT: 'RIGHT',
  SLASH: 'SLASH',    // J — slash chain / counter / finisher (contextual)
  THRUST: 'THRUST',  // K — pierce combo
  CHARGE: 'CHARGE',  // L — hold to charge, release to swing
  DODGE: 'DODGE',    // Space — with LEFT held = dash-back, else dash-through
  GUARD: 'GUARD',    // S — tap = deflect attempt, hold = block
  HELP: 'HELP',      // H — toggle key reference overlay
});

export const KEY_MAP = Object.freeze({
  a: ACTIONS.LEFT, d: ACTIONS.RIGHT,
  j: ACTIONS.SLASH, k: ACTIONS.THRUST, l: ACTIONS.CHARGE,
  ' ': ACTIONS.DODGE, s: ACTIONS.GUARD, h: ACTIONS.HELP,
});

const BUFFERED_ACTIONS = new Set([
  ACTIONS.SLASH, ACTIONS.THRUST, ACTIONS.CHARGE, ACTIONS.DODGE,
]);

export class InputSystem {
  /** @param {object} config CONFIG (uses PLAYER.inputBufferMs, TIMING.fps) */
  constructor(config = CONFIG) {
    this.config = config;
    /** Set by main.js: called once on first real keydown (audio autoplay unlock). */
    this.onFirstInteraction = null;

    // Physical key state: action → boolean
    this._held = new Map();
    // Edge latches: actions that received a keydown between last update() and now
    this._pendingDown = new Set();
    // Pressed edges for the current tick (valid until next update())
    this._pressed = new Set();
    // Input buffer: [{action, tick}] — oldest first
    this._buffer = [];
    // Pending virtual auto-releases: [{action, releaseTick}]
    this._pendingReleases = [];
    // Current tick (set each update call)
    this._tick = 0;
    // Has a real keydown ever been received?
    this._hadFirstInteraction = false;
  }

  /** Attach keydown/keyup listeners. Repeat events must be ignored. */
  attach(targetWindow) {
    targetWindow.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const action = KEY_MAP[e.key];
      if (!action) return;
      e.preventDefault();
      this._handleDown(action, true);
    });
    targetWindow.addEventListener('keyup', (e) => {
      const action = KEY_MAP[e.key];
      if (!action) return;
      e.preventDefault();
      this._handleUp(action);
    });
  }

  // Core down/up logic shared by real keys and inject().
  _handleDown(action, isRealKey) {
    if (this._held.get(action)) return; // already held, ignore (no repeat)
    this._held.set(action, true);
    this._pendingDown.add(action);
    if (BUFFERED_ACTIONS.has(action)) {
      this._buffer.push({ action, tick: this._tick });
    }
    if (isRealKey && !this._hadFirstInteraction) {
      this._hadFirstInteraction = true;
      if (typeof this.onFirstInteraction === 'function') {
        this.onFirstInteraction();
      }
    }
  }

  _handleUp(action) {
    this._held.set(action, false);
  }

  /**
   * Snapshot edges for this fixed tick. Called once per Game.step BEFORE any
   * controller update. `pressed()` edges are valid until the next update().
   * Presses arriving between ticks are latched, never dropped.
   * @param {number} tick current fixed tick counter
   */
  update(tick) {
    this._tick = tick;

    // Process pending virtual auto-releases
    for (let i = this._pendingReleases.length - 1; i >= 0; i--) {
      const r = this._pendingReleases[i];
      if (tick >= r.releaseTick) {
        this._handleUp(r.action);
        this._pendingReleases.splice(i, 1);
      }
    }

    // Snapshot the latched presses as the edge set for this tick
    this._pressed = new Set(this._pendingDown);
    this._pendingDown.clear();

  }

  /** @returns {boolean} action currently held */
  held(action) {
    return !!this._held.get(action);
  }

  /** @returns {boolean} action press edge occurred this tick */
  pressed(action) {
    return this._pressed.has(action);
  }

  /**
   * PLAYER-ONLY BUFFER. Every press of SLASH/THRUST/CHARGE/DODGE is also
   * recorded with its tick. PlayerController consumes during recovery windows.
   * @param {string} action
   * @param {number} maxAgeMs buffered press older than this is stale
   * @returns {boolean} true if a buffered press existed (and was consumed)
   */
  consumeBuffered(action, maxAgeMs) {
    const fps = this.config.TIMING.fps;
    const maxAgeTicks = maxAgeMs / (1000 / fps);
    for (let i = 0; i < this._buffer.length; i++) {
      const entry = this._buffer[i];
      if (entry.action === action) {
        const ageTicks = this._tick - entry.tick;
        if (ageTicks <= maxAgeTicks) {
          this._buffer.splice(i, 1);
          return true;
        }
        // Entry is too old — remove it and keep scanning (there could be a newer one)
        this._buffer.splice(i, 1);
        i--;
      }
    }
    return false;
  }

  /** Clear all transient input state. Call on world reset to avoid stale held/pressed state. */
  clear() {
    this._held.clear();
    this._pressed.clear();
    this._pendingDown.clear();
    this._buffer.length = 0;
    this._pendingReleases.length = 0;
  }

  /** @returns {Array<{action:string, tick:number}>} debug view, oldest first */
  peekBuffered() {
    return this._buffer.map(e => ({ action: e.action, tick: e.tick }));
  }

  /**
   * Virtual input for verification agents — MUST route through the exact same
   * code path as real key events (same latching, same buffer writes).
   * @param {string} action @param {'down'|'up'|'tap'} type
   * @param {number} [holdTicks=3] for 'tap': auto-release after N ticks
   */
  inject(action, type, holdTicks = 3) {
    if (type === 'down') {
      this._handleDown(action, false);
    } else if (type === 'up') {
      this._handleUp(action);
    } else if (type === 'tap') {
      this._handleDown(action, false);
      this._pendingReleases.push({ action, releaseTick: this._tick + holdTicks });
    }
  }
}
