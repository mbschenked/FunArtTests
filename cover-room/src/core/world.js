// Collision world: static yaw-boxes, actor hitbox capsules, rays, sphere sweeps, a character capsule mover.
// Contract: refs/design.md "core/world.js". Owner: A2. No physics library and no import of 'three', so node can
// unit-test it (tests/world.test.mjs). The browser passes THREE.Vector3 in; the tests pass a tiny shim class.
//
//   import { createWorld, bounce } from './core/world.js';
//   game.world = createWorld({ Vector3: THREE.Vector3, cellSize: 2 });
//
// Vector class requirements: `new Vector3(x, y, z)`, fields x/y/z, `set(x, y, z)`. Nothing else is called on
// vectors: every input vector (origin, dir, delta, actor.pos, …) is only read through .x/.y/.z, and actor.pos is
// written through .x/.y/.z. Returned points and normals are instances of the class you pass.
//
// Conventions: meters, Y up. Boxes rotate about Y only (`yaw`), with the same sense as Object3D.rotation.y, so a
// mesh with `rotation.y = yaw` lines up with the collider: local +Z maps to world (sin yaw, 0, cos yaw).
// Box sides are therefore always vertical and box tops always flat (no slopes anywhere).
//
// ---------------------------------------------------------------------------------------------------------------
// API (everything below is a method of the returned world)
//   addBox({center, size, yaw=0}, {tags, material, owner}) -> collider
//       center/size: Vector3, {x,y,z} or [x,y,z] (size = full extents). tags: Set, array or string.
//       collider: {id, kind:'box', center, size, yaw, tags:Set, material, owner,
//                  min, max (world AABB, Vector3), top, bottom, hx, hy, hz (half extents), cx, cy, cz, c, s}
//       Treat colliders as read-only; change one with updateBox.
//   updateBox(collider, {center?, size?, yaw?})      moves/resizes a box and re-files it in the broadphase
//   removeCollider(collider)
//   colliders                                         live array of static colliders
//
//   addHitboxes(actor, parts) -> entry     parts: [{bone, a, b, radius, part}] (a/b: Vector3 or [x,y,z] in bone space)
//       Also sets actor.hitboxes = entry. parts null/[] -> the fallback capsule only.
//   removeHitboxes(actor)
//   updateHitboxes()                       call once per sim step, after animation has posed the rigs.
//       WHAT IT READS FROM A RIG, per part, in this order:
//         1. rig.getBoneWorld(part.bone, outVec): writes the bone's world position (its origin) into outVec.
//            THREE's getWorldPosition does this and also refreshes the bone's matrixWorld (updateWorldMatrix(true,false)).
//            (If rig.getBoneWorld is missing, the position is read from matrixWorld.elements[12..14].)
//         2. rig.bones[part.bone].matrixWorld.elements: column-major 4x4 (THREE.Matrix4 layout). Columns 0/1/2 are the
//            bone's world X/Y/Z axes; they are normalised, so scale is ignored and a/b offsets stay in meters.
//            A missing matrixWorld means identity rotation.
//         world capsule = { A: P + Rx*a.x + Ry*a.y + Rz*a.z,  B: same with b,  radius (not scaled) }
//       Fallback when actor.rig is null (or every part's bone is missing): one upright capsule at actor.pos,
//       from y + radius to y + height - radius, using actor.height / actor.radius, part 'torso'.
//       Actors with alive === false are skipped by raycast/overlapSphere (opts.includeDead to include them).
//
//   raycast(origin, dir, maxDist=Inf, opts) -> hit or null
//       opts: {ignore (actor | collider | Set | array), hitActors=true, hitStatics=true, includeDead=false,
//              tags | mask (only colliders having any of these tags), skipTags (skip colliders having any), out}
//       hit: {point, normal, dist, collider|null, actor|null, part|null}. dir need not be normalised.
//       A ray whose origin is inside a box or capsule does not hit that shape (Unity/PhysX convention).
//   sweepSphere(from, to, radius, opts) -> {point (contact on the surface), normal, t (0..1 of from->to), dist,
//       center (sphere centre at contact), collider|null, actor|null, part|null} or null
//       opts as raycast, but hitActors defaults to false. Starting in contact/overlap counts as a hit at t=0 only when
//       the motion goes into the surface, so a resting sphere can still slide or lift off.
//   bounce(vel, normal, restitution, friction) -> vel   (also a named export) reflects the normal part of vel
//       (scaled by restitution) and scales the tangential part by (1 - friction). Mutates vel. No-op if separating.
//   moveCapsule(actor, delta, {stepHeight=0.35, snapDown=0.3, footRadius=0.5*radius, skin=0.001, skipTags, out})
//       -> {grounded, groundY (highest top under the footprint, -Infinity if none), ground (collider|null),
//           hitWall, wallNormal (Vector3, y=0, first wall touched), wallCollider, hitCeiling, stepped}
//       Feet-anchored vertical capsule (actor.pos = feet, actor.height, actor.radius). Horizontal move-and-slide
//       (up to 4 iterations) treats the capsule as its cylinder against boxes whose top is above
//       feet + stepHeight; lower boxes are stepped onto by the ground pass (footprint of footRadius). Snap-down
//       applies only when the previous call ended grounded and delta.y <= 0. slopeLimit is accepted and ignored:
//       yaw-only boxes have no slopes. Mutates actor.pos. Never tunnels: every horizontal contact is a swept test.
//   overlapSphere(center, radius, {out, ignore, includeDead}) -> actors[] (hitbox capsules within radius)
//   lineOfSight(a, b, {ignore, hitActors=false, skipTags, tags}) -> bool
//   groundAt(x, z, fromY=+Inf) -> highest box top at (x, z) that is <= fromY, or null
//   queryBoxes(aabbMin, aabbMax, out=[]) -> colliders overlapping the AABB (exact for yaw-boxes)
//   closestPointOnColliders(p, maxDist, {tags, skipTags, out}) -> {point, normal, dist (negative inside), collider} or null
//   probeWall(origin, dir, dist, height, {rays=3, spread=0.35 rad, tags, skipTags, out})
//       -> {point, normal, dist, collider, boxTop, top, hits} or null
//       A fan of horizontal rays from (origin.x, origin.y + height, origin.z) along dir (flattened), ±spread.
//       Nearest hit wins. boxTop = that box's top; top = top of the stack of boxes at that spot (cover height,
//       mantle/climb height).
//   debugMeshes(THREE, scene, {colorFn}) -> {group, statics, hitboxes, update(), toggle(v?), dispose()}
//       Two LineSegments (all boxes in one, all hitbox capsules in one). update() rebuilds the boxes only when
//       colliders changed and rewrites the capsules; call it per frame while visible. colorFn(collider) -> hex.
//   makeHit() -> a fresh hit object to pass as opts.out
//   stats() -> counts for perf checks
//
// RESULT OBJECTS ARE REUSED: raycast, sweepSphere, closestPointOnColliders, probeWall and moveCapsule each return
// the same internal object on every call (zero allocation per call). Copy what you keep, or pass opts.out
// (from makeHit(), or for moveCapsule any object - it gets the fields above, and wallNormal is created once).
// ---------------------------------------------------------------------------------------------------------------

const EMPTY = Object.freeze({});
const BIG = 1e30;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Reflect the normal component (× restitution), damp the tangential one (× (1 - friction)). Mutates vel.
export function bounce(vel, normal, restitution = 0.35, friction = 0.2) {
  const vn = vel.x * normal.x + vel.y * normal.y + vel.z * normal.z;
  if (vn >= 0) return vel; // separating or tangential: nothing to do
  const nx = normal.x * vn, ny = normal.y * vn, nz = normal.z * vn;
  const kt = 1 - friction;
  vel.x = (vel.x - nx) * kt - nx * restitution;
  vel.y = (vel.y - ny) * kt - ny * restitution;
  vel.z = (vel.z - nz) * kt - nz * restitution;
  return vel;
}

function toSet(tags) {
  if (!tags) return new Set();
  if (tags instanceof Set) return tags;
  if (typeof tags === 'string') return new Set([tags]);
  return new Set(tags);
}

function hasAny(set, q) {
  if (typeof q === 'string') return set.has(q);
  if (Array.isArray(q)) { for (let i = 0; i < q.length; i++) if (set.has(q[i])) return true; return false; }
  if (q instanceof Set) { for (const t of q) if (set.has(t)) return true; return false; }
  return false;
}

function isIgnored(ign, x) {
  if (!ign) return false;
  if (ign === x) return true;
  if (ign instanceof Set) return ign.has(x);
  if (Array.isArray(ign)) return ign.indexOf(x) >= 0;
  return false;
}

