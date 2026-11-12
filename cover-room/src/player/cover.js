// Cover (B1): cover search over level.cover markup and the 'cover' player mode. Spec: refs/player-spec.md §4.
// Library module (no install): controller.js registers the mode.
//
//   findCover(game, actor, intentX, intentZ, {stick, camYaw, exclude, maxRange, out}) -> ctx | null
//       The best cover face within cover.enterRange whose wall the intent points into (angle < cover.enterMaxAngle;
//       relaxed when already against it). ctx = {seg, s, px, pz, dist, swap}. Reused object: copy what you keep.
//   lowCoverDist(game, actor) -> m to the nearest low cover face the actor stands in front of (auto-crouch), or Infinity
//   createCoverMode(game, actor, ctrl) -> mode {enter(from, ctx), update(dt), exit(to)}
//
// Markup (design.md level.cover): [{id, a, b (floor points on the wall face), normal (out of the wall, toward the user),
//   height: 'low'|'high', top, ends: {a: 'corner'|'wall'|'open', b}}]. Faces of one object that share a corner point
//   (outer corner, normals ~90° apart) are linked, so pushing on at a 'corner' end wraps around it.
//
// Sub-states, emitted as 'state' {sys: 'cover', from, to}: enter -> in <-> edge, corner (wrap), popAim (low: stand up
// and aim), lean (high: step out at an edge and aim), blind (fire without aim), duck (forced down to reload) -> none
// (left cover). actor.state.cover mirrors it; actor.exposed is true only in popAim/lean (and out of cover).
// anim.cover: {height, side (+1 = facing/peeking to the character's right), pose ('enter'|'idle'|'move'|'popup'|'lean'|
//   'blind'|'exit'), t (0..1 of the current pose transition), edge, corner, slide}.
const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
const rd = (v, k, i) => (v == null ? 0 : Array.isArray(v) ? +v[i] || 0 : +v[k] || 0);

