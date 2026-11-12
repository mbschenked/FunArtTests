// Vantage (refs/ai-vantage.md; G 17:55–19:24, G-deck p65–68): "What positions could the player reach with ~3 seconds
// of movement?" and "How many points around the player can each position see?" The talk tried connectivity + vantage
// as an automatic replacement for designer zones and dropped it (G-deck p69–72: inconsistent results, reverse-
// engineered the high-level decisions, limited designers); what survived is vantage as one more post measure and the
// defender's "Defend Search" (G 39:51, G-deck p136 debug panel "Vantage Manager"): a defender that can't see the player
// looks inside its own hard point for a post that can. This module is that manager:
//   reach set   a bounded Dijkstra field from the LKP node out to reachTime × speed metres of path, sampled into
//               sectors × rings buckets (+ the LKP itself): the points the player could be at ~3 s from now
//   vantage     per post: the share of reach points visible from its fire point (one static ray each), cached
//               against the reach set's generation and measured on demand by post queries (posts.js) or by a budgeted
//               background sweep (current posts first, then the hard-point regions)
//   selectorFor the brain's hook at each re-score: 'perch' when the player is below a perch edge and out of the line
//               of fire, 'defendSearch' when a defender has had no vantage and no line of fire for lostT
//   searchStep  the lost-player search for a defender: it stays in its hard point, moves to the best-vantage post
//               there and looks outward over the visible reach points (spec §2: defenders don't walk the loops)
// No 'three' import: vectors come from game.world.Vector3.
import { dist2D, emitState, yawTo } from './tuning.js';
import { SELECTORS } from './posts.js';
import { regionContains } from './layout.js';

const STATIC_ONLY = Object.freeze({ hitActors: false });
export const MAX_REACH_POINTS = 1 + 16 * 4;          // the LKP + sectors (≤ 16) × rings (≤ 4)

// Pure (node-tested): picks the reach sample nodes. nodes: [{x, z}], dist: path distance per node (Infinity =
// unreached), src: the LKP {x, z}, R: reach radius (m). Buckets: sector = the node's bearing from src in S equal
// slices; ring k targets path distance R·(k+1)/K. Each node goes to the ring whose target is nearest; each bucket keeps
// the node nearest its ring target (ties: lowest node index). Returns node indices, ring-major then sector order.
export function sampleReach(nodes, dist, src, R, S, K) {
  const best = new Int32Array(S * K).fill(-1), err = new Float64Array(S * K).fill(Infinity);
  for (let i = 0; i < nodes.length; i++) {
    const d = dist[i];
    if (!(d > 0) || d > R) continue;
    const n = nodes[i];
    const a = Math.atan2(n.z - src.z, n.x - src.x);
    const s = Math.min(S - 1, Math.floor((a + Math.PI) / (2 * Math.PI) * S));
    let k = Math.round(d / (R / K)) - 1;
    k = k < 0 ? 0 : k >= K ? K - 1 : k;
    const e = Math.abs(d - R * (k + 1) / K), b = k * S + s;
    if (e < err[b]) { err[b] = e; best[b] = i; }
  }
  const out = [];
  for (let b = 0; b < S * K; b++) if (best[b] >= 0) out.push(best[b]);
  return out;
}

export class VantageManager {
  constructor(game, { P, posts, tools, director }) {
    this.game = game; this.P = P; this.posts = posts; this.tools = tools; this.dir = director;
    this.world = game.world;
    const V = game.world.Vector3;
    this.a = new V(); this.b = new V();
    this.field = tools && tools.ok ? tools.newField() : null;
    this.pts = [];                                     // [{x, y, z, node}] reach points at ai.vantage.pointH
    this.src = { x: 0, y: 0, z: 0 };
    this.R = 0;
    this.gen = 0;                                      // reach-set generation; post.vGen === gen = cached vantage valid
    this.sweepList = []; this.sweepI = 0;
    this.perches = posts.filter((p) => p.type === 'perch');
    this.stats = { rebuilds: 0, rays: 0, computed: 0 };
  }

  // ---- reach set ---------------------------------------------------------------------------------------------------
  // Director pre-step: rebuild the reach set when the LKP has moved ai.vantage.resample metres.
  update() {
    const P = this.P, L = this.dir.lkp;
    if (!this.dir.combat) for (const n of this.dir.npcs) if (n.ai.perchMode) this.setPerch(n.ai.brain, false, 'combat over');
    if (!P('ai.vantage.on') || !L.valid || !this.field) return;
    if (this.gen > 0 && Math.hypot(L.x - this.src.x, L.y - this.src.y, L.z - this.src.z) < P('ai.vantage.resample')) return;
    this.rebuild(L);
  }

