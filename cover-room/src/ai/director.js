// Encounter director = game.ai (ai-spec §2, §4, §6): shared last-known position, core roles (engager / ambusher /
// defender), the shooter tokens, the advance and flank timers, the grenade director, the lost-player rules and the
// search loops. The coordination rules are pure functions at the top of this file (node-tested in tests/ai.test.mjs);
// the Director class below wires them to the game. No 'three' import.
import { dist2D, randRange, emitState, clamp } from './tuning.js';
import { playerCrouched, playerExposed } from './perception.js';
import { PostQuery, SELECTORS } from './posts.js';
import { regionDist } from './layout.js';

export const DIRECTOR_ACTOR = Object.freeze({ id: 'director', team: 'enemy' });

// ================================================================================================ pure rules
// §4.1 role assignment (G 33:11–34:30, G-deck p113). npcs: [{id, distToPlayer, distToAmbush, hpDist: {hpId: m}, pin}]
// opts: {engagers: X, ambushers: Y, hardPoints: [{id, min, max, enabled}]}
// Returns {roles: Map(id -> {role, hardPoint}), warnings: string[]}. Pins (archetype / spawn role) count toward X / Y.
export function assignRoles(npcs, opts) {
  const roles = new Map();
  const warnings = [];
  const hps = (opts.hardPoints || []).filter((h) => h.enabled !== false);
  const free = () => npcs.filter((n) => !roles.has(n.id));
  const count = (role, hp) => { let c = 0; for (const r of roles.values()) if (r.role === role && (!hp || r.hardPoint === hp)) c++; return c; };
  const closest = (list, key) => { let best = null; for (const n of list) if (!best || key(n) < key(best)) best = n; return best; };
  const hpDist = (n, hp) => (n.hpDist && hp.id in n.hpDist ? n.hpDist[hp.id] : Infinity);

  // 0. archetype / spawn pins override (G 41:26)
  for (const n of npcs) {
    if (!n.pin) continue;
    if (n.pin === 'defender') {
      const hp = closest(hps, (h) => hpDist(n, h));
      roles.set(n.id, hp ? { role: 'defender', hardPoint: hp.id } : { role: 'engager', hardPoint: null });
    } else roles.set(n.id, { role: n.pin, hardPoint: null });
  }
  // 1. hard points up to their minimum (highest priority)
  for (const hp of hps) {
    while (count('defender', hp.id) < (hp.min || 0)) {
      const n = closest(free().filter((m) => hpDist(m, hp) < Infinity), (m) => hpDist(m, hp));
      if (!n) break;
      roles.set(n.id, { role: 'defender', hardPoint: hp.id });
    }
  }
  // 2. X engagers, closest to the player
  while (count('engager') < opts.engagers) {
    const n = closest(free(), (m) => m.distToPlayer);
    if (!n) break;
    roles.set(n.id, { role: 'engager', hardPoint: null });
  }
  // 3. Y ambushers, closest to the ambush point [INFERRED: the talk doesn't say how they're picked]
  while (count('ambusher') < opts.ambushers) {
    const n = closest(free(), (m) => (m.distToAmbush ?? -m.distToPlayer));
    if (!n) break;
    roles.set(n.id, { role: 'ambusher', hardPoint: null });
  }
  // 4. hard points up to their maximum
  for (const hp of hps) {
    while (count('defender', hp.id) < (hp.max ?? hp.min ?? 0)) {
      const n = closest(free().filter((m) => hpDist(m, hp) < Infinity), (m) => hpDist(m, hp));
      if (!n) break;
      roles.set(n.id, { role: 'defender', hardPoint: hp.id });
    }
  }
  // 5. leftovers become engagers, with the dev warning
  const left = free();
  if (left.length) warnings.push(`under-specified encounter: ${left.length} leftover NPC(s) made engagers`);
  for (const n of left) roles.set(n.id, { role: 'engager', hardPoint: null });
  return { roles, warnings };
}

// §4.2 shooter tokens (G 36:10–37:59, G-deck p114/p126). recs: [{id, eligible, canPeek, engaged, dist, tok, tokT,
// peekGrant}] — eligible = in combat with LOS, not reloading / hit-reacting; canPeek = could pop out to get LOS soon.
// opts: {min, max, now, losGrace, engagedPreempts}. Mutates tok / tokT / peekGrant. No allocation.
export function allocateTokens(recs, opts) {
  const better = (a, b) => (a.engaged !== b.engaged ? a.engaged : a.dist < b.dist);
  let holders = 0;
  // release: lost LOS, reloading or hit reaction (a peek grant gets losGrace to reach LOS)
  for (const r of recs) {
    if (!r.tok) continue;
    if (r.eligible) { r.peekGrant = false; holders++; continue; }
    if (r.peekGrant && r.canPeek && opts.now - r.tokT < opts.losGrace) { holders++; continue; }
    if (r.peekGrant) r.peekFailT = opts.now;                 // popped out and still no LOS: don't re-grant at once
    r.tok = false; r.peekGrant = false; r.tokT = -1;
  }
  // grant to the best eligible non-holders: directly engaged first, then closest
  while (holders < opts.max) {
    let best = null;
    for (const r of recs) if (!r.tok && r.eligible && (!best || better(r, best))) best = r;
    if (!best) break;
    best.tok = true; best.tokT = opts.now; best.peekGrant = false; holders++;
  }
  // the NPC the player is engaging takes a token from the worst non-engaged holder
  if (opts.engagedPreempts) {
    for (const r of recs) {
      if (r.tok || !r.eligible || !r.engaged) continue;
      let worst = null;
      for (const h of recs) if (h.tok && !h.engaged && (!worst || better(worst, h))) worst = h;
      if (!worst) break;
      worst.tok = false; worst.tokT = -1; worst.peekGrant = false;
      r.tok = true; r.tokT = opts.now; r.peekGrant = false;
    }
  }
  // below the minimum: grant to the closest NPC that can pop out to get LOS (peek grant)
  while (holders < opts.min) {
    let best = null;
    for (const r of recs) {
      if (r.tok || !r.canPeek || opts.now - (r.peekFailT ?? -1e9) < 2 * opts.losGrace) continue;
      if (!best || better(r, best)) best = r;
    }
    if (!best) break;
    best.tok = true; best.tokT = opts.now; best.peekGrant = !best.eligible; holders++;
  }
  return holders;
}

