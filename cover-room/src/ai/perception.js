// AI perception (ai-spec §1): the distance-narrowing view cone, one occlusion ray to a single test point on the
// player, the two-phase notice meter (white 0..1, yellow 1..2, orange at 2) and hearing via `noise` events.
// Pure math up top (node-testable, no 'three'); updateVision/onNoise below are the adapters that use game.world.

import { clamp, sat, lerp } from './tuning.js';

const DEG = Math.PI / 180;
const STATIC_ONLY = Object.freeze({ hitActors: false });   // reused ray options (no per-call allocation)

// §1.1 TLOU inverse law: half angle ∝ 1/distance, clamped. Degrees.
export function halfAngleDeg(d, P) {
  return clamp(P('ai.vision.K') / Math.max(d, 1e-3), P('ai.vision.halfMin'), P('ai.vision.halfMax'));
}

export function visionRange(alert, P) {
  return alert === 'combat' ? P('ai.vision.rangeCombat') : P('ai.vision.rangeUnaware');
}

// Is the offset (dx, dy, dz) from the NPC eye inside the cone around forward (fx, fz)? (ignores occlusion)
// downDeg (optional): the downward vertical half angle (a perch NPC leaning out looks down; vantage.js / layout.js).
export function inViewCone(fx, fz, dx, dy, dz, alert, P, downDeg) {
  const h = Math.hypot(dx, dz);
  const d = Math.hypot(h, dy);
  if (d > visionRange(alert, P)) return false;
  if (h < 1e-4) return true;
  const cosH = (fx * dx + fz * dz) / (h * (Math.hypot(fx, fz) || 1));
  const half = Math.min(180, halfAngleDeg(d, P) * (alert === 'combat' ? P('ai.vision.combatConeMul') : 1));
  if (cosH < Math.cos(half * DEG)) return false;
  const v = Math.atan2(dy, h);
  return Math.abs(v) <= (v < 0 && downDeg != null ? downDeg : P('ai.vision.halfV')) * DEG;
}

// §1.2 white-phase fill time: linear in distance (R), slower if never seen (M), faster when searching (C).
export function acquireTime(d, range, alert, everSeen, P) {
  let t = lerp(P('ai.notice.acqNear'), P('ai.notice.acqFar'), sat(d / range)) * P('ai.notice.difficultyMul');
  if (!everSeen) t *= P('ai.notice.neverSeenMul');
  if (alert === 'search') t *= P('ai.notice.searchMul');
  return Math.max(t, 1e-3);
}

// §1.2 yellow → orange fill time.
export function confirmTime(d, range, P) {
  return Math.max(lerp(P('ai.notice.confirmNear'), P('ai.notice.confirmFar'), sat(d / range)), 1e-3);
}

// One step of the notice meter (spec §1.2 pseudocode). Returns the new value in [0, 2].
export function stepMeter(a, seen, d, alert, everSeen, dt, P) {
  const range = visionRange(alert, P);
  if (seen) {
    a += dt / (a < 1 ? acquireTime(d, range, alert, everSeen, P) : confirmTime(d, range, P));
    if (d < P('ai.notice.instantRange')) a = Math.max(a, 2 - P('ai.notice.instantTime') / confirmTime(d, range, P));
  } else {
    a -= dt * P('ai.notice.decay');
  }
  return clamp(a, 0, 2);
}

// The player's crouch, read only through the Actor shape (design.md): cover mode and the cover pose.
export function playerCrouched(player) {
  if (!player) return false;
  if (player.crouched === true) return true;
  if (!player.ctrl || player.ctrl.mode !== 'cover') return false;
  const pose = player.anim && player.anim.cover && player.anim.cover.pose;
  return !(pose === 'popup' || pose === 'lean');
}

// Exposed = not hidden in cover (drives the UC2 pop-out accuracy ramp).
export function playerExposed(player) { return !playerCrouched(player); }

// §1.1 visibility test point height above the feet: chest while stealth, head top once combat started (M p.423).
export function testPointHeight(player, combatStarted, P) {
  const c = playerCrouched(player);
  if (combatStarted) return c ? P('ai.vision.crouchHeadTop') : P('ai.vision.headTop');
  return c ? P('ai.vision.crouchChest') : P('ai.vision.chest');
}