  rebuild(L) {
    const P = this.P, nav = this.dir.nav, nodes = nav.nodes;
    const R = P('ai.vantage.reachTime') * P('ai.vantage.speed');      // 3 s × 4.8 m/s = 14.4 m of path
    const S = Math.max(1, Math.min(16, P('ai.vantage.sectors'))), K = Math.max(1, Math.min(4, P('ai.vantage.rings')));
    const src = this.tools.nodeOf(L);
    this.tools.field(src, R, this.field);
    const h = P('ai.vantage.pointH');
    this.pts.length = 0;
    this.pts.push({ x: L.x, y: L.y + h, z: L.z, node: src });
    for (const id of sampleReach(nodes, this.field.dist, L, R, S, K)) {
      const n = nodes[id];
      this.pts.push({ x: n.x, y: n.y + h, z: n.z, node: id });
    }
    this.src.x = L.x; this.src.y = L.y; this.src.z = L.z;
    this.R = R;
    this.gen++;
    this.stats.rebuilds++;
    // background sweep order: posts inside enabled hard-point regions (by id)
    this.sweepList.length = 0; this.sweepI = 0;
    const hps = (this.dir.hardPoints || []).filter((h) => h.enabled && h.region);
    if (hps.length) for (const p of this.posts) if (hps.some((h) => regionContains(h.region, p))) this.sweepList.push(p);
  }

  ready(post) { return this.gen > 0 && post.vGen === this.gen; }