export function defineCoverParams(P) {
  const d = (k, v, o) => P.define(k, v, o);
  d('cover.enterRange', 2.0, { min: 0.3, max: 6, step: 0.05, label: 'enter range (m)' });            // PS §4 [INFERRED]
  d('cover.enterMaxAngle', 60, { min: 10, max: 120, step: 1, label: 'enter max angle (deg)' });     // PS §4 [INFERRED]
  d('cover.nearRange', 0.6, { min: 0, max: 2, step: 0.05, label: 'any-angle range (m)' });          // [INFERRED] already against the wall
  d('cover.enterSpeed', 6.0, { min: 1, max: 20, step: 0.1, label: 'enter speed (m/s)' });           // PS §4 [INFERRED]
  d('cover.enterMin', 0.20, { min: 0.05, max: 1, step: 0.01, label: 'enter min (s)' });             // PS §4 [INFERRED]
  d('cover.enterMax', 0.45, { min: 0.1, max: 1.5, step: 0.01, label: 'enter max (s)' });            // PS §4 [INFERRED]
  d('cover.wallGap', 0.05, { min: 0, max: 0.3, step: 0.01, label: 'gap to wall (m)' });             // [INFERRED]
  d('cover.edgeInset', 0.3, { min: 0, max: 1, step: 0.01, label: 'stop before open end (m)' });     // [INFERRED] shoulder at the edge
  d('cover.moveSpeed', 1.8, { min: 0.3, max: 5, step: 0.05, label: 'move speed (m/s)' });           // PS §4 [INFERRED]
  d('cover.accel', 12, { min: 1, max: 60, step: 0.5, label: 'move accel (m/s²)' });                 // [INFERRED]
  d('cover.leaveHoldTime', 0.25, { min: 0, max: 1.5, step: 0.01, label: 'push away to leave (s)' }); // PS §4 [INFERRED]
  d('cover.leaveAngle', 50, { min: 10, max: 89, step: 1, label: 'push-away cone (deg)' });          // [INFERRED]
  d('cover.edgeZone', 0.6, { min: 0, max: 2, step: 0.05, label: 'lean zone at an edge (m)' });      // [INFERRED] high cover lean needs an edge
  d('cover.cornerHold', 0.3, { min: 0, max: 1.5, step: 0.01, label: 'push on to wrap/leave (s)' }); // [INFERRED]
  d('cover.cornerTime', 0.35, { min: 0.05, max: 1.5, step: 0.01, label: 'corner wrap (s)' });       // [INFERRED]
  d('cover.lowHeightMax', 1.2, { min: 0.6, max: 2, step: 0.01, label: 'low cover up to (m)' });     // PS §4 cover.lowHeight 0.6–1.2 [INFERRED]
  d('cover.popAim.inTime', 0.14, { min: 0, max: 1, step: 0.01, label: 'pop-up in (s)' });            // PS §4 [MEASURED] F1 0:12.583→0:12.70 (yt-workaround)
  d('cover.popAim.fireReadyT', 0.13, { min: 0, max: 1, step: 0.01, label: 'fire ready after (s)' }); // PS §4 [MEASURED upper bound] (yt-workaround)
  d('cover.popAim.outTime', 0.17, { min: 0, max: 1, step: 0.01, label: 'pop-down (s)' });           // PS §4 [MEASURED] F1 0:13.783→0:13.93 (yt-workaround)
  d('cover.popAim.emptyHold', 0.067, { min: 0, max: 0.5, step: 0.001, label: 'empty hold (s)' });   // PS §4 [MEASURED] 4 frames (yt-workaround); B2 reloadDuck wins
  d('cover.popTurnRate', 1440, { min: 90, max: 4000, step: 10, label: 'pop body turn (deg/s)' });    // [INFERRED] ~180° within the pop
  // The root steps from the stop point to the end of the face; the animator adds its own pelvis lean-out (anim
  // cover.leanOut 0.32 m) on top, so the default extra here is 0. The camera pivot moves with the root and clears the edge.
  d('cover.lean.out', 0.0, { min: -0.3, max: 1.2, step: 0.01, label: 'lean root past the end (m)' }); // [INFERRED]
  d('cover.blindFire.readyT', 0.08, { min: 0, max: 0.5, step: 0.01, label: 'blind raise (s)' });     // [INFERRED]
  d('cover.blindFire.holdT', 0.4, { min: 0, max: 2, step: 0.05, label: 'blind pose hold (s)' });     // [INFERRED]
  d('cover.swap.enabled', true, { label: 'cover-to-cover (stick away + cover)' });                   // [ASSUMED] U4 has no swap button (PS §4)
  d('cover.swap.range', 4.0, { min: 0.5, max: 10, step: 0.1, label: 'swap range (m)' });            // [INFERRED]
  d('cover.swap.speed', 5.0, { min: 1, max: 12, step: 0.1, label: 'swap run speed (m/s)' });        // [INFERRED] ≈ run speed
}