// §4.3 / §4.4 dwell timers: count while the anchor stays within `reset` m; the caller consumes after dispatching.
export class DwellTimer {
  constructor() { this.x = 0; this.z = 0; this.t = 0; this.on = false; this.resets = 0; }
  start(pos) { this.x = pos.x; this.z = pos.z; this.t = 0; this.on = true; }
  stop() { this.on = false; this.t = 0; }
  update(pos, dt, reset) {
    if (!this.on) return;
    if (Math.hypot(pos.x - this.x, pos.z - this.z) > reset) { this.x = pos.x; this.z = pos.z; this.t = 0; this.resets++; return; }
    this.t += dt;
  }
  ready(wait) { return this.on && this.t >= wait - 1e-6; }
  consume() { this.t = 0; }
}

// §6 grenade director dwell: the player's position is sampled once per sampleRate (G-deck p142).
export class SampledDwell {
  constructor() { this.x = 0; this.z = 0; this.t = 0; this.acc = 0; this.on = false; this.resets = 0; }
  start(pos) { this.x = pos.x; this.z = pos.z; this.t = 0; this.acc = 0; this.on = true; }
  stop() { this.on = false; this.t = 0; this.acc = 0; }
  update(pos, dt, sampleRate, reset) {
    if (!this.on) return;
    this.acc += dt;
    while (this.acc >= sampleRate - 1e-6) {
      this.acc -= sampleRate;
      if (Math.hypot(pos.x - this.x, pos.z - this.z) > reset) { this.x = pos.x; this.z = pos.z; this.t = 0; this.resets++; }
      else this.t += sampleRate;
    }
  }
  ready(wait) { return this.on && this.t >= wait - 1e-6; }
  consume() { this.t = 0; }
}

// §4.3 combat vector: normalize(Σ w_i (npc_i − target)), w_i = 1 + shots in the last `window` s (M p.428).
export function combatVector(npcs, target, now, window, out) {
  let x = 0, z = 0;
  for (const n of npcs) {
    if (n.alive === false) continue;
    let w = 1;
    const shots = n.ai && n.ai.shotTimes;
    if (shots) for (let i = 0; i < shots.length; i++) if (now - shots[i] <= window) w++;
    const dx = n.pos.x - target.x, dz = n.pos.z - target.z;
    const d = Math.hypot(dx, dz) || 1;
    x += w * dx / d; z += w * dz / d;
  }
  const L = Math.hypot(x, z);
  if (L < 1e-6) { out.x = 0; out.z = 1; } else { out.x = x / L; out.z = z / L; }
  return out;
}

// Weight 0..1 of a point inside the oblong from the target along the combat vector (1 on the centre line).
export function oblongWeight(px, pz, target, cv, len, halfWidth) {
  const dx = px - target.x, dz = pz - target.z;
  const along = dx * cv.x + dz * cv.z;
  if (along < 0 || along > len) return 0;
  const lat = Math.abs(dx * cv.z - dz * cv.x);
  return lat >= halfWidth ? 0 : 1 - lat / halfWidth;
}

// ================================================================================================ the director
export class Director {
  constructor(game, { P, posts, tools, loops, Vector3 }) {
    this.game = game; this.P = P;
    this.posts = posts; this.tools = tools; this.loops = loops || [];
    this.V = Vector3;
    this.npcs = [];
    this.lkp = { x: 0, y: 0, z: 0, t: -1e9, valid: false };
    this.combat = false; this.combatT = -1;
    this.everCombat = false;
    this.lastPerceivedT = -1e9;
    this.advance = new DwellTimer();
    this.flank = new DwellTimer();
    this.grenade = new SampledDwell();
    this.grenadeNextT = 0;
    this.flankEval = null;            // staggered flanker choice in progress
    this.flankers = 0;
    this.confirm = { active: false, checker: null, t: 0, reason: '' };
    this.cv = { x: 0, z: 1 };
    this.ambush = { x: 0, y: 0, z: 0, t: -1e9, valid: false };
    this.rolesDirty = true;
    this.replaceAt = -1;
    this.warnings = [];
    this.budget = { rays: 0, fields: 0, vrays: 0 };
    this.vantage = null;              // VantageManager (vantage.js), set by index.js
    this.queryCursor = 0;
    this.exposedSince = -1e9; this.everHidden = false; this.wasExposed = true;
    this.investigation = null;
    this.searchAssigned = false;
    this.log = [];                    // [{t, what, actor}] for the debug panel / scenario logs (bounded)
    this.tokenRecs = [];
    this.tmpTarget = { x: 0, y: 0, z: 0 };
    this.playerMotion = 'stand';
    this.player = null;
    this._v = new Vector3(); this._v2 = new Vector3(); this._v3 = new Vector3();
  }