  // Measures one post against the reach set: post.vantage (0..1), post.vBits[i] (1 = reach point i visible),
  // post.vGen. Returns the rays used.
  compute(post) {
    if (!this.gen) return 0;
    const pts = this.pts, n = pts.length;
    if (!post.vBits) post.vBits = new Uint8Array(MAX_REACH_POINTS);
    let seen = 0, used = 0;
    const f = post.fire;
    if (f) {
      this.a.set(f.x, f.y, f.z);
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        this.b.set(p.x, p.y, p.z);
        used++;
        const v = this.world.lineOfSight(this.a, this.b, STATIC_ONLY) ? 1 : 0;
        post.vBits[i] = v; seen += v;
      }
    } else post.vBits.fill(0);                         // a high wall with no lean: sees nothing from behind it
    post.vantage = n ? seen / n : 0;
    post.vGen = this.gen;
    this.stats.rays += used; this.stats.computed++;
    return used;
  }

  // Director post-step, after the post queries: spend what is left of the vantage ray budget. Every live NPC's
  // current post first (selectorFor reads it), then the hard-point regions round-robin (debug colours, warm cache).
  sweep(budget) {
    if (!this.gen || !this.P('ai.vantage.on')) return;
    for (const n of this.dir.npcs) {
      const p = n.alive && n.ai.post;
      if (p && !this.ready(p)) { if (budget.vrays <= 0) return; budget.vrays -= this.compute(p); }
    }
    if (!this.P('ai.vantage.sweep')) return;
    const list = this.sweepList;
    for (let k = 0; k < list.length && budget.vrays > 0; k++) {
      const p = list[this.sweepI];
      this.sweepI = (this.sweepI + 1) % list.length;
      if (!this.ready(p)) budget.vrays -= this.compute(p);
    }
  }

  // ---- brain hooks -------------------------------------------------------------------------------------------------
  // Is the LKP below a perch edge on this NPC's floor? (≥ ai.perch.below m under it, within ai.perch.near m of the
  // perch's lean-out point.) This is the talk's case: the player climbing below an enemy on a balcony (G-deck p146).
  underPerch(npc, L) {
    const P = this.P, below = P('ai.perch.below'), near = P('ai.perch.near');
    if (npc.pos.y - L.y < below) return false;
    for (const p of this.perches) {
      if (Math.abs(p.y - npc.pos.y) > 1.0 || p.y - L.y < below) continue;
      if (dist2D(p.perchFire || p, L) <= near) return true;
    }
    return false;
  }

  setDefend(brain, to, why) {
    const ai = brain.ai, from = ai.defendState || 'hold';
    if (from === to) return;
    ai.defendState = to;
    emitState(this.game, brain.npc, 'ai.defend', from, to);
    this.dir.note(`defend ${to}${why ? ' (' + why + ')' : ''}`, brain.npc);
  }

  setPerch(brain, on, why) {
    const ai = brain.ai;
    if (!!ai.perchMode === on) return;
    ai.perchMode = on;
    emitState(this.game, brain.npc, 'ai.perch', on ? 'off' : 'perch', on ? 'perch' : 'off');
    this.dir.note(`perch ${on ? 'on' : 'off'}${why ? ' (' + why + ')' : ''}`, brain.npc);
  }

  // Called by brain.selectPost when it begins a query; base is the role's selector. Returns the selector to use.
  selectorFor(brain, base) {
    const ai = brain.ai, npc = brain.npc, P = this.P, now = brain.now, L = this.dir.lkp, q = ai.query;
    ai.lookAt = null;
    const prev = ai.selName;
    const failed = !!q && q.phase === 'done' && !q.best;          // the previous query (this one starts now) found nothing
    const quiet = now - Math.max(ai.fireLosT, ai.postArriveT);    // seconds without a line of fire, counted from arrival
    if (base !== 'engage' && base !== 'defend') { this.setPerch(brain, false, base); return base; }
    // perch (G 44:19, G-deck p146–147)
    if (P('ai.perch.on') && this.perches.length && L.valid) {
      if (prev === 'perch' && failed) { this.setPerch(brain, false, 'no perch can shoot'); ai.perchRetryT = now + P('ai.perch.retry'); }
      const under = this.underPerch(npc, L);
      if (ai.perchMode && !under) this.setPerch(brain, false, 'player not below');
      else if (!ai.perchMode && under && now >= (ai.perchRetryT || 0) && quiet > P('ai.perch.noLof')) this.setPerch(brain, true, 'player below the edge');
      if (ai.perchMode) return 'perch';
    } else if (ai.perchMode) this.setPerch(brain, false, 'off');
    // defend search (G 39:51, G-deck p136)
    if (base === 'defend' && P('ai.vantage.on') && ai.hardPoint && ai.hardPoint.region) {
      const post = ai.post;
      if ((ai.defendState || 'hold') === 'search') {
        if (prev === 'defendSearch' && failed) { this.setDefend(brain, 'hold', 'no post with vantage'); ai.defendRetryT = now + P('ai.vantage.lostT'); return 'defend'; }
        if (ai.fireLos) { this.setDefend(brain, 'hold', 'line of fire'); return 'defend'; }
        if (prev === 'defendSearch' && ai.atPost && !ai.moving && post && this.ready(post) && post.vantage >= P('ai.vantage.min')) {
          this.setDefend(brain, 'hold', `vantage ${post.vantage.toFixed(2)} at post ${post.id}`); return 'defend';
        }
        return 'defendSearch';
      }
      if (ai.atPost && !ai.moving && post && this.ready(post) && post.vantage < P('ai.vantage.min')
        && quiet > P('ai.vantage.lostT') && now >= (ai.defendRetryT || 0)) {
        this.setDefend(brain, 'search', `vantage ${post.vantage.toFixed(2)} at post ${post.id}`);
        return 'defendSearch';
      }
    }
    return base;
  }

  // brain.search() hook: a defender searches from its hard point. Returns true when it handled the step.
  searchStep(brain) {
    const ai = brain.ai, P = this.P, D = this.dir, npc = brain.npc, now = brain.now, hp = ai.hardPoint;
    if (!P('ai.vantage.on') || ai.role !== 'defender' || !hp || !hp.region || !hp.enabled) return false;
    if ((ai.defendState || 'hold') !== 'search') this.setDefend(brain, 'search', 'lost the player');
    brain.setBehavior(ai.moving ? 'search' : 'look');
    const q = ai.query;
    if (!ai.moving) {
      if (q.phase === 'done' && !q.consumed && ai.selName === 'defendSearch') {
        q.consumed = true;
        const cur = ai.post, cs = cur ? q.scoreOf(cur) : 0;
        if (q.best && q.best !== cur && (cs <= 0 || q.bestScore >= P('ai.posts.hysteresis') * cs)
          && brain.goTo(q.best.x, q.best.y, q.best.z, P('ai.move.searchSpeed'), 'post')) {
          brain.claim(q.best);
          D.note(`defend search: to post ${q.best.id} (vantage ${(q.best.vantage ?? 0).toFixed(2)})`, npc);
        }
      } else if (now >= ai.queryDueT && (q.phase === 'idle' || q.phase === 'done')) {
        ai.queryDueT = now + P('ai.posts.rescore');
        ai.selName = 'defendSearch';
        const r = hp.region;
        q.begin(npc, SELECTORS.defendSearch, D.posts, D.lkp, r.center, r.radius, D.cv, D.npcs, D.tools, P, ai.post, r);
        q.consumed = false;
      }
    }
    // look outward (G 19:05): turn toward the visible reach points one after another; none visible → the LKP
    const post = ai.post;
    if (ai.moving) { ai.lookAt = null; return true; }
    if (now >= (ai.lookNextT || 0)) {
      ai.lookNextT = now + P('ai.vantage.lookDwell');
      let pick = -1;
      const n = this.pts.length;
      if (post && ai.atPost && this.ready(post)) {
        for (let k = 1; k <= n; k++) { const i = ((ai.lookI ?? -1) + k) % n; if (post.vBits[i]) { pick = i; break; } }
      }
      ai.lookI = pick;
      const p = pick >= 0 ? this.pts[pick] : D.lkp;
      ai.lookAt = yawTo(p.x - npc.pos.x, p.z - npc.pos.z);
    }
    return true;
  }
}
