// level/nav.js: AI navigation over the walkable layers (ground, stairs, balcony). Contract: refs/design.md "level/room.js" (nav).
//
// A layered grid. Each cell (default 0.5 m) holds one node per walkable surface found above it, rasterised from the
// level's box colliders:
//   - a surface is the top face of a box tagged 'floor' or 'stairs';
//   - it is walkable when an upright capsule of the agent radius standing on it touches no other box between step
//     height and head height, and the surface under the capsule's rim doesn't drop away (this keeps agents off the
//     climb gap in the parapet and off the open side of the stairs).
// Neighbouring nodes (8-connected, no corner cutting) link when the height change is one step. On stairs the limit is
// two rises, because a 0.5 m cell can skip a 0.38 m tread. Only the largest connected component is kept, so enclosed
// pockets (the inside of the fountain rim) never become goals.
//
// API (returned by buildNav):
//   findPath(from, to) -> Vector3[] | null    A* over the grid, then string-pulled. Points are on the walking surface.
//   nearest(pos)       -> node | null         the node under / closest to pos (same layer preferred)
//   nodes: [{id, x, y, z, ix, iz, layer: 'ground'|'stairs'|'balcony', pos: Vector3}]
//   links: Int32Array of node-id pairs [a0, b0, a1, b1, ...] (each undirected link once; for debug drawing)
//   neighbors(id) -> {start, end} into adj/adjCost (CSR), clearLine(nodeA, nodeB) -> bool, cell, radius
//
// Box records (from room.js): {cx, cy, cz, hx, hy, hz, cos, sin, top, bottom, tags: Set<string>}, where yaw rotates the
// box about +Y and local +X maps to world (cos, 0, -sin), local +Z to (sin, 0, cos).
import { Vector3 } from 'three';

const DEFAULTS = {
  cell: 0.5,         // grid cell size (m)
  radius: 0.35,      // agent capsule radius (m); design.md Actor.radius
  height: 1.8,       // agent capsule height (m); design.md Actor.height
  step: 0.35,        // max height change between neighbours (m); world.moveCapsule stepHeight
  stairStep: 0.65,   // same, when either node is on stairs (two 0.3 m rises in one cell)
  rimProbe: 0.9,     // drop-off probe distance as a fraction of the radius
  upperY: 1.5,       // nodes above this (and not on stairs) are layer 'balcony'
};

// Point-in-footprint test and footprint distance for a yawed box.
function localXZ(b, x, z, out) {
  const dx = x - b.cx, dz = z - b.cz;
  out[0] = dx * b.cos - dz * b.sin;     // onto local +X = (cos, -sin)
  out[1] = dx * b.sin + dz * b.cos;     // onto local +Z = (sin,  cos)
  return out;
}
const _l = [0, 0];
function inside2D(b, x, z, pad) {
  localXZ(b, x, z, _l);
  return Math.abs(_l[0]) <= b.hx + pad && Math.abs(_l[1]) <= b.hz + pad;
}
function dist2D(b, x, z) {
  localXZ(b, x, z, _l);
  const ex = Math.max(Math.abs(_l[0]) - b.hx, 0), ez = Math.max(Math.abs(_l[1]) - b.hz, 0);
  return Math.hypot(ex, ez);
}
function footprintAABB(b) {
  const ex = Math.abs(b.cos) * b.hx + Math.abs(b.sin) * b.hz;
  const ez = Math.abs(b.sin) * b.hx + Math.abs(b.cos) * b.hz;
  return [b.cx - ex, b.cz - ez, b.cx + ex, b.cz + ez];
}

