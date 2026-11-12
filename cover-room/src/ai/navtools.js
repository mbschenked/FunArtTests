// Graph queries the AI needs on top of level.nav (A3): bounded Dijkstra distance fields (path distance from an NPC to
// every candidate post in one pass, instead of one A* per post) and an A* with a per-edge cost multiplier (the flank
// route around the combat vector). Works on nav's CSR adjacency (nodes[i].x/y/z, adjStart, adj, adjCost); if the nav
// doesn't expose that, `ok` is false and callers fall back to straight-line distances.
// No 'three' import. All scratch is preallocated; no allocation per query except the returned flank waypoint list.

export function createNavTools(nav) {
  const ok = !!(nav && nav.nodes && nav.nodes.length && nav.adjStart && nav.adj && nav.adjCost);
  if (!ok) return { ok: false, N: 0, newField() { return null; }, field() { return false; }, nodeOf() { return -1; } };
  const nodes = nav.nodes, N = nodes.length;
  const adjStart = nav.adjStart, adj = nav.adj, adjCost = nav.adjCost;
  const heap = new Int32Array(adj.length + N + 1);
  const key = new Float64Array(N);
  const closed = new Uint32Array(N);
  const stamp = new Uint32Array(N);
  let gen = 0, size = 0;

  function push(id) {
    let k = size++;
    heap[k] = id;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (key[heap[p]] <= key[heap[k]]) break;
      const t = heap[p]; heap[p] = heap[k]; heap[k] = t; k = p;
    }
  }
  function pop() {
    const top = heap[0];
    heap[0] = heap[--size];
    let k = 0;
    for (;;) {
      const l = 2 * k + 1, r = l + 1;
      let m = k;
      if (l < size && key[heap[l]] < key[heap[m]]) m = l;
      if (r < size && key[heap[r]] < key[heap[m]]) m = r;
      if (m === k) break;
      const t = heap[m]; heap[m] = heap[k]; heap[k] = t; k = m;
    }
    return top;
  }

  const nodeOf = (pos) => { const n = nav.nearest(pos); return n ? n.id : -1; };

  // A distance field: {dist: Float32Array (Infinity = unreached), came: Int32Array, source, maxDist}
  function newField() {
    const f = { dist: new Float32Array(N), came: new Int32Array(N), source: -1, maxDist: 0 };
    f.dist.fill(Infinity);
    return f;
  }

  // Dijkstra from node `src`, stopping past maxDist. Fills f.dist / f.came.
  function field(src, maxDist, f) {
    f.dist.fill(Infinity);
    f.source = src; f.maxDist = maxDist;
    if (src < 0) return false;
    const g = ++gen;
    const dist = f.dist, came = f.came;
    size = 0;
    dist[src] = 0; key[src] = 0; came[src] = -1; stamp[src] = g;
    push(src);
    while (size > 0) {
      const cur = pop();
      if (closed[cur] === g) continue;
      closed[cur] = g;
      const dc = dist[cur];
      if (dc > maxDist) break;
      for (let k = adjStart[cur], e = adjStart[cur + 1]; k < e; k++) {
        const j = adj[k];
        if (closed[j] === g) continue;
        const nd = dc + adjCost[k];
        if (stamp[j] !== g || nd < dist[j]) {
          stamp[j] = g; dist[j] = nd; key[j] = nd; came[j] = cur;
          if (size < heap.length) push(j);
        }
      }
    }
    return true;
  }

  // Closest approach to point p along the field's path from the source to node `id` (walks `came`).
  function pathClosest(f, id, p) {
    let best = Infinity;
    for (let c = id, guard = 0; c >= 0 && guard < N; c = f.came[c], guard++) {
      const n = nodes[c];
      const d = Math.hypot(n.x - p.x, n.z - p.z);
      if (d < best) best = d;
    }
    return best;
  }

  // A* from src to dst where each edge costs len × mul(ax, az, bx, bz). Returns {cost, len, ids: number[]} or null.
  const _g = new Float64Array(N), _came = new Int32Array(N);
  function costPath(src, dst, mul) {
    if (src < 0 || dst < 0) return null;
    const g = ++gen;
    const goal = nodes[dst];
    size = 0;
    _g[src] = 0; _came[src] = -1; stamp[src] = g;
    key[src] = Math.hypot(nodes[src].x - goal.x, nodes[src].z - goal.z);
    push(src);
    while (size > 0) {
      const cur = pop();
      if (closed[cur] === g) continue;
      closed[cur] = g;
      if (cur === dst) {
        const ids = [];
        let len = 0;
        for (let c = dst; c >= 0; c = _came[c]) {
          ids.push(c);
          const p = _came[c];
          if (p >= 0) len += Math.hypot(nodes[c].x - nodes[p].x, nodes[c].y - nodes[p].y, nodes[c].z - nodes[p].z);
        }
        ids.reverse();
        return { cost: _g[dst], len, ids };
      }
      const a = nodes[cur];
      for (let k = adjStart[cur], e = adjStart[cur + 1]; k < e; k++) {
        const j = adj[k];
        if (closed[j] === g) continue;
        const b = nodes[j];
        const ng = _g[cur] + adjCost[k] * mul(a.x, a.z, b.x, b.z);
        if (stamp[j] !== g || ng < _g[j]) {
          stamp[j] = g; _g[j] = ng; _came[j] = cur;
          key[j] = ng + Math.hypot(b.x - goal.x, b.z - goal.z);
          if (size < heap.length) push(j);
        }
      }
    }
    return null;
  }

  // Node ids → waypoints: drop collinear nodes, then shortcut with nav.clearLine only where `keep(ax,az,bx,bz)` allows
  // (the flank route must not be pulled back across the combat vector). `make(x,y,z)` creates a point.
  function waypoints(ids, keep, make) {
    if (!ids || !ids.length) return [];
    const pts = [ids[0]];
    for (let i = 1; i < ids.length - 1; i++) {
      const a = nodes[ids[i - 1]], b = nodes[ids[i]], c = nodes[ids[i + 1]];
      const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
      if (Math.abs(cross) > 1e-6 || Math.abs(b.y - a.y) > 0.05) pts.push(ids[i]);
    }
    if (ids.length > 1) pts.push(ids[ids.length - 1]);
    const out = [];
    let i = 0;
    out.push(make(nodes[pts[0]].x, nodes[pts[0]].y, nodes[pts[0]].z));
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1) {
        const a = nodes[pts[i]], b = nodes[pts[j]];
        if (keep(a.x, a.z, b.x, b.z) && nav.clearLine(a, b)) break;
        j--;
      }
      const n = nodes[pts[j]];
      out.push(make(n.x, n.y, n.z));
      i = j;
    }
    return out;
  }

  return { ok: true, N, nodes, nodeOf, newField, field, pathClosest, costPath, waypoints };
}
