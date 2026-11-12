// Climb data: the authored grab edges and every geometric query the climb controller needs.
// Pure (no three, no game), so node can unit-test it (tests/climb.test.mjs). Owner: B3.
// Spec: refs/climb-spec.md "Proposed data format for the room", §1 (hold finding), §2 (entry bands), §3 (moves).
//
// MARKUP (level.climb) - any of these shapes is accepted and normalised:
//   { edges: [Edge], holds?: [Edge | Hold], feet?: [] }      or a bare [Edge] array
//   Edge  = { id, kind: 'ledge'|'hold'|'bar'|'top', pts: [[x,y,z], ...] | a, b (Vector3/array/{x,y,z}),
//             normal?: [x,y,z] (out of the wall, toward the climber; for a polyline it is the FIRST segment's normal),
//             y?: number (overrides the points' y), size?: 'small'|'large', feet?: bool (default: kind !== 'bar'),
//             top?: bool (walkable surface above, climb-up allowed; default kind === 'top') }
//   Hold  = { id, pos|point|center: [x,y,z], normal, width = 0.25 }   -> a short edge centred on pos
//   Edges are horizontal and flat [DEV, Shaver via 80.lv]. pts runs along the grip line (the lip's outer top corner).
//
// CONVENTIONS after normalisation (what the queries rely on):
//   - Every edge is a polyline at one height y, parametrised by arc length s in [0, edge.len].
//   - Polylines are re-ordered so +s is the climber's RIGHT (climber faces -normal). Per-segment normal = (-dz, 0, dx)
//     for segment direction d. If `normal` is given and disagrees, the polyline is reversed; if omitted, the
//     author's order is taken as left-to-right seen from the climber.
//   - corners[i] = 'inner' | 'outer' | null for the vertex between segment i-1 and i ('inner' = the ledge turns toward
//     the climber, a concave corner; 'outer' = it wraps away around a convex corner).
//
// Grip = { edge, s, spread } (spread = hand spacing along the edge). Points are written into caller-owned vectors.
// All queries are allocation-free per call (results go into `out` objects the caller keeps).

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
}

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function xyz(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return [+v[0] || 0, +v[1] || 0, +v[2] || 0];
  if (typeof v === 'object' && 'x' in v) return [+v.x || 0, +v.y || 0, +v.z || 0];
  return null;
}

// Markup -> [{id, kind, size, feet, top, pts: [[x,y,z]...], normal: [x,y,z] | null}]. Bad entries are skipped
// and reported in `warnings`.
export function normalizeMarkup(raw, { holdWidth = 0.25, warnings = [] } = {}) {
  const list = [];
  if (!raw) return list;
  const push = (e, defKind) => {
    if (!e || typeof e !== 'object') return;
    const id = String(e.id ?? `edge${list.length}`);
    let pts = null;
    const normal = xyz(e.normal);
    if (Array.isArray(e.pts) && e.pts.length >= 2) pts = e.pts.map(xyz);
    else if (e.a && e.b) pts = [xyz(e.a), xyz(e.b)];
    else if (e.pos || e.point || e.center) {
      const c = xyz(e.pos || e.point || e.center);
      const n = normal || [0, 0, 1];
      const nl = Math.hypot(n[0], n[2]) || 1;
      const dx = n[2] / nl, dz = -n[0] / nl;                        // right = d where n = (-dz, 0, dx)
      const w = (e.width ?? holdWidth) / 2;
      pts = [[c[0] - dx * w, c[1], c[2] - dz * w], [c[0] + dx * w, c[1], c[2] + dz * w]];
    }
    if (!pts || pts.some((p) => !p)) { warnings.push({ id, rule: 'bad-shape', msg: `climb edge ${id}: no pts/a,b/pos` }); return; }
    if (typeof e.y === 'number') for (const p of pts) p[1] = e.y;
    const kind = e.kind || defKind || 'ledge';
    list.push({
      id, kind, size: e.size || null,
      feet: e.feet ?? (kind !== 'bar'),
      top: e.top ?? (kind === 'top'),
      pts, normal,
    });
  };
  const seen = new Set();                                            // level.climb.holds may re-list edges
  const add = (e, k) => { if (!e || seen.has(e) || (e.id != null && seen.has('id:' + e.id))) return; seen.add(e); if (e.id != null) seen.add('id:' + e.id); push(e, k); };
  if (Array.isArray(raw)) for (const e of raw) add(e, null);
  else {
    for (const e of raw.edges || []) add(e, null);
    for (const e of raw.holds || []) add(e, 'hold');
  }
  return list;
}

