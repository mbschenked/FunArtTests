// Tactical posts (ai-spec §3): generated once from the level's cover markup and nav, then scored per NPC by a post
// selector. Criteria are each 0..1 and multiplied (as a weighted geometric mean); any filter rejects outright; only
// posts within 25 m of the role's anchor are considered. scorePost() is THE scoring function; everything else here
// gathers the measures it reads, on a budget (rays and path fields are staggered across steps).
// No 'three' import: positions are plain {x, y, z}.
import { curveAt, dist2D } from './tuning.js';

// ------------------------------------------------------------------------------------------------ selectors
// One selector per use (spec §3.2 table). Flags turn filters on; `terms` lists the scored criteria, each with a weight
// param `ai.sel.<name>.<term>` (missing param = weight 0 = term off).
export const SELECTORS = {
  engage:      { rangeCurve: 'ai.posts.curve.engage',      mustShoot: true,  notBehind: true,  pathClear: true,  terms: ['range', 'path', 'cover', 'space'] },
  advance:     { rangeCurve: 'ai.posts.curve.advance',     mustShoot: true,  notBehind: true,  pathClear: true,  mustGain: true, terms: ['range', 'path', 'cover', 'space'] },
  ambush:      { rangeCurve: null,                         mustShoot: false, notBehind: false, pathClear: true,  terms: ['high', 'path', 'hidden', 'cover'] },
  defend:      { rangeCurve: null,                         mustShoot: false, notBehind: false, pathClear: false, terms: ['high', 'cover'] },
  flank:       { rangeCurve: 'ai.posts.curve.flank',       mustShoot: true,  notBehind: false, pathClear: false, offAxis: true, gather: 'flank', terms: ['range', 'cover'] },
  panic:       { rangeCurve: 'ai.posts.curve.panic',       mustShoot: false, notBehind: true,  pathClear: true,  terms: ['range', 'path', 'cover'] },
  investigate: { rangeCurve: 'ai.posts.curve.investigate', mustShoot: true,  notBehind: false, pathClear: false, terms: ['range', 'path'] },
};
const TERMS = ['range', 'path', 'cover', 'space', 'hidden', 'high'];
for (const [name, s] of Object.entries(SELECTORS)) {
  s.name = name;
  s.keys = {};
  s.w = {};
  for (const t of TERMS) { s.keys[t] = s.terms.includes(t) ? `ai.sel.${name}.${t}` : null; s.w[t] = 0; }
}

// Read the selector's weights from params (once per scoring pass, not per post).
export function refreshSelector(sel, P) {
  for (const t of TERMS) {
    const k = sel.keys[t];
    let v = 0;
    if (k) { try { v = P(k); } catch { v = 0; } }
    sel.w[t] = v;
  }
  return sel;
}

// ------------------------------------------------------------------------------------------------ THE score
// ctx holds the measures for this post (filled by measureCheap / measureRays below):
//   npc, sel, anchorDist, anchorLimit, pathLen, facesThreat, canShoot, behindTarget, pathNearTarget, gain, offAxis,
//   targetDist, allyDist, seenByTarget, elevation
export function scorePost(post, ctx, P) {
  const s = ctx.sel;
  // FILTERS (spec §3.2): any one rejects the post outright.
  if (post.claimedBy && post.claimedBy !== ctx.npc) return 0;                  // available: posts are exclusive
  if (ctx.anchorDist > ctx.anchorLimit) return 0;                               // 25 m from the role's anchor [DEV G 14:43]
  if (!(ctx.pathLen < Infinity)) return 0;                                      // reachable on the nav
  if (post.type === 'cover' && !ctx.facesThreat) return 0;                      // the wall must be between post and target
  if (s.mustShoot && !ctx.canShoot) return 0;                                   // ≥1 of 4 rays reach the target [DEV M p.424]
  if (s.notBehind && ctx.behindTarget) return 0;                                // not behind the player
  if (s.pathClear && ctx.pathNearTarget < P('ai.posts.pathNearPlayer')) return 0; // path doesn't run at the player [DEV M p.425]
  if (s.mustGain && ctx.gain < P('ai.advance.minGain')) return 0;               // advance: must end closer to the player
  if (s.offAxis && ctx.offAxis < P('ai.flank.offAxis')) return 0;               // flank: off the combat vector
  // SCORES: each term in [0,1]; the weights are exponents of a weighted geometric mean (spec §3.2 open point).
  const range  = s.rangeCurve ? curveAt(P, s.rangeCurve, ctx.targetDist) : 1;   // preferred distance to the target
  const path   = curveAt(P, 'ai.posts.curve.path', ctx.pathLen);                // 0 m 1.0, 5 m 0.9, 20 m 0.1 [DEV G slide]
  const cover  = post.type === 'cover' ? 1 : P('ai.posts.openScore');           // cover 1.0, open 0.4 [INFERRED]
  const space  = ctx.allyDist < P('ai.posts.allySpacing') ? 0 : 1;              // repelled within 2 m of allies [DEV R]
  const hidden = ctx.seenByTarget ? P('ai.posts.visibleScore') : 1;             // ambush: hidden 1.0, visible 0.2 [INFERRED]
  const high   = curveAt(P, 'ai.posts.curve.elevation', ctx.elevation);         // high ground: −10 m 0.1, 0 0.2, +5 1.0 [DEV]
  const w = s.w, W = w.range + w.path + w.cover + w.space + w.hidden + w.high;
  if (W <= 0) return 1;
  return (range ** w.range * path ** w.path * cover ** w.cover * space ** w.space * hidden ** w.hidden * high ** w.high) ** (1 / W);
}

