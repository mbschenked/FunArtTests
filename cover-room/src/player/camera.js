// Third-person camera rig: game.cameraRig. Owner: B1. Spec: refs/player-spec.md §3 (camera), refs/climb-spec.md §5–6.
// Contract (refs/design.md "player/*"): setProfile(name, blendS) · yaw, pitch · aimRay(out), plus kick/shake/wobble.
//
//   createCameraRig(game, {actor}) -> rig      install(game) -> rig (idempotent; controller.js installs it too)
//   rig.yaw, rig.pitch            the look direction (rad). +yaw turns left (three.js rotation.y), +pitch looks up.
//                                 The look ray passes through the RETICLE point (screen x 0.5, y = param hud.reticle.y,
//                                 0.42 from the top, read live; camera.reticleY without a HUD), not the screen centre: the optical axis is pitched down by
//                                 atan((1 - 2·reticleY)·tan(vfov/2)) so the reticle ray is exactly (yaw, pitch).
//   rig.side                      +1 = character right of screen centre (F1's default, measured), -1 = swapped.
//   rig.profile                   'explore' | 'combat' | 'aim' | 'cover' | 'climb' | 'hangAim'
//   setProfile(name, blendS)      switch now with this blend time. The rig otherwise follows actor.cameraProfile
//                                 (every player mode sets it each step) and only re-syncs when that value changes.
//   aimRay(out)                   out.origin / out.dir (or out.direction): the ray from the camera through the reticle,
//                                 with recoil kick, shake and damage wobble applied. The origin is moved forward along
//                                 the ray to the character's depth (out.startDist = how far), so geometry between the
//                                 camera and the character never eats a shot; out.camOrigin (if present) gets the
//                                 camera position. Returns out.
//   kick(pitchDeg, recoverS, yawDeg=0, peakS=recoverS/2)   recoil: rises to pitchDeg at peakS, back to 0 at recoverS.
//   shake(strength)               trauma-style shake (0..1 adds up, decays). 'camshake' {pos, strength} events feed it
//                                 with distance falloff.
//   wobble(ampDeg, decayS)        damage wobble [DEV G]: a decaying pitch/yaw noise, also in aimRay.
//   swapShoulder() / setSide(±1)  shoulder swap (blended over camera.shoulderSwapTime).
//   snap()                        jump to the current targets (spawn, restart).
//   lookScale                     multiplier on look input this step (grenade aim uses grenade.aimLookScale).
//   position, forward, fov, screenY, blend (0..1 of the current profile blend), collideFrac  (read-only state)
//
// Systems: 'camera.look' (order 9: look input -> yaw/pitch, before the controller reads them, so camera-relative
// movement uses this step's look) and 'camera' (order 70: profile blend, follow, collision, shake -> the THREE camera).
// Optional actor fields the rig reads: cameraProfile, cameraLow (crouched cover pivot), cameraPivot (Vector3 world
// pivot override, e.g. hand midpoint while climbing), cameraYawHint (yaw to ease toward after no look input, climbing).
// Every transition emits 'state' {sys: 'camera', from, to} and, once the blend completes, {sys: 'cameraBlend',
// from: 'blending', to: profile}, so __measure can time aim-in / aim-out against the spec.
import * as THREE from 'three';
import { ORDER } from '../core/game.js';

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
// Ease-out cubic: moves at once on the switch step (aim-in must not feel late), settles without overshoot.
const easeOut = (x) => { x = clamp(x, 0, 1); const k = 1 - x; return 1 - k * k * k; };

export const PROFILES = ['explore', 'combat', 'aim', 'grenade', 'cover', 'climb', 'hangAim'];
const FIELDS = ['vfov', 'distance', 'shoulderX', 'pivotHeight', 'followTau'];
// param keys per profile, built once (no string building per step)
const KEYS = Object.fromEntries(PROFILES.map((n) => [n, Object.fromEntries(FIELDS.map((f) => [f, `camera.${n}.${f}`]))]));