export function buildNav(boxes, bounds, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const cell = o.cell, r = o.radius;
  const x0 = bounds.min.x, z0 = bounds.min.z;
  const nx = Math.ceil((bounds.max.x - x0) / cell), nz = Math.ceil((bounds.max.z - z0) / cell);
  const cellOf = (x, z) => {
    const ix = Math.floor((x - x0) / cell), iz = Math.floor((z - z0) / cell);
    return ix < 0 || iz < 0 || ix >= nx || iz >= nz ? -1 : iz * nx + ix;
  };

  // Broadphase: per cell, the boxes whose footprint (grown by the radius) touches it.
  const bins = new Array(nx * nz);
  for (let i = 0; i < bins.length; i++) bins[i] = [];
  boxes.forEach((b, bi) => {
    const [ax0, az0, ax1, az1] = footprintAABB(b);
    const i0 = Math.max(0, Math.floor((ax0 - r - x0) / cell)), i1 = Math.min(nx - 1, Math.floor((ax1 + r - x0) / cell));
    const k0 = Math.max(0, Math.floor((az0 - r - z0) / cell)), k1 = Math.min(nz - 1, Math.floor((az1 + r - z0) / cell));
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) bins[k * nx + i].push(bi);
  });
  const walkable = (b) => b.tags.has('floor') || b.tags.has('stairs');

  // Walkable surface tops at (x, z) within tol of y; returns the closest one's y or NaN.
  const surfaceNear = (x, z, y, tol) => {
    const c = cellOf(x, z);
    if (c < 0) return NaN;
    let best = NaN, bd = Infinity;
    for (const bi of bins[c]) {
      const b = boxes[bi];
      if (!walkable(b) || !inside2D(b, x, z, 0)) continue;
      const d = Math.abs(b.top - y);
      if (d <= tol && d < bd) { bd = d; best = b.top; }
    }
    return best;
  };
  // Capsule standing at (x, y, z): blocked if any box overlaps [y + step, y + height] within the radius.
  const clear = (x, y, z, list) => {
    const lo = y + o.step, hi = y + o.height;
    for (const bi of list) {
      const b = boxes[bi];
      if (b.top <= lo || b.bottom >= hi) continue;
      if (dist2D(b, x, z) < r) return false;
    }
    return true;
  };

  // --- nodes ---
  let nodes = [];
  const cellNodes = new Array(nx * nz).fill(null);
  const probe = r * o.rimProbe;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const c = iz * nx + ix;
      const x = x0 + (ix + 0.5) * cell, z = z0 + (iz + 0.5) * cell;
      const cands = [];
      for (const bi of bins[c]) {
        const b = boxes[bi];
        if (!walkable(b) || !inside2D(b, x, z, 0)) continue;
        const stairs = b.tags.has('stairs');
        const same = cands.find((s) => Math.abs(s.y - b.top) < 0.05);
        if (same) same.stairs = same.stairs || stairs;
        else cands.push({ y: b.top, stairs });
      }
      for (const s of cands) {
        if (!clear(x, s.y, z, bins[c])) continue;
        const tol = s.stairs ? o.step : o.step;      // one rise between the centre and the rim probe
        if (Number.isNaN(surfaceNear(x + probe, z, s.y, tol)) || Number.isNaN(surfaceNear(x - probe, z, s.y, tol)) ||
            Number.isNaN(surfaceNear(x, z + probe, s.y, tol)) || Number.isNaN(surfaceNear(x, z - probe, s.y, tol))) continue;
        const n = { id: nodes.length, x, y: s.y, z, ix, iz, stairs: s.stairs,
          layer: s.stairs ? 'stairs' : s.y > o.upperY ? 'balcony' : 'ground' };
        nodes.push(n);
        (cellNodes[c] || (cellNodes[c] = [])).push(n);
      }
    }
  }

  const canStep = (a, b) => Math.abs(a.y - b.y) <= (a.stairs || b.stairs ? o.stairStep : o.step);
  const linkTo = (a, ix, iz) => {
    if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) return null;
    const list = cellNodes[iz * nx + ix];
    if (!list) return null;
    let best = null;
    for (const b of list) if (canStep(a, b) && (!best || Math.abs(b.y - a.y) < Math.abs(best.y - a.y))) best = b;
    return best;
  };

  // --- links (8-connected, no corner cutting) ---
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let nb = nodes.map(() => []);
  for (const a of nodes) {
    for (const [dx, dz] of DIRS) {
      const b = linkTo(a, a.ix + dx, a.iz + dz);
      if (!b) continue;
      if (dx && dz && (!linkTo(a, a.ix + dx, a.iz) || !linkTo(a, a.ix, a.iz + dz))) continue;
      nb[a.id].push(b.id);
    }
  }
  // make symmetric (a link exists only if both directions agree)
  for (const a of nodes) nb[a.id] = nb[a.id].filter((j) => nb[j].includes(a.id));

  // --- keep the largest connected component ---
  const comp = new Int32Array(nodes.length).fill(-1);
  const sizes = [];
  for (const s of nodes) {
    if (comp[s.id] >= 0) continue;
    const ci = sizes.length, stack = [s.id];
    comp[s.id] = ci;
    let size = 0;
    while (stack.length) {
      const i = stack.pop();
      size++;
      for (const j of nb[i]) if (comp[j] < 0) { comp[j] = ci; stack.push(j); }
    }
    sizes.push(size);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  const remap = new Int32Array(nodes.length).fill(-1);
  const kept = [];
  for (const n of nodes) if (comp[n.id] === main) { remap[n.id] = kept.length; kept.push(n); }
  const keptNb = kept.map((n) => nb[n.id].map((j) => remap[j]).filter((j) => j >= 0));
  for (let i = 0; i < kept.length; i++) kept[i].id = i;
  cellNodes.fill(null);
  for (const n of kept) {
    n.pos = new Vector3(n.x, n.y, n.z);
    const c = n.iz * nx + n.ix;
    (cellNodes[c] || (cellNodes[c] = [])).push(n);
  }
  nodes = kept;
  nb = keptNb;

  // CSR adjacency + link pairs
  const N = nodes.length;
  const adjStart = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) adjStart[i + 1] = adjStart[i] + nb[i].length;
  const adj = new Int32Array(adjStart[N]), adjCost = new Float32Array(adjStart[N]);
  const pairs = [];
  for (let i = 0; i < N; i++) {
    let k = adjStart[i];
    for (const j of nb[i]) {
      const a = nodes[i], b = nodes[j];
      adj[k] = j;
      adjCost[k] = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      k++;
      if (j > i) pairs.push(i, j);
    }
  }

  return new Nav({ o, nodes, cellNodes, nx, nz, x0, z0, adjStart, adj, adjCost, links: Int32Array.from(pairs),
    components: sizes.length, dropped: nodes.length === 0 ? 0 : sizes.reduce((s, v) => s + v, 0) - N });
}

