// Stealth takedowns (U4-style melee on an enemy that has not spotted you): rear takedown, ledge pull-down, cover
// pull-over. Spec: refs/stealth-spec.md. Contract: refs/design.md (install(game), params, events, no wall clock).
//
//   install(game) -> game.stealth
//   game.stealth.candidate          {kind, victim} the takedown on offer this step (the cue shows), or null
//   game.stealth.records            running takedowns (one per victim; the player is busy only for the attacker part)
//   game.stealth.find()             -> candidate | null (also what the prompt shows)
//   game.stealth.start(kind, victim) -> record | null   (what the melee press calls; tests may call it too)
//
// Flow. A 'stealth' system (before the player) picks the best candidate each step. The cue is U4's: no icon, the
// player's free arm lifts toward the victim (player.anim.reach, posed by the animator; hanging: a look up only);
// stealth.prompt.icon 1 also shows "[F] Takedown" over his head (game.hud.prompt). Melee (F / Square, input 'melee')
// starts it: the player enters the controller mode 'takedown' (registered here; the ledge pull keeps anim.mode
// 'climb') which owns his pos / yaw / anim until the move ends, then hands back to 'ground',
// 'cover' (re-entered on the same wall) or 'climb' (re-caught on the same edge). The victim's brain is suspended
// (npc.alive = false, ai.takenDown = record, ai.bodySeen = true so nobody "finds" him mid-move); a 'stealth.victims'
// system right after the AI owns his pos / yaw / anim. At the kill beat brain.die({dir, source: null}) runs (the HUD
// kill marker is for shots; the attacker is in the 'takedown' event). The victim's last pose IS the death pose at the
// matching death clock, so the hand-back to the brain's death anim is seamless.
//
// Events: 'takedown' {kind, attacker, victim, phase: 'start'|'grab'|'kill'|'impact'|'end', duration} (measure.js
// records them); 'state' {sys: 'stealth'} for the player's phases, {sys: 'stealth.victim'} for the victim's,
// {sys: 'stealth.witness'} for an NPC that saw it; 'noise' {kind: 'bodyfall', radius stealth.noise.bodyFall} when the
// body hits the floor (non-loud: hearers investigate, ai-spec §1.3). AI reactions use the existing director: a witness
// (another NPC not in combat that sees the attacker or the victim between the press and the kill / landing) calls
// director.enterCombat; a body found later goes through brain.lookForBodies -> director.bodyFound (search), unchanged.
import * as THREE from 'three';
import { ORDER } from '../core/game.js';
import { inViewCone, npcEye } from '../ai/perception.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrapPi = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const lerpAngle = (a, b, t) => a + wrapPi(b - a) * t;
const bump = (a, b, x) => (x <= a || x >= b ? 0 : Math.sin(Math.PI * (x - a) / (b - a)));
const ON_WALL = new Set(['hang', 'lean', 'lookBack', 'shimmy', 'corner']);
const STATIC_ONLY = Object.freeze({ hitActors: false });
const PELVIS_H = 1.02;            // character/skeleton.js REST pelvis height (1.8 m figure)
const DEATH_LYING = 0.76;         // share of anim.death.duration at which the death pose lies on the floor (T 0.95)
const EPS = 1e-6;                 // sim-time comparisons (the step clock accumulates float error)