// Per-profile targets. shoulderX sign: positive puts the character RIGHT of the screen centre (camera shifted to the
// character's left), which is what F1 measures for cover (x 0.55–0.60) and aim (head x ≈ 0.82).
function defineParams(P) {
  const d = (k, v, o) => P.define(k, v, o);
  const deg = { min: 20, max: 90, step: 0.5 };
  const dist = { min: 0.3, max: 9, step: 0.05 };
  const sx = { min: -1.5, max: 1.5, step: 0.01 };
  const ph = { min: 0.3, max: 2.5, step: 0.01 };
  const tau = { min: 0, max: 0.6, step: 0.005 };
  // explore: player-spec §3
  d('camera.explore.vfov', 50, { ...deg, label: 'vfov' });                 // §3 [INFERRED] PC has no FOV slider (P8)
  // §3 solved 4.5 m for frac 0.43 with a centred projection; §3 says tune the distance to the framing, and with the
  // reticle offset and the -12° pitch 4.5 m gives 0.377 (tests/player.html), so 4.0 m -> ≈0.42.
  d('camera.explore.distance', 4.0, { ...dist, label: 'distance' });       // §3 [MEASURED framing (yt-workaround), INFERRED fov] char 0.38–0.50 of screen h
  d('camera.explore.shoulderX', 0.15, { ...sx, label: 'shoulder x' });     // §3 [MEASURED framing] char x 0.46–0.50 (within follow-lag noise) (yt-workaround)
  d('camera.explore.pivotHeight', 1.55, { ...ph, label: 'pivot height' }); // §3 [INFERRED from framing]
  d('camera.explore.followTau', 0.12, { ...tau, label: 'follow lag (s)' }); // §3 camera.follow.tau [INFERRED]
  // combat: §3 lists the mode without numbers -> [INFERRED]: a little closer and more over the shoulder than explore
  d('camera.combat.vfov', 50, { ...deg, label: 'vfov' });                  // [INFERRED]
  d('camera.combat.distance', 3.8, { ...dist, label: 'distance' });        // [INFERRED]
  d('camera.combat.shoulderX', 0.35, { ...sx, label: 'shoulder x' });      // [INFERRED]
  d('camera.combat.pivotHeight', 1.5, { ...ph, label: 'pivot height' });   // [INFERRED]
  d('camera.combat.followTau', 0.1, { ...tau, label: 'follow lag (s)' });  // [INFERRED]
  d('camera.combat.holdT', 6, { min: 0, max: 30, step: 0.5, label: 'combat hold after shot/hit (s)' }); // [INFERRED]
  // aim: §3 (F1 0:12.95)
  d('camera.aim.vfov', 37, { ...deg, label: 'vfov' });                     // §3 [MEASURED ratio 1.35, low] (yt-workaround)
  d('camera.aim.distance', 1.1, { ...dist, label: 'distance' });           // §3 [MEASURED framing, INFERRED] (yt-workaround)
  // §3's table says 0.55, but at distance 1.1 / vfov 37 / 16:9 that puts the pivot at x 0.92; with the animator's poses
  // 0.47 puts the head at x ≈ 0.80 (cover pop-up) / 0.84 (standing aim) around the measured 0.82 (F1 0:12.95).
  // [MEASURED framing (yt-workaround), re-solved in tests/player.html]
  d('camera.aim.shoulderX', 0.47, { ...sx, label: 'shoulder x' });
  d('camera.aim.pivotHeight', 1.55, { ...ph, label: 'pivot height' });     // [INFERRED] shoulder/neck of a standing 1.8 m char
  d('camera.aim.followTau', 0.03, { ...tau, label: 'follow lag (s)' });    // [INFERRED] tight: the reticle must not swim
  d('camera.aim.inTime', 0.14, { min: 0, max: 1, step: 0.01, label: 'blend in (s)' });            // §3 [MEASURED] F1 0:12.583→0:12.70 (yt-workaround)
  d('camera.aim.outTimeCover', 0.17, { min: 0, max: 1, step: 0.01, label: 'blend out to cover (s)' }); // §3 [MEASURED] F1 0:13.783→0:13.93 (yt-workaround)
  d('camera.aim.outTime', 0.25, { min: 0, max: 1, step: 0.01, label: 'blend out to explore (s)' });  // §3 [MEASURED, MP] F4 (yt-workaround)
  // grenade hold: §3/§6 say the gun-aim view [MEASURED F4, MP], but our animator's throwAim pose raises the throw hand (yt-workaround)
  // into that close lens, so the hold gets its own wider framing [ASSUMED]; set these to the aim values to match F4.
  d('camera.grenade.vfov', 42, { ...deg, label: 'vfov' });                 // [ASSUMED]
  d('camera.grenade.distance', 2.1, { ...dist, label: 'distance' });       // [ASSUMED] hand out of the lens
  d('camera.grenade.shoulderX', 0.6, { ...sx, label: 'shoulder x' });      // [ASSUMED]
  d('camera.grenade.pivotHeight', 1.6, { ...ph, label: 'pivot height' });  // [ASSUMED]
  d('camera.grenade.followTau', 0.05, { ...tau, label: 'follow lag (s)' }); // [INFERRED]
  // cover: §3 (F1 0:08.0, 0:12.40)
  d('camera.cover.vfov', 50, { ...deg, label: 'vfov' });                   // [INFERRED] same as explore
  d('camera.cover.distance', 5.0, { ...dist, label: 'distance' });         // §3 [MEASURED framing, INFERRED fov] crouched 0.22 of screen h (yt-workaround)
  d('camera.cover.shoulderX', 0.5, { ...sx, label: 'shoulder x' });        // §3 [MEASURED framing] char x 0.55–0.60 (yt-workaround)
  d('camera.cover.pivotHeight', 1.45, { ...ph, label: 'pivot height (high)' }); // [INFERRED]
  d('camera.cover.pivotHeightLow', 1.1, { ...ph, label: 'pivot height (low)' }); // [INFERRED] "further back and lower, shows over the cover"
  d('camera.cover.followTau', 0.12, { ...tau, label: 'follow lag (s)' });  // [INFERRED]
  // climb: climb-spec §6
  d('camera.climb.vfov', 50, { ...deg, label: 'vfov' });                   // climb-spec §6 [MEASURED rough] 50–60 (yt-workaround)
  d('camera.climb.distance', 5.0, { ...dist, label: 'distance' });         // climb-spec §6 [MEASURED rough] 4–7 m (yt-workaround)
  d('camera.climb.shoulderX', 0.0, { ...sx, label: 'shoulder x' });        // [INFERRED] wall centred
  d('camera.climb.pivotHeight', 1.3, { ...ph, label: 'pivot height' });    // [INFERRED] mid body while hanging
  d('camera.climb.followTau', 0.15, { ...tau, label: 'follow lag (s)' });  // [INFERRED]
  d('camera.climb.inTime', 0.5, { min: 0, max: 2, step: 0.05, label: 'blend in (s)' });  // climb-spec §6 [INFERRED]
  // With B3's actor.climbCam the pivot is the hands' midpoint (climb-spec §6), moved out along the wall normal so the
  // spring arm starts in free space (never inside the wall at mid-wall holds), and up for hang-aim (over the lip).
  d('camera.climb.pivotOut', 0.45, { min: 0, max: 1.5, step: 0.01, label: 'pivot out from wall (m)' });   // [INFERRED] > collideRadius
  d('camera.climb.pivotUp', -0.2, { min: -2, max: 1, step: 0.01, label: 'pivot above hands (m)' });      // [INFERRED] climb-spec §6 hands midpoint
  d('camera.climb.outTime', 0.4, { min: 0, max: 2, step: 0.05, label: 'blend out (s)' }); // climb-spec §6 [INFERRED]
  // hangAim: climb-spec §5 (≈0.45 right, ≈0.2 above the head, ≈1.0 back)
  d('camera.hangAim.vfov', 37, { ...deg, label: 'vfov' });                 // [INFERRED] = aim
  d('camera.hangAim.distance', 1.0, { ...dist, label: 'distance' });       // climb-spec §5 [MEASURED rough] (yt-workaround)
  d('camera.hangAim.shoulderX', 0.45, { ...sx, label: 'shoulder x' });     // climb-spec §5 [MEASURED rough] (yt-workaround)
  d('camera.hangAim.pivotHeight', 1.75, { ...ph, label: 'pivot height' }); // climb-spec §5 head + 0.2 [MEASURED rough] (yt-workaround)
  d('camera.hangAim.followTau', 0.03, { ...tau, label: 'follow lag (s)' }); // [INFERRED]
  d('camera.hangAim.pivotUp', 0.5, { min: -1, max: 1.5, step: 0.01, label: 'pivot above hands (m)' }); // climb-spec §5 head+0.2, chest at the lip [MEASURED rough (yt-workaround)]
  d('camera.hangAim.inTime', 0.2, { min: 0, max: 1, step: 0.01, label: 'blend in (s)' });   // climb-spec §5 [MEASURED (yt-workaround)]
  d('camera.hangAim.outTime', 0.3, { min: 0, max: 1, step: 0.01, label: 'blend out (s)' }); // climb-spec §5 [MEASURED] (yt-workaround)
  // shared
  // The reticle point is the HUD's param (hud.reticle.y, read live); this one is only the fallback without a HUD.
  if (!P.has('hud.reticle.y')) d('camera.reticleY', 0.42, { min: 0.3, max: 0.6, step: 0.005, label: 'reticle y (no HUD)' }); // §3 [MEASURED] F1 (640,300)/720p (yt-workaround)
  d('camera.blendDefault', 0.35, { min: 0, max: 2, step: 0.01, label: 'other blends (s)' });            // [INFERRED]
  d('camera.settleTau', 0.15, { min: 0, max: 1, step: 0.01, label: 'retarget lag (s)' });                // [INFERRED] param edits / crouch
  d('camera.follow.tauY', 0.16, { ...tau, label: 'vertical follow lag (s)' });                        // [INFERRED] steps/jumps
  d('camera.pitchDefault', -12, { min: -60, max: 30, step: 0.5, label: 'start pitch (deg)' });         // §3 [MEASURED framing, low] (yt-workaround)
  d('camera.pitchMin', -60, { min: -89, max: 0, step: 1, label: 'pitch min (deg)' });                  // §3 [INFERRED]
  d('camera.pitchMax', 70, { min: 0, max: 89, step: 1, label: 'pitch max (deg)' });                    // §3 [INFERRED]
  d('camera.shoulderSwapTime', 0.2, { min: 0, max: 1, step: 0.01, label: 'shoulder swap (s)' });       // [INFERRED]
  d('camera.collideRadius', 0.25, { min: 0.05, max: 0.6, step: 0.01, label: 'collide radius' });      // §3 [INFERRED]
  d('camera.collideReturnTau', 0.25, { min: 0, max: 1, step: 0.01, label: 'collide return (s)' });     // §3 [INFERRED]
  d('camera.damageWobble.amp', 0.6, { min: 0, max: 5, step: 0.05, label: 'damage wobble (deg)' });    // §3 [DEV G exists, INFERRED amp]
  d('camera.damageWobble.decay', 0.25, { min: 0.02, max: 2, step: 0.01, label: 'wobble decay (s)' }); // §3 [INFERRED]
  d('camera.damageWobble.freq', 7, { min: 1, max: 30, step: 0.5, label: 'wobble freq (Hz)' });        // [INFERRED]
  d('camera.shake.maxDeg', 2.5, { min: 0, max: 10, step: 0.1, label: 'shake max (deg)' });            // [INFERRED]
  d('camera.shake.decay', 1.6, { min: 0.1, max: 10, step: 0.1, label: 'shake decay (/s)' });          // [INFERRED]
  d('camera.shake.freq', 16, { min: 1, max: 40, step: 0.5, label: 'shake freq (Hz)' });               // [INFERRED]
  d('camera.shake.falloffDist', 8, { min: 1, max: 40, step: 0.5, label: 'camshake falloff (m)' });    // [INFERRED]
  d('camera.autoOrient.delay', 1.0, { min: 0, max: 5, step: 0.1, label: 'auto-orient delay (s)' });   // climb-spec §6 [INFERRED]
  d('camera.autoOrient.rate', 60, { min: 0, max: 360, step: 5, label: 'auto-orient rate (deg/s)' });  // climb-spec §6 [INFERRED]
  d('camera.autoOrient.tolerance', 25, { min: 0, max: 90, step: 1, label: 'auto-orient stops within (deg)' }); // climb-spec §6 ±25° [INFERRED]
  // Entering a climb while looking away from the wall (drop to hang from a top edge): swing round to face the wall
  // over the climb blend-in, so the camera isn't left inside the rampart looking out. [INFERRED]
  d('camera.climb.swingAbove', 100, { min: 30, max: 180, step: 1, label: 'swing to wall if off by (deg)' }); // [INFERRED]
}

