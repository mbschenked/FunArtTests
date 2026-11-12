// Measurement feed for the timing seam. Contract: refs/design.md "debug/measure.js".
//
// Records, with the sim time (game.time) and step (game.frame) at which they happen:
//   {type: 'state', time, frame, actor, sys, from, to, t}     every `state` event (actor = actor.id)
//   {type: 'input', time, frame, action, edge: 'press'|'release'}   per-step input edges; `move` counts as pressed while |move| > 0
//   {type: 'grenade:throw' | 'grenade:explode' | 'shot' | 'death', time, frame, actor}
//   {type: 'takedown', time, frame, kind, phase, actor, victim, duration}   stealth takedowns (src/player/stealth.js);
//                           phase 'start' | 'kill' | 'end', duration = planned length (s) on start, measured on end
//
// window.__measure:
//   log(filter?)            entries (a copy, JSON-safe). filter: {type, sys, actor, action} (all optional)
//   span(sys, from, to)     durations (s) from each entry into state `from` to the next entry into state `to`
//                           (same sys and actor). `to` omitted: until the state is left. '*' matches any state.
//   gap(a, b)               durations from each entry matching `a` to the next entry matching `b`, where a/b are
//                           partial entries, e.g. gap({type:'input', action:'cover', edge:'press'}, {sys:'cover', to:'enter'})
//   clear()
import { ORDER } from '../core/game.js';
import { BUTTONS } from '../core/input.js';

const MAX_ENTRIES = 20000;
const OTHER_EVENTS = ['grenade:throw', 'grenade:explode', 'shot', 'death'];
const actorId = (a) => (a == null ? null : typeof a === 'object' ? (a.id ?? null) : a);

export class Measure {
  constructor(game) {
    this.game = game;
    this.name = 'measure';
    // Runs right after input (not at ORDER.measure = 100) so an input edge is logged before the state change it causes
    // in the same step; otherwise gap(input press -> state) would skip to the next occurrence.
    this.order = ORDER.input + 0.5;
    this.entries = [];
    this._prevMove = false;
    this._offs = [game.events.on('state', (e) => this._push({
      type: 'state', actor: actorId(e.actor), sys: e.sys, from: e.from ?? null, to: e.to ?? null, t: e.t ?? null,
    }))];
    for (const type of OTHER_EVENTS) {
      this._offs.push(game.events.on(type, (e) => this._push({
        type, actor: actorId(e && (e.owner || e.shooter || e.actor)),
      })));
    }
    this._offs.push(game.events.on('takedown', (e) => this._push({
      type: 'takedown', kind: e.kind ?? null, phase: e.phase ?? null, actor: actorId(e.attacker),
      victim: actorId(e.victim), duration: e.duration ?? null,
    })));
  }

  _push(entry) {
    entry.time = +this.game.time.toFixed(6);
    entry.frame = this.game.frame;
    if (this.entries.length >= MAX_ENTRIES) this.entries.shift();
    this.entries.push(entry);
  }

  // System update (order 0.5): this step's input edges.
  update(dt, game) {
    const input = game.input;
    if (!input || !input.pressed) return;
    for (const a of BUTTONS) {
      if (input.pressed(a)) this._push({ type: 'input', action: a, edge: 'press' });
      else if (input.released(a)) this._push({ type: 'input', action: a, edge: 'release' });
    }
    const m = input.axis('move');
    const moving = m.x !== 0 || m.y !== 0;
    if (moving !== this._prevMove) this._push({ type: 'input', action: 'move', edge: moving ? 'press' : 'release' });
    this._prevMove = moving;
  }

  log(filter) {
    const out = [];
    for (const e of this.entries) if (!filter || matches(e, filter)) out.push({ ...e });
    return out;
  }

  span(sys, from, to) {
    const out = [];
    const open = new Map();                       // actor -> time it entered `from`
    for (const e of this.entries) {
      if (e.type !== 'state' || e.sys !== sys) continue;
      const k = e.actor;
      if (open.has(k)) {
        const done = to === undefined || to === null ? e.from === from || from === '*' : to === '*' || e.to === to;
        if (done) { out.push(round(e.time - open.get(k))); open.delete(k); }
      }
      if (!open.has(k) && (from === '*' || e.to === from)) open.set(k, e.time);
    }
    return out;
  }

  gap(a, b) {
    const out = [];
    let start = null;
    for (const e of this.entries) {
      if (start !== null && matches(e, b)) { out.push(round(e.time - start)); start = null; continue; }
      if (start === null && matches(e, a)) start = e.time;
    }
    return out;
  }

  clear() { this.entries.length = 0; this._prevMove = false; }

  dispose() { for (const off of this._offs) off(); }
}

const round = (v) => +v.toFixed(6);
function matches(e, f) {
  for (const k in f) if (f[k] !== undefined && e[k] !== f[k]) return false;
  return true;
}

// Create the recorder, add it as the measure system and expose window.__game / window.__measure.
export function installMeasure(game) {
  const m = new Measure(game);
  game.addSystem(m);
  if (typeof window !== 'undefined') {
    window.__game = game;
    window.__measure = {
      log: (filter) => m.log(filter),
      span: (sys, from, to) => m.span(sys, from, to),
      gap: (a, b) => m.gap(a, b),
      clear: () => m.clear(),
      recorder: m,
    };
  }
  return m;
}

export const install = installMeasure;