// Every number is a param. Sources: refs/stealth-spec.md section; no timing or distance is published for U4's
// takedowns (spec §0), so they are [INFERRED] from human-motion norms and how the moves read, unless tagged otherwise.
const PARAMS = [
  ['stealth.enabled', 1, 0, 1, 1, 'takedowns on'],                                          // [ASSUMED]
  // rear takedown (spec §1)
  ['stealth.rear.range', 1.6, 0.5, 3, 0.05, 'rear: reach (m)'],                             // [INFERRED]
  ['stealth.rear.cone', 75, 20, 135, 1, 'rear: behind within ± (deg)'],                     // [INFERRED]
  ['stealth.rear.maxDy', 0.5, 0, 1.5, 0.05, 'rear: height difference (m)'],                 // [INFERRED]
  ['stealth.rear.gap', 0.52, 0.3, 0.9, 0.01, 'rear: attacker behind victim (m)'],           // [INFERRED] chest to back
  ['stealth.rear.snap', 0.2, 0.05, 0.6, 0.01, 'rear: close in (s)'],                        // [INFERRED]
  ['stealth.rear.kill', 1.3, 0.3, 3, 0.05, 'rear: neck snap at (s)'],                       // [INFERRED]
  ['stealth.rear.duration', 2.0, 0.8, 4, 0.05, 'rear: player busy (s)'],                    // [INFERRED]
  // ledge pull-down (spec §2)
  ['stealth.ledge.back', 0.8, 0.1, 2.5, 0.05, 'ledge: victim behind the lip (m)'],          // [INFERRED] arm reach over the lip
  ['stealth.ledge.lateral', 1.0, 0.2, 2.5, 0.05, 'ledge: victim along the lip (m)'],        // [INFERRED]
  ['stealth.ledge.dyMin', -0.25, -1, 0, 0.05, 'ledge: victim feet vs lip, min (m)'],        // [INFERRED]
  ['stealth.ledge.dyMax', 0.4, 0, 1.5, 0.05, 'ledge: victim feet vs lip, max (m)'],         // [INFERRED]
  ['stealth.ledge.grab', 0.35, 0.1, 1, 0.01, 'ledge: hand on the ankle at (s)'],            // [INFERRED]
  // stealth-measured.md §4 [MEASURED] V1: grab -> victim over the edge 1.1-1.3 s, Drake settled back on the ledge
  // 1.6-1.8 s after the grab. Off the lip at grab + 0.95 puts him past the edge at grab + ~1.15; busy = grab + 1.7.
  ['stealth.ledge.release', 1.3, 0.2, 2.5, 0.01, 'ledge: victim off the lip at (s)'],       // [MEASURED] V1 (grab + 0.95)
  ['stealth.ledge.yank', 0.4, 0.1, 1, 0.01, 'ledge: final pull before release (s)'],        // [INFERRED] struggle, then the pull
  ['stealth.ledge.duration', 2.05, 0.4, 3.5, 0.05, 'ledge: player busy (s)'],               // [MEASURED] V1 (grab + 1.7)
  ['stealth.ledge.rise', 0.25, 0, 0.6, 0.01, 'ledge: pull-up for the reach (m)'],           // [INFERRED] hang-aim rise
  ['stealth.ledge.throw', 1.8, 0, 5, 0.1, 'ledge: out from the wall (m/s)'],                // [INFERRED]
  ['stealth.ledge.side', 0.7, 0, 3, 0.1, 'ledge: sideways, past the player (m/s)'],         // [INFERRED]
  ['stealth.ledge.up', 0.6, 0, 3, 0.1, 'ledge: upward at release (m/s)'],                   // [INFERRED]
  // cover pull-over (spec §3)
  ['stealth.cover.minBehind', 0.3, 0, 1, 0.05, 'cover: victim behind the face, min (m)'],   // [INFERRED]
  ['stealth.cover.maxBehind', 1.6, 0.6, 3, 0.05, 'cover: victim behind the face, max (m)'], // [INFERRED] 0.55 wall + reach
  ['stealth.cover.lateral', 0.9, 0.2, 2, 0.05, 'cover: victim along the wall (m)'],         // [INFERRED]
  ['stealth.cover.grab', 0.3, 0.1, 1, 0.01, 'cover: hands on the collar at (s)'],           // [INFERRED]
  ['stealth.cover.over', 0.95, 0.4, 2, 0.01, 'cover: victim lands at (s)'],                 // [INFERRED]
  ['stealth.cover.kill', 1.35, 0.5, 3, 0.01, 'cover: strike at (s)'],                       // [INFERRED]
  ['stealth.cover.duration', 1.95, 0.8, 4, 0.05, 'cover: player busy (s)'],                 // [INFERRED]
  ['stealth.cover.land', 0.85, 0.4, 1.5, 0.01, 'cover: body lands out from the wall (m)'],  // [INFERRED]
  ['stealth.cover.kneelOff', 0.55, 0.3, 1, 0.01, 'cover: kneel beside the body (m)'],       // [INFERRED]
  // shared
  ['stealth.gravity', 9.81, 1, 30, 0.1, 'body fall gravity (m/s²)'],                        // physics
  ['stealth.noise.bodyFall', 4, 0, 20, 0.5, 'body fall noise (m)'],                         // ai-spec §1.3 table [INFERRED]
  ['stealth.noise.struggle', 0, 0, 20, 0.5, 'struggle noise (m, 0 = silent)'],              // [ASSUMED] silent
  ['stealth.witness.time', 0.15, 0, 1, 0.01, 'witness: sight needed (s)'],                  // [ASSUMED]
  // The cue: U4 shows no button icon; Drake's free arm lifts toward the enemy when a takedown is available
  // (stealth-measured.md §4 [WIKI], none seen in V1 [MEASURED]). The [F] / [□] text is a test aid, off by default.
  ['stealth.prompt.icon', 0, 0, 1, 1, 'show the [F] takedown text'],                        // [MEASURED] none in U4
  ['stealth.prompt.height', 2.05, 1, 3, 0.05, 'prompt text above the victim (m)'],          // [ASSUMED]
  ['stealth.reach.time', 0.2, 0.05, 1, 0.01, 'reach cue: arm up / down (s)'],               // [ASSUMED]
  ['stealth.reach.dist', 0.45, 0.2, 0.6, 0.01, 'reach cue: hand out from the shoulder (m)'], // [ASSUMED]
];
export function defineStealthParams(P) {
  for (const [k, v, min, max, step, label] of PARAMS) P.define(k, v, { min, max, step, label });
}