  note(what, actor) {
    if (this.log.length > 200) this.log.shift();
    this.log.push({ t: +this.game.time.toFixed(3), what, actor: actor ? actor.id : null });
  }

  add(npc) { this.npcs.push(npc); this.tokenRecs.push(npc.ai.tokRec); this.rolesDirty = true; }

  alive() { let n = 0; for (const a of this.npcs) if (a.alive) n++; return n; }

  // ---- shared knowledge -------------------------------------------------------------------------------------------
  setLKP(pos, t) {
    this.lkp.x = pos.x; this.lkp.y = pos.y; this.lkp.z = pos.z; this.lkp.t = t; this.lkp.valid = true;
  }

  // An NPC perceived the player this step (combat / search re-spot). No cheating: only perception moves the LKP.
  perceived(npc, player) {
    this.setLKP(player.pos, this.game.time);
    this.lastPerceivedT = this.game.time;
    if (this.confirm.active && this.game.time > this.confirm.t) this.endConfirm('re-spotted');
  }

  // Any NPC reached orange (or was shot at / heard combat): everyone in the room goes to combat (C, P; M p.423).
  enterCombat(byNpc, pos, why) {
    const g = this.game;
    if (pos) this.setLKP(pos, g.time);
    if (!this.combat) {
      this.combat = true; this.combatT = g.time; this.everCombat = true;
      this.lastPerceivedT = g.time;
      const anchor = this.lkp;
      this.advance.start(anchor); this.flank.start(anchor); this.grenade.start(anchor);
      this.grenadeNextT = g.time;
      this.searchAssigned = false;
      this.investigation = null;
      this.rolesDirty = true;
      emitState(g, DIRECTOR_ACTOR, 'ai.director', 'calm', 'combat');
      this.note(`combat (${why})`, byNpc);
      for (const n of this.npcs) if (n.alive && n.ai.alert !== 'combat') n.ai.brain.setAlert('combat');
    }
  }

  // ---- per step ---------------------------------------------------------------------------------------------------
  preUpdate(dt) {
    const g = this.game, P = this.P;
    this.player = g.player;
    this.budget.rays = P('ai.budget.postRays');
    this.budget.fields = P('ai.budget.fields');
    this.budget.vrays = P('ai.budget.vantageRays');
    this.trackPlayer(dt);
    if (this.vantage) this.vantage.update();                  // reach set follows the LKP (combat and search)
    if (this.combat) {
      combatVector(this.npcs, this.lkp, g.time, P('ai.flank.shotWindow'), this.cv);
      if (this.rolesDirty) this.assign();
      if (this.replaceAt > 0 && g.time >= this.replaceAt) { this.replaceAt = -1; this.assign(); this.note('engager replaced'); }
    }
  }

  postUpdate(dt) {
    const g = this.game, P = this.P;
    if (this.combat) {
      this.tokens();
      this.timers(dt);
      this.lostPlayer();
    }
    this.runQueries();
    if (this.vantage) this.vantage.sweep(this.budget);
    this.grenadeAvoid();
  }

  trackPlayer() {
    const pl = this.player;
    if (!pl) return;
    const exposed = playerExposed(pl);
    if (!exposed) this.everHidden = true;
    if (exposed && !this.wasExposed) this.exposedSince = this.game.time;
    this.wasExposed = exposed;
    const v = pl.vel;
    const sp = v ? Math.hypot(v.x, v.z) : 0;
    this.playerMotion = pl.ctrl && pl.ctrl.mode === 'roll' ? 'roll' : sp > this.P('ai.acc.runSpeed') ? 'run' : 'stand';
  }

  // seconds since the player last came out of cover (Infinity when never hidden: no pop-out penalty)
  tExposed() {
    if (!this.everHidden) return Infinity;
    return this.wasExposed ? this.game.time - this.exposedSince : 0;
  }

