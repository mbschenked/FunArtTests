// Level-authored and level-derived tactical layout (ai-spec §3.1, §4.1; refs/ai-vantage.md):
//   regions        a hard point's zone: a circle {center, radius} or a floor polygon {poly: [[x, z], ...]}, each at a
//                  floor height y. regionContains() is the one membership test (posts, candidates, role anchors).
//   hard points    the level's designer hard points (G 25:31–27:28; fields from G-deck p88: name, zone region, min NPCs,
//                  max NPCs, on/off), plus the auto ones the 'overwatch' spawn hints make where no designer region
//                  already covers the spawn.
//   perch posts    the talk's third post type (G 11:03, 44:19; G-deck p46 "Teal: Perch", p146–147): an elevated post at
//                  an edge above a drop, where the NPC leans out to aim down. Two generated kinds:
//                    rail   a low wall / parapet with a drop behind it: its cover posts become perches (cover-like: hide
//                           behind the rail, pop up over it as before; in perch mode lean over it to aim down)
//                    ledge  an open edge of the walkable surface (a cliff edge, the climb gap): stand and lean out;
//                           only the perch selector uses these
//                  Every perch has perchFire, the lean-out point past the edge (rails keep fire = the pop-up point).
//   designer posts level.posts join the generated pool and are treated equally (C: "designer-placed posts load
//                  separately, join the same pool"). Optional tags [ASSUMED]: hardPoint (only that hard point's
//                  defenders may use it) and roles (only those core roles may use it).
// No 'three' import: posts are plain {x, y, z} objects (see posts.js for the post shape).
import { dist2D } from './tuning.js';

const STATIC_ONLY = Object.freeze({ hitActors: false });

// ------------------------------------------------------------------------------------------------ regions
// Normalises a region in place: computes center (polygon centroid) and radius (bounding circle) so code that only
// knows circles (role assignment distance) keeps working, and the floor height y when the center has one.
export function normalizeRegion(r) {
  if (!r) return null;
  if (r.poly && r.poly.length >= 3) {
    let cx = 0, cz = 0;
    for (const [x, z] of r.poly) { cx += x; cz += z; }
    cx /= r.poly.length; cz /= r.poly.length;
    let rad = 0;
    for (const [x, z] of r.poly) rad = Math.max(rad, Math.hypot(x - cx, z - cz));
    r.center = { x: cx, y: r.y ?? 0, z: cz };
    r.radius = rad;
  } else if (r.center) {
    r.center = { x: r.center.x, y: r.center.y ?? 0, z: r.center.z };
    if (r.radius == null) r.radius = 4;
  } else if (r.x !== undefined) {               // a bare point: the old {x, y, z} hard-point shape
    r.center = { x: r.x, y: r.y ?? 0, z: r.z };
    if (r.radius == null) r.radius = 4;
  }
  if (r.y == null && r.center) r.y = r.center.y;
  if (r.yTol == null) r.yTol = 1.5;             // [ASSUMED] one storey: a balcony region never claims the floor below
  return r;
}