// ------------------------------------------------------------------------------------------------- adapters
// Vision check for one NPC: cone, then one ray to the test point. Writes npc.ai.canSee / seeDist.
// `tmp` is {eye, target, dir} scratch vectors (world.Vector3); no allocation.
// The eye follows the cover pose: the pop-up / lean point while peeking or aiming, crouched while hidden at low cover.
// Perches (layout.js): in perch mode the eye is the lean-out point (a ledge perch always leans; a rail perch while
// popped up), so the NPC can see straight down past the edge.
export function npcEye(npc, P, out) {
  const ai = npc.ai, post = ai && ai.atPost && !ai.moving ? ai.post : null;
  if (post && post.type === 'perch' && ai.perchMode && post.perchFire && ai.alert === 'combat') {
    const ph = ai.coverPhase, f = post.perchFire;
    if (!post.rail || ph === 'aim' || ph === 'peek' || ph === 'blind') return out.set(f.x, f.y, f.z);
  }
  if (post && (post.type === 'cover' || (post.type === 'perch' && post.rail)) && ai.alert === 'combat') {
    const ph = ai.coverPhase;
    if ((ph === 'aim' || ph === 'peek' || ph === 'blind') && post.fire) return out.set(post.fire.x, post.fire.y, post.fire.z);
    if (post.height === 'low') return out.set(npc.pos.x, npc.pos.y + P('ai.vision.crouchEye'), npc.pos.z);
  }
  return out.set(npc.pos.x, npc.pos.y + P('ai.vision.eye'), npc.pos.z);
}

export function updateVision(npc, player, game, P, tmp, combatStarted) {
  const ai = npc.ai;
  ai.canSee = false;
  if (!player || player.alive === false) return false;
  const eye = npcEye(npc, P, tmp.eye);
  const tgt = tmp.target.set(player.pos.x, player.pos.y + testPointHeight(player, combatStarted, P), player.pos.z);
  const dx = tgt.x - eye.x, dy = tgt.y - eye.y, dz = tgt.z - eye.z;
  const d = Math.hypot(dx, dy, dz);
  ai.seeDist = d;
  if (player.ctrl && player.ctrl.mode === 'cover' && d > P('ai.vision.coverRange')) return false;   // [WIKI] 18 m
  const look = ai.lookYaw ?? npc.yaw;                      // the aim direction while popped out, else the body
  const fx = Math.sin(look), fz = Math.cos(look);
  const leaning = ai.perchMode && ai.atPost && !ai.moving && ai.post && ai.post.type === 'perch';
  if (!inViewCone(fx, fz, dx, dy, dz, ai.alert, P, leaning ? P('ai.perch.lookDown') : undefined)) return false;
  tmp.dir.set(dx, dy, dz);
  const hit = game.world.raycast(eye, tmp.dir, d, STATIC_ONLY);
  ai.canSee = !hit;
  return ai.canSee;
}

// §1.3 hearing: the radius scaled per listener, halved when a wall is between. Returns 'none'|'suspicious'|'combat'.
export function hearNoise(npc, ev, game, P, tmp) {
  const ai = npc.ai;
  const dx = ev.pos.x - npc.pos.x, dz = ev.pos.z - npc.pos.z, dy = ev.pos.y - npc.pos.y;
  const d = Math.hypot(dx, dy, dz);
  let r = (ev.radius || 0) * P('ai.hearing.mul') * (ai.alert === 'unaware' ? P('ai.hearing.unawareMul') : 1);
  if (d > r) return 'none';
  const eye = tmp.eye.set(npc.pos.x, npc.pos.y + P('ai.vision.eye'), npc.pos.z);
  if (!game.world.lineOfSight(eye, ev.pos, STATIC_ONLY)) r *= P('ai.hearing.occlusion');
  if (d > r) return 'none';
  const loud = ev.kind === 'gunshot' || ev.kind === 'grenade';
  if (loud && (ai.alert !== 'unaware' || d <= P('ai.hearing.combatRadius'))) return 'combat';
  return 'suspicious';
}