export function install(game) {
  const P = game.params;
  defineStealthParams(P);
  const pg = (k) => P.get(k);
  const pf = pg;                                             // the AI's param-function shape (perception.js helpers)
  const V = () => new THREE.Vector3();
  const tmpA = V(), tmpB = V(), tmpC = V(), tmpD = V(), tmpE = V();
  const promptAt = V();

  const S = {
    candidate: null, records: [], cur: null, promptShown: false, _mode: null, _phase: 'none',
    find, start,
  };
  game.stealth = S;

  const player = () => game.player;
  const director = () => game.ai || null;
  const enemies = () => game.enemies || (game.ai && game.ai.npcs) || [];
  const deathDur = () => (P.has && P.has('anim.death.duration') ? pg('anim.death.duration') : 1.25);
  const deathSlide = () => (P.has && P.has('anim.death.slide') ? pg('anim.death.slide') : 0.45);

  function victimOk(npc) {
    if (!npc || !npc.alive || !npc.ai || npc.ai.takenDown || !npc.ai.brain) return false;
    return npc.ai.alert !== 'combat';                         // spec §0: orange blocks a stealth takedown [INFERRED]
  }
  const fwdOf = (yaw, out) => out.set(Math.sin(yaw), 0, Math.cos(yaw));

  // ---------------------------------------------------------------------------------------------------- candidates
  const cand = { kind: null, victim: null, score: 0 };
  function find() {
    const pl = player();
    if (!pl || !pl.ctrl || !pl.alive || !pg('stealth.enabled')) return null;
    if (game.params.has('ai.enabled') && !pg('ai.enabled')) return null;
    const ctrl = pl.ctrl;
    if (ctrl.grenadeAiming) return null;
    let best = null, bestD = Infinity;
    const mode = ctrl.mode;
    for (const npc of enemies()) {
      if (!victimOk(npc)) continue;
      let d = Infinity, kind = null;
      if (mode === 'ground') { d = rearCheck(pl, npc); kind = 'rear'; }
      else if (mode === 'climb') { d = ledgeCheck(pl, npc); kind = 'ledge'; }
      else if (mode === 'cover') { d = coverCheck(pl, npc); kind = 'cover'; }
      if (d < bestD) { bestD = d; best = npc; cand.kind = kind; }
    }
    if (!best) return null;
    cand.victim = best; cand.score = bestD;
    return cand;
  }

  // Rear: on the ground, close behind an NPC that is not in combat, nothing solid between. -> distance or Infinity.
  function rearCheck(pl, npc) {
    const dx = pl.pos.x - npc.pos.x, dz = pl.pos.z - npc.pos.z, d = Math.hypot(dx, dz);
    if (d > pg('stealth.rear.range') || d < 1e-3) return Infinity;
    if (Math.abs(pl.pos.y - npc.pos.y) > pg('stealth.rear.maxDy')) return Infinity;
    const fx = Math.sin(npc.yaw), fz = Math.cos(npc.yaw);
    const behind = -(fx * dx + fz * dz) / d;                 // cos of the angle between (player - npc) and the npc's back
    if (behind < Math.cos(pg('stealth.rear.cone') * DEG)) return Infinity;
    // nothing solid between, at chest and at knee height (a planter rim or low wall blocks the step in)
    for (const h of [1.2, 0.35]) {
      tmpA.set(pl.pos.x, pl.pos.y + h, pl.pos.z); tmpB.set(npc.pos.x, npc.pos.y + h, npc.pos.z);
      if (game.world && !game.world.lineOfSight(tmpA, tmpB, STATIC_ONLY)) return Infinity;
    }
    return d;
  }

  // Ledge: hanging on a wall edge (not reaching / climbing up), the NPC's feet at the lip height, just behind it.
  function ledgeCheck(pl, npc) {
    const cm = pl.ctrl.modes.climb && pl.ctrl.modes.climb.climb;
    if (!cm || !cm.edge || !ON_WALL.has(cm.sub)) return Infinity;
    const data = cm.data, edge = cm.edge;
    const dy = npc.pos.y - edge.y;
    if (dy < pg('stealth.ledge.dyMin') || dy > pg('stealth.ledge.dyMax')) return Infinity;
    const E = data.pointAt(edge, cm.s, tmpA), n = data.normalAt(edge, cm.s, 0, tmpB);
    const rx = npc.pos.x - E.x, rz = npc.pos.z - E.z;
    const back = -(rx * n.x + rz * n.z);                     // behind the lip (on top of it)
    const lat = Math.abs(rx * -n.z + rz * n.x);
    if (back < -0.1 || back > pg('stealth.ledge.back') || lat > pg('stealth.ledge.lateral')) return Infinity;
    return Math.hypot(back, lat);
  }

  // Cover: settled at low cover, the NPC just beyond the same wall, within arm's reach of the player along it.
  function coverCheck(pl, npc) {
    const cmode = pl.ctrl.modes.cover;
    if (!cmode || !cmode.seg || !cmode.state) return Infinity;
    const st = cmode.state(), seg = cmode.seg();
    if (!seg || !seg.low || !(st === 'in' || st === 'edge')) return Infinity;
    if (Math.abs(npc.pos.y - seg.ay) > 0.4) return Infinity;
    const rx = npc.pos.x - seg.ax, rz = npc.pos.z - seg.az;
    const behind = -(rx * seg.nx + rz * seg.nz);
    if (behind < pg('stealth.cover.minBehind') || behind > pg('stealth.cover.maxBehind')) return Infinity;
    const along = rx * seg.tx + rz * seg.tz;
    const pAlong = (pl.pos.x - seg.ax) * seg.tx + (pl.pos.z - seg.az) * seg.tz;
    if (along < -0.2 || along > seg.len + 0.2 || Math.abs(along - pAlong) > pg('stealth.cover.lateral')) return Infinity;
    // reach over the top: a clear line from above the wall to the NPC's chest
    tmpA.set(pl.pos.x - seg.nx * 0.2, seg.top + 0.3, pl.pos.z - seg.nz * 0.2);
    tmpB.set(npc.pos.x, npc.pos.y + 1.2, npc.pos.z);
    if (game.world && !game.world.lineOfSight(tmpA, tmpB, STATIC_ONLY)) return Infinity;
    return Math.hypot(behind, along - pAlong);
  }

  // ------------------------------------------------------------------------------------------------------- start
  function start(kind, victim) {
    const pl = player();
    if (!pl || !pl.ctrl || !victimOk(victim) || S.cur) return null;
    const ctrl = pl.ctrl;
    ensureMode();
    const now = game.time;
    const td = {
      kind, attacker: pl, victim, t0: now, t: 0, T: null, from: ctrl.mode,
      killed: false, grabbed: false, landed: false, attackerDone: false, victimDone: false, impactAt: -1, impactPos: V(),
      a0: pl.pos.clone(), ay0: pl.yaw, v0: victim.pos.clone(), vy0: victim.yaw, vyaw: victim.yaw, dir: 1,
      seen: new Map(), witnessed: [], next: null, phaseA: 'none', phaseV: 'idle',
      animA: { kind, role: 'attacker', t: 0, T: null, dir: 1, grabW: V(), strikeW: V(), gap: 0 },
      animV: { kind, role: 'victim', t: 0, T: null, dir: 1, pitch: 0, pelvisW: null, air: 0, land: 0, deathT: 0 },
      // geometry
      n: V(), tan: V(), p1: V(), p2: V(), p3: V(), fp: V(), fv: V(), fth: 0, spin: 0, landRoot: V(), landPelvis: V(),
      side: 1, top: 0, floorY: victim.pos.y, edge: null, s: 0, seg: null, coverCtx: null,
    };
    if (kind === 'rear') setupRear(td); else if (kind === 'ledge') setupLedge(td); else setupCover(td);
    td.animA.T = td.animV.T = td.T;
    td.animA.dir = td.animV.dir = td.dir;
    // suspend the victim's brain: the dead path only writes his anim, which the victims system overrides
    const ai = victim.ai;
    victim.alive = false;
    ai.takenDown = td; ai.bodySeen = true;
    if (victim.vel) victim.vel.set(0, 0, 0);
    S.cur = td;
    S.records.push(td);
    ctrl.setMode('takedown', td);
    emitTakedown(td, 'start', td.T.end);
    setVictimPhase(td, 'held');
    const ns = pg('stealth.noise.struggle');
    if (ns > 0) game.events.emit('noise', { pos: victim.pos.clone(), radius: ns, kind: 'struggle', source: pl });
    return td;
  }

  function setupRear(td) {
    const T = { snap: pg('stealth.rear.snap'), grab: pg('stealth.rear.snap'), kill: pg('stealth.rear.kill'), end: pg('stealth.rear.duration') };
    T.kill = Math.max(T.kill, T.grab + 0.1); T.end = Math.max(T.end, T.kill + 0.3);
    td.T = T;
    td.dir = 1;                                                // crumples forward, away from the attacker
    const v = td.victim, gap = pg('stealth.rear.gap');
    td.animA.gap = gap;
    fwdOf(v.yaw, td.n);
    td.p1.set(v.pos.x - td.n.x * gap, td.a0.y, v.pos.z - td.n.z * gap);   // where the attacker stands to grab
    td.impactAt = T.kill + DEATH_LYING * deathDur();
  }

  function setupLedge(td) {
    const pl = td.attacker, v = td.victim, cm = pl.ctrl.modes.climb.climb, data = cm.data;
    const T = { grab: pg('stealth.ledge.grab'), release: pg('stealth.ledge.release'), end: pg('stealth.ledge.duration'), kill: Infinity };
    T.release = Math.max(T.release, T.grab + 0.1); T.end = Math.max(T.end, T.release + 0.2);
    td.T = T;
    td.edge = cm.edge; td.s = cm.s;
    data.normalAt(cm.edge, cm.s, 0, td.n); td.n.y = 0; td.n.normalize();          // out of the wall
    td.tan.set(-td.n.z, 0, td.n.x);
    const sV = data.closestS(cm.edge, v.pos.x, v.pos.y, v.pos.z, true);
    data.pointAt(cm.edge, sV, td.p1);                                            // the lip under the victim
    td.p1.addScaledVector(td.n, 0.1); td.p1.y = cm.edge.y;                        // feet just past it at release
    const f = fwdOf(v.yaw, tmpA);
    const facing = f.x * td.n.x + f.z * td.n.z >= 0;                              // facing out over the edge
    td.dir = facing ? 1 : -1;                                                     // forward over it, or back over it
    td.vyaw = Math.atan2(facing ? td.n.x : -td.n.x, facing ? td.n.z : -td.n.z);
    td.side = (v.pos.x - pl.pos.x) * td.tan.x + (v.pos.z - pl.pos.z) * td.tan.z >= 0 ? 1 : -1;
  }

  function setupCover(td) {
    const pl = td.attacker, v = td.victim, cmode = pl.ctrl.modes.cover, seg = cmode.seg();
    const T = { grab: pg('stealth.cover.grab'), over: pg('stealth.cover.over'), kill: pg('stealth.cover.kill'), end: pg('stealth.cover.duration') };
    T.haul = T.grab + 0.15;
    T.over = Math.max(T.over, T.haul + 0.2); T.kill = Math.max(T.kill, T.over + 0.15); T.end = Math.max(T.end, T.kill + 0.3);
    td.T = T;
    td.seg = seg; td.top = seg.top; td.floorY = seg.ay;
    td.n.set(seg.nx, 0, seg.nz); td.tan.set(seg.tx, 0, seg.tz);
    const rx = v.pos.x - seg.ax, rz = v.pos.z - seg.az;
    const along = rx * seg.tx + rz * seg.tz, behind = -(rx * seg.nx + rz * seg.nz);
    // far face: a ray from the victim back toward the wall, a little under the top
    let thick = 0.55;
    tmpA.set(v.pos.x, seg.top - 0.2, v.pos.z);
    const hit = game.world && game.world.raycast(tmpA, tmpB.set(seg.nx, 0, seg.nz), behind + 0.2, STATIC_ONLY);
    if (hit) thick = clamp(behind - hit.dist, 0.1, 1.2);
    const wB = Math.min(behind, thick + 0.3);                                     // victim pulled against the far face
    td.p1.set(seg.ax + seg.tx * along - seg.nx * wB, seg.ay, seg.az + seg.tz * along - seg.nz * wB);
    // pelvis lands on the near side, out from the face
    const out = pg('stealth.cover.land');
    td.landPelvis.set(seg.ax + seg.tx * along + seg.nx * out, seg.ay + 0.11, seg.az + seg.tz * along + seg.nz * out);
    td.p2.set(seg.ax + seg.tx * along - seg.nx * thick * 0.5, seg.top, seg.az + seg.tz * along - seg.nz * thick * 0.5);   // wall top
    const f = fwdOf(v.yaw, tmpA);
    const away = f.x * seg.nx + f.z * seg.nz < 0;                                 // back to the wall: pulled over backward
    td.dir = away ? -1 : 1;
    td.vyaw = away ? Math.atan2(-seg.nx, -seg.nz) : Math.atan2(seg.nx, seg.nz);
    fwdOf(td.vyaw, tmpA);
    td.landRoot.copy(td.landPelvis).addScaledVector(tmpA, -td.dir * deathSlide()); td.landRoot.y = seg.ay;
    // the player kneels beside the body's chest, on his own side of it (toward the wall's middle when level)
    const pAlong = (pl.pos.x - seg.ax) * seg.tx + (pl.pos.z - seg.az) * seg.tz;
    let side = Math.sign(pAlong - along);
    if (Math.abs(pAlong - along) < 0.25) side = along < seg.len / 2 ? 1 : -1;
    td.side = side || 1;
    const k = pg('stealth.cover.kneelOff');
    td.p3.copy(td.landPelvis).addScaledVector(td.n, 0.32).addScaledVector(td.tan, td.side * k); td.p3.y = seg.ay;
    td.kneelYaw = Math.atan2(-td.tan.x * td.side, -td.tan.z * td.side);
    td.coverYaw = Math.atan2(-seg.nx, -seg.nz);
    td.coverS = clamp(pAlong, 0, seg.len);
    td.impactAt = T.over;
  }

  // ---------------------------------------------------------------------------------------------- the player mode
  function ensureMode() {
    const pl = player();
    if (!pl || !pl.ctrl || S._mode) return;
    const ctrl = pl.ctrl;
    S._mode = ctrl.registerMode('takedown', {
      td: null,
      enter(from, td) {
        this.td = td;
        pl.vel.set(0, 0, 0);
        if (ctrl.grenadeAiming && game.grenades && game.grenades.cancel) { game.grenades.cancel(pl); ctrl.grenadeAiming = false; }
        if (pl.weapon && pl.weapon.setTrigger) pl.weapon.setTrigger(false);
        pl.exposed = true;
        if (td.kind === 'ledge') pl.cameraProfile = 'climb';
        else if (td.kind === 'cover') { pl.cameraProfile = 'cover'; pl.cameraLow = true; }
        else pl.cameraProfile = ctrl.inCombat ? 'combat' : 'explore';
        stepAttacker(td, 0);
      },
      update(dt) { if (this.td) stepAttacker(this.td, dt); return true; },
      exit(to) {
        const td = this.td;
        this.td = null;
        if (pl.anim) pl.anim.takedown = null;
        if (td && !td.attackerDone) { td.attackerDone = true; if (S.cur === td) S.cur = null; if (!td.grabbed) release(td); }
      },
    });
  }

  function setAttackerPhase(td, ph) {
    if (td.phaseA === ph) return;
    const from = td.phaseA; td.phaseA = ph;
    td.attacker.ctrl.emit('stealth', from, ph);
  }
  function setVictimPhase(td, ph) {
    if (td.phaseV === ph) return;
    const from = td.phaseV; td.phaseV = ph;
    game.events.emit('state', { actor: td.victim, sys: 'stealth.victim', from, to: ph, t: game.time });
  }
  function emitTakedown(td, phase, duration = null) {
    game.events.emit('takedown', { kind: td.kind, attacker: td.attacker, victim: td.victim, phase, duration, t: game.time });
  }

  function stepAttacker(td, dt) {
    const pl = td.attacker, ctrl = pl.ctrl, T = td.T, a = pl.anim;
    const t = td.t = game.time - td.t0 + EPS;
    const A = td.animA;
    A.t = t;
    if (td.kind === 'rear') {
      const u = sstep(0, T.snap, t);
      const tx = lerp(td.a0.x, td.p1.x, u), tz = lerp(td.a0.z, td.p1.z, u);
      ctrl.move(tx - pl.pos.x, 0, tz - pl.pos.z);
      pl.yaw = lerpAngle(td.ay0, td.vyaw, u);
      setAttackerPhase(td, t < T.grab ? 'snap' : t < T.kill ? 'choke' : 'recover');
    } else if (td.kind === 'ledge') {
      const up = pg('stealth.ledge.rise') * bump(0, T.release + 0.25, t);
      pl.pos.set(td.a0.x, td.a0.y + up, td.a0.z);
      pl.yaw = td.ay0;
      // the hand follows the near ankle of the victim
      const v = td.victim;
      A.grabW.set(v.pos.x, v.pos.y + 0.1, v.pos.z).addScaledVector(td.n, 0.06);
      if (t >= T.release) A.grabW.copy(td.p1).setY(td.p1.y + 0.1);
      setAttackerPhase(td, t < T.grab ? 'reach' : t < T.release ? 'yank' : 'recover');
    } else {
      // cover: reach over / haul (in place), step to the kneel spot, kneel + strike, back to the wall
      const go = sstep(T.haul, T.over + 0.1, t), back = sstep(T.kill + 0.15, T.end - 0.05, t);
      const tx = lerp(lerp(td.a0.x, td.p3.x, go), td.a0.x, back), tz = lerp(lerp(td.a0.z, td.p3.z, go), td.a0.z, back);
      ctrl.move(tx - pl.pos.x, 0, tz - pl.pos.z);
      pl.yaw = lerpAngle(lerpAngle(td.ay0, td.kneelYaw, sstep(T.haul + 0.2, T.over + 0.15, t)), td.coverYaw, back);
      pl.cameraLow = t < T.grab || t > T.end - 0.3;
      // hands: the victim's chest (follows him over the wall); the strike lands on his head
      chestOf(td, A.grabW);
      A.strikeW.copy(td.landPelvis).addScaledVector(td.n, 0.62); A.strikeW.y = td.floorY + 0.12;
      setAttackerPhase(td, t < T.grab ? 'reach' : t < T.over ? 'haul' : t < T.kill ? 'kneel' : 'recover');
    }
    // ledge: the animator poses the hanging attacker from mode 'climb' (character/skins.js lifts the figure onto its
    // anchored hands only in that mode); the others are full-body 'takedown' poses.
    a.mode = td.kind === 'ledge' ? 'climb' : 'takedown'; a.takedown = A; a.modeT = null;
    a.speed = 0; a.localVel.x = 0; a.localVel.z = 0; a.action = null; a.aim.on = false;
    pl.vel.set(0, 0, 0);
    if (t >= T.end) finishAttacker(td);
  }

  // World point of the victim's chest (where the cover pull-over hands hold him).
  function chestOf(td, out) {
    const v = td.victim, AV = td.animV;
    if (!AV.pelvisW) return out.set(v.pos.x, v.pos.y + 1.35, v.pos.z).addScaledVector(td.n, 0.12);
    const f = fwdOf(td.vyaw, tmpE), th = AV.pitch;
    // body up axis pitched by th about the victim's left axis: up*cos + fwd*sin
    return out.copy(AV.pelvisW).addScaledVector(f, 0.42 * Math.sin(th)).setY(AV.pelvisW.y + 0.42 * Math.cos(th));
  }

  function finishAttacker(td) {
    if (td.attackerDone) return;
    td.attackerDone = true;
    if (S.cur === td) S.cur = null;
    const pl = td.attacker, ctrl = pl.ctrl;
    emitTakedown(td, 'end', game.time - td.t0);
    setAttackerPhase(td, 'none');
    if (td.kind === 'ledge') {
      ctrl.setMode('climb', { grab: { type: 'hang', from: 'air', edge: td.edge, s: td.s } });
    } else if (td.kind === 'cover' && td.seg) {
      const seg = td.seg, off = pl.radius + pg('cover.wallGap');
      const px = seg.ax + seg.tx * td.coverS + seg.nx * off, pz = seg.az + seg.tz * td.coverS + seg.nz * off;
      ctrl.setMode('cover', { seg, s: td.coverS, px, pz, dist: Math.hypot(px - pl.pos.x, pz - pl.pos.z), swap: false });
    } else ctrl.setMode('ground', { speed: 0 });
  }

  // Back out before the grab (the player was interrupted): the NPC carries on as if nothing happened.
  function release(td) {
    const v = td.victim;
    v.alive = true; v.ai.takenDown = null; v.ai.bodySeen = false;
    td.victimDone = true;
    setVictimPhase(td, 'none');
    emitTakedown(td, 'end', game.time - td.t0);
  }

  // ------------------------------------------------------------------------------------------------- the victim
  function stepVictim(td, dt) {
    const v = td.victim, ai = v.ai, an = v.anim, T = td.T, AV = td.animV;
    const t = game.time - td.t0 + EPS;
    AV.t = t;
    v.vel.set(0, 0, 0);
    if (t < T.grab) {                                              // not touched yet: standing (brain suspended)
      an.mode = 'locomotion'; an.speed = 0; an.localVel.x = 0; an.localVel.z = 0; an.turnRate = 0;
      an.action = null; an.aim.on = false; an.aim.weight = 0;
      return;
    }
    if (!td.grabbed) { td.grabbed = true; emitTakedown(td, 'grab'); setVictimPhase(td, 'grabbed'); }
    an.mode = 'takedown'; an.takedown = AV; an.action = null; an.aim.on = false; an.aim.weight = 0; an.speed = 0;
    if (td.kind === 'rear') stepRearVictim(td, t);
    else if (td.kind === 'ledge') stepLedgeVictim(td, t, dt);
    else stepCoverVictim(td, t);
    if (!td.victimDone && td.killed && t >= td.victimEnd) {
      td.victimDone = true;
      ai.takenDown = null; ai.bodySeen = false;              // the body can now be found (ai-spec §1.4)
      setVictimPhase(td, 'none');
    }
  }

  function kill(td, dirSign, deathT) {
    if (td.killed) return;
    td.killed = true;
    const v = td.victim, f = fwdOf(td.vyaw, tmpC).multiplyScalar(dirSign);
    v.ai.brain.die({ dir: f, source: null });
    v.ai.deathT = game.time - deathT;                        // the brain's death clock continues the pose we hand over
    emitTakedown(td, 'kill');
    setVictimPhase(td, 'dead');
  }

  function stepRearVictim(td, t) {
    const T = td.T, AV = td.animV, v = td.victim;
    v.yaw = td.vyaw;
    AV.pelvisW = null; AV.pitch = 0;
    if (t >= T.kill) {
      kill(td, 1, t - T.kill);
      AV.land = sstep(T.kill, T.kill + 0.3, t); AV.deathT = t - T.kill;
      td.victimEnd = Math.max(T.end, td.impactAt + 0.05);
      if (t >= td.impactAt) {                                    // the body hits the floor, forward of his feet
        td.impactPos.copy(fwdOf(td.vyaw, tmpA)).multiplyScalar(deathSlide()).add(v.pos); td.impactPos.y = v.pos.y + 0.15;
        bodyNoise(td);
      }
    }
  }

  function stepLedgeVictim(td, t, dt) {
    const T = td.T, AV = td.animV, v = td.victim, n = td.n, g = pg('stealth.gravity');
    const f = fwdOf(td.vyaw, tmpA);
    if (!td.pelvisW) td.pelvisW = AV.pelvisW = new THREE.Vector3();
    if (t < T.release) {                                         // yanked: feet dragged to the lip, body tipping over it
      // a struggle (feet dragged 30 %, leaning back against the pull), then the pull over the lip in the last yank s
      const ty = Math.max(T.grab, T.release - pg('stealth.ledge.yank'));
      const u = 0.3 * sstep(T.grab, Math.min(ty, T.grab + 0.5), t) + 0.7 * sstep(ty, T.release, t);
      v.yaw = lerpAngle(td.vy0, td.vyaw, sstep(T.grab, T.grab + 0.18, t));
      v.pos.set(lerp(td.v0.x, td.p1.x, u), td.p1.y, lerp(td.v0.z, td.p1.z, u));
      const th = td.dir * (0.9 * u - 0.18 * bump(T.grab, ty + 0.1, t));
      AV.pitch = th; AV.air = 0;
      td.pelvisW.set(v.pos.x, v.pos.y + PELVIS_H * Math.cos(th), v.pos.z).addScaledVector(n, PELVIS_H * Math.abs(Math.sin(th)));
      td.fth = th;
      setVictimPhase(td, 'yanked');
      return;
    }
    if (!td.flying && !td.landed) {                              // release: ballistic from the lip
      td.flying = true;
      td.fp.copy(td.pelvisW);
      td.fv.copy(n).multiplyScalar(pg('stealth.ledge.throw')).addScaledVector(td.tan, td.side * pg('stealth.ledge.side'));
      td.fv.y = pg('stealth.ledge.up');
      const fy = game.world ? game.world.groundAt(td.fp.x + td.fv.x, td.fp.z + td.fv.z, td.fp.y - 0.5) : 0;
      const h = td.fp.y - ((fy == null ? 0 : fy) + 0.11);
      const tf = (td.fv.y + Math.sqrt(td.fv.y * td.fv.y + 2 * g * Math.max(0.1, h))) / g;   // time to the floor
      td.spin = (td.dir * Math.PI / 2 - td.fth) / Math.max(0.2, tf);
      setVictimPhase(td, 'falling');
    }
    if (td.flying) {
      td.fv.y -= g * dt;
      td.fp.addScaledVector(td.fv, dt);
      td.fth += td.spin * dt;
      if (Math.abs(td.fth) > Math.PI / 2) td.fth = td.dir * Math.PI / 2;
      const fy = game.world ? game.world.groundAt(td.fp.x, td.fp.z, td.fp.y + 0.3) : 0;
      const floor = fy == null ? 0 : fy;
      AV.pitch = td.fth; AV.air = sstep(T.release, T.release + 0.15, t);
      td.pelvisW.copy(td.fp);
      v.pos.set(td.fp.x, Math.max(floor, td.fp.y - PELVIS_H), td.fp.z);
      if (td.fp.y <= floor + 0.12 && td.fv.y < 0) {              // landed: lie along the topple, as the death pose does
        td.flying = false; td.landed = true; td.landT = t;
        td.fp.y = floor + 0.11; td.pelvisW.copy(td.fp); AV.pitch = td.dir * Math.PI / 2;
        v.pos.copy(td.fp).addScaledVector(f, -td.dir * deathSlide()); v.pos.y = floor;
        td.impactAt = t; td.impactPos.copy(td.fp);
        kill(td, td.dir, DEATH_LYING * deathDur());
        td.victimEnd = t + 0.4;
        bodyNoise(td);
      }
    }
    if (td.landed) {
      AV.land = sstep(td.landT, td.landT + 0.12, t); AV.deathT = DEATH_LYING * deathDur() + (t - td.landT);
    }
  }

  function stepCoverVictim(td, t) {
    const T = td.T, AV = td.animV, v = td.victim, f = fwdOf(td.vyaw, tmpA);
    if (!td.pelvisW) td.pelvisW = AV.pelvisW = new THREE.Vector3();
    v.yaw = lerpAngle(td.vy0, td.vyaw, sstep(T.grab, T.haul, t));
    if (t < T.haul) {                                            // collar grabbed: dragged against the far face
      const u = sstep(T.grab, T.haul, t);
      v.pos.set(lerp(td.v0.x, td.p1.x, u), td.floorY, lerp(td.v0.z, td.p1.z, u));
      AV.pitch = td.dir * 0.15 * u; AV.air = 0;
      td.pelvisW.set(v.pos.x, v.pos.y + PELVIS_H - 0.03, v.pos.z);
      return;
    }
    if (t < T.over) {                                            // hauled over the top on a Bezier arc
      setVictimPhase(td, 'hauled');
      const u = sstep(T.haul, T.over, t), w = 1 - u;
      const x0 = td.p1.x, z0 = td.p1.z, y0 = td.floorY + PELVIS_H - 0.03;
      const cx = td.p2.x, cz = td.p2.z, cy = td.top + 1.0;        // control point above the wall top
      const x2 = td.landPelvis.x, z2 = td.landPelvis.z, y2 = td.landPelvis.y;
      td.pelvisW.set(w * w * x0 + 2 * w * u * cx + u * u * x2, w * w * y0 + 2 * w * u * cy + u * u * y2, w * w * z0 + 2 * w * u * cz + u * u * z2);
      AV.pitch = td.dir * (0.15 + (Math.PI / 2 - 0.15) * u);
      AV.air = sstep(0, 0.2, u);
      const k = sstep(0, 1, u) * deathSlide() * -td.dir;
      v.pos.set(td.pelvisW.x + f.x * k, td.floorY, td.pelvisW.z + f.z * k);
      return;
    }
    if (!td.landed) {
      td.landed = true; td.landT = T.over;
      td.pelvisW.copy(td.landPelvis); v.pos.copy(td.landRoot);
      td.impactPos.copy(td.landPelvis);
      bodyNoise(td);
      setVictimPhase(td, 'down');
    }
    AV.pitch = td.dir * Math.PI / 2; AV.air = 1;
    AV.land = sstep(T.over, T.over + 0.12, t); AV.deathT = DEATH_LYING * deathDur() + (t - T.over);
    if (t >= T.kill) kill(td, td.dir, AV.deathT);
    td.victimEnd = T.end;
  }

  function bodyNoise(td) {
    if (td.noised) return;
    td.noised = true;
    const r = pg('stealth.noise.bodyFall');
    emitTakedown(td, 'impact');
    if (r > 0) game.events.emit('noise', { pos: td.impactPos.clone(), radius: r, kind: 'bodyfall', source: td.attacker });
  }

  // Another NPC sees the move (the attacker or the victim) for witness.time: straight to combat (spec §4).
  function witnesses(td, dt) {
    const D = director();
    // The act is witnessable from the start until the kill (ledge: the landing). After it the attacker is ordinary
    // perception (brain meters) and the body is found through the brain's lookForBodies -> director.bodyFound (search).
    if (!D || td.victimDone || td.killed) return;
    const pl = td.attacker, v = td.victim;
    for (const npc of enemies()) {
      if (npc === v || !npc.alive || !npc.ai || npc.ai.takenDown || npc.ai.alert === 'combat') continue;
      const eye = npcEye(npc, pf, tmpA);
      const fx = Math.sin(npc.yaw), fz = Math.cos(npc.yaw);
      let sees = false;
      for (let i = 0; i < 2 && !sees; i++) {
        const p = i === 0 ? tmpB.set(pl.pos.x, pl.pos.y + 1.2, pl.pos.z)
          : td.animV.pelvisW ? tmpB.copy(td.animV.pelvisW) : tmpB.set(v.pos.x, v.pos.y + 1.0, v.pos.z);
        if (!inViewCone(fx, fz, p.x - eye.x, p.y - eye.y, p.z - eye.z, npc.ai.alert, pf)) continue;
        if (game.world && !game.world.lineOfSight(eye, p, STATIC_ONLY)) continue;
        sees = true;
      }
      const s = sees ? (td.seen.get(npc) || 0) + dt : 0;
      td.seen.set(npc, s);
      if (sees && s >= pg('stealth.witness.time')) {
        td.witnessed.push(npc.id);
        game.events.emit('state', { actor: npc, sys: 'stealth.witness', from: 'none', to: 'saw', t: game.time });
        npc.ai.everSeen = true; npc.ai.spotT = game.time;
        D.enterCombat(npc, pl.pos, 'saw takedown');
        if (D.perceived) D.perceived(npc, pl);
      }
    }
  }

  function hideIcon() {
    if (!S.iconShown) return;
    S.iconShown = false;
    if (game.hud && game.hud.prompt) game.hud.prompt(null);
  }

  // ------------------------------------------------------------------------------------------------- systems
  game.addSystem({
    name: 'stealth', order: ORDER.player - 0.5,
    update(dt) {
      ensureMode();
      const pl = player();
      if (!pl || !pl.ctrl) return;
      const c = S.cur ? null : find();
      S.candidate = c;
      const hud = game.hud;
      // The cue (no icon in U4): anim.reach {w 0..1, x, y, z the victim's chest, arm (false: hanging, look only)}.
      const R = pl.anim.reach || (pl.anim.reach = { w: 0, x: 0, y: 0, z: 0, arm: true });
      R.w = clamp(R.w + (c ? 1 : -1) * (dt || 0) / Math.max(0.01, pg('stealth.reach.time')), 0, 1);
      if (c) { R.x = c.victim.pos.x; R.y = c.victim.pos.y + 1.3; R.z = c.victim.pos.z; R.arm = c.kind !== 'ledge'; R.dist = pg('stealth.reach.dist'); }
      if (S.cur) R.w = 0;
      const icon = pg('stealth.prompt.icon') > 0 && hud && hud.prompt;
      if (c) {
        const v = c.victim;
        if (icon) {
          promptAt.set(v.pos.x, v.pos.y + pg('stealth.prompt.height'), v.pos.z);
          hud.prompt(`[${game.input && game.input.device === 'pad' ? '□' : 'F'}] Takedown`, promptAt);
          S.iconShown = true;
        }
        if (!S.promptShown) { S.promptShown = true; pl.ctrl.emit('stealth', 'none', 'prompt'); }
        if (game.input && game.input.pressed('melee')) {
          pl.ctrl.emit('stealth', 'prompt', 'none'); S.promptShown = false;
          hideIcon();
          start(c.kind, v);
        }
      } else if (S.promptShown) {
        S.promptShown = false;
        hideIcon();
        if (!S.cur) pl.ctrl.emit('stealth', 'prompt', 'none');
      }
      if (!icon && S.iconShown) hideIcon();
    },
  });
  game.addSystem({
    name: 'stealth.victims', order: ORDER.ai + 0.5,
    update(dt) {
      if (!S.records.length) return;
      for (const td of S.records) {
        if (!td.victimDone) { stepVictim(td, dt); witnesses(td, dt); }
      }
      if (S.records.every((td) => td.victimDone && td.attackerDone)) S.records.length = 0;
    },
  });
  return S;
}