function rd(o, k, i) { return Array.isArray(o) ? o[i] : o[k]; }

export function createWorld({ Vector3, cellSize = 2 } = {}) {
  if (typeof Vector3 !== 'function') {
    throw new Error('createWorld({Vector3}): pass THREE.Vector3 or a class with constructor(x,y,z), x/y/z and set(x,y,z)');
  }
  const V = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);
  const cs = cellSize;

  // ------------------------------------------------------------------ statics + uniform grid broadphase (XZ)
  const colliders = [];
  const grid = new Map(); // cell key -> collider[]
  let gMinIx = 0, gMaxIx = -1, gMinIz = 0, gMaxIz = -1; // filled cell range (empty while max < min)
  let maxTop = -BIG;
  let nextId = 1, version = 0, stamp = 0;
  // Cell keys stay inside V8's small-integer range (< 2^30) so Map lookups never box a number: ±4096 cells
  // (±8 km at 2 m cells) per axis.
  const cellKey = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);

  function derive(col) {
    const hx = col.size.x / 2, hy = col.size.y / 2, hz = col.size.z / 2;
    const c = Math.cos(col.yaw), s = Math.sin(col.yaw);
    col.hx = hx; col.hy = hy; col.hz = hz;
    col.cx = col.center.x; col.cy = col.center.y; col.cz = col.center.z;
    col.c = c; col.s = s;
    const ex = Math.abs(c) * hx + Math.abs(s) * hz; // world AABB half extents of the yawed box
    const ez = Math.abs(s) * hx + Math.abs(c) * hz;
    col.min.set(col.cx - ex, col.cy - hy, col.cz - ez);
    col.max.set(col.cx + ex, col.cy + hy, col.cz + ez);
    col.top = col.cy + hy; col.bottom = col.cy - hy;
  }

  function fileInGrid(col) {
    const i0 = Math.floor((col.min.x - 1e-6) / cs), i1 = Math.floor((col.max.x + 1e-6) / cs);
    const j0 = Math.floor((col.min.z - 1e-6) / cs), j1 = Math.floor((col.max.z + 1e-6) / cs);
    if (Math.min(i0, j0) < -4000 || Math.max(i1, j1) > 4000) throw new Error(`world.addBox: box ${col.id} is outside the grid range (±4000 cells)`);
    col._cells.length = 0;
    for (let ix = i0; ix <= i1; ix++) {
      for (let iz = j0; iz <= j1; iz++) {
        const k = cellKey(ix, iz);
        let list = grid.get(k);
        if (!list) { list = []; grid.set(k, list); }
        list.push(col);
        col._cells.push(k);
      }
    }
    if (gMaxIx < gMinIx) { gMinIx = i0; gMaxIx = i1; gMinIz = j0; gMaxIz = j1; } else {
      if (i0 < gMinIx) gMinIx = i0; if (i1 > gMaxIx) gMaxIx = i1;
      if (j0 < gMinIz) gMinIz = j0; if (j1 > gMaxIz) gMaxIz = j1;
    }
    if (col.top > maxTop) maxTop = col.top;
  }

  function unfile(col) {
    for (const k of col._cells) {
      const list = grid.get(k);
      if (!list) continue;
      const i = list.indexOf(col);
      if (i >= 0) { list[i] = list[list.length - 1]; list.pop(); }
      if (!list.length) grid.delete(k);
    }
    col._cells.length = 0;
  }

  function addBox({ center, size, yaw = 0 }, { tags, material = null, owner = null } = EMPTY) {
    const col = {
      id: nextId++, kind: 'box',
      center: V(rd(center, 'x', 0), rd(center, 'y', 1), rd(center, 'z', 2)),
      size: V(rd(size, 'x', 0), rd(size, 'y', 1), rd(size, 'z', 2)),
      yaw, tags: toSet(tags), material, owner,
      min: V(), max: V(), top: 0, bottom: 0,
      hx: 0, hy: 0, hz: 0, cx: 0, cy: 0, cz: 0, c: 1, s: 0,
      _stamp: 0, _cells: [],
    };
    derive(col);
    fileInGrid(col);
    colliders.push(col);
    version++;
    return col;
  }

  function updateBox(col, { center, size, yaw } = EMPTY) {
    unfile(col);
    if (center) col.center.set(rd(center, 'x', 0), rd(center, 'y', 1), rd(center, 'z', 2));
    if (size) col.size.set(rd(size, 'x', 0), rd(size, 'y', 1), rd(size, 'z', 2));
    if (yaw !== undefined) col.yaw = yaw;
    derive(col);
    fileInGrid(col);
    version++;
    return col;
  }

  function removeCollider(col) {
    const i = colliders.indexOf(col);
    if (i < 0) return false;
    unfile(col);
    colliders.splice(i, 1);
    version++;
    return true;
  }

  // ------------------------------------------------------------------ scratch registers
  // Hot-path helpers pass numbers through this Float64Array instead of arguments / return values / closure lets.
  // V8 boxes a double (a 16-byte heap allocation) whenever it crosses a call that is not inlined, or is stored in a
  // closure slot; the narrowphase functions are too big to inline, so this is what keeps the hot paths allocation-free.
  //   F[0..2]  out normal            F[3..5]   out contact point        F[6..8]  closest point on segment
  //   F[9]     best distance         F[10..12] best normal              F[13]    out distance / push depth
  //   F[16..21] ray origin, unit dir F[22]     ray maxT / sweep length  F[23]    sweep radius
  //   F[24..29] capsule A, B         F[30]     capsule radius           F[31]    capsule inflate (sweeps vs actors)
  //   F[32..33] circle centre x, z   F[34..35] circle dir x, z          F[36]    circle travel  F[37] circle radius
  //   F[38..40] query point          F[42..45] gather rect minX, minZ, maxX, maxZ
  const F = new Float64Array(48);

  // Collect statics whose cells overlap the XZ rect F[42..45] into out[0..n). Dedupe by stamp. Not re-entrant.
  function gather(out) {
    if (gMaxIx < gMinIx) return 0;
    let i0 = Math.floor(F[42] / cs), i1 = Math.floor(F[44] / cs);
    let j0 = Math.floor(F[43] / cs), j1 = Math.floor(F[45] / cs);
    if (i0 < gMinIx) i0 = gMinIx; if (i1 > gMaxIx) i1 = gMaxIx;
    if (j0 < gMinIz) j0 = gMinIz; if (j1 > gMaxIz) j1 = gMaxIz;
    const st = ++stamp;
    let n = 0;
    for (let ix = i0; ix <= i1; ix++) {
      for (let iz = j0; iz <= j1; iz++) {
        const list = grid.get(cellKey(ix, iz));
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const col = list[k];
          if (col._stamp === st) continue;
          col._stamp = st;
          out[n++] = col;
        }
      }
    }
    return n;
  }
  function setRect(minX, minZ, maxX, maxZ) { F[42] = minX; F[43] = minZ; F[44] = maxX; F[45] = maxZ; }

  function passTags(col, tags, skip) {
    if (tags != null && !hasAny(col.tags, tags)) return false;
    if (skip != null && hasAny(col.tags, skip)) return false;
    return true;
  }

  // Closest point on segment F[24..29] to point F[38..40] -> F[6..8].
  function closestOnSeg() {
    const ax = F[24], ay = F[25], az = F[26];
    const abx = F[27] - ax, aby = F[28] - ay, abz = F[29] - az;
    const L = abx * abx + aby * aby + abz * abz;
    let t = L > 1e-18 ? ((F[38] - ax) * abx + (F[39] - ay) * aby + (F[40] - az) * abz) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    F[6] = ax + abx * t; F[7] = ay + aby * t; F[8] = az + abz * t;
  }
  function loadCapsule(caps, o, inflate) {
    F[24] = caps[o]; F[25] = caps[o + 1]; F[26] = caps[o + 2];
    F[27] = caps[o + 3]; F[28] = caps[o + 4]; F[29] = caps[o + 5]; F[30] = caps[o + 6] + inflate;
  }

  // Ray F[16..21] (unit dir) vs capsule F[24..30]. true -> entry distance in F[13].
  // Miss, or origin inside the capsule -> false. Capsule = finite cylinder ∪ two end spheres; the entry into a
  // union of convex parts is the smallest entry over the parts.
  function rayCapsule() {
    const ox = F[16], oy = F[17], oz = F[18], dx = F[19], dy = F[20], dz = F[21];
    const ax = F[24], ay = F[25], az = F[26], bx = F[27], by = F[28], bz = F[29], r = F[30];
    const bax = bx - ax, bay = by - ay, baz = bz - az;
    const oax = ox - ax, oay = oy - ay, oaz = oz - az;
    const baba = bax * bax + bay * bay + baz * baz;
    const baoa = bax * oax + bay * oay + baz * oaz;
    { // origin inside -> no hit
      const s = baba > 1e-18 ? clamp(baoa / baba, 0, 1) : 0;
      const ex = oax - bax * s, ey = oay - bay * s, ez = oaz - baz * s;
      if (ex * ex + ey * ey + ez * ez < r * r) return false;
    }
    const bard = bax * dx + bay * dy + baz * dz;
    const rdoa = dx * oax + dy * oay + dz * oaz;
    const oaoa = oax * oax + oay * oay + oaz * oaz;
    let best = BIG;
    const a = baba - bard * bard;
    if (a > 1e-12) { // cylinder body
      const b = baba * rdoa - baoa * bard;
      const c = baba * oaoa - baoa * baoa - r * r * baba;
      const h = b * b - a * c;
      if (h >= 0) {
        const t = (-b - Math.sqrt(h)) / a;
        const y = baoa + t * bard;
        if (t >= 0 && y > 0 && y < baba) best = t;
      }
    }
    for (let k = 0; k < 2; k++) { // end spheres
      const ocx = k ? ox - bx : oax, ocy = k ? oy - by : oay, ocz = k ? oz - bz : oaz;
      const b = ocx * dx + ocy * dy + ocz * dz;
      const c = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
      const h = b * b - c;
      if (h < 0) continue;
      const t = -b - Math.sqrt(h);
      if (t >= 0 && t < best) best = t;
    }
    if (best === BIG) return false;
    F[13] = best;
    return true;
  }

  // Ray F[16..21] (unit dir) vs yaw-box, limit F[22]. true -> distance F[13], world normal F[0..2].
  // Origin inside the box -> false.
  function rayBox(col) {
    const c = col.c, s = col.s, hx = col.hx, hy = col.hy, hz = col.hz;
    const wx = F[16] - col.cx, wz = F[18] - col.cz, dx = F[19], dz = F[21];
    const lx = c * wx - s * wz, ly = F[17] - col.cy, lz = s * wx + c * wz;
    const vx = c * dx - s * dz, vy = F[20], vz = s * dx + c * dz;
    let tE = -BIG, tX = BIG, ax = -1, sg = 0;
    if (vx > -1e-12 && vx < 1e-12) { if (lx < -hx || lx > hx) return false; } else {
      let t1 = (-hx - lx) / vx, t2 = (hx - lx) / vx;
      if (t1 > t2) { const q = t1; t1 = t2; t2 = q; }
      if (t1 > tE) { tE = t1; ax = 0; sg = vx > 0 ? -1 : 1; }
      if (t2 < tX) tX = t2;
    }
    if (vy > -1e-12 && vy < 1e-12) { if (ly < -hy || ly > hy) return false; } else {
      let t1 = (-hy - ly) / vy, t2 = (hy - ly) / vy;
      if (t1 > t2) { const q = t1; t1 = t2; t2 = q; }
      if (t1 > tE) { tE = t1; ax = 1; sg = vy > 0 ? -1 : 1; }
      if (t2 < tX) tX = t2;
    }
    if (vz > -1e-12 && vz < 1e-12) { if (lz < -hz || lz > hz) return false; } else {
      let t1 = (-hz - lz) / vz, t2 = (hz - lz) / vz;
      if (t1 > t2) { const q = t1; t1 = t2; t2 = q; }
      if (t1 > tE) { tE = t1; ax = 2; sg = vz > 0 ? -1 : 1; }
      if (t2 < tX) tX = t2;
    }
    if (tE > tX || tX < 0 || tE < 0 || tE > F[22]) return false;
    const nlx = ax === 0 ? sg : 0, nlz = ax === 2 ? sg : 0;
    F[0] = c * nlx + s * nlz; F[1] = ax === 1 ? sg : 0; F[2] = -s * nlx + c * nlz;
    F[13] = tE;
    return true;
  }

  // Capsule along the box edge between local corners n0 and n1 (bits 1 = +x, 2 = +y, 4 = +z), in world space,
  // radius r, against the sweep ray F[16..21]. true -> entry distance in F[13].
  function edgeCap(col, n0, n1, r) {
    const c = col.c, s = col.s;
    const x0 = (n0 & 1) ? col.hx : -col.hx, y0 = (n0 & 2) ? col.hy : -col.hy, z0 = (n0 & 4) ? col.hz : -col.hz;
    const x1 = (n1 & 1) ? col.hx : -col.hx, y1 = (n1 & 2) ? col.hy : -col.hy, z1 = (n1 & 4) ? col.hz : -col.hz;
    F[24] = col.cx + c * x0 + s * z0; F[25] = col.cy + y0; F[26] = col.cz - s * x0 + c * z0;
    F[27] = col.cx + c * x1 + s * z1; F[28] = col.cy + y1; F[29] = col.cz - s * x1 + c * z1;
    F[30] = r;
    return rayCapsule();
  }

  // Moving sphere (ray F[16..21], length F[22], radius F[23]) vs yaw-box, after Ericson, Real-Time Collision
  // Detection §5.5.7: ray vs the box grown by r, then edge capsules / corner spheres in the edge and vertex regions.
  // true -> distance F[13], world normal F[0..2], world contact point F[3..5].
  // Already touching/overlapping counts as a hit at 0 only when moving inward.
  function sweepSphereBox(col) {
    const c = col.c, s = col.s, hx = col.hx, hy = col.hy, hz = col.hz;
    const len = F[22], r = F[23], ux = F[19], uz = F[21];
    const wx = F[16] - col.cx, wz = F[18] - col.cz;
    const lx = c * wx - s * wz, ly = F[17] - col.cy, lz = s * wx + c * wz;
    const vx = c * ux - s * uz, vy = F[20], vz = s * ux + c * uz;
    {
      const qx = clamp(lx, -hx, hx), qy = clamp(ly, -hy, hy), qz = clamp(lz, -hz, hz);
      const ex = lx - qx, ey = ly - qy, ez = lz - qz;
      const d2 = ex * ex + ey * ey + ez * ez;
      const rr = r + 1e-7;
      if (d2 <= rr * rr) {
        let nx = 0, ny = 0, nz = 0;
        if (d2 > 1e-18) { const d = Math.sqrt(d2); nx = ex / d; ny = ey / d; nz = ez / d; } else {
          const px = hx - Math.abs(lx), py = hy - Math.abs(ly), pz = hz - Math.abs(lz);
          if (px <= py && px <= pz) nx = lx >= 0 ? 1 : -1;
          else if (py <= pz) ny = ly >= 0 ? 1 : -1;
          else nz = lz >= 0 ? 1 : -1;
        }
        if (vx * nx + vy * ny + vz * nz >= -1e-12) return false;
        F[0] = c * nx + s * nz; F[1] = ny; F[2] = -s * nx + c * nz;
        F[3] = col.cx + c * qx + s * qz; F[4] = col.cy + qy; F[5] = col.cz - s * qx + c * qz;
        F[13] = 0;
        return true;
      }
    }
    const Ex = hx + r, Ey = hy + r, Ez = hz + r;
    let tE = -BIG, tX = BIG;
    if (vx > -1e-12 && vx < 1e-12) { if (lx < -Ex || lx > Ex) return false; } else {
      let t1 = (-Ex - lx) / vx, t2 = (Ex - lx) / vx;
      if (t1 > t2) { const q = t1; t1 = t2; t2 = q; }
      if (t1 > tE) tE = t1; if (t2 < tX) tX = t2;
    }
    if (vy > -1e-12 && vy < 1e-12) { if (ly < -Ey || ly > Ey) return false; } else {
      let t1 = (-Ey - ly) / vy, t2 = (Ey - ly) / vy;
      if (t1 > t2) { const q = t1; t1 = t2; t2 = q; }
      if (t1 > tE) tE = t1; if (t2 < tX) tX = t2;
    }
    if (vz > -1e-12 && vz < 1e-12) { if (lz < -Ez || lz > Ez) return false; } else {
      let t1 = (-Ez - lz) / vz, t2 = (Ez - lz) / vz;
      if (t1 > t2) { const q = t1; t1 = t2; t2 = q; }
      if (t1 > tE) tE = t1; if (t2 < tX) tX = t2;
    }
    if (tE > tX || tX < 0 || tE > len) return false;
    const t0 = tE > 0 ? tE : 0;
    const px = lx + vx * t0, py = ly + vy * t0, pz = lz + vz * t0;
    let u = 0, v = 0;
    if (px < -hx) u |= 1; if (px > hx) v |= 1;
    if (py < -hy) u |= 2; if (py > hy) v |= 2;
    if (pz < -hz) u |= 4; if (pz > hz) v |= 4;
    const m = u | v;
    let t;
    if (m === 7) { // vertex region: the three edge capsules meeting at corner v
      t = BIG;
      if (edgeCap(col, v, v ^ 1, r) && F[13] < t) t = F[13];
      if (edgeCap(col, v, v ^ 2, r) && F[13] < t) t = F[13];
      if (edgeCap(col, v, v ^ 4, r) && F[13] < t) t = F[13];
      if (t === BIG) return false;
    } else if ((m & (m - 1)) === 0) { // face region: the grown-box time is exact
      t = t0;
    } else { // edge region
      if (!edgeCap(col, u ^ 7, v, r)) return false;
      t = F[13];
    }
    if (t > len) return false;
    // normal and contact point from the closest point to the sphere centre at contact
    const sx = lx + vx * t, sy = ly + vy * t, sz = lz + vz * t;
    const qx = clamp(sx, -hx, hx), qy = clamp(sy, -hy, hy), qz = clamp(sz, -hz, hz);
    let nx = sx - qx, ny = sy - qy, nz = sz - qz;
    const d = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (d > 1e-12) { nx /= d; ny /= d; nz /= d; } else { nx = 0; ny = 1; nz = 0; }
    F[0] = c * nx + s * nz; F[1] = ny; F[2] = -s * nx + c * nz;
    F[3] = col.cx + c * qx + s * qz; F[4] = col.cy + qy; F[5] = col.cz - s * qx + c * qz;
    F[13] = t;
    return true;
  }

  // 2D (XZ) circle F[32..33] radius F[37] vs a yaw-box footprint rectangle ----------------------------------
  // Overlap (distance < r, or the centre inside the rectangle, which also makes r = 0 a point-in-rect test).
  function circleOverlapsRect(col) {
    const wx = F[32] - col.cx, wz = F[33] - col.cz;
    const lx = col.c * wx - col.s * wz, lz = col.s * wx + col.c * wz;
    const ex = lx - clamp(lx, -col.hx, col.hx), ez = lz - clamp(lz, -col.hz, col.hz);
    const d2 = ex * ex + ez * ez;
    return d2 === 0 || d2 < F[37] * F[37];
  }

  // Push-out of the circle from the rectangle. true -> push distance F[13], world normal F[0], F[2].
  function circleRectPen(col) {
    const c = col.c, s = col.s, hx = col.hx, hz = col.hz, r = F[37];
    const wx = F[32] - col.cx, wz = F[33] - col.cz;
    const lx = c * wx - s * wz, lz = s * wx + c * wz;
    const ex = lx - clamp(lx, -hx, hx), ez = lz - clamp(lz, -hz, hz);
    const d2 = ex * ex + ez * ez;
    if (d2 >= r * r) return false;
    let nx, nz;
    if (d2 > 1e-18) { const d = Math.sqrt(d2); nx = ex / d; nz = ez / d; F[13] = r - d; } else {
      const fx = hx - Math.abs(lx), fz = hz - Math.abs(lz);
      if (fx <= fz) { nx = lx >= 0 ? 1 : -1; nz = 0; F[13] = fx + r; } else { nx = 0; nz = lz >= 0 ? 1 : -1; F[13] = fz + r; }
    }
    F[0] = c * nx + s * nz; F[2] = -s * nx + c * nz;
    return true;
  }

  // Moving circle (centre F[32..33], unit dir F[34..35], travel F[36], radius F[37]) vs the rectangle grown by r
  // (a rounded rectangle). true -> distance F[13], world normal F[0], F[2]. Touching/overlapping is a hit at 0
  // only when moving inward.
  function sweepCircleRect(col) {
    const c = col.c, s = col.s, hx = col.hx, hz = col.hz;
    const ux = F[34], uz = F[35], len = F[36], r = F[37];
    const wx = F[32] - col.cx, wz = F[33] - col.cz;
    const ox = c * wx - s * wz, oz = s * wx + c * wz;
    const vx = c * ux - s * uz, vz = s * ux + c * uz;
    const ex = ox - clamp(ox, -hx, hx), ez = oz - clamp(oz, -hz, hz);
    const d2 = ex * ex + ez * ez;
    let nx, nz, t;
    if (d2 <= r * r) {
      if (d2 > 1e-18) { const d = Math.sqrt(d2); nx = ex / d; nz = ez / d; } else {
        const fx = hx - Math.abs(ox), fz = hz - Math.abs(oz);
        if (fx <= fz) { nx = ox >= 0 ? 1 : -1; nz = 0; } else { nx = 0; nz = oz >= 0 ? 1 : -1; }
      }
      if (vx * nx + vz * nz >= -1e-12) return false;
      F[0] = c * nx + s * nz; F[2] = -s * nx + c * nz; F[13] = 0;
      return true;
    }
    const Ex = hx + r, Ez = hz + r;
    let tE = -BIG, tX = BIG, ax = -1;
    if (vx > -1e-12 && vx < 1e-12) { if (ox < -Ex || ox > Ex) return false; } else {
      let t1 = (-Ex - ox) / vx, t2 = (Ex - ox) / vx;
      if (t1 > t2) { const q = t1; t1 = t2; t2 = q; }
      if (t1 > tE) { tE = t1; ax = 0; }
      if (t2 < tX) tX = t2;
    }
    if (vz > -1e-12 && vz < 1e-12) { if (oz < -Ez || oz > Ez) return false; } else {
      let t1 = (-Ez - oz) / vz, t2 = (Ez - oz) / vz;
      if (t1 > t2) { const q = t1; t1 = t2; t2 = q; }
      if (t1 > tE) { tE = t1; ax = 1; }
      if (t2 < tX) tX = t2;
    }
    if (tE > tX || tX < 0 || tE > len) return false;
    const t0 = tE > 0 ? tE : 0;
    const hpx = ox + vx * t0, hpz = oz + vz * t0;
    if ((hpx > hx || hpx < -hx) && (hpz > hz || hpz < -hz)) { // corner region: ray vs the corner circle
      const kx = hpx > 0 ? hx : -hx, kz = hpz > 0 ? hz : -hz;
      const ocx = ox - kx, ocz = oz - kz;
      const b = ocx * vx + ocz * vz, cc = ocx * ocx + ocz * ocz - r * r;
      const disc = b * b - cc;
      if (disc < 0) return false;
      t = -b - Math.sqrt(disc);
      if (t < 0 || t > len) return false;
      nx = (ox + vx * t - kx) / r; nz = (oz + vz * t - kz) / r;
    } else {
      t = t0;
      if (ax === 0) { nx = vx > 0 ? -1 : 1; nz = 0; } else { nx = 0; nz = vz > 0 ? -1 : 1; }
    }
    F[0] = c * nx + s * nz; F[2] = -s * nx + c * nz; F[13] = t;
    return true;
  }

  // ------------------------------------------------------------------ actor hitboxes
  const entries = [];
  const warned = new Set();
  const _boneP = V();

  function addHitboxes(actor, parts) {
    removeHitboxes(actor);
    const list = (parts || []).map((p) => ({
      bone: p.bone,
      ax: rd(p.a, 'x', 0), ay: rd(p.a, 'y', 1), az: rd(p.a, 'z', 2),
      bx: rd(p.b, 'x', 0), by: rd(p.b, 'y', 1), bz: rd(p.b, 'z', 2),
      r: p.radius, part: p.part || 'torso',
    }));
    const cap = Math.max(1, list.length);
    const entry = {
      actor, parts: list,
      caps: new Float64Array(cap * 7), // per capsule: Ax Ay Az Bx By Bz r (world)
      partOf: new Array(cap).fill('torso'),
      count: 0, fallback: true,
      aabb: new Float64Array(6),
    };
    entries.push(entry);
    actor.hitboxes = entry;
    refreshEntry(entry);
    return entry;
  }

  function removeHitboxes(actor) {
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].actor === actor) { entries.splice(i, 1); return true; }
    }
    return false;
  }

  function refreshEntry(e) {
    const a = e.actor, rig = a.rig, caps = e.caps;
    let n = 0;
    if (rig && e.parts.length) {
      const bones = rig.bones || EMPTY;
      for (let i = 0; i < e.parts.length; i++) {
        const p = e.parts[i];
        const bone = bones[p.bone];
        const m = bone && bone.matrixWorld && bone.matrixWorld.elements;
        if (!bone && (rig.bones || typeof rig.getBoneWorld !== 'function')) {
          if (!warned.has(p.bone)) { warned.add(p.bone); console.warn(`world: rig has no bone "${p.bone}"`); }
          continue;
        }
        if (typeof rig.getBoneWorld === 'function') { rig.getBoneWorld(p.bone, _boneP); F[38] = _boneP.x; F[39] = _boneP.y; F[40] = _boneP.z; }
        else { F[38] = m[12]; F[39] = m[13]; F[40] = m[14]; }
        const px = F[38], py = F[39], pz = F[40];
        let Xx = 1, Xy = 0, Xz = 0, Yx = 0, Yy = 1, Yz = 0, Zx = 0, Zy = 0, Zz = 1;
        if (m) {
          const lX = Math.hypot(m[0], m[1], m[2]) || 1, lY = Math.hypot(m[4], m[5], m[6]) || 1, lZ = Math.hypot(m[8], m[9], m[10]) || 1;
          Xx = m[0] / lX; Xy = m[1] / lX; Xz = m[2] / lX;
          Yx = m[4] / lY; Yy = m[5] / lY; Yz = m[6] / lY;
          Zx = m[8] / lZ; Zy = m[9] / lZ; Zz = m[10] / lZ;
        } else if (!warned.has('!m:' + p.bone)) {
          warned.add('!m:' + p.bone); console.warn(`world: bone "${p.bone}" has no matrixWorld; using identity rotation`);
        }
        const o = n * 7;
        caps[o] = px + Xx * p.ax + Yx * p.ay + Zx * p.az;
        caps[o + 1] = py + Xy * p.ax + Yy * p.ay + Zy * p.az;
        caps[o + 2] = pz + Xz * p.ax + Yz * p.ay + Zz * p.az;
        caps[o + 3] = px + Xx * p.bx + Yx * p.by + Zx * p.bz;
        caps[o + 4] = py + Xy * p.bx + Yy * p.by + Zy * p.bz;
        caps[o + 5] = pz + Xz * p.bx + Yz * p.by + Zz * p.bz;
        caps[o + 6] = p.r;
        e.partOf[n] = p.part;
        n++;
      }
    }
    e.fallback = n === 0;
    if (n === 0) { // upright capsule at the feet position
      const r = a.radius ?? 0.35, h = a.height ?? 1.8, P = a.pos;
      const rr = Math.min(r, h / 2);
      caps[0] = P.x; caps[1] = P.y + rr; caps[2] = P.z;
      caps[3] = P.x; caps[4] = P.y + h - rr; caps[5] = P.z;
      caps[6] = rr;
      e.partOf[0] = 'torso';
      n = 1;
    }
    e.count = n;
    const bb = e.aabb;
    bb[0] = BIG; bb[1] = BIG; bb[2] = BIG; bb[3] = -BIG; bb[4] = -BIG; bb[5] = -BIG;
    for (let i = 0; i < n; i++) {
      const o = i * 7, r = caps[o + 6];
      for (let k = 0; k < 3; k++) {
        const lo = Math.min(caps[o + k], caps[o + 3 + k]) - r, hi = Math.max(caps[o + k], caps[o + 3 + k]) + r;
        if (lo < bb[k]) bb[k] = lo;
        if (hi > bb[k + 3]) bb[k + 3] = hi;
      }
    }
  }

  function updateHitboxes() { for (let i = 0; i < entries.length; i++) refreshEntry(entries[i]); }

  // Ray F[16..21] vs an actor AABB grown by F[31]: true when [0, F[9]] touches it (origin inside counts).
  function rayHitsAABB(bb) {
    const g = F[31];
    let t0 = 0, t1 = F[9];
    for (let k = 0; k < 3; k++) {
      const o = F[16 + k], d = F[19 + k], lo = bb[k] - g, hi = bb[k + 3] + g;
      if (d > -1e-12 && d < 1e-12) { if (o < lo || o > hi) return false; continue; }
      let ta = (lo - o) / d, tb = (hi - o) / d;
      if (ta > tb) { const q = ta; ta = tb; tb = q; }
      if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ queries
  function makeHit() {
    return { point: V(), normal: V(), center: V(), dist: 0, t: 0, collider: null, actor: null, part: null, boxTop: 0, top: 0, hits: 0 };
  }
  const _rayHit = makeHit(), _losHit = makeHit(), _sweepHit = makeHit(), _closeHit = makeHit(), _probeHit = makeHit(), _probeTmp = makeHit();
  const _candA = [], _candB = [];

  // Best-hit state shared by the cast internals (distance and normal live in F[9..12]).
  let bCol = null, bEnt = null, bIdx = -1;

  // Ray F[16..21] vs statics, nearest within F[9]: 2D DDA over the grid (Amanatides & Woo).
  function castStatics(ign, tags, skip) {
    if (gMaxIx < gMinIx) return;
    const ox = F[16], oz = F[18], dx = F[19], dz = F[21];
    const x0 = gMinIx * cs, x1 = (gMaxIx + 1) * cs, z0 = gMinIz * cs, z1 = (gMaxIz + 1) * cs;
    let tA = 0, tB = F[9];
    if (dx > -1e-12 && dx < 1e-12) { if (ox < x0 || ox > x1) return; } else {
      let ta = (x0 - ox) / dx, tb = (x1 - ox) / dx;
      if (ta > tb) { const q = ta; ta = tb; tb = q; }
      if (ta > tA) tA = ta; if (tb < tB) tB = tb;
    }
    if (dz > -1e-12 && dz < 1e-12) { if (oz < z0 || oz > z1) return; } else {
      let ta = (z0 - oz) / dz, tb = (z1 - oz) / dz;
      if (ta > tb) { const q = ta; ta = tb; tb = q; }
      if (ta > tA) tA = ta; if (tb < tB) tB = tb;
    }
    if (tA > tB) return;
    let ix = clamp(Math.floor((ox + dx * tA) / cs), gMinIx, gMaxIx);
    let iz = clamp(Math.floor((oz + dz * tA) / cs), gMinIz, gMaxIz);
    const stepX = dx > 1e-12 ? 1 : dx < -1e-12 ? -1 : 0;
    const stepZ = dz > 1e-12 ? 1 : dz < -1e-12 ? -1 : 0;
    let tMaxX = stepX > 0 ? ((ix + 1) * cs - ox) / dx : stepX < 0 ? (ix * cs - ox) / dx : BIG;
    let tMaxZ = stepZ > 0 ? ((iz + 1) * cs - oz) / dz : stepZ < 0 ? (iz * cs - oz) / dz : BIG;
    const tDX = stepX ? cs / Math.abs(dx) : BIG, tDZ = stepZ ? cs / Math.abs(dz) : BIG;
    const st = ++stamp;
    for (;;) {
      const list = grid.get(cellKey(ix, iz));
      if (list) {
        for (let k = 0; k < list.length; k++) {
          const col = list[k];
          if (col._stamp === st) continue;
          col._stamp = st;
          if ((tags != null || skip != null) && !passTags(col, tags, skip)) continue;
          if (ign && isIgnored(ign, col)) continue;
          F[22] = F[9];
          if (rayBox(col) && F[13] <= F[9]) {
            F[9] = F[13]; F[10] = F[0]; F[11] = F[1]; F[12] = F[2];
            bCol = col; bEnt = null; bIdx = -1;
          }
        }
      }
      const tNext = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      if (tNext >= F[9] || tNext > tB) break;
      if (tMaxX < tMaxZ) { ix += stepX; tMaxX += tDX; if (ix < gMinIx || ix > gMaxIx) break; }
      else { iz += stepZ; tMaxZ += tDZ; if (iz < gMinIz || iz > gMaxIz) break; }
    }
  }

  // Ray F[16..21] vs actor capsules grown by F[31], nearest within F[9].
  function castActors(ign, includeDead) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i], a = e.actor;
      if (!e.count) continue;
      if (a.alive === false && !includeDead) continue;
      if (ign && isIgnored(ign, a)) continue;
      if (!rayHitsAABB(e.aabb)) continue;
      for (let k = 0; k < e.count; k++) {
        loadCapsule(e.caps, k * 7, F[31]);
        if (rayCapsule() && F[13] < F[9]) { F[9] = F[13]; bCol = null; bEnt = e; bIdx = k; }
      }
    }
  }

  // Normal of the best actor hit at the point F[16..18] + F[19..21] * F[9] -> F[10..12].
  function writeActorNormal() {
    const t = F[9];
    F[38] = F[16] + F[19] * t; F[39] = F[17] + F[20] * t; F[40] = F[18] + F[21] * t;
    loadCapsule(bEnt.caps, bIdx * 7, 0);
    closestOnSeg();
    let nx = F[38] - F[6], ny = F[39] - F[7], nz = F[40] - F[8];
    const d = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (d > 1e-12) { nx /= d; ny /= d; nz /= d; } else { nx = 0; ny = 1; nz = 0; }
    F[10] = nx; F[11] = ny; F[12] = nz;
  }

  function fillHit(hit) {
    if (bEnt) writeActorNormal();
    const t = F[9];
    hit.point.set(F[16] + F[19] * t, F[17] + F[20] * t, F[18] + F[21] * t);
    hit.normal.set(F[10], F[11], F[12]);
    hit.dist = t;
    hit.collider = bCol;
    hit.actor = bEnt ? bEnt.actor : null;
    hit.part = bEnt ? bEnt.partOf[bIdx] : null;
    return hit;
  }

  function raycastInto(hit, origin, dir, maxDist, opts, actorsDefault) {
    const L = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    if (!(L > 1e-12)) return null;
    F[16] = origin.x; F[17] = origin.y; F[18] = origin.z;
    F[19] = dir.x / L; F[20] = dir.y / L; F[21] = dir.z / L;
    F[9] = maxDist == null ? BIG : Math.min(maxDist, BIG);
    if (!(F[9] > 0)) return null;
    F[31] = 0;
    bCol = null; bEnt = null; bIdx = -1;
    const ign = opts.ignore, tags = opts.tags ?? opts.mask ?? null, skip = opts.skipTags ?? null;
    if (opts.hitStatics !== false) castStatics(ign, tags, skip);
    if (opts.hitActors ?? actorsDefault) castActors(ign, !!opts.includeDead);
    if (!bCol && !bEnt) return null;
    return fillHit(hit);
  }

  function raycast(origin, dir, maxDist = BIG, opts = EMPTY) {
    return raycastInto(opts.out || _rayHit, origin, dir, maxDist, opts, true);
  }

  const _losDir = { x: 0.5, y: 0.5, z: 0.5 }; // non-integer init keeps these as double fields
  function lineOfSight(a, b, opts = EMPTY) {
    _losDir.x = b.x - a.x; _losDir.y = b.y - a.y; _losDir.z = b.z - a.z;
    const L = Math.sqrt(_losDir.x * _losDir.x + _losDir.y * _losDir.y + _losDir.z * _losDir.z);
    if (L < 1e-9) return true;
    return raycastInto(_losHit, a, _losDir, L, opts, false) === null;
  }

  function sweepSphere(from, to, radius, opts = EMPTY) {
    const hit = opts.out || _sweepHit;
    const ox = from.x, oy = from.y, oz = from.z;
    let ux = to.x - ox, uy = to.y - oy, uz = to.z - oz;
    const len = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (len < 1e-12) return null;
    ux /= len; uy /= len; uz /= len;
    F[16] = ox; F[17] = oy; F[18] = oz; F[19] = ux; F[20] = uy; F[21] = uz; F[23] = radius;
    const ign = opts.ignore, tags = opts.tags ?? opts.mask ?? null, skip = opts.skipTags ?? null;
    F[9] = len;
    bCol = null; bEnt = null; bIdx = -1;
    if (opts.hitStatics !== false) {
      setRect(Math.min(ox, to.x) - radius, Math.min(oz, to.z) - radius, Math.max(ox, to.x) + radius, Math.max(oz, to.z) + radius);
      const n = gather(_candA);
      const yLo = Math.min(oy, to.y) - radius, yHi = Math.max(oy, to.y) + radius;
      for (let i = 0; i < n; i++) {
        const col = _candA[i];
        if (col.bottom > yHi || col.top < yLo) continue;
        if ((tags != null || skip != null) && !passTags(col, tags, skip)) continue;
        if (ign && isIgnored(ign, col)) continue;
        F[22] = F[9];
        if (sweepSphereBox(col) && (F[13] < F[9] || (F[13] === F[9] && !bCol))) {
          F[9] = F[13]; bCol = col;
          F[10] = F[0]; F[11] = F[1]; F[12] = F[2]; F[38] = F[3]; F[39] = F[4]; F[40] = F[5];
        }
      }
    }
    if (opts.hitActors) {
      F[31] = radius;
      castActors(ign, !!opts.includeDead);
      F[31] = 0;
      if (bEnt) { // contact point = centre - normal * radius
        writeActorNormal();
        const t = F[9];
        F[38] = F[16] + F[19] * t - F[10] * radius; F[39] = F[17] + F[20] * t - F[11] * radius; F[40] = F[18] + F[21] * t - F[12] * radius;
      }
    }
    if (!bCol && !bEnt) return null;
    const t = F[9];
    hit.center.set(ox + ux * t, oy + uy * t, oz + uz * t);
    hit.point.set(F[38], F[39], F[40]);
    hit.normal.set(F[10], F[11], F[12]);
    hit.dist = t;
    hit.t = t / len;
    hit.collider = bCol;
    hit.actor = bEnt ? bEnt.actor : null;
    hit.part = bEnt ? bEnt.partOf[bIdx] : null;
    return hit;
  }

  function overlapSphere(center, radius, opts = EMPTY) {
    const out = opts.out || [];
    out.length = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i], a = e.actor;
      if (!e.count) continue;
      if (a.alive === false && !opts.includeDead) continue;
      if (opts.ignore && isIgnored(opts.ignore, a)) continue;
      for (let k = 0; k < e.count; k++) {
        F[38] = center.x; F[39] = center.y; F[40] = center.z;
        loadCapsule(e.caps, k * 7, 0);
        closestOnSeg();
        const ex = F[38] - F[6], ey = F[39] - F[7], ez = F[40] - F[8], rr = radius + F[30];
        if (ex * ex + ey * ey + ez * ez <= rr * rr) { out.push(a); break; }
      }
    }
    return out;
  }

  function groundAt(x, z, fromY = BIG) {
    setRect(x, z, x, z);
    const n = gather(_candB);
    F[32] = x; F[33] = z; F[37] = 0;
    let best = -BIG;
    for (let i = 0; i < n; i++) {
      const col = _candB[i];
      if (col.top > fromY + 1e-9 || col.top <= best) continue;
      if (circleOverlapsRect(col)) best = col.top;
    }
    return best > -BIG ? best : null;
  }

  function queryBoxes(aabbMin, aabbMax, out = []) {
    setRect(aabbMin.x, aabbMin.z, aabbMax.x, aabbMax.z);
    const n = gather(_candB);
    const qcx = (aabbMin.x + aabbMax.x) / 2, qcz = (aabbMin.z + aabbMax.z) / 2;
    const qhx = (aabbMax.x - aabbMin.x) / 2, qhz = (aabbMax.z - aabbMin.z) / 2;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const col = _candB[i];
      if (col.max.x < aabbMin.x || col.min.x > aabbMax.x) continue;
      if (col.max.y < aabbMin.y || col.min.y > aabbMax.y) continue;
      if (col.max.z < aabbMin.z || col.min.z > aabbMax.z) continue;
      // separating axes: the box's own local X and Z
      const c = col.c, s = col.s, ddx = col.cx - qcx, ddz = col.cz - qcz;
      const ac = Math.abs(c), as = Math.abs(s);
      if (Math.abs(ddx * c - ddz * s) > qhx * ac + qhz * as + col.hx) continue;
      if (Math.abs(ddx * s + ddz * c) > qhx * as + qhz * ac + col.hz) continue;
      out[m++] = col;
    }
    out.length = m;
    return out;
  }

  function closestPointOnColliders(p, maxDist, opts = EMPTY) {
    const hit = opts.out || _closeHit;
    const tags = opts.tags ?? opts.mask ?? null, skip = opts.skipTags ?? null;
    setRect(p.x - maxDist, p.z - maxDist, p.x + maxDist, p.z + maxDist);
    const n = gather(_candB);
    let best = maxDist, bestCol = null, nx = 0, ny = 0, nz = 0, qx = 0, qy = 0, qz = 0;
    for (let i = 0; i < n; i++) {
      const col = _candB[i];
      if ((tags != null || skip != null) && !passTags(col, tags, skip)) continue;
      const c = col.c, s = col.s, hx = col.hx, hy = col.hy, hz = col.hz;
      const wx = p.x - col.cx, wz = p.z - col.cz;
      const lx = c * wx - s * wz, ly = p.y - col.cy, lz = s * wx + c * wz;
      let cx = clamp(lx, -hx, hx), cy = clamp(ly, -hy, hy), cz = clamp(lz, -hz, hz);
      const ex = lx - cx, ey = ly - cy, ez = lz - cz;
      let d = Math.sqrt(ex * ex + ey * ey + ez * ez), lnx, lny, lnz;
      if (d > 1e-12) { lnx = ex / d; lny = ey / d; lnz = ez / d; } else { // inside: nearest face, negative distance
        const fx = hx - Math.abs(lx), fy = hy - Math.abs(ly), fz = hz - Math.abs(lz);
        lnx = 0; lny = 0; lnz = 0;
        if (fx <= fy && fx <= fz) { lnx = lx >= 0 ? 1 : -1; cx = lnx * hx; d = -fx; }
        else if (fy <= fz) { lny = ly >= 0 ? 1 : -1; cy = lny * hy; d = -fy; }
        else { lnz = lz >= 0 ? 1 : -1; cz = lnz * hz; d = -fz; }
      }
      if (d < best || (d === best && !bestCol)) {
        best = d; bestCol = col;
        nx = c * lnx + s * lnz; ny = lny; nz = -s * lnx + c * lnz;
        qx = col.cx + c * cx + s * cz; qy = col.cy + cy; qz = col.cz - s * cx + c * cz;
      }
    }
    if (!bestCol) return null;
    hit.point.set(qx, qy, qz); hit.normal.set(nx, ny, nz); hit.dist = best;
    hit.collider = bestCol; hit.actor = null; hit.part = null;
    return hit;
  }

  // Top of the stack of boxes over (x, z) that starts with a box topping out at `top` (gaps < 0.03 m bridge).
  function stackTop(x, z, top) {
    F[32] = x; F[33] = z; F[37] = 0;
    for (let iter = 0; iter < 8; iter++) {
      setRect(x, z, x, z);
      const n = gather(_candB);
      let next = top;
      for (let i = 0; i < n; i++) {
        const col = _candB[i];
        if (col.bottom <= top + 0.03 && col.top > next && circleOverlapsRect(col)) next = col.top;
      }
      if (next === top) break;
      top = next;
    }
    return top;
  }

  const _probeO = { x: 0.5, y: 0.5, z: 0.5 }, _probeD = { x: 0.5, y: 0.5, z: 0.5 };
  const _probeOpts = { hitActors: false, tags: null, skipTags: null };
  function probeWall(origin, dir, dist, height, opts = EMPTY) {
    const hit = opts.out || _probeHit;
    let fx = dir.x, fz = dir.z;
    const fl = Math.sqrt(fx * fx + fz * fz);
    if (fl < 1e-9) return null;
    fx /= fl; fz /= fl;
    const rays = Math.max(1, opts.rays ?? 3), spread = opts.spread ?? 0.35;
    _probeO.x = origin.x; _probeO.y = origin.y + height; _probeO.z = origin.z;
    _probeOpts.tags = opts.tags ?? opts.mask ?? null; _probeOpts.skipTags = opts.skipTags ?? null;
    let best = BIG, hits = 0, bc = null, px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < rays; i++) {
      const ang = rays === 1 ? 0 : -spread + (2 * spread * i) / (rays - 1);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      _probeD.x = fx * ca + fz * sa; _probeD.y = 0; _probeD.z = -fx * sa + fz * ca;
      const h = raycastInto(_probeTmp, _probeO, _probeD, dist, _probeOpts, false);
      if (!h) continue;
      hits++;
      if (h.dist < best) {
        best = h.dist; bc = h.collider;
        px = h.point.x; py = h.point.y; pz = h.point.z; nx = h.normal.x; ny = h.normal.y; nz = h.normal.z;
      }
    }
    if (!bc) return null;
    hit.point.set(px, py, pz); hit.normal.set(nx, ny, nz); hit.dist = best;
    hit.collider = bc; hit.actor = null; hit.part = null; hit.hits = hits;
    hit.boxTop = bc.top;
    hit.top = stackTop(px - nx * 0.02, pz - nz * 0.02, bc.top);
    return hit;
  }

  // ------------------------------------------------------------------ character capsule mover
  const groundedState = new WeakMap();
  const _moveRes = { grounded: false, groundY: 0.5, ground: null, hitWall: false, wallNormal: V(), wallCollider: null, hitCeiling: false, stepped: false };

  function moveCapsule(actor, delta, opts = EMPTY) {
    const res = opts.out || _moveRes;
    if (!res.wallNormal) res.wallNormal = V();
    const pos = actor.pos;
    const r = actor.radius ?? 0.35, h = actor.height ?? 1.8;
    const stepH = opts.stepHeight ?? 0.35, snap = opts.snapDown ?? 0.3;
    const rf = opts.footRadius ?? r * 0.5, skin = opts.skin ?? 0.001;
    const skip = opts.skipTags ?? null;
    const x0 = pos.x, y0 = pos.y, z0 = pos.z;
    let px = x0, pz = z0;
    let mx = delta.x, mz = delta.z;
    const dy = delta.y || 0;
    res.hitWall = false; res.wallCollider = null; res.wallNormal.set(0, 0, 0);
    res.hitCeiling = false; res.stepped = false;

    // ---- horizontal: cylinder vs boxes that reach above the step height
    const yLo = y0 + stepH + 1e-6, yHi = y0 + h - 1e-6;
    const pad = r + skin + 0.01;
    setRect(Math.min(px, px + mx) - pad, Math.min(pz, pz + mz) - pad, Math.max(px, px + mx) + pad, Math.max(pz, pz + mz) + pad);
    const n = gather(_candA);
    let nb = 0;
    for (let i = 0; i < n; i++) {
      const col = _candA[i];
      if (col.top > yLo && col.bottom < yHi && (skip == null || !hasAny(col.tags, skip))) _candA[nb++] = col;
    }
    F[37] = r;
    for (let pass = 0; pass < 2; pass++) { // depenetrate (spawned inside, a box moved onto us, float drift)
      for (let i = 0; i < nb; i++) {
        F[32] = px; F[33] = pz;
        if (circleRectPen(_candA[i])) { px += F[0] * (F[13] + skin); pz += F[2] * (F[13] + skin); }
      }
    }
    const omx = mx, omz = mz;
    let pnx = 0, pnz = 0, contacts = 0;
    for (let it = 0; it < 4; it++) {
      const len = Math.sqrt(mx * mx + mz * mz);
      if (len < 1e-9) break;
      const ux = mx / len, uz = mz / len;
      let tBest = len, hitCol = null, hnx = 0, hnz = 0;
      F[32] = px; F[33] = pz; F[34] = ux; F[35] = uz;
      for (let i = 0; i < nb; i++) {
        F[36] = tBest;
        if (sweepCircleRect(_candA[i]) && (F[13] < tBest || !hitCol)) { tBest = F[13]; hitCol = _candA[i]; hnx = F[0]; hnz = F[2]; }
      }
      if (!hitCol) { px += mx; pz += mz; break; }
      px += ux * tBest + hnx * skin; pz += uz * tBest + hnz * skin;
      let rx = mx - ux * tBest, rz = mz - uz * tBest;
      const dn = rx * hnx + rz * hnz;
      if (dn < 0) { rx -= hnx * dn; rz -= hnz * dn; }
      if (contacts === 0) { res.hitWall = true; res.wallCollider = hitCol; res.wallNormal.set(hnx, 0, hnz); }
      else if (rx * pnx + rz * pnz < -1e-9) { rx = 0; rz = 0; } // crease: two walls pinch the motion to zero in 2D
      if (rx * omx + rz * omz <= 0) { rx = 0; rz = 0; }       // never slide backwards against the input
      pnx = hnx; pnz = hnz; contacts++;
      mx = rx; mz = rz;
    }

    // ---- vertical: ground under the footprint, step up, snap down, ceiling
    setRect(px - r, pz - r, px + r, pz + r);
    const m = gather(_candB);
    F[32] = px; F[33] = pz;
    let g = -BIG, gCol = null;
    const stepTop = y0 + stepH + 1e-6;
    F[37] = rf;
    for (let i = 0; i < m; i++) {
      const col = _candB[i];
      if (col.top > stepTop || col.top <= g) continue;
      if (skip != null && hasAny(col.tags, skip)) continue;
      if (circleOverlapsRect(col)) { g = col.top; gCol = col; }
    }
    const wasGrounded = groundedState.has(actor) ? groundedState.get(actor) : true;
    const targetY = y0 + dy;
    let newY = targetY, grounded = false;
    if (gCol) {
      if (dy > 0) { if (g > targetY) newY = g; } // rising: lifted out of a step but still airborne
      else if (g >= targetY - 1e-9) { newY = g; grounded = true; }
      else if (wasGrounded && targetY - g <= snap + 1e-9) { newY = g; grounded = true; }
    }
    F[37] = r - 1e-4;
    if (dy > 0) { // ceiling
      for (let i = 0; i < m; i++) {
        const col = _candB[i];
        if (col.bottom < y0 + h - 1e-6 || col.bottom >= newY + h) continue;
        if (skip != null && hasAny(col.tags, skip)) continue;
        if (circleOverlapsRect(col)) { newY = col.bottom - h; res.hitCeiling = true; }
      }
    }
    if (grounded && newY > y0 + 1e-6) { // stepped up: is there headroom at the new height?
      let blocked = false;
      for (let i = 0; i < m && !blocked; i++) {
        const col = _candB[i];
        if (col.top <= newY + stepH + 1e-6 || col.bottom >= newY + h - 1e-6) continue;
        if (skip != null && hasAny(col.tags, skip)) continue;
        if (circleOverlapsRect(col)) blocked = true;
      }
      if (blocked) {
        px = x0; pz = z0; newY = y0; grounded = wasGrounded;
        const l = Math.sqrt(omx * omx + omz * omz) || 1;
        res.hitWall = true; res.wallNormal.set(-omx / l, 0, -omz / l);
      } else res.stepped = true;
    }
    pos.x = px; pos.y = newY; pos.z = pz;
    groundedState.set(actor, grounded);
    res.grounded = grounded;
    res.groundY = gCol ? g : -Infinity;
    res.ground = gCol;
    return res;
  }

  // ------------------------------------------------------------------ debug wireframes
  function debugMeshes(THREE, scene, { colorFn = null } = EMPTY) {
    const group = new THREE.Group();
    group.name = 'world-debug';
    const staticGeo = new THREE.BufferGeometry();
    const statics = new THREE.LineSegments(staticGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75 }));
    statics.frustumCulled = false;
    const hitGeo = new THREE.BufferGeometry();
    const hitboxes = new THREE.LineSegments(hitGeo, new THREE.LineBasicMaterial({ color: 0xff4d6d }));
    hitboxes.frustumCulled = false;
    group.add(statics, hitboxes);
    if (scene) scene.add(group);
    let builtVersion = -1, hitCap = 0, hitPos = null;
    const SEG = 12, ARC = 6, PER_CAP = (SEG * 2 + 4 + ARC * 4) * 2; // vertices per capsule
    const COS = [], SIN = [];
    for (let i = 0; i <= SEG; i++) { COS.push(Math.cos((i / SEG) * Math.PI * 2)); SIN.push(Math.sin((i / SEG) * Math.PI * 2)); }
    const col3 = new THREE.Color();

    function buildStatics() {
      const pos = new Float32Array(colliders.length * 24 * 3), clr = new Float32Array(colliders.length * 24 * 3);
      let o = 0;
      const E = [0, 1, 1, 3, 3, 2, 2, 0, 4, 5, 5, 7, 7, 6, 6, 4, 0, 4, 1, 5, 2, 6, 3, 7]; // corner bits: 1=x, 2=z, 4=y
      for (const col of colliders) {
        col3.set(colorFn ? colorFn(col) : 0x37d6ff);
        for (const k of E) {
          const lx = (k & 1) ? col.hx : -col.hx, lz = (k & 2) ? col.hz : -col.hz, ly = (k & 4) ? col.hy : -col.hy;
          pos[o] = col.cx + col.c * lx + col.s * lz; pos[o + 1] = col.cy + ly; pos[o + 2] = col.cz - col.s * lx + col.c * lz;
          clr[o] = col3.r; clr[o + 1] = col3.g; clr[o + 2] = col3.b;
          o += 3;
        }
      }
      staticGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      staticGeo.setAttribute('color', new THREE.BufferAttribute(clr, 3));
      builtVersion = version;
    }

    function updateHits() {
      let total = 0;
      for (const e of entries) total += e.count;
      if (total > hitCap) {
        hitCap = Math.max(16, total * 2);
        hitPos = new Float32Array(hitCap * PER_CAP * 3);
        hitGeo.setAttribute('position', new THREE.BufferAttribute(hitPos, 3).setUsage(THREE.DynamicDrawUsage));
      }
      let o = 0;
      const put = (x, y, z) => { hitPos[o++] = x; hitPos[o++] = y; hitPos[o++] = z; };
      for (const e of entries) {
        for (let k = 0; k < e.count; k++) {
          const c = e.caps, b = k * 7;
          const ax = c[b], ay = c[b + 1], az = c[b + 2], bx = c[b + 3], by = c[b + 4], bz = c[b + 5], r = c[b + 6];
          let wx = bx - ax, wy = by - ay, wz = bz - az;
          const L = Math.hypot(wx, wy, wz);
          if (L > 1e-9) { wx /= L; wy /= L; wz /= L; } else { wx = 0; wy = 1; wz = 0; }
          // u = any unit vector perpendicular to w, v = w × u
          let ux = -wz, uy = 0, uz = wx;
          if (Math.abs(wy) > 0.9) { ux = 1; uy = 0; uz = 0; }
          const uw = ux * wx + uy * wy + uz * wz; // Gram-Schmidt against w
          ux -= wx * uw; uy -= wy * uw; uz -= wz * uw;
          const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
          const vx = wy * uz - wz * uy, vy = wz * ux - wx * uz, vz = wx * uy - wy * ux;
          for (const [cx, cy, cz] of [[ax, ay, az], [bx, by, bz]]) {
            for (let i = 0; i < SEG; i++) {
              put(cx + r * (COS[i] * ux + SIN[i] * vx), cy + r * (COS[i] * uy + SIN[i] * vy), cz + r * (COS[i] * uz + SIN[i] * vz));
              put(cx + r * (COS[i + 1] * ux + SIN[i + 1] * vx), cy + r * (COS[i + 1] * uy + SIN[i + 1] * vy), cz + r * (COS[i + 1] * uz + SIN[i + 1] * vz));
            }
          }
          for (const [qx, qy, qz] of [[ux, uy, uz], [-ux, -uy, -uz], [vx, vy, vz], [-vx, -vy, -vz]]) {
            put(ax + r * qx, ay + r * qy, az + r * qz); put(bx + r * qx, by + r * qy, bz + r * qz);
          }
          for (const [cx, cy, cz, sg] of [[ax, ay, az, -1], [bx, by, bz, 1]]) { // half circles over each cap
            for (const [px, py, pz] of [[ux, uy, uz], [vx, vy, vz]]) {
              for (let i = 0; i < ARC; i++) {
                const a0 = (i / ARC) * Math.PI, a1 = ((i + 1) / ARC) * Math.PI;
                put(cx + r * (Math.cos(a0) * px + sg * Math.sin(a0) * wx), cy + r * (Math.cos(a0) * py + sg * Math.sin(a0) * wy), cz + r * (Math.cos(a0) * pz + sg * Math.sin(a0) * wz));
                put(cx + r * (Math.cos(a1) * px + sg * Math.sin(a1) * wx), cy + r * (Math.cos(a1) * py + sg * Math.sin(a1) * wy), cz + r * (Math.cos(a1) * pz + sg * Math.sin(a1) * wz));
              }
            }
          }
        }
      }
      if (hitPos) { hitGeo.attributes.position.needsUpdate = true; hitGeo.setDrawRange(0, o / 3); }
    }

    function update() {
      if (!group.visible) return;
      if (builtVersion !== version) buildStatics();
      updateHits();
    }
    function toggle(v) { group.visible = v === undefined ? !group.visible : !!v; if (group.visible) update(); return group.visible; }
    function dispose() {
      if (group.parent) group.parent.remove(group);
      staticGeo.dispose(); hitGeo.dispose(); statics.material.dispose(); hitboxes.material.dispose();
    }
    update();
    return { group, statics, hitboxes, update, toggle, dispose };
  }

  function stats() {
    let caps = 0;
    for (const e of entries) caps += e.count;
    return { colliders: colliders.length, cells: grid.size, cellSize: cs, actors: entries.length, capsules: caps, version };
  }

  return {
    Vector3, cellSize: cs, colliders, entries,
    addBox, updateBox, removeCollider,
    addHitboxes, removeHitboxes, updateHitboxes,
    raycast, sweepSphere, bounce, moveCapsule,
    overlapSphere, lineOfSight, groundAt,
    queryBoxes, closestPointOnColliders, probeWall,
    debugMeshes, makeHit, stats,
  };
}