// Smooth, allocation-free pseudo-noise in [-1, 1] (sum of incommensurate sines).
function noise(t, seed) {
  return 0.55 * Math.sin(t * 6.2832 + seed) + 0.3 * Math.sin(t * 13.37 + seed * 1.7) + 0.15 * Math.sin(t * 29.11 + seed * 2.3);
}

export function createCameraRig(game, { actor = null } = {}) {
  const P = game.params;
  defineParams(P);
  const pg = (k) => P.get(k);

  const cur = { vfov: 50, distance: 4.5, shoulderX: 0.15, pivotHeight: 1.55, followTau: 0.12 };
  const from = { ...cur };
  const tgt = { ...cur };
  const pivot = new THREE.Vector3();      // smoothed pivot
  const rawPivot = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const position = new THREE.Vector3();
  const forward = new THREE.Vector3(0, 0, 1);
  const right = new THREE.Vector3(-1, 0, 0);
  const tmp = new THREE.Vector3();
  const sweepOpts = { ignore: null, hitActors: false };
  const stateEvt = { actor: null, sys: 'camera', from: '', to: '', t: 0 };
  const kicks = [];                        // fixed pool: {t, dur, peak, pitch, yaw}
  for (let i = 0; i < 4; i++) kicks.push({ t: 0, dur: 0, peak: 0, pitch: 0, yaw: 0, on: false });

  const rig = {
    name: 'camera', order: ORDER.camera,
    actor,
    yaw: 0, pitch: pg('camera.pitchDefault') * DEG,
    side: 1, sideBlend: 1,
    profile: 'explore', blend: 1, blendS: 0, blendT: 0, settled: true,
    lookScale: 1,
    position, forward, right, pivot,
    fov: 50, screenY: 0.42, collideFrac: 1,
    // live offsets (rad)
    kickPitch: 0, kickYaw: 0, shakePitch: 0, shakeYaw: 0, trauma: 0, wobbleAmp: 0, wobbleTau: 0.25,
    lastLookT: 0, _lastActorProfile: null, _snapped: false,
    swing: { on: false, t: 0, dur: 0.5, err: 0, done: 0 },

    setProfile(name, blendS) {
      if (!PROFILES.includes(name)) { console.warn(`[camera] unknown profile '${name}'`); return; }
      if (name === rig.profile) return;
      Object.assign(from, cur);
      const prev = rig.profile;
      rig.profile = name;
      rig.blendS = Math.max(0, blendS ?? pg('camera.blendDefault'));
      rig.blendT = 0;
      rig.blend = rig.blendS > 0 ? 0 : 1;
      rig.settled = false;
      stateEvt.actor = rig.actor; stateEvt.sys = 'camera'; stateEvt.from = prev; stateEvt.to = name; stateEvt.t = game.time;
      game.events.emit('state', stateEvt);
      if (rig.blend >= 1) settle();
    },

    swapShoulder() { rig.side = -rig.side; },
    setSide(s) { rig.side = s < 0 ? -1 : 1; },

    // Also accepts B2's object form: kick({pitch (rad), yaw (rad), peakT, recoverT}).
    kick(pitchDeg, recoverS = 0.1, yawDeg = 0, peakS) {
      let pr, yr;
      if (pitchDeg && typeof pitchDeg === 'object') {
        const o = pitchDeg;
        pr = +o.pitch || 0; yr = +o.yaw || 0; recoverS = o.recoverT ?? 0.1; peakS = o.peakT;
      } else { pr = (+pitchDeg || 0) * DEG; yr = (+yawDeg || 0) * DEG; }
      let k = kicks[0];
      for (const c of kicks) { if (!c.on) { k = c; break; } if (c.t / c.dur > k.t / k.dur) k = c; }
      k.on = true; k.t = 0; k.dur = Math.max(0.01, recoverS); k.peak = clamp(peakS ?? recoverS * 0.5, 0.001, k.dur * 0.95);
      k.pitch = pr; k.yaw = yr;
    },
    shake(strength) { rig.trauma = clamp(rig.trauma + Math.max(0, strength), 0, 1); },
    wobble(ampDeg, decayS) {
      rig.wobbleAmp = Math.max(rig.wobbleAmp, (ampDeg ?? pg('camera.damageWobble.amp')) * DEG);
      rig.wobbleTau = Math.max(0.01, decayS ?? pg('camera.damageWobble.decay'));
    },

    // Final look angles (rig + recoil + shake + wobble).
    lookYaw() { return rig.yaw + rig.kickYaw + rig.shakeYaw; },
    lookPitch() { return rig.pitch + rig.kickPitch + rig.shakePitch; },

    aimRay(out) {
      const y = rig.lookYaw(), p = rig.lookPitch();
      const cp = Math.cos(p);
      const dir = out.dir || out.direction || (out.dir = new THREE.Vector3());
      dir.set(Math.sin(y) * cp, Math.sin(p), Math.cos(y) * cp);
      // Start at the character's depth along the ray (never behind the shooter).
      tmp.subVectors(pivot, position);
      const adv = Math.max(0, tmp.dot(dir) - 0.15);
      const o = out.origin || (out.origin = new THREE.Vector3());
      o.copy(position).addScaledVector(dir, adv);
      if (out.camOrigin) out.camOrigin.copy(position);
      out.startDist = adv;
      return out;
    },

    snap() {
      const a = rig.actor;
      if (a && a.cameraProfile && PROFILES.includes(a.cameraProfile)) rig.profile = a.cameraProfile;
      rig._lastActorProfile = a ? a.cameraProfile ?? null : null;
      targets(tgt);
      Object.assign(cur, tgt); Object.assign(from, tgt);
      rig.blend = 1; rig.settled = true;
      rig.sideBlend = rig.side;
      rig.collideFrac = 1;
      if (a) { pivotTarget(rawPivot); pivot.copy(rawPivot); }
      rig._snapped = true;
      place(0);
    },

    // 'camera.look' system (order 9): this step's look input.
    look(dt) {
      const inp = game.input;
      if (!inp) return;
      const ld = inp.lookDelta();
      const k = rig.lookScale;
      if (ld.yaw !== 0 || ld.pitch !== 0) rig.lastLookT = game.time;
      rig.yaw = wrapPi(rig.yaw + ld.yaw * k);
      rig.pitch = clamp(rig.pitch + ld.pitch * k, pg('camera.pitchMin') * DEG, pg('camera.pitchMax') * DEG);
      // hang-aim arcs (B3's actor.hangAimLimits: centerYaw, yaw half-range, pitchMin/Max, rad): the aim stays over the lip
      const hl = rig.actor && rig.actor.hangAim && rig.actor.hangAimLimits;
      if (hl) {
        rig.yaw = wrapPi(hl.centerYaw + clamp(wrapPi(rig.yaw - hl.centerYaw), -hl.yaw, hl.yaw));
        rig.pitch = clamp(rig.pitch, hl.pitchMin, hl.pitchMax);
      }
      // swing to the wall on a climb entry (eased; look input still adds on top)
      const sw = rig.swing;
      if (sw.on) {
        sw.t = Math.min(sw.dur, sw.t + dt);
        const e = easeOut(sw.t / sw.dur) * sw.err;
        rig.yaw = wrapPi(rig.yaw + e - sw.done); sw.done = e;
        if (sw.t >= sw.dur) sw.on = false;
      }
      // Climb auto-orient (climb-spec §6): after a while with no look input, ease toward facing the wall (or
      // actor.cameraYawHint) until within the tolerance.
      const a = rig.actor;
      const hint = a ? (a.cameraYawHint ?? wallYaw(a)) : null;
      if (hint != null && !sw.on && game.time - rig.lastLookT > pg('camera.autoOrient.delay')) {
        const err = wrapPi(hint - rig.yaw), tol = pg('camera.autoOrient.tolerance') * DEG;
        if (Math.abs(err) > tol) {
          const step = pg('camera.autoOrient.rate') * DEG * dt, want = err - Math.sign(err) * tol;
          rig.yaw = wrapPi(rig.yaw + clamp(want, -step, step));
        }
      }
    },

    update(dt) {
      const a = rig.actor || game.player;
      if (!a) return;
      rig.actor = a;
      if (!rig._snapped) rig.snap();
      // follow actor.cameraProfile changes
      const want = a.cameraProfile || 'explore';
      if (want !== rig._lastActorProfile) {
        rig._lastActorProfile = want;
        if (want !== rig.profile && PROFILES.includes(want)) {
          const from = rig.profile;
          rig.setProfile(want, blendFor(from, want));
          const wy = want === 'climb' && from !== 'hangAim' ? wallYaw(a) : null;
          if (wy != null) {
            const err = wrapPi(wy - rig.yaw);
            if (Math.abs(err) > pg('camera.climb.swingAbove') * DEG) {
              const sw = rig.swing; sw.on = true; sw.t = 0; sw.done = 0; sw.err = err; sw.dur = Math.max(0.05, pg('camera.climb.inTime'));
            }
          }
        }
      }
      // blend
      targets(tgt);
      if (rig.blend < 1) {
        rig.blendT += dt;
        rig.blend = rig.blendS > 0 ? clamp(rig.blendT / rig.blendS, 0, 1) : 1;
        const e = easeOut(rig.blend);
        for (const f of FIELDS) cur[f] = from[f] + (tgt[f] - from[f]) * e;
        if (rig.blend >= 1) settle();
      } else {
        const st = pg('camera.settleTau');
        const k = st > 0 ? 1 - Math.exp(-dt / st) : 1;
        for (const f of FIELDS) cur[f] += (tgt[f] - cur[f]) * k;
      }
      // shoulder side
      const sw = pg('camera.shoulderSwapTime');
      const sstep = sw > 0 ? (2 * dt) / sw : 2;
      rig.sideBlend += clamp(rig.side - rig.sideBlend, -sstep, sstep);
      // pivot follow (xz and y lag separately)
      pivotTarget(rawPivot);
      // aiming profiles use their own tight lag on y too, so the reticle doesn't drift on a step-up
      const aimLike = rig.profile === 'aim' || rig.profile === 'grenade' || rig.profile === 'hangAim';
      const tx = cur.followTau, ty = aimLike ? cur.followTau : pg('camera.follow.tauY');
      const kx = tx > 0 ? 1 - Math.exp(-dt / tx) : 1;
      const ky = ty > 0 ? 1 - Math.exp(-dt / ty) : 1;
      pivot.x += (rawPivot.x - pivot.x) * kx;
      pivot.z += (rawPivot.z - pivot.z) * kx;
      pivot.y += (rawPivot.y - pivot.y) * ky;
      // recoil kicks
      rig.kickPitch = 0; rig.kickYaw = 0;
      for (const k of kicks) {
        if (!k.on) continue;
        k.t += dt;
        if (k.t >= k.dur) { k.on = false; continue; }
        const w = k.t < k.peak ? Math.sin((k.t / k.peak) * Math.PI * 0.5) : 0.5 + 0.5 * Math.cos(((k.t - k.peak) / (k.dur - k.peak)) * Math.PI);
        rig.kickPitch += k.pitch * w; rig.kickYaw += k.yaw * w;
      }
      // shake + wobble
      const t = game.time;
      rig.trauma = Math.max(0, rig.trauma - pg('camera.shake.decay') * dt);
      const tr = rig.trauma * rig.trauma * pg('camera.shake.maxDeg') * DEG;
      const f = pg('camera.shake.freq');
      rig.wobbleAmp *= Math.exp(-dt / rig.wobbleTau);
      if (rig.wobbleAmp < 1e-5) rig.wobbleAmp = 0;
      const wf = pg('camera.damageWobble.freq');
      rig.shakePitch = tr * noise(t * f, 1.3) + rig.wobbleAmp * noise(t * wf, 4.1);
      rig.shakeYaw = tr * noise(t * f, 7.9) + rig.wobbleAmp * noise(t * wf, 2.6);
      place(dt);
    },
  };

  // yaw that faces the wall while climbing (B3's actor.climbCam.normal points out of the wall), else null
  function wallYaw(a) {
    if (!a || !(rig.profile === 'climb' || rig.profile === 'hangAim')) return null;
    const n = a.climbCam && a.climbCam.normal;
    if (!n || Math.hypot(n.x, n.z) < 1e-3) return null;
    return Math.atan2(-n.x, -n.z);
  }

  function blendFor(a, b) {
    if (b === 'aim' || b === 'grenade') return pg('camera.aim.inTime');
    if (a === 'aim' || a === 'grenade') return b === 'cover' ? pg('camera.aim.outTimeCover') : pg('camera.aim.outTime');
    if (b === 'hangAim') return pg('camera.hangAim.inTime');
    if (a === 'hangAim') return pg('camera.hangAim.outTime');
    if (b === 'climb') return pg('camera.climb.inTime');
    if (a === 'climb') return pg('camera.climb.outTime');
    return pg('camera.blendDefault');
  }

  function settle() {
    rig.settled = true;
    stateEvt.actor = rig.actor; stateEvt.sys = 'cameraBlend'; stateEvt.from = 'blending'; stateEvt.to = rig.profile; stateEvt.t = game.time;
    game.events.emit('state', stateEvt);
  }

  function targets(out) {
    const n = rig.profile, k = KEYS[n];
    out.vfov = pg(k.vfov);
    out.distance = pg(k.distance);
    out.shoulderX = pg(k.shoulderX);
    out.pivotHeight = n === 'cover' && rig.actor && rig.actor.cameraLow ? pg('camera.cover.pivotHeightLow') : pg(k.pivotHeight);
    out.followTau = pg(k.followTau);
  }

  function pivotTarget(out) {
    const a = rig.actor;
    const climbing = rig.profile === 'climb' || rig.profile === 'hangAim';
    const cc = a.climbCam;
    if (climbing && cc && cc.target && (cc.target.x || cc.target.y || cc.target.z)) {
      const n = cc.normal, nl = n ? Math.hypot(n.x, n.z) : 0, out_ = pg('camera.climb.pivotOut');
      out.copy(cc.target);
      if (nl > 1e-3) { out.x += (n.x / nl) * out_; out.z += (n.z / nl) * out_; }
      out.y += rig.profile === 'hangAim' ? pg('camera.hangAim.pivotUp') : pg('camera.climb.pivotUp');
    } else if (climbing && a.cameraPivot) out.copy(a.cameraPivot);
    else out.set(a.pos.x, a.pos.y + cur.pivotHeight, a.pos.z);
  }

  // Camera transform from pivot, angles, current profile values; spring-arm collision.
  function place(dt) {
    const y = rig.lookYaw(), p = rig.lookPitch();
    const cp = Math.cos(p);
    forward.set(Math.sin(y) * cp, Math.sin(p), Math.cos(y) * cp);
    right.set(-Math.cos(y), 0, Math.sin(y));
    // camera = pivot - forward·distance - right·(shoulderX·side): +shoulderX moves the camera to the character's left,
    // so the character sits right of centre.
    const lat = cur.shoulderX * rig.sideBlend;
    desired.copy(pivot).addScaledVector(forward, -cur.distance).addScaledVector(right, -lat);
    // spring arm: sweep a sphere from the pivot to the desired point; pull in at once, ease back out
    let frac = 1;
    const w = game.world;
    if (w && w.sweepSphere) {
      sweepOpts.ignore = rig.actor;
      const hit = w.sweepSphere(pivot, desired, pg('camera.collideRadius'), sweepOpts);
      if (hit) frac = clamp(hit.t, 0, 1);
    }
    if (frac < rig.collideFrac || dt === 0) rig.collideFrac = frac;
    else {
      const rt = pg('camera.collideReturnTau');
      rig.collideFrac += (frac - rig.collideFrac) * (rt > 0 ? 1 - Math.exp(-dt / rt) : 1);
    }
    position.copy(pivot).lerp(desired, rig.collideFrac);
    // reticle offset: optical axis pitched down so the look ray passes through screen y = reticleY
    rig.screenY = P.has('hud.reticle.y') ? pg('hud.reticle.y') : P.has('camera.reticleY') ? pg('camera.reticleY') : 0.42;
    rig.fov = cur.vfov;
    const delta = Math.atan((1 - 2 * rig.screenY) * Math.tan(cur.vfov * DEG * 0.5));
    const cam = game.camera;
    if (cam) {
      cam.position.copy(position);
      cam.rotation.set(p - delta, y + Math.PI, 0, 'YXZ');
      if (Math.abs(cam.fov - cur.vfov) > 1e-4) { cam.fov = cur.vfov; cam.updateProjectionMatrix(); }
      cam.updateMatrixWorld();
    }
  }

  // 'camshake' {pos, strength} (vfx explosions): distance falloff from the camera.
  game.events.on('camshake', (e) => {
    if (!e) return;
    let s = +e.strength || 0;
    if (e.pos) {
      const dd = Math.hypot(e.pos.x - position.x, e.pos.y - position.y, e.pos.z - position.z) / pg('camera.shake.falloffDist');
      s /= 1 + dd * dd;
    }
    rig.shake(s);
  });

  return rig;
}

// Adds the rig and its two systems; sets game.cameraRig. Safe to call twice (main.js loads this module after
// controller.js, which already installed it).
export function install(game) {
  if (game.cameraRig) return game.cameraRig;
  const rig = createCameraRig(game, { actor: game.player || null });
  game.cameraRig = rig;
  if (rig.actor) rig.yaw = rig.actor.yaw;
  game.addSystem({ name: 'camera.look', order: ORDER.player - 1, update: (dt) => rig.look(dt) });
  game.addSystem(rig);
  return rig;
}