// ------------------------------------------------------------------------------------------------ generation
// posts: [{id, type: 'cover'|'open', x, y, z, nx, nz (wall normal, toward where the NPC stands; 0 for open),
//          tx, tz (along the wall), height: 'low'|'high'|null, top, coverId, lean: -1|0|1, canFire,
//          fire: {x, y, z} (pop-up / lean / standing eye point), node (nav id), claimedBy}]
export function generatePosts(level, nav, P) {
  const posts = [];
  const nodeAt = (x, y, z) => (nav && nav.nearest ? nav.nearest({ x, y, z }) : null);
  const spacing = P('ai.posts.coverSpacing'), setback = P('ai.posts.setback');
  const edgeLean = P('ai.posts.edgeLean'), leanOut = P('ai.posts.leanOut'), pop = P('ai.posts.popHeight');

  for (const c of (level && level.cover) || []) {
    const ax = c.a.x, az = c.a.z, bx = c.b.x, bz = c.b.z;
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-3) continue;
    const tx = (bx - ax) / L, tz = (bz - az) / L;
    const nl = Math.hypot(c.normal.x, c.normal.z) || 1;
    const nx = c.normal.x / nl, nz = c.normal.z / nl;
    const floorY = c.a.y || 0;
    const margin = Math.min(0.35, L / 2);
    const count = Math.max(1, Math.floor((L - 2 * margin) / spacing) + 1);
    const step = count > 1 ? (L - 2 * margin) / (count - 1) : 0;
    for (let i = 0; i < count; i++) {
      const s = count > 1 ? margin + i * step : L / 2;
      const x = ax + tx * s + nx * setback, z = az + tz * s + nz * setback;
      const n = nodeAt(x, floorY + 0.1, z);
      if (nav && (!n || Math.hypot(n.x - x, n.z - z) > 0.45 || Math.abs(n.y - floorY) > 0.4)) continue;
      const y = n ? n.y : floorY;
      const ends = c.ends || {};
      const leanA = (ends.a === 'corner' || ends.a === 'open') && s <= edgeLean;
      const leanB = (ends.b === 'corner' || ends.b === 'open') && L - s <= edgeLean;
      const high = c.height === 'high';
      let lean = 0, fire = null;
      if (high) {
        if (leanA && (!leanB || s <= L - s)) lean = -1; else if (leanB) lean = 1;
        if (lean) {
          const ex = lean < 0 ? ax : bx, ez = lean < 0 ? az : bz;
          fire = { x: ex + tx * lean * leanOut + nx * setback, y: y + 1.55, z: ez + tz * lean * leanOut + nz * setback };
        }
      } else {
        fire = { x, y: y + Math.max(pop, (c.top ?? floorY + 1) - y + 0.45), z };
      }
      posts.push({
        id: posts.length, type: 'cover', x, y, z, nx, nz, tx, tz, height: high ? 'high' : 'low',
        top: c.top ?? floorY + (high ? 2 : 1), coverId: c.id, lean, canFire: !!fire, fire,
        node: n ? n.id : -1, claimedBy: null,
      });
    }
  }

  // Open posts: nav nodes on a coarse lattice, away from cover posts.
  if (nav && nav.nodes && nav.nodes.length) {
    const cell = nav.cell || 0.5;
    const k = Math.max(1, Math.round(P('ai.posts.openGrid') / cell));
    const nCover = posts.length;
    for (const n of nav.nodes) {
      if (n.ix === undefined || n.ix % k !== 0 || n.iz % k !== 0) continue;
      let near = false;
      for (let i = 0; i < nCover; i++) {
        const p = posts[i];
        if (Math.abs(p.y - n.y) < 0.6 && Math.hypot(p.x - n.x, p.z - n.z) < 1.2) { near = true; break; }
      }
      if (near) continue;
      posts.push({
        id: posts.length, type: 'open', x: n.x, y: n.y, z: n.z, nx: 0, nz: 0, tx: 0, tz: 0, height: null, top: n.y,
        coverId: null, lean: 0, canFire: true, fire: { x: n.x, y: n.y + 1.55, z: n.z }, node: n.id, claimedBy: null,
      });
    }
  }
  return posts;
}