// Is the point inside the region? Same floor (|y − region.y| ≤ yTol), then polygon (even-odd) or circle.
export function regionContains(r, p) {
  if (!r) return false;
  if (r.y != null && p.y != null && Math.abs(p.y - r.y) > r.yTol) return false;
  if (r.poly) {
    let inside = false;
    const P = r.poly;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const xi = P[i][0], zi = P[i][1], xj = P[j][0], zj = P[j][1];
      if ((zi > p.z) !== (zj > p.z) && p.x < (xj - xi) * (p.z - zi) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }
  return dist2D(p, r.center) <= r.radius;
}

// Distance used to pick the closest NPC for a hard point (director role assignment): 0 inside, else to the center,
// plus the height difference so an NPC on the floor below isn't "closest" to a balcony zone. [ASSUMED]
export function regionDist(r, p) {
  if (!r || !r.center) return Infinity;
  if (regionContains(r, p)) return 0;
  return dist2D(p, r.center) + Math.abs((p.y ?? 0) - (r.y ?? 0));
}

// ------------------------------------------------------------------------------------------------ hard points
// Designer hard points from level.hardPoints (kept, normalised) + an auto hard point per 'overwatch' spawn that no
// designer region contains (index.js used to make these only when the level had none; now they sit alongside).
// spawns: [{pos, role}], npcs: the actors created from them (same order). Returns the list the director uses.
export function loadHardPoints(level, spawns, npcs) {
  const out = [];
  for (const h of (level && level.hardPoints) || []) {
    out.push({ id: h.id, name: h.name || h.id, region: normalizeRegion({ ...h.region, poly: h.region.poly && h.region.poly.map((v) => [v[0], v[1]]) }),
      min: h.min ?? 0, max: h.max ?? h.min ?? 1, enabled: h.enabled !== false, designer: true });
  }
  spawns.forEach((sp, i) => {
    const npc = npcs[i];
    if (!npc || sp.role !== 'overwatch') return;
    const p = npc.pos;
    if (out.some((h) => h.designer && h.enabled && regionContains(h.region, p))) return;   // a designer zone covers it
    out.push({ id: 'hp-' + npc.id, name: 'overwatch ' + npc.id, region: normalizeRegion({ center: { x: p.x, y: p.y, z: p.z }, radius: 4 }),
      min: 1, max: 1, enabled: true, designer: false });
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ perch posts
// Rail perches: every low-cover post whose wall has a drop of at least ai.perch.minDrop behind it becomes a perch.
// It keeps the cover post's position, wall normal and pop-up fire point (it is still a place to crouch behind the
// rail and fight as before); perchFire is a lean-out point just past the rail's far face, used in perch mode to aim
// straight down at a player below the edge.
function convertRails(posts, world, P) {
  const minDrop = P('ai.perch.minDrop'), past = P('ai.perch.leanPast'), up = P('ai.perch.railUp');
  let n = 0;
  for (const p of posts) {
    if (p.type !== 'cover' || p.height !== 'low') continue;
    // walk away from the NPC (−normal) from the wall's near face until the ground drops below the wall top
    const fx = p.x - p.nx * P('ai.posts.setback'), fz = p.z - p.nz * P('ai.posts.setback');
    let far = -1, below = null;
    for (let s = 0.05; s <= 2.0; s += 0.05) {
      const g = world.groundAt(fx - p.nx * s, fz - p.nz * s, p.top + 0.05);
      if (g === null || g < p.top - 0.1) { far = s; below = g; break; }
    }
    if (far < 0) continue;
    const g2 = world.groundAt(fx - p.nx * (far + 0.3), fz - p.nz * (far + 0.3), p.top + 0.05);
    const drop = p.y - (g2 === null ? (below ?? -1e9) : Math.min(g2, below ?? g2));
    if (!(drop >= minDrop)) continue;
    p.type = 'perch'; p.rail = true; p.drop = drop;
    p.perchFire = { x: fx - p.nx * (far + past), y: p.top + up, z: fz - p.nz * (far + past) };
    n++;
  }
  return n;
}

// Ledge perches: nav nodes at an open edge (nothing at knee height between the node and the probe point past the
// edge) with a drop of at least minDrop; one per ledgeSpacing metres along the edge.
const DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0], [Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2], [-Math.SQRT1_2, Math.SQRT1_2]];
function addLedges(posts, nav, world, P, V) {
  if (!nav || !nav.nodes) return 0;
  const minDrop = P('ai.perch.minDrop'), probe = P('ai.perch.ledgeProbe'), past = P('ai.perch.leanPast'), eye = P('ai.perch.eye');
  const spacing = P('ai.perch.ledgeSpacing');
  const a = new V(), b = new V();
  const found = [];
  for (const n of nav.nodes) {
    let best = null;
    for (const [dx, dz] of DIRS) {
      const qx = n.x + dx * probe, qz = n.z + dz * probe;
      const g = world.groundAt(qx, qz, n.y + 0.3);
      const drop = g === null ? 99 : n.y - g;
      if (drop < minDrop) continue;
      a.set(n.x, n.y + 0.5, n.z); b.set(qx, n.y + 0.5, qz);
      if (!world.lineOfSight(a, b, STATIC_ONLY)) continue;              // a rail or wall: not an open edge
      a.y = n.y + eye; b.y = n.y + eye;
      if (!world.lineOfSight(a, b, STATIC_ONLY)) continue;
      if (!best || drop > best.drop + 1e-6) best = { dx, dz, drop };
    }
    if (!best) continue;
    // where exactly the floor ends along that direction
    let edge = probe;
    for (let s = 0; s <= probe; s += 0.05) {
      const g = world.groundAt(n.x + best.dx * s, n.z + best.dz * s, n.y + 0.3);
      if (g === null || g < n.y - 0.3) { edge = s; break; }
    }
    found.push({ n, ...best, edge });
  }
  let added = 0;
  const kept = [];
  for (const f of found) {
    if (kept.some((k) => Math.abs(k.n.y - f.n.y) < 0.5 && Math.hypot(k.n.x - f.n.x, k.n.z - f.n.z) < spacing)) continue;
    kept.push(f);
    const n = f.n;
    posts.push({
      id: posts.length, type: 'perch', rail: false, x: n.x, y: n.y, z: n.z, nx: -f.dx, nz: -f.dz, tx: f.dz, tz: -f.dx,
      height: null, top: n.y, coverId: null, lean: 0, canFire: true, drop: f.drop,
      fire: { x: n.x + f.dx * (f.edge + past), y: n.y + eye, z: n.z + f.dz * (f.edge + past) }, node: n.id, claimedBy: null,
    });
    posts[posts.length - 1].perchFire = posts[posts.length - 1].fire;
    added++;
  }
  return added;
}

// Converts rails and adds ledges. Returns {rails, ledges}.
export function addPerchPosts(posts, nav, world, P) {
  if (!P('ai.perch.on') || !world || typeof world.groundAt !== 'function') return { rails: 0, ledges: 0 };
  const rails = P('ai.perch.rails') ? convertRails(posts, world, P) : 0;
  const ledges = addLedges(posts, nav, world, P, world.Vector3 || Object);
  return { rails, ledges };
}

// ------------------------------------------------------------------------------------------------ designer posts
// level.posts: [{id, type: 'open'|'perch', pos: [x, y, z], face: [dx, dz] (the way the NPC looks / leans out),
//   hardPoint?, roles?}]. A designer post replaces generated posts within ai.posts.designerClear m on its floor.
export function addDesignerPosts(posts, level, nav, world, P) {
  const list = (level && level.posts) || [];
  if (!list.length) return 0;
  const clear = P('ai.posts.designerClear');
  let added = 0;
  for (const d of list) {
    const [x, y, z] = d.pos;
    const node = nav && nav.nearest ? nav.nearest({ x, y: y + 0.1, z }) : null;
    if (nav && (!node || Math.hypot(node.x - x, node.z - z) > 0.6 || Math.abs(node.y - y) > 0.5)) {
      console.warn(`[ai] designer post ${d.id} is off the nav (nearest node ${node ? node.id : 'none'}): skipped`);
      continue;
    }
    for (let i = posts.length - 1; i >= 0; i--) {
      const p = posts[i];
      if (!p.designer && Math.abs(p.y - y) < 0.6 && Math.hypot(p.x - x, p.z - z) < clear) posts.splice(i, 1);
    }
    const fl = Math.hypot(d.face[0], d.face[1]) || 1, fx = d.face[0] / fl, fz = d.face[1] / fl;
    const py = node ? node.y : y;
    let fire, drop = 0;
    if (d.type === 'perch') {
      // lean out past the edge in the face direction (the same rule as a generated ledge perch)
      let edge = P('ai.perch.ledgeProbe');
      for (let s = 0; s <= 2; s += 0.05) {
        const g = world.groundAt(x + fx * s, z + fz * s, py + 0.3);
        if (g === null || g < py - 0.3) {
          const g2 = world.groundAt(x + fx * (s + 0.3), z + fz * (s + 0.3), py + 0.3);   // past a hold / lip on the face
          edge = s; drop = py - Math.min(g === null ? -99 : g, g2 === null ? -99 : g2); break;
        }
      }
      fire = { x: x + fx * (edge + P('ai.perch.leanPast')), y: py + P('ai.perch.eye'), z: z + fz * (edge + P('ai.perch.leanPast')) };
    } else fire = { x, y: py + 1.55, z };
    posts.push({
      id: posts.length, type: d.type === 'perch' ? 'perch' : 'open', rail: false, x, y: py, z, nx: -fx, nz: -fz, tx: fz, tz: -fx,
      height: null, top: py, coverId: null, lean: 0, canFire: true, drop, fire, node: node ? node.id : -1, claimedBy: null,
      designer: d.id, hardPoint: d.hardPoint || null, roles: d.roles || null, perchFire: d.type === 'perch' ? fire : null,
    });
    added++;
  }
  return added;
}

// Post ids are indices (debug.js colours posts by id): renumber after the layout passes add / remove posts.
export function renumberPosts(posts) { posts.forEach((p, i) => { p.id = i; }); return posts; }