  // ---- roles ------------------------------------------------------------------------------------------------------
  assign() {
    const P = this.P;
    this.rolesDirty = false;
    this.updateAmbushPoint(true);
    const hps = this.hardPoints || [];
    const list = [];
    for (const n of this.npcs) {
      if (!n.alive) continue;
      const hpDist = {};
      for (const hp of hps) hpDist[hp.id] = hp.region ? (hp.region.center ? regionDist(hp.region, n.pos) : dist2D(n.pos, hp.region)) : Infinity;
      list.push({ id: n.id, npc: n, distToPlayer: dist2D(n.pos, this.lkp),
        distToAmbush: this.ambush.valid ? dist2D(n.pos, this.ambush) : undefined, hpDist, pin: n.ai.pin || null });
    }
    const res = assignRoles(list, { engagers: P('ai.roles.engagers'), ambushers: P('ai.roles.ambushers'), hardPoints: hps });
    for (const w of res.warnings) if (!this.warnings.includes(w)) { this.warnings.push(w); console.warn('[ai] ' + w); }
    for (const item of list) {
      const r = res.roles.get(item.id);
      const ai = item.npc.ai;
      const hp = r.hardPoint != null ? hps.find((h) => h.id === r.hardPoint) : null;
      ai.hardPoint = hp || null;
      if (ai.role !== r.role) {
        emitState(this.game, item.npc, 'ai.role', ai.role, r.role);
        ai.role = r.role;
        ai.queryDueT = 0;
      }
    }
  }

  // §4.1 ambush point: a nav node ~ambushDist along the nav from the LKP, in the player's heading (else away from us).
  updateAmbushPoint(force) {
    const g = this.game, P = this.P, t = this.tools;
    if (!force && g.time - this.ambush.t < 2) return;
    this.ambush.t = g.time;
    if (!t || !t.ok || !this.lkp.valid) { this.ambush.valid = false; return; }
    if (!this.ambushField) this.ambushField = t.newField();
    const D = P('ai.roles.ambushDist');
    t.field(t.nodeOf(this.lkp), D + 4, this.ambushField);
    let hx = 0, hz = 0;
    const pv = this.player && this.player.vel;
    if (pv && Math.hypot(pv.x, pv.z) > 0.5) { hx = pv.x; hz = pv.z; } else { hx = this.cv.x; hz = this.cv.z; }
    const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
    let best = -1, bs = -Infinity, bestFar = -1, farD = -1;
    const nodes = t.nodes, f = this.ambushField.dist;
    for (let i = 0; i < nodes.length; i += 3) {
      const d = f[i];
      if (!(d < Infinity)) continue;
      if (d > farD) { farD = d; bestFar = i; }
      if (Math.abs(d - D) > 3) continue;
      const n = nodes[i];
      const dx = n.x - this.lkp.x, dz = n.z - this.lkp.z, L = Math.hypot(dx, dz) || 1;
      const s = (dx * hx + dz * hz) / L;
      if (s > bs) { bs = s; best = i; }
    }
    if (best < 0) best = bestFar;          // a room smaller than the ambush distance: the farthest reachable node
    if (best < 0) { this.ambush.valid = false; return; }
    const n = nodes[best];
    this.ambush.x = n.x; this.ambush.y = n.y; this.ambush.z = n.z; this.ambush.valid = true;
  }

  onDeath(npc) {
    if (npc.ai.role === 'engager' && this.combat) {
      this.replaceAt = this.game.time + this.P('ai.roles.replaceDelay');      // G-deck p114
      this.note('engager down: replace in ' + this.P('ai.roles.replaceDelay') + ' s', npc);
    } else this.rolesDirty = true;
    if (this.confirm.checker === npc) { this.confirm.checker = null; this.pickChecker(); }
  }

  // ---- tokens -----------------------------------------------------------------------------------------------------
  tokens() {
    const g = this.game, P = this.P;
    for (const n of this.npcs) n.ai.brain.fillTokenRec(this);
    allocateTokens(this.tokenRecs, { min: P('ai.tokens.min'), max: P('ai.tokens.max'), now: g.time,
      losGrace: P('ai.tokens.losGrace'), engagedPreempts: P('ai.tokens.engagedPreempts') });
    for (const n of this.npcs) {
      const r = n.ai.tokRec;
      if (r.tok !== n.ai.tok) {
        emitState(g, n, 'ai.token', n.ai.tok ? 'shooter' : 'none', r.tok ? 'shooter' : 'none');
        n.ai.tok = r.tok;
      }
    }
  }

  // ---- advance / flank / grenade timers --------------------------------------------------------------------------
  timers(dt) {
    const g = this.game, P = this.P, lkp = this.lkp;
    if (g.time === this.combatT) return;                  // the step combat started counts as t = 0
    this.advance.update(lkp, dt, P('ai.advance.reset'));
    this.flank.update(lkp, dt, P('ai.flank.reset'));
    this.grenade.update(lkp, dt, P('ai.grenade.sampleRate'), P('ai.grenade.moveReset'));

    if (this.advance.ready(P('ai.advance.wait'))) {
      this.advance.consume();
      emitState(g, DIRECTOR_ACTOR, 'ai.timer', 'advance-wait', 'advance');
      this.dispatchAdvance();
    }
    if (this.flank.ready(P('ai.flank.wait')) && !this.flankEval && this.flankers === 0) {
      let pressure = 0;
      for (const n of this.npcs) if (n.alive && n.ai.alert === 'combat') pressure++;
      if (pressure - 1 >= P('ai.flank.minPressure')) {
        this.flank.consume();
        emitState(g, DIRECTOR_ACTOR, 'ai.timer', 'flank-wait', 'flank');
        this.beginFlank();
      }
    }
    if (this.flankEval) this.stepFlank();
    if (P('ai.grenade.on') && this.grenade.ready(P('ai.grenade.timer')) && g.time >= this.grenadeNextT) {
      if (this.liveEnemyGrenades() < P('ai.grenade.maxInFlight') && this.dispatchGrenade()) {
        this.grenade.consume();
        this.grenadeNextT = g.time + P('ai.grenade.cooldown');
      } else this.grenadeNextT = g.time + P('ai.grenade.sampleRate');      // retry at the next sample
    }
  }