class Nav {
  constructor(d) {
    Object.assign(this, d);
    this.cell = d.o.cell;
    this.radius = d.o.radius;
    const N = d.nodes.length;
    // A* scratch, reused by every query (generation stamps instead of clearing)
    this._g = new Float64Array(N);
    this._came = new Int32Array(N);
    this._stamp = new Uint32Array(N);
    this._closed = new Uint32Array(N);
    this._gen = 0;
    this._heap = new Int32Array(d.adj.length + N + 1);
    this._f = new Float64Array(N);
  }

  neighbors(id) { return { start: this.adjStart[id], end: this.adjStart[id + 1] }; }

  _cell(x, z) {
    const ix = Math.floor((x - this.x0) / this.cell), iz = Math.floor((z - this.z0) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return null;
    return this.cellNodes[iz * this.nx + ix];
  }

  // The node under pos (same cell, the surface closest to pos.y, preferring surfaces at or below the feet),
  // else the closest node within ~6 m.
  nearest(pos) {
    const here = this._cell(pos.x, pos.z);
    if (here) {
      let best = null, bd = Infinity;
      for (const n of here) {
        const dy = n.y - pos.y;
        const d = dy > 0.6 ? dy + 10 : Math.abs(dy);
        if (d < bd) { bd = d; best = n; }
      }
      if (best) return best;
    }
    const ix = Math.floor((pos.x - this.x0) / this.cell), iz = Math.floor((pos.z - this.z0) / this.cell);
    let best = null, bd = Infinity;
    for (let ring = 1; ring <= 12; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const jx = ix + dx, jz = iz + dz;
          if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) continue;
          const list = this.cellNodes[jz * this.nx + jx];
          if (!list) continue;
          for (const n of list) {
            const d = Math.hypot(n.x - pos.x, (n.y - pos.y) * 2, n.z - pos.z);
            if (d < bd) { bd = d; best = n; }
          }
        }
      }
      if (best && ring * this.cell > bd) break;   // no closer node can be further out
    }
    return best;
  }

  // Straight walk from node a to node b stays on linked surfaces (samples every quarter cell).
  clearLine(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / (this.cell * 0.25)));
    let y = a.y, prevStairs = a.stairs;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const list = this._cell(a.x + dx * t, a.z + dz * t);
      if (!list) return false;
      let hit = null;
      for (const n of list) {
        const lim = n.stairs || prevStairs ? this.o.stairStep : this.o.step;
        if (Math.abs(n.y - y) <= lim && (!hit || Math.abs(n.y - y) < Math.abs(hit.y - y))) hit = n;
      }
      if (!hit) return false;
      y = hit.y;
      prevStairs = hit.stairs;
    }
    return Math.abs(y - b.y) < 0.05;
  }

  // A* (3D Euclidean costs and heuristic), then greedy string-pulling with clearLine.
  findPath(from, to) {
    const s = this.nearest(from), g = this.nearest(to);
    if (!s || !g) return null;
    const ids = this._astar(s.id, g.id);
    if (!ids) return null;
    const nodes = this.nodes;
    const keep = [ids[0]];
    let i = 0;
    while (i < ids.length - 1) {
      let j = ids.length - 1;
      while (j > i + 1 && !this.clearLine(nodes[ids[i]], nodes[ids[j]])) j--;
      keep.push(ids[j]);
      i = j;
    }
    const out = keep.map((id) => nodes[id].pos.clone());
    // start and end at the requested points, on the walking surface
    out[0].set(from.x, s.y, from.z);
    if (keep.length > 1) out[out.length - 1].set(to.x, g.y, to.z);
    else out.push(new Vector3(to.x, g.y, to.z));
    return out;
  }

  _astar(sid, gid) {
    const nodes = this.nodes, G = this._g, F = this._f, came = this._came, stamp = this._stamp, closed = this._closed;
    const heap = this._heap;
    const gen = ++this._gen;
    const goal = nodes[gid];
    const h = (n) => Math.hypot(n.x - goal.x, n.y - goal.y, n.z - goal.z);
    let size = 0;
    const push = (id) => {
      let k = size++;
      heap[k] = id;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (F[heap[p]] <= F[heap[k]]) break;
        const t = heap[p]; heap[p] = heap[k]; heap[k] = t; k = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      heap[0] = heap[--size];
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < size && F[heap[l]] < F[heap[m]]) m = l;
        if (r < size && F[heap[r]] < F[heap[m]]) m = r;
        if (m === k) break;
        const t = heap[m]; heap[m] = heap[k]; heap[k] = t; k = m;
      }
      return top;
    };
    stamp[sid] = gen; G[sid] = 0; F[sid] = h(nodes[sid]); came[sid] = -1;
    push(sid);
    while (size > 0) {
      const cur = pop();
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      if (cur === gid) {
        const path = [];
        for (let c = gid; c >= 0; c = came[c]) path.push(c);
        return path.reverse();
      }
      for (let k = this.adjStart[cur], e = this.adjStart[cur + 1]; k < e; k++) {
        const j = this.adj[k];
        if (closed[j] === gen) continue;
        const ng = G[cur] + this.adjCost[k];
        if (stamp[j] !== gen || ng < G[j]) {
          stamp[j] = gen; G[j] = ng; F[j] = ng + h(nodes[j]); came[j] = cur;
          if (size < heap.length) push(j);
        }
      }
    }
    return null;
  }
}
