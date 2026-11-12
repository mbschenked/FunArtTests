// AI shooting model (ai-spec §5): the U4 time-to-accuracy ramp, the UC2 distance curve, pop-out ramp and target
// movement modifiers, the accuracy floor, burst patterns and the deliberate near-miss point.
// Pure (node-testable, no 'three').
import { curveAt, sat, clamp, randRange, randInt } from './tuning.js';

// Seconds from spotting to full accuracy at distance d (U4 curves, G-deck p145), interpolated and clamped at 5/30 m.
export function timeToAccuracy(d, P) {
  return curveAt(P, P('ai.acc.class') === 'medium' ? 'ai.acc.ttaMedium' : 'ai.acc.ttaLight', d);
}

// 0 → 1 over timeToAccuracy(d) since this NPC spotted the player. Linear from 0 [INFERRED: shape not on the slide].
export function rampSinceSpot(t, d, P) { return sat(t / timeToAccuracy(d, P)); }

// Per-weapon distance curve (UC2 assault rifle, R; pistol [INFERRED]).
export function distAccuracy(kind, d, P) {
  return curveAt(P, kind === 'pistol' ? 'ai.acc.distPistol' : 'ai.acc.distRifle', d);
}

// UC2 "time to accurate cover": 0 when the player pops out, back to 1 over popOutRamp seconds.
export function popOutRamp(tExposed, P) {
  const T = P('ai.acc.popOutRamp');
  return T <= 0 ? 1 : sat(tExposed / T);
}

// UC2 target movement modifiers.
export function moveMod(motion, P) {
  return motion === 'roll' ? P('ai.acc.moveRoll') : motion === 'run' ? P('ai.acc.moveRun') : P('ai.acc.moveStand');
}

// spec §5 hitChance: product of the factors, scaled and offset by class/difficulty, clamped to [floor, 1].
// s: {dist, tSpot (s since spotted), tExposed (s since the player left cover; Infinity if never in cover), motion, kind}
export function hitChance(s, P) {
  const raw = distAccuracy(s.kind, s.dist, P)
    * rampSinceSpot(s.tSpot, s.dist, P)
    * popOutRamp(s.tExposed, P)
    * moveMod(s.motion, P)
    * P('ai.acc.mul')
    + P('ai.acc.add');
  return clamp(raw, P('ai.acc.floor'), 1);
}

// Plan the next burst into `out` = {shots, gap (s between rounds)}. Rifle: 33% single shots, else full auto (R).
export function planBurst(rng, kind, P, out) {
  if (kind === 'pistol') {
    out.shots = randInt(rng, P('ai.burst.pistolMin'), P('ai.burst.pistolMax'));
    out.gap = randRange(rng, P('ai.burst.pistolGapMin'), P('ai.burst.pistolGapMax'));
  } else if (rng() < P('ai.burst.singleChance')) {
    out.shots = randInt(rng, P('ai.burst.singleMin'), P('ai.burst.singleMax'));
    out.gap = randRange(rng, P('ai.burst.singleGapMin'), P('ai.burst.singleGapMax'));
  } else {
    out.shots = randInt(rng, P('ai.burst.autoMin'), P('ai.burst.autoMax'));
    out.gap = 60 / P('ai.burst.autoRpm');
  }
  return out;
}

export function burstPause(rng, kind, P) {
  return kind === 'pistol'
    ? randRange(rng, P('ai.burst.pistolPauseMin'), P('ai.burst.pistolPauseMax'))
    : randRange(rng, P('ai.burst.pauseMin'), P('ai.burst.pauseMax'));
}

// Aim point for one round. hit: a point on the target's body. miss: 0.4–1.2 m off the silhouette, sideways or high,
// so it reads as a near miss; when the target is crouched in cover, the miss goes into the cover top in front.
// from: muzzle-ish origin; tgt: {x,y,z} target feet; bodyH: aim height for a hit; out: written and returned.
export function aimPoint(rng, hit, from, tgt, bodyH, crouched, P, out) {
  const dx = tgt.x - from.x, dz = tgt.z - from.z;
  const h = Math.hypot(dx, dz) || 1;
  const sx = -dz / h, sz = dx / h;                       // sideways unit (perpendicular to the shot, horizontal)
  if (hit) {
    const j = (rng() - 0.5) * 0.2;                        // ±10 cm on the torso
    out.x = tgt.x + sx * j; out.y = tgt.y + bodyH + (rng() - 0.5) * 0.2; out.z = tgt.z + sz * j;
    return out;
  }
  const off = 0.35 + randRange(rng, P('ai.acc.missMin'), P('ai.acc.missMax'));   // silhouette radius + offset
  if (crouched) {                                         // into the cover lip just in front of the target
    const back = 0.7 / h;
    out.x = tgt.x - dx * back + sx * (rng() - 0.5) * 0.8;
    out.y = tgt.y + 0.85 + rng() * 0.2;
    out.z = tgt.z - dz * back + sz * (rng() - 0.5) * 0.8;
    return out;
  }
  const a = (rng() < 0.5 ? -1 : 1) * randRange(rng, 0.2, 1.2);   // sideways or over the shoulder, never into the feet
  const ux = Math.cos(a), uy = Math.abs(Math.sin(a));
  out.x = tgt.x + sx * off * ux * (a < 0 ? -1 : 1);
  out.y = tgt.y + bodyH + off * uy;
  out.z = tgt.z + sz * off * ux * (a < 0 ? -1 : 1);
  return out;
}