  dispatchAdvance() {
    const g = this.game;
    // the engager that has sat at its post the longest, not moving, flanking or checking the LKP
    let best = null;
    for (const n of this.npcs) {
      const a = n.ai;
      if (!n.alive || a.alert !== 'combat' || a.role !== 'engager' || a.flankRoute || a.confirmLKP || a.moving || a.throwPhase) continue;
      if (!best || a.postArriveT < best.ai.postArriveT) best = n;
    }
    if (!best) { this.note('advance: no candidate'); return; }
    best.ai.advanceReq = true;
    best.ai.advanceT = g.time;
    best.ai.queryDueT = 0;
    emitState(g, best, 'ai.director', 'hold', 'advance');
    this.note('advance', best);
    // ask another NPC (a token holder if possible) for suppressing fire (G 35:44)
    let sup = null;
    for (const n of this.npcs) if (n !== best && n.alive && n.ai.alert === 'combat' && (!sup || (n.ai.tok && !sup.ai.tok))) sup = n;
    if (sup) { sup.ai.suppressUntil = g.time + this.P('ai.advance.suppress'); this.note('suppress', sup); }
  }

  // §4.3 flank: choose one flanker by route rating, one candidate NPC per step (staggered A*).
  beginFlank() {
    const list = [];
    for (const n of this.npcs) {
      const a = n.ai;
      if (!n.alive || a.alert !== 'combat' || a.confirmLKP || a.throwPhase || a.role === 'defender') continue;
      if (a.advanceReq || this.game.time - (a.advanceT ?? -1e9) < 3) continue;     // just sent to advance [ASSUMED]
      list.push(n);
    }
    // "prefer an NPC that is doing something boring": non-shooters first, then farther from the action
    list.sort((p, q) => (p.ai.tok - q.ai.tok) || (dist2D(q.pos, this.lkp) - dist2D(p.pos, this.lkp)));
    this.flankEval = { list, i: 0, best: null, bestRating: 0, bestRoute: null, bestPost: null };
    this.note('flank request');
  }

  stepFlank() {
    const e = this.flankEval, P = this.P, g = this.game;
    if (e.i < e.list.length) {
      const n = e.list[e.i++];
      if (n.alive && !n.ai.advanceReq && !n.ai.throwPhase) {
        const r = this.flankRouteFor(n);
        if (r && r.rating >= P('ai.flank.minRating') && (!e.best || (n.ai.tok ? 0 : 1) * 10 + r.rating > (e.best.ai.tok ? 0 : 1) * 10 + e.bestRating)) {
          e.best = n; e.bestRating = r.rating; e.bestRoute = r.route; e.bestPost = r.post;
        }
      }
      return;
    }
    this.flankEval = null;
    if (!e.best) { this.note('flank: no route ≥ min rating'); emitState(g, DIRECTOR_ACTOR, 'ai.timer', 'flank', 'flank-none'); return; }
    const a = e.best.ai;
    a.brain.startFlank(e.bestPost, e.bestRoute, e.bestRating);
    this.flankers++;
    emitState(g, e.best, 'ai.director', 'hold', 'flank');
    this.note(`flank dispatched (rating ${e.bestRating.toFixed(2)})`, e.best);
  }

  // Best flank post + route for one NPC: posts with LOS to the LKP, off the combat vector, routed by an A* whose
  // edges cost more inside the combat-vector oblong. rating = straight-line distance / weighted path cost.
  flankRouteFor(npc) {
    const P = this.P, t = this.tools, lkp = this.lkp, cv = this.cv;
    if (!t || !t.ok) return null;
    const q = npc.ai.flankQuery || (npc.ai.flankQuery = new PostQuery(40));
    q.begin(npc, SELECTORS.flank, this.posts, lkp, lkp, P('ai.posts.radius'), cv, this.npcs, t, P, null);
    const budget = { rays: 400, fields: 1 };
    let guard = 0;
    while (!q.step(budget, this.game.world, P, npc.ai.brain.tmp) && guard++ < 4) { /* one-off burst */ }
    // top 3 scored posts
    const top = [];
    for (let i = 0; i < q.n; i++) {
      const c = q.cands[i];
      if (c.score <= 0) continue;
      top.push(c);
    }
    top.sort((a, b) => b.score - a.score);
    const len = P('ai.flank.len'), hw = P('ai.flank.halfWidth'), mul = P('ai.flank.costMul');
    const costMul = (ax, az, bx, bz) => 1 + mul * oblongWeight((ax + bx) / 2, (az + bz) / 2, lkp, cv, len, hw);
    const keep = (ax, az, bx, bz) => {
      for (let s = 0; s <= 4; s++) {
        const u = s / 4;
        if (oblongWeight(ax + (bx - ax) * u, az + (bz - az) * u, lkp, cv, len, hw) > 0) return false;
      }
      return true;
    };
    let best = null;
    const src = t.nodeOf(npc.pos);
    for (let k = 0; k < Math.min(3, top.length); k++) {
      const post = top[k].post;
      const r = t.costPath(src, post.node, costMul);
      if (!r || r.cost <= 0) continue;
      const straight = Math.hypot(post.x - npc.pos.x, post.z - npc.pos.z);
      const rating = clamp(straight / r.cost, 0, 1);
      const score = rating * top[k].score;
      if (!best || score > best.score) {
        const V = this.V;
        best = { post, rating, score, route: t.waypoints(r.ids, keep, (x, y, z) => new V(x, y, z)) };
      }
    }
    return best;
  }