export class ClimbData {
  // raw: level.climb markup (see top). Vector3: class used for any vectors this module creates (default Vec3).
  constructor(raw, { Vector3 = Vec3 } = {}) {
    this.V = Vector3;
    this.warnings = [];
    this.edges = [];
    this.byId = new Map();
    for (const def of normalizeMarkup(raw, { warnings: this.warnings })) this._add(def);
    // scratch (allocation-free queries)
    this._p = new Vec3(); this._n = new Vec3(); this._r = new Vec3(); this._q = new Vec3();
    this._cand = { edge: null, s: 0, dist: 0, angle: 0, score: -1e9, cls: 'none', u: 0, v: 0 };
    this._candReach = { edge: null, s: 0, dist: 0, angle: 0, score: -1e9, cls: 'none', u: 0, v: 0 };
    this._candLunge = { edge: null, s: 0, dist: 0, angle: 0, score: -1e9, cls: 'none', u: 0, v: 0 };
  }

  _add(def) {
    let pts = def.pts.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[2] - a[i - 1][2]) > 1e-4);
    if (pts.length < 2) { this.warnings.push({ id: def.id, rule: 'bad-shape', msg: `climb edge ${def.id}: zero length` }); return; }
    const y = pts[0][1];
    for (const p of pts) if (Math.abs(p[1] - y) > 0.01) {
      this.warnings.push({ id: def.id, rule: 'not-flat', msg: `climb edge ${def.id}: not horizontal (edges must be flat) - using y=${y}` });
      break;
    }
    // orientation: +s must be the climber's right, i.e. normal = (-dz, 0, dx) of the first segment
    if (def.normal) {
      const dx = pts[1][0] - pts[0][0], dz = pts[1][2] - pts[0][2];
      if (-dz * def.normal[0] + dx * def.normal[2] < 0) pts = pts.slice().reverse();
    }
    const segs = [];
    let s0 = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = pts[i][0], az = pts[i][2], bx = pts[i + 1][0], bz = pts[i + 1][2];
      const len = Math.hypot(bx - ax, bz - az);
      const dx = (bx - ax) / len, dz = (bz - az) / len;
      segs.push({ ax, az, bx, bz, len, dx, dz, nx: -dz, nz: dx, s0 });
      s0 += len;
    }
    const corners = [null];
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], b = segs[i];
      const turn = a.dx * b.dz - a.dz * b.dx;                       // signed turn (xz cross)
      corners.push(Math.abs(turn) < Math.sin(5 * DEG) ? null : (b.dx * a.nx + b.dz * a.nz > 0 ? 'inner' : 'outer'));
    }
    const edge = {
      id: def.id, index: this.edges.length, kind: def.kind, size: def.size, feet: def.feet, top: def.top,
      y, segs, len: s0, corners,
    };
    this.edges.push(edge);
    this.byId.set(edge.id, edge);
  }

  get(id) { return this.byId.get(id) || null; }

  // ---------------------------------------------------------------- edge geometry
  segIndex(edge, s) {
    const segs = edge.segs;
    for (let i = 0; i < segs.length - 1; i++) if (s < segs[i].s0 + segs[i].len) return i;
    return segs.length - 1;
  }

  pointAt(edge, s, out) {
    s = clamp(s, 0, edge.len);
    const g = edge.segs[this.segIndex(edge, s)];
    const k = s - g.s0;
    return out.set(g.ax + g.dx * k, edge.y, g.az + g.dz * k);
  }

  // Outward normal at s, blended across polyline vertices over +-blend metres (smooth corner wrap).
  normalAt(edge, s, blend, out) {
    s = clamp(s, 0, edge.len);
    const segs = edge.segs;
    const i = this.segIndex(edge, s);
    const g = segs[i];
    let nx = g.nx, nz = g.nz;
    if (blend > 0) {
      if (i > 0 && s - g.s0 < blend) {
        const w = 0.5 + 0.5 * (s - g.s0) / blend, p = segs[i - 1];
        nx = p.nx + (g.nx - p.nx) * w; nz = p.nz + (g.nz - p.nz) * w;
      } else if (i < segs.length - 1 && g.s0 + g.len - s < blend) {
        const w = 0.5 + 0.5 * (g.s0 + g.len - s) / blend, q = segs[i + 1];
        nx = q.nx + (g.nx - q.nx) * w; nz = q.nz + (g.nz - q.nz) * w;
      }
      const l = Math.hypot(nx, nz) || 1;
      nx /= l; nz /= l;
    }
    return out.set(nx, 0, nz);
  }

  // Climber's right at s (unit, horizontal): right = (nz, 0, -nx).
  rightAt(edge, s, blend, out) {
    this.normalAt(edge, s, blend, out);
    return out.set(out.z, 0, -out.x);
  }

  // How far the grip centre may sit from each end so both hands stay on the edge.
  handRoom(edge, spread, margin = 0.05) {
    return Math.max(0, Math.min(spread, edge.len - margin)) / 2;
  }

  spreadOn(edge, spread, margin = 0.05) { return 2 * this.handRoom(edge, spread, margin); }

  // Arc length of the point on the edge closest to (px, py, pz). xzOnly ignores height. Sets this.lastDist.
  closestS(edge, px, py, pz, xzOnly = false) {
    let best = 1e30, bestS = 0;
    for (const g of edge.segs) {
      let t = (px - g.ax) * g.dx + (pz - g.az) * g.dz;
      t = clamp(t, 0, g.len);
      const qx = g.ax + g.dx * t, qz = g.az + g.dz * t;
      const dy = xzOnly ? 0 : py - edge.y;
      const d2 = (px - qx) ** 2 + (pz - qz) ** 2 + dy * dy;
      if (d2 < best) { best = d2; bestS = g.s0 + t; }
    }
    this.lastDist = Math.sqrt(best);
    return bestS;
  }

  // Corner type and its arc length if a polyline vertex lies within `range` of s in direction dir (+1/-1).
  cornerAhead(edge, s, dir, range) {
    for (let i = 1; i < edge.segs.length; i++) {
      const sv = edge.segs[i].s0, d = (sv - s) * dir;
      if (d >= -range && d <= range && edge.corners[i]) return { type: edge.corners[i], s: sv };
    }
    return null;
  }

  // ---------------------------------------------------------------- entry (spec §2)
  // mode: 'jump' (targeted leap from the ground), 'fall' (catch while airborne), 'dropFromTop' (step off a top edge).
  // feet: actor feet position. fx, fz: unit intent/facing direction. speed: horizontal speed (m/s).
  // cfg: resolved numbers (see climb.js readCfg). ignore: an edge to skip (just released). out: {edge, s, dist, h}.
  // Returns out or null. Heights are measured FROM THE FEET (spec §2 note; private reference project roll-air-pop lesson).
  findEntry(mode, feet, fx, fz, speed, cfg, ignore, out) {
    let best = null, bestScore = 1e30;
    const n = this._n;
    for (const e of this.edges) {
      if (e === ignore) continue;
      const h = e.y - feet.y;
      if (mode === 'jump') {
        if (h < cfg.jumpGrabMin || h > cfg.jumpGrabMax) continue;
      } else if (mode === 'fall') {
        const hands = feet.y + cfg.catchHandHeight;
        const above = hands - e.y;                                   // hands from 0 to +band above the edge
        if (above < 0 || above > cfg.catchBand) continue;
      } else if (mode === 'dropFromTop') {
        if (!e.top || Math.abs(h) > 0.2) continue;
      } else continue;
      let s = this.closestS(e, feet.x, feet.y, feet.z, true);
      const room = this.handRoom(e, cfg.handSpread);
      s = clamp(s, room, e.len - room);
      const p = this.pointAt(e, s, this._p);
      this.normalAt(e, s, 0, n);
      const ox = feet.x - p.x, oz = feet.z - p.z;
      const front = ox * n.x + oz * n.z;                             // + = in front of the wall (climber side)
      const lateral = Math.abs(-ox * n.z + oz * n.x);                // along the edge, beyond its (clamped) ends
      const facing = -(fx * n.x + fz * n.z);                         // cos(angle between intent and into-the-wall)
      let score;
      if (mode === 'jump') {
        const reach = speed >= cfg.runSpeed ? cfg.reachRun : cfg.reachStand;
        if (front < -0.05 || front > reach + 0.05 || lateral > 0.35) continue;
        if (facing < Math.cos(cfg.facingCone)) continue;
        score = Math.hypot(front, lateral) + 0.1 * h;
      } else if (mode === 'fall') {
        if (front < -0.1 || front > cfg.catchFront || lateral > 0.3) continue;
        if (facing < 0) continue;                                    // never catch an edge behind you
        score = front + lateral;
      } else {
        if (front > 0.1 || front < -cfg.dropTopBack || lateral > 0.3) continue;
        score = -front + lateral;
      }
      if (score < bestScore) { bestScore = score; best = e; out.edge = e; out.s = s; out.h = h; out.dist = Math.hypot(front, lateral); }
    }
    return best ? out : null;
  }

  // ---------------------------------------------------------------- moves on the wall (spec §1, §3)
  // Classify a wall-plane displacement (u right, v up): 'up' | 'down' | 'side' | 'diag' (+-classHalf bands, spec §1).
  classify(u, v, classHalf) {
    const a = Math.atan2(v, Math.abs(u));                            // -90..90 deg
    if (a >= Math.PI / 2 - classHalf) return 'up';
    if (a <= -Math.PI / 2 + classHalf) return 'down';
    if (Math.abs(a) <= classHalf) return 'side';
    return 'diag';
  }

  reachMax(cls, cfg) { return cls === 'up' ? cfg.reachUp : cls === 'down' ? cfg.reachDown : cls === 'side' ? cfg.reachSide : cfg.reachDiag; }
  lungeMax(cls, cfg) { return cls === 'up' ? cfg.lungeUp : cls === 'down' ? cfg.lungeDown : cls === 'side' ? cfg.lungeSide : cfg.lungeDiag; }

  // Hold search from the stick (spec §1 pseudo-code). ref = the leading hand's grip point; R, N = wall basis there;
  // (du, dv) = unit stick direction in the wall plane. Fills this._candReach / this._candLunge (score -1e9 = none).
  _search(cur, ref, R, N, du, dv, cfg) {
    const cr = this._candReach, cl = this._candLunge, c = this._cand;
    cr.score = -1e9; cr.edge = null; cl.score = -1e9; cl.edge = null;
    const p = this._q, nn = this._r;
    const cone = cfg.coneHalf;
    for (const e of this.edges) {
      if (e === cur) continue;                                       // the current edge is the shimmy's job
      const room = this.handRoom(e, cfg.handSpread);
      for (const g of e.segs) {
        if (g.nx * N.x + g.nz * N.z < 0.3) continue;                 // faces another way (corner side / behind)
        const au = (g.ax - ref.x) * R.x + (g.az - ref.z) * R.z;
        const bu = (g.bx - ref.x) * R.x + (g.bz - ref.z) * R.z;
        const v = e.y - ref.y;
        const du_ = bu - au;
        // up to two trial points on the segment: where the stick ray crosses its height, and the closest point
        for (let k = 0; k < 2; k++) {
          let t;
          if (k === 0) {
            if (Math.abs(dv) < 1e-3 || v / dv <= 0) continue;
            const u = (v / dv) * du;
            t = Math.abs(du_) > 1e-6 ? (u - au) / du_ : 0.5;
          } else t = Math.abs(du_) > 1e-6 ? (0 - au) / du_ : 0.5;
          t = clamp(t, 0, 1);
          const s = clamp(g.s0 + t * g.len, room, e.len - room);
          this.pointAt(e, s, p);
          this.normalAt(e, s, 0, nn);
          if (nn.x * N.x + nn.z * N.z < 0.3) continue;
          const ox = p.x - ref.x, oy = p.y - ref.y, oz = p.z - ref.z;
          const u = ox * R.x + oz * R.z, w = oy, depth = ox * N.x + oz * N.z;
          const inPlane = Math.hypot(u, w);
          if (inPlane < 0.05) continue;
          const angle = Math.acos(clamp((u * du + w * dv) / inPlane, -1, 1));
          if (angle > cone) continue;
          const dist = Math.sqrt(u * u + w * w + depth * depth);
          const cls = this.classify(u, w, cfg.classHalf);
          const lmax = this.lungeMax(cls, cfg);
          if (dist > lmax) continue;
          const score = cfg.wAng * (1 - angle / cone) + cfg.wDist * (1 - dist / lmax);
          const tier = dist <= this.reachMax(cls, cfg) ? cr : cl;
          if (score > tier.score) {
            tier.edge = e; tier.s = s; tier.dist = dist; tier.angle = angle; tier.score = score; tier.cls = cls;
            tier.u = u; tier.v = w;
          }
        }
      }
    }
    return c;
  }

  // Edges behind the climber for the jump-back (spec §3): facing back toward this wall, within maxDist of the
  // grip, not far above. Fills out {edge, s, dist} and returns it, or null.
  searchBehind(cur, grip, N, cfg, out) {
    let best = null, bd = 1e30;
    const nn = this._r, p = this._q;
    for (const e of this.edges) {
      if (e === cur) continue;
      const room = this.handRoom(e, cfg.handSpread);
      let s = this.closestS(e, grip.x, grip.y, grip.z);
      s = clamp(s, room, e.len - room);
      this.pointAt(e, s, p);
      this.normalAt(e, s, 0, nn);
      if (nn.x * N.x + nn.z * N.z > -0.5) continue;                  // must face us (its normal ~ -N)
      const dy = p.y - grip.y;
      if (dy > 0.6 || dy < -cfg.jumpBackMax) continue;
      const out_ = (p.x - grip.x) * N.x + (p.z - grip.z) * N.z;      // must actually be behind (along +N)
      if (out_ < 0.5) continue;
      const d = Math.hypot(p.x - grip.x, dy, p.z - grip.z);
      if (d > cfg.jumpBackMax || d >= bd) continue;
      bd = d; best = e; out.edge = e; out.s = s; out.dist = d;
    }
    return best ? out : null;
  }

  // The move the stick asks for, in the spec's priority order (§1 pseudo-code, climb-up first at a top edge).
  // edge/s/spread: current grip. (u, v): stick in the wall plane (u = along the wall to the climber's right,
  // v = up the wall), magnitude <= 1. out: {type, edge, s, dist, cls, needsJump, dir, du, dv}.
  //   type: 'none' | 'climbUp' | 'shimmy' | 'reach' | 'lunge' | 'jumpBack'
  //   'reach' -> static, no button.  'lunge' -> needsJump (arm-extend feedback until Jump).
  //   'jumpBack' -> out.edge = a target behind, or null (free leap; the caller checks the floor height).
  findMove(edge, s, spread, u, v, cfg, out) {
    out.type = 'none'; out.edge = null; out.s = 0; out.dist = 0; out.cls = 'none'; out.needsJump = false; out.dir = 0;
    const m = Math.hypot(u, v);
    out.du = 0; out.dv = 0;
    if (m < cfg.moveDeadzone) return out;
    const du = u / m, dv = v / m;
    out.du = du; out.dv = dv;
    const stickUp = dv >= Math.cos(cfg.classHalf);
    // 1. climb-up at a walkable top
    if (edge.top && stickUp) { out.type = 'climbUp'; out.edge = edge; out.s = s; return out; }
    // 2. shimmy: horizontal-dominant stick and the same edge continues that way
    const room = this.handRoom(edge, spread);
    const dir = du >= 0 ? 1 : -1;
    // a hold's few cm of play is not a shimmy: the edge must offer >= 0.1 m of travel for the grip centre
    const canSlide = edge.len - 2 * room >= 0.1 && (dir > 0 ? s < edge.len - room - 0.005 : s > room + 0.005);
    if (Math.abs(du) >= Math.abs(dv) && canSlide) { out.type = 'shimmy'; out.dir = dir; out.edge = edge; out.s = s; return out; }
    // 3./4. holds in the stick cone from the leading hand
    const N = this.normalAt(edge, s, cfg.cornerBlend, this._n);
    const R = this._r2 || (this._r2 = new Vec3());
    R.set(N.z, 0, -N.x);
    const ref = this._ref || (this._ref = new Vec3());
    this.pointAt(edge, s + (spread / 2) * du, ref);
    this._search(edge, ref, R, N, du, dv, cfg);
    const cr = this._candReach, cl = this._candLunge;
    const pick = cr.edge ? cr : cl.edge ? cl : null;
    if (pick) {
      out.type = pick === cr ? 'reach' : 'lunge';
      out.needsJump = pick === cl;
      out.edge = pick.edge; out.s = pick.s; out.dist = pick.dist; out.cls = pick.cls;
      return out;
    }
    // 5. stick away from the wall (> 120 deg from wall-up): look back / jump back
    if (dv < Math.cos(120 * DEG)) {
      out.type = 'jumpBack';
      const g = this.pointAt(edge, s, this._p);
      const b = this.searchBehind(edge, g, N, cfg, this._behind || (this._behind = { edge: null, s: 0, dist: 0 }));
      if (b) { out.edge = b.edge; out.s = b.s; out.dist = b.dist; }
      return out;
    }
    // 6. diagonal push with nothing in the cone: shimmy if the edge continues that way
    if (Math.abs(du) > 0.3 && canSlide) { out.type = 'shimmy'; out.dir = dir; out.edge = edge; out.s = s; return out; }
    return out;                                                      // 'none': lean / arm-extend feedback only
  }

  // Slide a grip centre along its edge by `delta` metres, keeping both hands on. -> {s, endReached}.
  slide(edge, s, delta, spread, out) {
    const room = this.handRoom(edge, spread);
    const want = s + delta;
    out.s = clamp(want, room, edge.len - room);
    out.endReached = Math.abs(out.s - want) > 1e-9;
    return out;
  }

  // A foothold edge 0.9-1.3 m (band) below the hands near lateral position s on `edge` (spec §7), or null.
  foothold(edge, s, band0, band1, out) {
    const g = this.pointAt(edge, s, this._p);
    let best = null, bd = 1e30;
    for (const e of this.edges) {
      if (e === edge || e.kind === 'bar' || e.feet === false) continue;
      const dy = g.y - e.y;
      if (dy < band0 || dy > band1) continue;
      const fs = this.closestS(e, g.x, e.y, g.z, true);
      if (this.lastDist > 0.5) continue;
      if (this.lastDist < bd) { bd = this.lastDist; best = e; out.edge = e; out.s = fs; }
    }
    return best ? out : null;
  }

  // Where the climber stands after a climb-up at grip s: inset metres in from the lip, at the edge height.
  topSurface(edge, s, inset, out) {
    if (!edge.top) return null;
    const p = this.pointAt(edge, s, this._p);
    const n = this.normalAt(edge, s, 0, this._n);
    return out.set(p.x - n.x * inset, edge.y, p.z - n.z * inset);
  }

  // Edges whose closest point is within radius of p (debug draw, AI). out: array (cleared).
  edgesNear(p, radius, out = []) {
    out.length = 0;
    for (const e of this.edges) {
      this.closestS(e, p.x, p.y, p.z);
      if (this.lastDist <= radius) out.push(e);
    }
    return out;
  }

  // Authoring rules (spec "Authoring rules"): no edge (deadMin, deadMax) above the floor in front of it (Naughty Dog's
  // 3.25-4 m dead zone) and none (avoidMin, avoidMax) above it (the mantle ambiguity band). floorAt(x, z, fromY) ->
  // y | null (world.groundAt). Samples every `step` m along each edge. Returns [{id, rule, h, s}] (also stored).
  validate({ floorAt, deadMin = 3.25, deadMax = 4.0, avoidMin = 0.5, avoidMax = 0.8, step = 0.5, front = 0.6, floorY = 0 } = {}) {
    const out = [];
    const p = new Vec3(), n = new Vec3();
    for (const e of this.edges) {
      const k = Math.max(2, Math.ceil(e.len / step) + 1);
      const seen = new Set();
      for (let i = 0; i < k; i++) {
        const s = (e.len * i) / (k - 1);
        this.pointAt(e, s, p); this.normalAt(e, s, 0, n);
        const fx = p.x + n.x * front, fz = p.z + n.z * front;
        const f = floorAt ? floorAt(fx, fz, e.y - 0.05) : floorY;
        if (f == null) continue;
        const h = e.y - f;
        let rule = null;
        if (h > deadMin && h < deadMax) rule = 'dead-zone';
        else if (h > avoidMin && h < avoidMax) rule = 'avoid-band';
        if (rule && !seen.has(rule)) { seen.add(rule); out.push({ id: e.id, rule, h: +h.toFixed(3), s: +s.toFixed(2) }); }
      }
    }
    return out;
  }
}
