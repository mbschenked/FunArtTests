// utils.js — seeded RNG, event bus, math helpers. No imports.
// Math.random is BANNED everywhere in src/ — all randomness flows through RNG
// so fights are deterministic and verification scripts are reproducible.

/** Deterministic PRNG (mulberry32). */
export class RNG {
  constructor(seed = 1) {
    this.reseed(seed);
  }

  reseed(seed) {
    this._s = seed >>> 0;
    if (this._s === 0) this._s = 0x9e3779b9;
  }

  /** @returns {number} float in [0, 1) */
  next() {
    let t = (this._s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** float in [min, max) */
  range(min, max) {
    return min + this.next() * (max - min);
  }

  /** integer in [min, max] inclusive */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  chance(p) {
    return this.next() < p;
  }

  /** @param {Object<string,number>} weightMap id → weight; zero/negative weights excluded */
  weightedPick(weightMap) {
    const entries = Object.entries(weightMap).filter(([, w]) => w > 0);
    const total = entries.reduce((s, [, w]) => s + w, 0);
    if (total <= 0) return null;
    let roll = this.next() * total;
    for (const [id, w] of entries) {
      roll -= w;
      if (roll < 0) return id;
    }
    return entries[entries.length - 1][0];
  }
}

/** Minimal synchronous pub/sub. Listeners are cosmetic-only by contract:
 *  render/audio/debug subscribe; NOTHING that mutates combat state may live
 *  in a listener (single-writer rule — CombatSystem owns state). */
export class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }

  emit(type, payload) {
    this._listeners.get(type)?.forEach((fn) => fn(payload));
    this._listeners.get('*')?.forEach((fn) => fn({ type, ...payload }));
  }
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** The boss poise-regen health curve from TOG, exactly:
 *  Curve_Arelius_Health_vs_StaminaRegenRate sample points
 *  (0→0, 0.3→0.216, 0.5→0.5, 0.7→0.784, 1→1) are f(x) = 3x² − 2x³. */
export const smoothstep01 = (x) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

/** @param {{x:number,y:number,w:number,h:number}} a top-left anchored rects */
export function aabbOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