// ------------------------------------------------------------------------------------------------ measures
const DEG = 180 / Math.PI;
const STATIC_ONLY = Object.freeze({ hitActors: false });

// q = the query (see PostQuery). Fills ctx with every measure that needs no raycast.
export function measureCheap(post, q, ctx, P) {
  const t = q.target, npc = q.npc;
  ctx.anchorDist = dist2D(post, q.anchor);
  ctx.anchorLimit = q.anchorLimit;
  ctx.pathLen = q.field ? q.field.dist[post.node] ?? Infinity : dist2D(post, npc.pos) * 1.2;
  if (post.node < 0 && q.field) ctx.pathLen = Infinity;
  const dx = t.x - post.x, dz = t.z - post.z;
  const d = Math.hypot(dx, dz) || 1e-6;
  ctx.targetDist = d;
  ctx.facesThreat = post.type !== 'cover' || (post.nx * dx + post.nz * dz) / d < P('ai.posts.facing');
  const cvx = q.cv.x, cvz = q.cv.z;
  const along = (post.x - t.x) * cvx + (post.z - t.z) * cvz;
  ctx.behindTarget = along < -P('ai.posts.behindMargin');
  ctx.offAxis = Math.acos(Math.max(-1, Math.min(1, along / d))) * DEG;
  ctx.gain = q.selfDist - d;
  ctx.pathNearTarget = (q.field && q.selfDist > P('ai.posts.pathNearPlayer') && post.node >= 0)
    ? q.tools.pathClosest(q.field, post.node, t) : Infinity;
  let ally = Infinity;
  for (const o of q.allies) {
    if (o === npc || o.alive === false) continue;
    const op = o.ai && o.ai.post ? o.ai.post : o.pos;
    const da = Math.hypot(op.x - post.x, op.z - post.z);
    if (da < ally) ally = da;
  }
  ctx.allyDist = ally;
  ctx.elevation = post.y - t.y;
  ctx.canShoot = true;          // optimistic until measureRays runs
  ctx.seenByTarget = false;
}

// The raycast measures: can-shoot (≥1 of up to 4 rays from the fire point reach the target) and seen-by-target.
// Returns the number of rays used.
export function measureRays(post, q, ctx, P, world, tmp) {
  let used = 0;
  const t = q.target;
  if (q.sel.mustShoot || q.sel.terms.includes('high')) {
    ctx.canShoot = false;
    if (post.fire) {
      const nr = Math.max(1, Math.min(4, P('ai.posts.raysPerPost')));
      const f = post.fire;
      const dx = t.x - f.x, dz = t.z - f.z, h = Math.hypot(dx, dz) || 1;
      const sx = -dz / h, sz = dx / h;
      for (let i = 0; i < nr && !ctx.canShoot; i++) {
        // chest, head, left shoulder, right shoulder
        const off = i === 2 ? -0.3 : i === 3 ? 0.3 : 0;
        tmp.target.set(t.x + sx * off, t.y + (i === 0 ? 1.3 : i === 1 ? 1.7 : 1.45), t.z + sz * off);
        tmp.eye.set(f.x, f.y, f.z);
        used++;
        if (world.lineOfSight(tmp.eye, tmp.target, STATIC_ONLY)) ctx.canShoot = true;
      }
    }
  }
  if (q.sel.terms.includes('hidden')) {
    tmp.eye.set(t.x, t.y + 1.6, t.z);
    tmp.target.set(post.x, post.y + 0.9, post.z);
    used++;
    ctx.seenByTarget = world.lineOfSight(tmp.eye, tmp.target, STATIC_ONLY);
  }
  return used;
}

// ------------------------------------------------------------------------------------------------ staggered query
// One per NPC. begin() gathers the nearest candidates; step() spends budget (one path field, then rays) and finishes
// with every candidate scored. Results: q.best (post or null), q.bestScore, q.cands[i].score (-1 = rejected).
export class PostQuery {
  constructor(maxCand = 40) {
    this.cands = [];
    for (let i = 0; i < maxCand; i++) this.cands.push({ post: null, score: 0, cheap: 0, rayDone: false, canShoot: true, seen: false });
    this.n = 0;
    this.phase = 'idle';
    this.ctx = {};
    this.target = { x: 0, y: 0, z: 0 };
    this.anchor = { x: 0, y: 0, z: 0 };
    this.cv = { x: 0, z: 1 };
    this.field = null;
    this.best = null; this.bestScore = 0; this.doneT = -1;
    this.cursor = 0;
  }