// ------------------------------------------------------------------------------------------------ markup cache
// Prepared face: a/b on the floor, unit tangent t (a->b), normal n (xz, out of the wall), length, low/high, ends,
// linked outer-corner neighbours. Cached per level.cover array.
let cacheSrc = null, cacheList = [];
export function coverSegments(game) {
  const src = game.level && game.level.cover;
  if (!Array.isArray(src)) return cacheList.length ? (cacheList = [], cacheSrc = null, cacheList) : cacheList;
  if (src === cacheSrc) return cacheList;
  const P = game.params;
  const lowMax = P.has('cover.lowHeightMax') ? P.get('cover.lowHeightMax') : 1.2;
  cacheSrc = src; cacheList = [];
  for (const c of src) {
    const ax = rd(c.a, 'x', 0), ay = rd(c.a, 'y', 1), az = rd(c.a, 'z', 2);
    const bx = rd(c.b, 'x', 0), bz = rd(c.b, 'z', 2);
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.05) continue;
    let nx = rd(c.normal, 'x', 0), nz = rd(c.normal, 'z', 2);
    const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
    const tx = (bx - ax) / len, tz = (bz - az) / len;
    const top = Number.isFinite(c.top) ? c.top : ay + (c.height === 'high' ? 2 : 1);
    const low = c.height ? c.height === 'low' : top - ay <= lowMax;
    // In cover the root faces INTO the wall (-n), as the animator expects (root +Z into the wall); the character's
    // right is then (nz, 0, -nx). rightSign: +1 if a->b runs to the character's right.
    const rightSign = tx * nz - tz * nx >= 0 ? 1 : -1;
    cacheList.push({ src: c, id: c.id, ax, ay, az, bx, bz, tx, tz, nx, nz, len, top, low, rightSign,
      endA: (c.ends && c.ends.a) || 'open', endB: (c.ends && c.ends.b) || 'open', adjA: null, adjB: null });
  }
  // links round an end: the level's own links ({id, end}: the adjacent face, or the far face of a thin wall) when it
  // gives them, else an endpoint shared with another face whose normal points the way you'd keep moving (outer corner)
  const byId = new Map(cacheList.map((s) => [s.id, s]));
  for (const s of cacheList) {
    const L = s.src.links;
    for (const end of ['A', 'B']) {
      const ln = L && L[end.toLowerCase()];
      if (ln && byId.has(ln.id)) { s['adj' + end] = { seg: byId.get(ln.id), end: String(ln.end).toUpperCase() === 'A' ? 'A' : 'B' }; continue; }
      if (L) continue;
      const px = end === 'A' ? s.ax : s.bx, pz = end === 'A' ? s.az : s.bz;
      const ux = end === 'A' ? -s.tx : s.tx, uz = end === 'A' ? -s.tz : s.tz;   // outward along s at this end
      for (const o of cacheList) {
        if (o === s || Math.abs(o.ay - s.ay) > 0.3) continue;
        const da = Math.hypot(o.ax - px, o.az - pz), db = Math.hypot(o.bx - px, o.bz - pz);
        if (Math.min(da, db) > 0.2) continue;
        if (o.nx * ux + o.nz * uz < 0.7) continue;                               // not an outer corner
        s['adj' + end] = { seg: o, end: da <= db ? 'A' : 'B' };
      }
    }
  }
  return cacheList;
}

const _ctx = { seg: null, s: 0, px: 0, pz: 0, dist: 0, swap: false };

function sLo(game, seg, actor) { const P = game.params, r = actor.radius; return seg.endA === 'wall' ? r + 0.02 : Math.min(P.get('cover.edgeInset'), seg.len / 2); }
function sHi(game, seg, actor) { const P = game.params, r = actor.radius; return seg.len - (seg.endB === 'wall' ? r + 0.02 : Math.min(P.get('cover.edgeInset'), seg.len / 2)); }

export function findCover(game, actor, ix, iz, opts = {}) {
  const segs = coverSegments(game);
  if (!segs.length) return null;
  const P = game.params;
  const range = opts.maxRange ?? P.get('cover.enterRange');
  const maxAng = P.get('cover.enterMaxAngle') * DEG, near = P.get('cover.nearRange');
  const off = actor.radius + P.get('cover.wallGap');
  const il = Math.hypot(ix, iz) || 1; ix /= il; iz /= il;
  const cx = Math.sin(opts.camYaw ?? actor.yaw), cz = Math.cos(opts.camYaw ?? actor.yaw);
  let best = null, bestScore = Infinity;
  const out = opts.out || _ctx;
  for (const seg of segs) {
    if (seg === opts.exclude) continue;
    if (Math.abs(seg.ay - actor.pos.y) > 0.6) continue;
    const rx = actor.pos.x - seg.ax, rz = actor.pos.z - seg.az;
    const front = rx * seg.nx + rz * seg.nz;                 // distance in front of the wall face
    if (front < -0.05) continue;
    const lo = sLo(game, seg, actor), hi = sHi(game, seg, actor);
    const s = clamp(rx * seg.tx + rz * seg.tz, lo, hi);
    const px = seg.ax + seg.tx * s + seg.nx * off, pz = seg.az + seg.tz * s + seg.nz * off;
    const dist = Math.hypot(px - actor.pos.x, pz - actor.pos.z);
    if (dist > range) continue;
    // intent into the wall: angle between the intent and -n; without a stick the camera direction also counts
    let ang = Math.acos(clamp(-(ix * seg.nx + iz * seg.nz), -1, 1));
    if (!opts.stick) ang = Math.min(ang, Math.acos(clamp(-(cx * seg.nx + cz * seg.nz), -1, 1)));
    const limit = dist <= near ? Math.max(maxAng, 100 * DEG) : maxAng;
    if (ang > limit) continue;
    const score = dist + ang * 0.8;
    if (score < bestScore) { bestScore = score; best = seg; out.s = s; out.px = px; out.pz = pz; out.dist = dist; }
  }
  if (!best) return null;
  out.seg = best; out.swap = !!opts.swap;
  return out;
}