  flankDone(npc) { this.flankers = Math.max(0, this.flankers - 1); this.note('flank arrived', npc); }

  // ---- grenades ---------------------------------------------------------------------------------------------------
  liveEnemyGrenades() {
    const live = this.game.grenades && this.game.grenades.live;
    let c = 0;
    if (live) for (const gr of live) if (gr.owner && gr.owner.team === 'enemy') c++;
    for (const n of this.npcs) if (n.ai.throwPhase) c++;
    return c;
  }

  // §6: rank Combat NPCs with a clear arc and no ally near the target: −|d − 12| + (non-shooter ? 2 : 0).
  dispatchGrenade() {
    const g = this.game, P = this.P, lkp = this.lkp;
    if (!g.grenades || typeof g.grenades.throwAt !== 'function') return false;
    for (const n of this.npcs) if (n.alive && Math.hypot(n.pos.x - lkp.x, n.pos.z - lkp.z) < P('ai.grenade.friendCheck')) {
      this.note('grenade: friend check failed');
      return false;
    }
    let best = null, bs = -Infinity;
    const why = [];
    for (const n of this.npcs) {
      const a = n.ai;
      if (!n.alive || a.alert !== 'combat' || a.hitUntil > g.time || a.flee || a.moving || a.throwPhase) { why.push(n.id + ':busy'); continue; }
      const d = dist2D(n.pos, lkp);
      if (d < P('ai.grenade.minDist') || d > P('ai.grenade.maxDist')) { why.push(n.id + ':dist ' + d.toFixed(1)); continue; }
      if (!this.clearArc(n, lkp)) { why.push(n.id + ':no arc'); continue; }
      const s = -Math.abs(d - P('ai.grenade.prefer')) + (a.tok ? 0 : 2);
      if (s > bs) { bs = s; best = n; }
    }
    emitState(g, DIRECTOR_ACTOR, 'ai.timer', 'grenade-dwell', best ? 'grenade' : 'grenade-none');
    if (!best) { this.note('grenade: no thrower (' + why.join(', ') + ')'); return false; }
    const r = P('ai.grenade.accuracy') * Math.sqrt(g.rng()), ang = g.rng() * Math.PI * 2;
    best.ai.brain.requestThrow(lkp.x + Math.cos(ang) * r, lkp.y, lkp.z + Math.sin(ang) * r);
    emitState(g, best, 'ai.director', 'hold', 'grenade');
    this.note('grenade thrower', best);
    return true;
  }