  // sel: SELECTORS entry; posts: all posts; target/anchor: {x,y,z}; cv: unit combat vector {x, z}
  begin(npc, sel, posts, target, anchor, anchorLimit, cv, allies, tools, P, forceInclude) {
    this.npc = npc; this.sel = refreshSelector(sel, P); this.allies = allies; this.tools = tools;
    this.target.x = target.x; this.target.y = target.y; this.target.z = target.z;
    this.anchor.x = anchor.x; this.anchor.y = anchor.y; this.anchor.z = anchor.z;
    this.anchorLimit = anchorLimit;
    this.cv.x = cv.x; this.cv.z = cv.z;
    this.selfDist = Math.hypot(npc.pos.x - target.x, npc.pos.z - target.z);
    // the K posts nearest the NPC (M p.424) among those within anchorLimit of the anchor (G 14:43); sorted insertion
    const K = Math.min(this.cands.length - 1, P('ai.posts.candidates'));
    let n = 0;
    const flankBand = sel.gather === 'flank';
    const ideal = flankBand ? P('ai.flank.ideal') : 0, minOff = Math.cos(P('ai.flank.offAxis') * Math.PI / 180);
    for (const p of posts) {
      const da = dist2D(p, anchor);
      if (da > anchorLimit) continue;
      let d;
      if (flankBand) {                       // flank: posts off the combat vector, nearest the ideal flank distance
        if (((p.x - target.x) * cv.x + (p.z - target.z) * cv.z) / (da || 1) > minOff) continue;
        d = Math.abs(da - ideal);
      } else d = Math.hypot(p.x - npc.pos.x, p.z - npc.pos.z) + Math.abs(p.y - npc.pos.y);
      if (n < K) n++;
      else if (d >= this.cands[n - 1].cheap) continue;
      let i = n - 1;
      while (i > 0 && this.cands[i - 1].cheap > d) { this.cands[i].post = this.cands[i - 1].post; this.cands[i].cheap = this.cands[i - 1].cheap; i--; }
      this.cands[i].post = p; this.cands[i].cheap = d;
    }
    if (forceInclude) {
      let has = false;
      for (let i = 0; i < n; i++) if (this.cands[i].post === forceInclude) has = true;
      if (!has) { this.cands[n].post = forceInclude; n++; }
    }
    this.n = n;
    for (let i = 0; i < n; i++) { const c = this.cands[i]; c.rayDone = false; c.score = 0; }
    this.phase = 'field';
    this.cursor = 0;
    this.best = null; this.bestScore = 0;
  }

  // budget: {rays, fields} for this step (shared across NPCs). Returns true when finished.
  step(budget, world, P, tmp) {
    if (this.phase === 'idle' || this.phase === 'done') return this.phase === 'done';
    if (this.phase === 'field') {
      if (this.tools && this.tools.ok) {
        if (budget.fields <= 0) return false;
        budget.fields--;
        if (!this.npc.ai.field) this.npc.ai.field = this.tools.newField();
        this.field = this.npc.ai.field;
        this.tools.field(this.tools.nodeOf(this.npc.pos), P('ai.posts.radius') * 2 + 10, this.field);
      } else this.field = null;
      // cheap pass: reject without rays where possible
      for (let i = 0; i < this.n; i++) {
        const c = this.cands[i];
        measureCheap(c.post, this, this.ctx, P);
        this.ctx.npc = this.npc; this.ctx.sel = this.sel;
        c.score = scorePost(c.post, this.ctx, P);
        c.rayDone = c.score <= 0;
        if (c.score <= 0) c.score = -1;
      }
      this.phase = 'rays';
      this.cursor = 0;
    }
    if (this.phase === 'rays') {
      while (this.cursor < this.n) {
        const c = this.cands[this.cursor];
        if (!c.rayDone) {
          if (budget.rays <= 0) return false;
          measureCheap(c.post, this, this.ctx, P);
          budget.rays -= measureRays(c.post, this, this.ctx, P, world, tmp);
          this.ctx.npc = this.npc; this.ctx.sel = this.sel;
          c.canShoot = this.ctx.canShoot; c.seen = this.ctx.seenByTarget;
          const s = scorePost(c.post, this.ctx, P);
          c.score = s > 0 ? s : -1;
          c.rayDone = true;
        }
        this.cursor++;
      }
      let best = null, bs = 0;
      for (let i = 0; i < this.n; i++) {
        const c = this.cands[i];
        if (c.score > bs && (!c.post.claimedBy || c.post.claimedBy === this.npc)) { bs = c.score; best = c.post; }
      }
      this.best = best; this.bestScore = bs;
      this.phase = 'done';
      return true;
    }
    return false;
  }

  scoreOf(post) {
    for (let i = 0; i < this.n; i++) if (this.cands[i].post === post) return Math.max(0, this.cands[i].score);
    return 0;
  }
}