export function lowCoverDist(game, actor) {
  const segs = coverSegments(game);
  let best = Infinity;
  for (const seg of segs) {
    if (!seg.low || Math.abs(seg.ay - actor.pos.y) > 0.4) continue;
    const rx = actor.pos.x - seg.ax, rz = actor.pos.z - seg.az;
    const front = rx * seg.nx + rz * seg.nz - actor.radius;
    if (front < -0.05) continue;
    const along = rx * seg.tx + rz * seg.tz;
    if (along < -0.2 || along > seg.len + 0.2) continue;
    if (front < best) best = Math.max(0, front);
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ the mode
export function createCoverMode(game, actor, ctrl) {
  const P = game.params;
  const pg = (k) => P.get(k);
  const c = {
    seg: null, state: 'none', st: 0, s: 0, v: 0, dirAlong: 1, awayT: 0, pushT: 0, sideEnd: null,
    // enter
    dur: 0, x0: 0, z0: 0, m0x: 0, m0z: 0, m1x: 0, m1z: 0, x1: 0, z1: 0, y0: 0, y1: 0, slide: false,
    // corner wrap: an arc round the pivot (the shared corner, or the middle of a thin wall's end)
    pvx: 0, pvz: 0, ca0: 0, cda: 0, cr0: 0, cr1: 0, cy0: 0, cnext: null, cnextS: 0,
    // aim / lean
    aimT: 0, leanEnd: 0, leanOut: 0, popAmt: 0, blindT: -1e9, emptyT: 0, duckReload: false,
    name: 'cover',
  };

  function setState(to) {
    if (to === c.state) return;
    const from = c.state;
    c.state = to; c.st = 0;
    actor.state.cover = to === 'none' ? null : to;
    ctrl.emit('cover', from, to);
  }

  const off = () => actor.radius + pg('cover.wallGap');
  const faceYaw = (seg) => Math.atan2(-seg.nx, -seg.nz);   // root +Z into the wall (animator contract)
  // the point on the line at arc length s
  const lineX = (seg, s) => seg.ax + seg.tx * s + seg.nx * off();
  const lineZ = (seg, s) => seg.az + seg.tz * s + seg.nz * off();

  function moveTo(x, z) {
    return ctrl.move(x - actor.pos.x, 0, z - actor.pos.z);
  }

  function leanableEnd(seg, s) {
    // -> 'A' | 'B' | null: the nearest end within cover.edgeZone that isn't against a wall
    const zone = pg('cover.edgeZone');
    const lo = sLo(game, seg, actor), hi = sHi(game, seg, actor);
    const dA = s - lo, dB = hi - s;
    const okA = seg.endA !== 'wall' && dA <= zone, okB = seg.endB !== 'wall' && dB <= zone;
    if (okA && okB) return dA <= dB ? 'A' : 'B';
    return okA ? 'A' : okB ? 'B' : null;
  }

  // camera on the open side: an edge on the screen's right puts the camera right of the character (side -1)
  function cameraSideFor(seg, end) {
    const rig = game.cameraRig;
    if (!rig || !end) return;
    const ex = end === 'A' ? seg.ax : seg.bx, ez = end === 'A' ? seg.az : seg.bz;
    const scr = (ex - actor.pos.x) * rig.right.x + (ez - actor.pos.z) * rig.right.z;
    rig.setSide(scr > 0 ? -1 : 1);
  }

  const mode = {
    enter(from, ctx) {
      const seg = ctx.seg;
      c.seg = seg;
      c.s = ctx.s;
      c.x0 = actor.pos.x; c.z0 = actor.pos.z; c.x1 = ctx.px; c.z1 = ctx.pz;
      const dist = Math.max(ctx.dist, 1e-3);
      const sp = Math.hypot(actor.vel.x, actor.vel.z);
      c.slide = sp > pg('player.walk.speed') + 0.3 || !!ctx.swap;
      c.dur = ctx.swap ? Math.max(pg('cover.enterMin'), dist / pg('cover.swap.speed'))
        : clamp(dist / pg('cover.enterSpeed'), pg('cover.enterMin'), pg('cover.enterMax'));
      // Hermite: leave along the current velocity, arrive moving into the wall (the slide-in "thud")
      let m0x = actor.vel.x * c.dur, m0z = actor.vel.z * c.dur;
      const ml = Math.hypot(m0x, m0z), mmax = 1.2 * dist;
      if (ml > mmax) { m0x *= mmax / ml; m0z *= mmax / ml; }
      c.m0x = m0x; c.m0z = m0z;
      const into = Math.min(dist, 0.6) * 0.5;
      c.m1x = -seg.nx * into; c.m1z = -seg.nz * into;
      // root yaw: from the current facing to facing into the wall (shortest way)
      c.y0 = actor.yaw;
      c.y1 = c.y0 + wrapPi(faceYaw(seg) - actor.yaw);
      const tang = actor.vel.x * seg.tx + actor.vel.z * seg.tz;
      c.dirAlong = Math.abs(tang) > 0.2 ? Math.sign(tang) : (c.dirAlong || 1);
      c.v = 0; c.awayT = 0; c.pushT = 0; c.aimT = 0; c.leanOut = c.s; c.popAmt = 0; c.emptyT = 0; c.duckReload = false;
      c.blindT = -1e9; c.sideEnd = null;
      if (ctrl.grenadeAiming) { /* keep the grenade aim: it pops up once in */ }
      c.state = 'none';
      setState('enter');
      actor.cameraProfile = 'cover';
      actor.cameraLow = seg.low;
      actor.exposed = true;
      const a = actor.anim;
      a.mode = 'cover'; a.cover.pose = 'enter'; a.cover.t = 0; a.cover.slide = c.slide; a.cover.height = seg.low ? 'low' : 'high';
    },

    update(dt) {
      const seg = c.seg, inp = game.input, st = ctrl.stick, caps = ctrl.caps, a = actor.anim, w = actor.weapon;
      c.st += dt;
      a.mode = 'cover';
      a.cover.height = seg.low ? 'low' : 'high';
      a.cover.top = seg.top;
      a.cover.edge = false; a.cover.corner = 0;
      a.modeT = null;

      // ---------------------------------------------------------------- entering (input locked until settled)
      if (c.state === 'enter') {
        const u = clamp(c.st / c.dur, 0, 1);
        const u2 = u * u, u3 = u2 * u;
        const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
        const x = h00 * c.x0 + h10 * c.m0x + h01 * c.x1 + h11 * c.m1x;
        const z = h00 * c.z0 + h10 * c.m0z + h01 * c.z1 + h11 * c.m1z;
        const px = actor.pos.x, pz = actor.pos.z;
        moveTo(x, z);
        actor.vel.set((actor.pos.x - px) / dt, 0, (actor.pos.z - pz) / dt);
        actor.yaw = wrapPi(lerp(c.y0, c.y1, smooth(u)));
        a.cover.pose = 'enter'; a.cover.t = u; a.t = u; a.crouch = seg.low ? smooth(u) : 0;
        actor.cameraProfile = 'cover'; actor.cameraLow = seg.low;
        if (u >= 1) {
          if (Math.hypot(actor.pos.x - c.x1, actor.pos.z - c.z1) > 0.25) { ctrl.setMode('ground'); return true; }  // blocked on the way
          moveTo(c.x1, c.z1);
          actor.yaw = wrapPi(c.y1);
          actor.vel.set(0, 0, 0);
          c.s = (actor.pos.x - seg.ax) * seg.tx + (actor.pos.z - seg.az) * seg.tz;
          setState('in');
        }
        caps.allowReload = true;
        return true;
      }

      // ---------------------------------------------------------------- corner wrap
      if (c.state === 'corner') {
        const T = pg('cover.cornerTime');
        const u = clamp(c.st / T, 0, 1), e = smooth(u);
        const px = actor.pos.x, pz = actor.pos.z;
        const ang = c.ca0 + c.cda * e, r = lerp(c.cr0, c.cr1, e);
        actor.pos.x = c.pvx + Math.sin(ang) * r; actor.pos.z = c.pvz + Math.cos(ang) * r;
        actor.vel.set((actor.pos.x - px) / dt, 0, (actor.pos.z - pz) / dt);
        actor.yaw = wrapPi(c.cy0 + c.cda * e);
        a.cover.pose = 'move'; a.cover.corner = u; a.cover.t = u;
        if (u >= 1) {
          c.seg = c.cnext.seg; c.s = c.cnextS;
          moveTo(lineX(c.seg, c.s), lineZ(c.seg, c.s));
          actor.vel.set(0, 0, 0);
          actor.yaw = faceYaw(c.seg);
          actor.cameraLow = c.seg.low;
          setState('in');
        }
        return true;
      }

      // ---------------------------------------------------------------- shared actions
      const aimHeld = inp.down('aim');
      const wantAim = aimHeld || ctrl.grenadeAiming;
      const leanEnd = leanableEnd(seg, c.s);
      const canPop = seg.low || leanEnd !== null;
      if (aimHeld && (ctrl.pressed('swapShoulder') || ctrl.pressed('jump')) && game.cameraRig) game.cameraRig.swapShoulder();

      if (ctrl.pressed('cover')) {
        if (ctrl.grenadeAiming) { if (game.grenades && game.grenades.cancel) game.grenades.cancel(actor); ctrl.grenadeAiming = false; }
        else {
          const away = st.mag > 0.3 && st.dx * seg.nx + st.dz * seg.nz > 0.5;
          if (away) {
            if (pg('cover.swap.enabled')) {
              const n = findCover(game, actor, st.dx, st.dz, { stick: true, exclude: seg, maxRange: pg('cover.swap.range'), swap: true });
              if (n) { ctrl.setMode('cover', n); return false; }
            }
            if (ctrl.roll(st.dx, st.dz)) return false;
          } else { ctrl.setMode('ground'); return false; }
        }
      }
      if (!aimHeld && ctrl.pressed('jump')) {
        if (seg.low) {
          const into = st.mag < 0.3 || -(st.dx * seg.nx + st.dz * seg.nz) > 0.3;
          if (into && ctrl.jumpAction(-seg.nx, -seg.nz, { fromCover: true, noJump: true })) return false;
        } else if (ctrl.jumpAction(-seg.nx, -seg.nz, { fromCover: true, noJump: true })) return false;
      }

      // reload duck (PS §4 / B2 reloadDuck): hold, then drop into cover; pop back up when it's done if aim is held
      const ws = w && w.state;
      let forceDown = false;
      if (ws && ws.reloading && (c.state === 'popAim' || c.state === 'lean' || c.duckReload)) {
        c.emptyT += dt;
        const duck = ws.reloadDuck;
        const hold = duck && duck.active ? duck.hold : pg('cover.popAim.emptyHold');
        if (c.duckReload || c.emptyT >= hold) { forceDown = true; c.duckReload = true; }
      } else { c.duckReload = false; c.emptyT = 0; }

      caps.allowReload = true;
      caps.allowGrenade = canPop;

      // ---------------------------------------------------------------- pop-up aim / lean
      if (wantAim && canPop && !forceDown) {
        const lean = !seg.low;
        if (c.state !== 'popAim' && c.state !== 'lean') {
          c.aimT = 0;
          if (lean) c.leanEnd = leanEnd === 'A' ? -1 : 1;
          setState(lean ? 'lean' : 'popAim');
        }
        c.aimT += dt;
        const inT = pg('cover.popAim.inTime');
        c.popAmt = clamp(c.popAmt + dt / Math.max(inT, 1e-3), 0, 1);
        if (lean) {
          // step out past the edge (along the face, beyond the stop point)
          const sEdge = c.leanEnd < 0 ? sLo(game, seg, actor) : sHi(game, seg, actor);
          c.leanOut = sEdge + c.leanEnd * (pg('cover.edgeInset') + pg('cover.lean.out'));
          const sT = lerp(c.s, c.leanOut, smooth(c.popAmt));
          moveTo(lineX(seg, sT), lineZ(seg, sT));
          cameraSideFor(seg, c.leanEnd < 0 ? 'A' : 'B');
        }
        turnToward(ctrl.camYaw, dt);
        caps.allowFire = aimHeld;
        caps.fireReady = c.aimT >= pg('cover.popAim.fireReadyT');
        caps.fireMode = aimHeld ? 'aim' : 'none';
        actor.exposed = true;
        actor.cameraProfile = ctrl.aimProfile ? ctrl.aimProfile() : 'aim'; actor.cameraLow = false;
        a.cover.pose = lean ? 'lean' : 'popup'; a.cover.t = c.popAmt; a.crouch = 0;
        a.cover.side = lean ? c.leanEnd * seg.rightSign : sideOf(seg);
        actor.vel.set(0, 0, 0);
        return true;
      }

      // leaving pop/lean: back down / back in
      if (c.state === 'popAim' || c.state === 'lean') setState(forceDown ? 'duck' : 'in');
      if (c.popAmt > 0) {
        c.popAmt = clamp(c.popAmt - dt / Math.max(pg('cover.popAim.outTime'), 1e-3), 0, 1);
        if (!seg.low) {
          const sT = lerp(c.s, c.leanOut, smooth(c.popAmt));
          moveTo(lineX(seg, sT), lineZ(seg, sT));
        }
        turnToward(faceYaw(seg), dt);
        a.cover.pose = seg.low ? 'popup' : 'lean'; a.cover.t = c.popAmt;
        actor.exposed = c.popAmt > 0.5;
        actor.cameraProfile = 'cover'; actor.cameraLow = seg.low;
        a.crouch = seg.low ? 1 - c.popAmt : 0;
        if (c.popAmt > 0) return true;
      }
      if (c.state === 'duck' && !c.duckReload) setState('in');
      actor.exposed = false;
      actor.cameraProfile = 'cover'; actor.cameraLow = seg.low;

      // ---------------------------------------------------------------- blind fire (fire without aim)
      if (!aimHeld && !forceDown && inp.pressed('fire') && c.state !== 'blind') setState('blind');
      if (c.state === 'blind' && inp.down('fire')) c.blindT = game.time;
      const blind = c.state === 'blind' && game.time - c.blindT < pg('cover.blindFire.holdT') && !forceDown;
      if (blind) {
        caps.allowFire = true;
        caps.fireReady = c.st >= pg('cover.blindFire.readyT');
        caps.fireMode = 'blind';
        a.cover.pose = 'blind'; a.cover.t = clamp(c.st / Math.max(pg('cover.blindFire.readyT'), 1e-3), 0, 1);
        a.cover.side = sideOf(seg);
        a.crouch = seg.low ? 1 : 0;
        turnToward(faceYaw(seg), dt);
        actor.vel.set(0, 0, 0);
        return true;
      }
      if (c.state === 'blind') setState('in');

      // ---------------------------------------------------------------- move along the wall
      const along = st.x * seg.tx + st.z * seg.tz;
      const awayDot = st.mag > 0.2 ? (st.dx * seg.nx + st.dz * seg.nz) : 0;
      if (st.mag > 0.3 && awayDot > Math.cos(pg('cover.leaveAngle') * DEG)) {
        c.awayT += dt;
        if (c.awayT >= pg('cover.leaveHoldTime')) { ctrl.setMode('ground'); return false; }
      } else c.awayT = 0;
      const pushing = st.mag > 0.2 && Math.abs(along) > 0.25 * st.mag && awayDot <= 0.5;
      const tv = pushing ? clamp(along / 0.7, -1, 1) * pg('cover.moveSpeed') : 0;
      const acc = pg('cover.accel') * dt;
      c.v += clamp(tv - c.v, -acc, acc);
      if (pushing) c.dirAlong = Math.sign(along);
      const lo = sLo(game, seg, actor), hi = sHi(game, seg, actor);
      let sN = c.s + c.v * dt;
      let atEnd = null;
      if (sN <= lo + 1e-4) { sN = lo; if (c.v < 0) c.v = 0; atEnd = 'A'; }
      if (sN >= hi - 1e-4) { sN = hi; if (c.v > 0) c.v = 0; atEnd = 'B'; }
      const px = actor.pos.x, pz = actor.pos.z;
      moveTo(lineX(seg, sN), lineZ(seg, sN));
      actor.vel.set((actor.pos.x - px) / dt, 0, (actor.pos.z - pz) / dt);
      c.s = (actor.pos.x - seg.ax) * seg.tx + (actor.pos.z - seg.az) * seg.tz;
      turnToward(faceYaw(seg), dt);

      // edge: pushing out at an end (peek); keep pushing to wrap an outer corner or step out of cover
      const pushEnd = pushing && atEnd && ((atEnd === 'A' && along < 0) || (atEnd === 'B' && along > 0));
      const endType = atEnd === 'A' ? seg.endA : seg.endB;
      if (pushEnd && endType !== 'wall') {
        if (c.state !== 'edge') { setState('edge'); c.pushT = 0; }
        c.pushT += dt;
        a.cover.edge = true;
        if (c.pushT >= pg('cover.cornerHold')) {
          const adj = atEnd === 'A' ? seg.adjA : seg.adjB;
          if (adj && endType === 'corner') { startCorner(seg, adj); return true; }
          // step out of cover around the open end, walking
          ctrl.setMode('ground', { speed: pg('player.walk.speed') });
          return true;
        }
      } else if (c.state === 'edge') setState('in');

      // camera side follows the nearest open edge (a manual swap holds until the edge changes)
      const le = leanableEnd(seg, c.s);
      if (le !== c.sideEnd) { c.sideEnd = le; cameraSideFor(seg, le); }

      a.cover.pose = Math.abs(c.v) > 0.05 ? 'move' : 'idle';
      a.cover.t = 1;
      a.cover.side = sideOf(seg);
      a.crouch = seg.low ? 1 : 0;
      return true;
    },

    exit(to) {
      if (ctrl.grenadeAiming && to !== 'cover') { if (game.grenades && game.grenades.cancel) game.grenades.cancel(actor); ctrl.grenadeAiming = false; }
      setState('none');
      actor.cameraLow = false;
      actor.exposed = true;
      actor.anim.cover.pose = 'exit';
      c.popAmt = 0;
      c.seg = null;
    },
  };

  function sideOf(seg) { return c.dirAlong * seg.rightSign; }

  function turnToward(yaw, dt) {
    const err = wrapPi(yaw - actor.yaw), r = pg('cover.popTurnRate') * DEG * dt;
    const step = clamp(err, -r, r);
    actor.yaw = wrapPi(actor.yaw + step);
    actor.anim.turnRate = step / dt;
  }

  function startCorner(seg, adj) {
    const o = adj.seg;
    const s1 = adj.end === 'A' ? sLo(game, o, actor) : sHi(game, o, actor);
    const atB = c.s > seg.len / 2;
    const e0x = atB ? seg.bx : seg.ax, e0z = atB ? seg.bz : seg.az;          // this face's end point
    const e1x = adj.end === 'A' ? o.ax : o.bx, e1z = adj.end === 'A' ? o.az : o.bz;
    c.pvx = (e0x + e1x) / 2; c.pvz = (e0z + e1z) / 2;
    const v0x = actor.pos.x - c.pvx, v0z = actor.pos.z - c.pvz;
    const v1x = lineX(o, s1) - c.pvx, v1z = lineZ(o, s1) - c.pvz;
    c.ca0 = Math.atan2(v0x, v0z); c.cr0 = Math.hypot(v0x, v0z); c.cr1 = Math.hypot(v1x, v1z);
    let da = wrapPi(Math.atan2(v1x, v1z) - c.ca0);
    // go round the outside: the mid direction must point away from the cover (normals' bisector, or past the end)
    let ox = seg.nx + o.nx, oz = seg.nz + o.nz;
    if (Math.hypot(ox, oz) < 0.3) { ox = atB ? seg.tx : -seg.tx; oz = atB ? seg.tz : -seg.tz; }
    const mid = c.ca0 + da / 2;
    if (Math.sin(mid) * ox + Math.cos(mid) * oz < 0) da -= Math.sign(da || 1) * 2 * Math.PI;
    c.cda = da;
    c.cy0 = actor.yaw;
    c.cnext = adj; c.cnextS = s1;
    // keep moving the same way round: along the new face, away from the shared corner
    c.dirAlong = adj.end === 'A' ? 1 : -1;
    c.v = 0;
    setState('corner');
  }

  mode.state = () => c.state;
  mode.seg = () => c.seg;
  return mode;
}