  // Sampled high arc from the hand to the target (8 segments); blocked if a static is hit short of the target.
  clearArc(npc, tgt) {
    const P = this.P, w = this.game.world, G = this.game.grenades;
    if (G && typeof G.planThrow === 'function' && !G.stub) {    // the real solver: same arc the throw will fly
      const plan = G.planThrow(npc, tgt, { arc: 'high' });
      return !!(plan && plan.clear);
    }
    const x0 = npc.pos.x, y0 = npc.pos.y + 1.7, z0 = npc.pos.z;
    const x1 = tgt.x, y1 = tgt.y + 0.1, z1 = tgt.z;
    const apex = Math.max(y0, y1) + P('ai.grenade.apex');
    const N = 8;
    const a = this._v, b = this._v2, dir = this._v3;
    let px = x0, py = y0, pz = z0;
    for (let i = 1; i <= N; i++) {
      const u = i / N;
      // quadratic Bezier through the apex control point (a smooth stand-in for the ballistic arc)
      const cx = (x0 + x1) / 2, cy = 2 * apex - (y0 + y1) / 2, cz = (z0 + z1) / 2;
      const qx = (1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * cx + u * u * x1;
      const qy = (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * cy + u * u * y1;
      const qz = (1 - u) * (1 - u) * z0 + 2 * (1 - u) * u * cz + u * u * z1;
      a.set(px, py, pz); dir.set(qx - px, qy - py, qz - pz);
      const L = Math.hypot(dir.x, dir.y, dir.z);
      const hit = w.raycast(a, dir, L, { hitActors: false });
      if (hit && Math.hypot(hit.point.x - x1, hit.point.z - z1) > 1.2) return false;
      px = qx; py = qy; pz = qz;
    }
    return true;
  }

  // React to live grenades: NPCs inside the flee radius of the predicted rest point flee after a reaction delay.
  grenadeAvoid() {
    const g = this.game, P = this.P;
    const live = g.grenades && g.grenades.live;
    if (!live || !live.length) return;
    const R = P('ai.grenade.fleeRadius');
    for (const gr of live) {
      if (gr.alive === false) continue;
      const land = this.predictRest(gr, this.tmpTarget);
      for (const n of this.npcs) {
        if (!n.alive || n.ai.flee === gr || n.ai.fleePending === gr) continue;
        if (Math.hypot(n.pos.x - land.x, n.pos.z - land.z) > R) continue;
        if (gr.owner === n && gr.fuseLeft > 2) continue;           // its own grenade on the way out
        n.ai.brain.warnGrenade(gr, land, randRange(g.rng, P('ai.grenade.reactMin'), P('ai.grenade.reactMax')));
      }
    }
  }

  predictRest(gr, out) {
    const pr = gr.predicted;                              // weapons/grenades.js: the first-contact point
    if (pr && !gr.resting && Number.isFinite(pr.x)) { out.x = pr.x; out.y = pr.y; out.z = pr.z; return out; }
    const v = gr.vel, p = gr.pos;
    if (!v || Math.hypot(v.x, v.y, v.z) < 1) { out.x = p.x; out.y = p.y; out.z = p.z; return out; }
    const gy = this.game.world.groundAt ? (this.game.world.groundAt(p.x, p.z, p.y) ?? 0) : 0;
    const h = Math.max(0, p.y - gy);
    const t = (v.y + Math.sqrt(v.y * v.y + 2 * 9.81 * h)) / 9.81;
    out.x = p.x + v.x * t; out.y = gy; out.z = p.z + v.z * t;
    return out;
  }

  // ---- lost player: snuck-away cheat, LKP timeout, confirm LKP → search (§2) --------------------------------------
  lostPlayer() {
    const g = this.game, P = this.P, pl = this.player;
    if (!pl || this.confirm.active) { if (this.confirm.active) this.stepConfirm(); return; }
    const unseen = g.time - this.lastPerceivedT;
    if (unseen > P('ai.notice.combatReacquire') + 0.05 && dist2D(pl.pos, this.lkp) > P('ai.search.snuckAway')) {
      this.startConfirm('snuck-away');            // M p.423 cheat; U4 default 8 m (G-deck p114)
    } else if (P('ai.search.pursueOnTimeout') && unseen >= P('ai.search.lkpTimeout')) {
      this.startConfirm('timeout');               // allow-pursue-on-timeout (G-deck p114)
    }
  }

  startConfirm(reason) {
    this.confirm.active = true; this.confirm.t = this.game.time; this.confirm.reason = reason; this.confirm.checker = null;
    emitState(this.game, DIRECTOR_ACTOR, 'ai.director', 'combat', 'confirmLKP');
    this.note('confirm LKP (' + reason + ')');
    this.pickChecker();
  }

  pickChecker() {
    let best = null, bd = Infinity;
    for (const n of this.npcs) {
      const a = n.ai;
      if (!n.alive || a.alert !== 'combat' || a.flee) continue;
      const d = dist2D(n.pos, this.lkp) + (a.role === 'engager' ? 0 : 3);
      if (d < bd) { bd = d; best = n; }
    }
    this.confirm.checker = best;
    if (best) { best.ai.brain.startConfirm(this.lkp); emitState(this.game, best, 'ai.director', 'hold', 'checkLKP'); this.note('LKP checker', best); }
  }

  stepConfirm() {
    const c = this.confirm, P = this.P;
    if (!c.checker || !c.checker.alive) { this.pickChecker(); if (!c.checker) return; }
    const ch = c.checker;
    if (dist2D(ch.pos, this.lkp) <= P('ai.search.lkpArrive') || ch.ai.confirmArrived) {
      if (this.lastPerceivedT < c.t) this.enterSearch();
      else this.endConfirm('re-spotted');
    }
  }

  endConfirm(why) {
    const c = this.confirm;
    if (!c.active) return;
    c.active = false;
    if (c.checker) c.checker.ai.brain.endConfirm();
    c.checker = null;
    emitState(this.game, DIRECTOR_ACTOR, 'ai.director', 'confirmLKP', 'combat');
    this.note('confirm cancelled (' + why + ')');
    this.advance.start(this.lkp); this.flank.start(this.lkp); this.grenade.start(this.lkp);
  }

  // LKP confirmed empty: bark "lost him", every NPC searches (stealth regained). Never back to unaware (C).
  enterSearch() {
    const g = this.game;
    const c = this.confirm;
    if (c.checker) c.checker.ai.brain.endConfirm();
    c.active = false; c.checker = null;
    this.combat = false;
    this.advance.stop(); this.flank.stop(); this.grenade.stop();
    this.flankEval = null; this.flankers = 0;
    emitState(g, DIRECTOR_ACTOR, 'ai.director', 'confirmLKP', 'search');
    this.bark(null, 'Lost him.');
    for (const n of this.npcs) {
      if (!n.alive) continue;
      n.ai.tok = false; n.ai.tokRec.tok = false; n.ai.tokRec.peekGrant = false;
      n.ai.brain.setAlert('search');
    }
    this.assignSearch();
  }

  // Body found: all NPCs search (C) — irreversibly ends Unaware.
  bodyFound(byNpc, pos) {
    if (this.combat) return;
    this.setLKP(pos, this.game.time);
    this.bark(byNpc, 'Found a body!');
    for (const n of this.npcs) if (n.alive && n.ai.alert !== 'search') n.ai.brain.setAlert('search');
    this.assignSearch();
  }

  // §2 search loops: spline cap per loop; each NPC joins the loop with the fewest searchers at its nearest point.
  assignSearch() {
    const P = this.P, cap = P('ai.search.splineCap');
    if (!this.loops.length) return;
    const counts = this.loops.map(() => 0);
    for (const n of this.npcs) {
      if (!n.alive) continue;
      // defenders don't walk the loops: they search from their hard point (G 39:51; vantage.js searchStep)
      if (this.vantage && this.P('ai.vantage.on') && n.ai.role === 'defender' && n.ai.hardPoint && n.ai.hardPoint.region) { n.ai.searchLoop = -1; continue; }
      let li = -1;
      for (let i = 0; i < this.loops.length; i++) if (counts[i] < cap && (li < 0 || counts[i] < counts[li])) li = i;
      if (li < 0) li = 0;
      counts[li]++;
      const loop = this.loops[li];
      let bi = 0, bd = Infinity;
      for (let i = 0; i < loop.length; i++) { const d = dist2D(loop[i], n.pos); if (d < bd) { bd = d; bi = i; } }
      n.ai.searchLoop = li; n.ai.searchI = bi; n.ai.searchDir = counts[li] % 2 ? 1 : -1;
    }
    this.searchAssigned = true;
  }

  // §2 investigate pair (C): the spotter recruits the nearest ally; the closer one to the stimulus investigates.
  startInvestigation(spotter, pos) {
    const g = this.game, P = this.P;
    if (this.investigation && g.time - this.investigation.t < 1) return;
    let ally = null, bd = P('ai.investigate.recruitRange');
    for (const n of this.npcs) {
      if (n === spotter || !n.alive || n.ai.alert !== 'unaware') continue;
      const d = dist2D(n.pos, spotter.pos);
      if (d < bd) { bd = d; ally = n; }
    }
    let inv = spotter, watch = ally;
    if (ally && dist2D(ally.pos, pos) < dist2D(spotter.pos, pos)) { inv = ally; watch = spotter; }
    this.investigation = { t: g.time, pos: { x: pos.x, y: pos.y, z: pos.z }, investigator: inv, watcher: watch };
    const s0 = randRange(g.rng, P('ai.investigate.staggerMin'), P('ai.investigate.staggerMax'));
    inv.ai.brain.startInvestigate('investigator', pos, s0);
    if (watch) watch.ai.brain.startInvestigate('watcher', pos, s0 + randRange(g.rng, P('ai.investigate.staggerMin'), P('ai.investigate.staggerMax')));
    this.bark(inv, watch ? 'Check it out, I\'ll cover you.' : 'Huh?');
  }

  investigationOver() {
    const inv = this.investigation;
    this.investigation = null;
    if (!inv) return;
    for (const n of [inv.investigator, inv.watcher]) if (n && n.alive && n.ai.alert === 'suspicious') n.ai.brain.endInvestigate();
  }

  bark(npc, line) {
    this.game.events.emit('bark', { actor: npc, line });
    this.note('bark: ' + line, npc);
  }

  // ---- staggered post queries -------------------------------------------------------------------------------------
  runQueries() {
    const n = this.npcs.length;
    if (!n) return;
    // round-robin from a rotating start, so no NPC starves when the budget runs out
    for (let k = 0; k < n; k++) {
      const npc = this.npcs[(this.queryCursor + k) % n];
      if (!npc.alive) continue;
      const q = npc.ai.query;
      if (q.phase === 'field' || q.phase === 'rays') q.step(this.budget, this.game.world, this.P, npc.ai.brain.tmp);
      if (this.budget.rays <= 0 && this.budget.fields <= 0) break;
    }
    this.queryCursor = (this.queryCursor + 1) % n;
  }

  // ---- debug ------------------------------------------------------------------------------------------------------
  snapshot() {
    const g = this.game;
    return {
      t: +g.time.toFixed(3), combat: this.combat,
      lkp: this.lkp.valid ? [+this.lkp.x.toFixed(2), +this.lkp.y.toFixed(2), +this.lkp.z.toFixed(2), +this.lkp.t.toFixed(2)] : null,
      timers: { advance: +this.advance.t.toFixed(2), flank: +this.flank.t.toFixed(2), grenade: +this.grenade.t.toFixed(2) },
      confirm: this.confirm.active ? (this.confirm.checker ? this.confirm.checker.id : '?') : null,
      npcs: this.npcs.map((n) => ({ id: n.id, alive: n.alive, hp: n.health, alert: n.ai.alert, meter: +n.ai.meter.toFixed(2),
        role: n.ai.role, tok: n.ai.tok, beh: n.ai.behavior, phase: n.ai.coverPhase,
        pos: [+n.pos.x.toFixed(2), +n.pos.z.toFixed(2)] })),
    };
  }
}

export { playerCrouched };
