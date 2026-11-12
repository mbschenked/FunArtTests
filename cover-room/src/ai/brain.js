// Per-enemy brain (ai-spec §0–§7): perception and the notice meter, the alert states (unaware → suspicious/investigate
// → combat → search), post selection, the cover cycle (idle / peek / aim / blind / reload), burst fire with the accuracy
// ramp, grenade throws and flight from grenades, hit reactions and death. Skill priority (§0, [INFERRED]):
//   dead > hit reaction > grenade avoid > throw > [combat: confirm LKP > flank > fight] | search | investigate | ambient
// Movement follows level.nav paths with world.moveCapsule. No 'three' import: vectors come from game.world.Vector3.
import { clamp, randRange, wrapAngle, yawTo, dist2D, emitState } from './tuning.js';
import { updateVision, stepMeter, hearNoise, inViewCone, playerCrouched } from './perception.js';
import { hitChance, planBurst, burstPause, aimPoint } from './shooting.js';
import { SELECTORS, isCoverLike } from './posts.js';

const STATIC_ONLY = Object.freeze({ hitActors: false });
const MOVE_OPTS = Object.freeze({ stepHeight: 0.35, snapDown: 0.3 });
const SHOT_RING = 16;

export class Brain {
  constructor(game, npc, director, P, index) {
    this.game = game; this.npc = npc; this.dir = director; this.P = P; this.index = index;
    const V = game.world.Vector3;
    this.tmp = { eye: new V(), target: new V(), dir: new V() };
    this.delta = new V(); this.aim = new V(); this.fireFrom = new V();
    this.vy = 0;
    this.burst = { shots: 0, gap: 0.1 };
    this.home = { x: npc.pos.x, y: npc.pos.y, z: npc.pos.z, yaw: npc.yaw };
    this.lastProgress = { x: npc.pos.x, z: npc.pos.z, t: 0, repaths: 0 };
    this.ai = npc.ai = {
      brain: this,
      alert: 'unaware', meter: 0, everSeen: false,
      canSee: false, seeDist: 0, seenFor: 0, perceived: false, lastSeen: { x: 0, y: 0, z: 0, valid: false },
      spotT: -1, fireLos: false, fireLosT: -1e9, fireLosNext: 0,
      role: 'engager', pin: null, hardPoint: null, flanker: false, tok: false,
      tokRec: { id: npc.id, eligible: false, canPeek: false, engaged: false, dist: 0, tok: false, tokT: -1, peekGrant: false },
      engagedT: -1e9, suppressUntil: -1,
      post: null, atPost: false, postArriveT: -1e9, query: null, queryDueT: 0, selName: 'engage', panicDone: false,
      advanceReq: false, flankRoute: null, flankPost: null, confirmLKP: false, confirmArrived: false,
      behavior: 'idle', coverPhase: 'none', phaseT: 0, phaseUntil: 0, peekAt: 0, aimReadyAt: 0, nextShotT: 0, blind: false,
      moving: false, path: null, pathI: 0, speed: 0, goal: { x: 0, y: 0, z: 0, valid: false }, goalKind: null,
      throwPhase: null, throwT: 0, throwTarget: { x: 0, y: 0, z: 0 }, released: false,
      hitUntil: -1, lastHitT: -1e9, hit: null,
      flee: null, fleePending: null, fleeAt: 0, fleeLand: { x: 0, y: 0, z: 0 },
      inv: null, searchLoop: -1, searchI: 0, searchDir: 1, detour: null,
      shotTimes: new Float64Array(SHOT_RING).fill(-1e9), shotI: 0, lastShotT: -1e9,
      deathT: -1, deathDir: null, field: null, flankQuery: null,
    };
    this.ai.shotTimes.fill(-1e9);
  }

  get now() { return this.game.time; }

  // ================================================================================================ alert state
  setAlert(next) {
    const ai = this.ai, from = ai.alert;
    if (from === next) return;
    ai.alert = next;
    emitState(this.game, this.npc, 'ai', from, next);
    if (next === 'combat') {
      ai.inv = null; ai.seenFor = 0; ai.queryDueT = 0; ai.detour = null;
      if (ai.canSee) ai.everSeen = true;
    } else if (next === 'search') {
      this.release(); ai.meter = 0; ai.atPost = false; ai.flankRoute = null; ai.flanker = false; ai.confirmLKP = false; ai.advanceReq = false;
      ai.fireLos = false; ai.suppressUntil = -1;
      this.stop(); ai.coverPhase = 'none';
    } else if (next === 'unaware') {
      ai.inv = null;
    }
  }

  // ================================================================================================ events
  onNoise(ev) {
    const ai = this.ai, npc = this.npc;
    if (!npc.alive || !ev || !ev.pos) return;
    if (ev.source && ev.source.team === 'enemy') return;              // our own side's shots and steps
    const res = hearNoise(npc, ev, this.game, this.P, this.tmp);
    if (res === 'none') return;
    const D = this.dir;
    if (res === 'combat') {
      if (!D.combat) D.enterCombat(npc, ev.pos, 'heard ' + ev.kind);
      else if (ev.source && ev.source.team === 'player') { D.setLKP(ev.pos, this.now); D.lastPerceivedT = this.now; }
      return;
    }
    if (ai.alert === 'unaware') D.startInvestigation(npc, ev.pos);
    else if (ai.alert === 'search') ai.detour = { x: ev.pos.x, y: ev.pos.y, z: ev.pos.z };
  }

  // Player shots that hit or pass close count as "directly engaging" this NPC (token priority) and alert it.
  onShot(ev) {
    const npc = this.npc;
    if (!npc.alive || !ev || !ev.shooter || ev.shooter.team !== 'player') return;
    const o = ev.origin, e = ev.end || (ev.hit && ev.hit.point);
    let near = ev.hit && ev.hit.actor === npc;
    if (!near && o && e) {
      const cx = npc.pos.x, cy = npc.pos.y + 1.2, cz = npc.pos.z;
      const dx = e.x - o.x, dy = e.y - o.y, dz = e.z - o.z;
      const L2 = dx * dx + dy * dy + dz * dz || 1;
      const t = clamp(((cx - o.x) * dx + (cy - o.y) * dy + (cz - o.z) * dz) / L2, 0, 1);
      near = Math.hypot(o.x + dx * t - cx, o.y + dy * t - cy, o.z + dz * t - cz) <= this.P('ai.tokens.engagedRadius');
    }
    if (!near) return;
    this.ai.engagedT = this.now;
    if (!this.dir.combat) this.dir.enterCombat(npc, ev.shooter.pos, 'shot at');
  }

  // Called by weapons' applyDamage (actor.takeDamage): owns health, hit reaction and death (§7).
  takeDamage(p) {
    const npc = this.npc, ai = this.ai, P = this.P, now = this.now;
    if (!npc.alive) return;
    npc.health = Math.max(0, Math.round(npc.health - p.amount));      // integer hp (R)
    const src = p.source;
    if (src && src.team === 'player') {
      ai.engagedT = now;
      if (!this.dir.combat) this.dir.enterCombat(npc, src.pos, 'hit');
      else { this.dir.setLKP(src.pos, now); this.dir.lastPerceivedT = now; }
    }
    if (npc.health <= 0) { this.die(p); return; }
    let dur = p.part === 'head' ? P('ai.hit.head') : p.part === 'limb' ? P('ai.hit.limb') : P('ai.hit.torso');
    if (now - ai.lastHitT <= P('ai.hit.staggerWindow')) dur = Math.max(dur, P('ai.hit.stagger'));   // 2 hits within 1 s
    ai.lastHitT = now;
    ai.hitUntil = now + dur;
    this.setHit(p.dir, p.part || 'torso', now);
    // a hit reaction cancels the burst and releases the shooter token (G-deck p126)
    this.burst.shots = 0;
    ai.tok = false; ai.tokRec.tok = false; ai.tokRec.peekGrant = false;
    if (ai.coverPhase === 'aim' || ai.coverPhase === 'blind' || ai.coverPhase === 'peek') this.setPhase('idle');
    if (ai.throwPhase && !ai.released) { ai.throwPhase = null; }
    if (npc.health < P('ai.hit.panicHp') * npc.maxHealth && ai.atPost && !ai.panicDone) ai.queryDueT = 0;
    this.setBehavior('hitreact');
  }

  // Hit record for the animator (reused object: no allocation per hit).
  setHit(dir, part, t0) {
    const h = this.ai.hit || (this.ai.hit = { dir: { x: 0, y: 0, z: 0 }, part: 'torso', t0: 0 });
    if (dir) { h.dir.x = dir.x; h.dir.y = dir.y; h.dir.z = dir.z; } else { h.dir.x = 0; h.dir.y = 0; h.dir.z = 0; }
    h.part = part; h.t0 = t0;
  }

  die(p) {
    const npc = this.npc, ai = this.ai;
    npc.alive = false;
    ai.deathT = this.now;
    ai.deathDir = p && p.dir ? { x: p.dir.x, y: p.dir.y, z: p.dir.z } : null;
    this.release();
    this.stop();
    ai.tok = false; ai.tokRec.tok = false;
    ai.throwPhase = null;
    emitState(this.game, npc, 'ai', ai.alert, 'dead');
    ai.alert = 'dead';
    this.setBehavior('dead');
    this.game.events.emit('death', { actor: npc, source: p ? p.source : null });
    this.dir.onDeath(npc);
  }

  // ================================================================================================ per step
  update(dt) {
    const npc = this.npc, ai = this.ai, now = this.now;
    if (!npc.alive) { this.writeAnim(dt); return; }
    this.perceive(dt);
    if (ai.hitUntil > now) {
      this.stopInPlace();
    } else {
      if (ai.behavior === 'hitreact') this.setBehavior(ai.moving ? 'move' : 'idle');
      if (ai.flee) this.updateFlee();
      else if (ai.fleePending && now >= ai.fleeAt) this.beginFlee();
      else if (ai.throwPhase) this.updateThrow();
      else if (ai.alert === 'combat') this.combat();
      else if (ai.alert === 'search') this.search();
      else if (ai.alert === 'suspicious') this.investigate();
      else this.ambient();
    }
    this.move(dt);
    this.face(dt);
    const w = npc.weapon;
    if (w && typeof w.update === 'function') w.update(dt);           // idempotent per step (weapons/weapon.js)
    this.writeAnim(dt);
    this.hud();
  }

  // ---- perception (§1) ----------------------------------------------------------------------------------------------
  perceive(dt) {
    const ai = this.ai, P = this.P, D = this.dir, pl = D.player, now = this.now;
    if (!pl) return;
    const ph = ai.coverPhase;
    ai.lookYaw = (ph === 'aim' || ph === 'peek' || ph === 'blind') && D.lkp.valid
      ? yawTo(D.lkp.x - this.npc.pos.x, D.lkp.z - this.npc.pos.z) : this.npc.yaw;
    const every = Math.max(1, P('ai.budget.visionEvery'));
    if ((this.game.frame + this.index) % every === 0) {
      updateVision(this.npc, pl, this.game, P, this.tmp, D.everCombat);
      if (ai.canSee) { ai.lastSeen.x = pl.pos.x; ai.lastSeen.y = pl.pos.y; ai.lastSeen.z = pl.pos.z; ai.lastSeen.valid = true; }
      if (ai.alert === 'unaware' || ai.alert === 'suspicious') this.lookForBodies();
    }
    const seen = ai.canSee;
    if (ai.alert === 'combat') {
      ai.seenFor = seen ? ai.seenFor + dt : 0;
      const was = ai.perceived;
      ai.perceived = ai.seenFor >= P('ai.notice.combatReacquire');
      if (ai.perceived) {
        D.perceived(this.npc, pl);
        ai.everSeen = true;
        if (!was && (ai.spotT < 0 || now - ai.fireLosT > P('ai.acc.respotReset'))) ai.spotT = now;
      }
      return;
    }
    ai.perceived = false;
    ai.meter = stepMeter(ai.meter, seen, ai.seeDist, ai.alert, ai.everSeen, dt, P);
    if (ai.meter >= 2) {
      ai.everSeen = true;
      ai.spotT = now;
      D.enterCombat(this.npc, pl.pos, ai.alert === 'search' ? 're-spotted' : 'spotted');
      D.perceived(this.npc, pl);
      ai.perceived = true;
    } else if (ai.meter >= 1 && ai.alert === 'unaware') {
      D.startInvestigation(this.npc, pl.pos);
    }
  }

  lookForBodies() {
    const D = this.dir, npc = this.npc, P = this.P;
    for (const o of D.npcs) {
      if (o.alive || o === npc || o.ai.bodySeen) continue;
      const dx = o.pos.x - npc.pos.x, dz = o.pos.z - npc.pos.z, dy = o.pos.y + 0.3 - (npc.pos.y + P('ai.vision.eye'));
      if (!inViewCone(Math.sin(npc.yaw), Math.cos(npc.yaw), dx, dy, dz, this.ai.alert, P)) continue;
      this.tmp.eye.set(npc.pos.x, npc.pos.y + P('ai.vision.eye'), npc.pos.z);
      this.tmp.target.set(o.pos.x, o.pos.y + 0.3, o.pos.z);
      if (!this.game.world.lineOfSight(this.tmp.eye, this.tmp.target, STATIC_ONLY)) continue;
      o.ai.bodySeen = true;
      D.bodyFound(npc, o.pos);
      return;
    }
  }

  // Line of fire from where this NPC shoots (pop-up / lean point at its post, else its eye) to the LKP. Two rays.
  checkFireLos() {
    const ai = this.ai, P = this.P, D = this.dir, now = this.now;
    if (now < ai.fireLosNext) return;
    ai.fireLosNext = now + P('ai.budget.fireLosEvery');
    const f = this.firePoint(this.fireFrom);
    if (!f || !D.lkp.valid) { ai.fireLos = false; return; }
    const L = D.lkp, w = this.game.world;
    this.tmp.target.set(L.x, L.y + P('ai.vision.chest'), L.z);
    let los = w.lineOfSight(f, this.tmp.target, STATIC_ONLY);
    if (!los) { this.tmp.target.y = L.y + P('ai.vision.headTop'); los = w.lineOfSight(f, this.tmp.target, STATIC_ONLY); }
    ai.fireLos = los;
    if (los) {
      if (ai.spotT < 0 || now - ai.fireLosT > P('ai.acc.respotReset')) ai.spotT = now;   // ramp restarts after LOS lost > 2 s
      ai.fireLosT = now;
    }
  }

  firePoint(out) {
    const ai = this.ai, npc = this.npc;
    if (ai.atPost && ai.post && !ai.moving) {
      const f = (ai.perchMode && ai.post.perchFire) || ai.post.fire;     // perch mode: lean out past the edge (vantage.js)
      if (!f) return null;
      return out.set(f.x, f.y, f.z);
    }
    return out.set(npc.pos.x, npc.pos.y + 1.55, npc.pos.z);
  }

  // Token bookkeeping record for director.allocateTokens (§4.2).
  fillTokenRec(D) {
    const ai = this.ai, r = ai.tokRec, npc = this.npc, P = this.P, now = this.now;
    const busy = !npc.alive || ai.alert !== 'combat' || ai.hitUntil > now || !!ai.flee || !!ai.throwPhase || ai.confirmLKP
      || (npc.weapon && npc.weapon.state && npc.weapon.state.reloading);
    r.dist = dist2D(npc.pos, D.lkp);
    const ambushHold = ai.role === 'ambusher' && r.dist > P('ai.roles.ambushPopDist');
    r.eligible = !busy && !ambushHold && ai.fireLos && !ai.moving;
    r.canPeek = !busy && !ambushHold && ai.atPost && !ai.moving && !!(ai.post && ai.post.fire);
    r.engaged = now - ai.engagedT <= P('ai.tokens.engagedWindow');
    r.tok = ai.tok;
  }

  // ---- combat (§3–§5) ---------------------------------------------------------------------------------------------
  combat() {
    const ai = this.ai, D = this.dir, P = this.P, now = this.now;
    this.checkFireLos();
    if (ai.confirmLKP) {                                         // §2: walk up to the last known position
      if (!ai.moving && dist2D(this.npc.pos, D.lkp) > P('ai.search.lkpArrive')) {
        if (!this.goTo(D.lkp.x, D.lkp.y, D.lkp.z, P('ai.move.run'), 'lkp')) ai.confirmArrived = true;
      }
      if (dist2D(this.npc.pos, D.lkp) <= P('ai.search.lkpArrive')) ai.confirmArrived = true;
      this.setBehavior(ai.moving ? 'move' : 'look');
      return;
    }
    if (ai.flankRoute) {                                         // §4.3: run the flank route
      this.setBehavior('flank');
      if (!ai.moving) {
        ai.flankRoute = null; ai.flanker = false;
        this.arrived('post');
        D.flankDone(this.npc);
      }
      return;
    }
    this.selectPost();
    if (ai.moving) { this.setBehavior('move'); this.setPhase('none'); return; }
    if (ai.atPost && isCoverLike(ai.post)) this.coverFight();
    else this.openFight();
  }

  // Post selection: start a staggered query each re-score interval, act on it when it finishes.
  selectPost() {
    const ai = this.ai, D = this.dir, P = this.P, now = this.now, npc = this.npc;
    const q = ai.query;
    const panic = npc.health < P('ai.hit.panicHp') * npc.maxHealth && !ai.panicDone && ai.atPost;
    const name = panic ? 'panic' : ai.advanceReq ? 'advance' : ai.role === 'ambusher' ? 'ambush' : ai.role === 'defender' ? 'defend' : 'engage';
    if (now >= ai.queryDueT && (q.phase === 'idle' || q.phase === 'done')) {
      ai.queryDueT = now + P('ai.posts.rescore');
      // vantage.js may swap in 'perch' (player below the edge) or 'defendSearch' (defender with no vantage)
      const sel = D.vantage && !panic && !ai.advanceReq ? D.vantage.selectorFor(this, name) : name;
      ai.selName = sel;
      let anchor = D.lkp, limit = P('ai.posts.radius'), region = null;
      if (sel === 'ambush' && D.ambush.valid) anchor = D.ambush;
      if (ai.role === 'defender' && (sel === 'defend' || sel === 'defendSearch' || sel === 'perch') && ai.hardPoint && ai.hardPoint.region) {
        anchor = ai.hardPoint.region.center || ai.hardPoint.region;
        limit = ai.hardPoint.region.radius || 4;
        region = ai.hardPoint.region.center ? ai.hardPoint.region : null;   // a layout.js zone: posts inside it
      }
      q.begin(npc, SELECTORS[sel], D.posts, D.lkp, anchor, limit, D.cv, D.npcs, D.tools, P, ai.post, region);
      q.consumed = false;
      return;
    }
    if (q.phase !== 'done' || q.consumed) return;
    q.consumed = true;
    const forced = ai.selName === 'advance' || ai.selName === 'panic' || ai.selName === 'defendSearch' || ai.selName === 'perch';
    const cur = ai.post, cs = cur ? q.scoreOf(cur) : 0;
    const best = q.best, bs = q.bestScore;
    if (best && best !== cur && (cs <= 0 || forced || (bs >= P('ai.posts.hysteresis') * cs && now - ai.postArriveT >= P('ai.posts.minDwell')))) {
      if (this.goTo(best.x, best.y, best.z, P('ai.move.run'), 'post')) {
        this.claim(best);
        if (ai.selName === 'advance') { ai.advanceReq = false; this.dir.note('advancing to post ' + best.id, npc); }
        if (ai.selName === 'panic') { ai.panicDone = true; this.dir.note('panic fallback', npc); }
      }
    } else if (forced && ai.selName === 'advance') {
      ai.advanceReq = false;
      this.dir.note('advance: no closer post', npc);
    }
  }

  // Cover cycle (G-deck p128): hidden idle; non-holders peek; token holders pop out (aim) for 4–6 s and fire bursts,
  // then hide 1–2.5 s. Reload releases the token (allocateTokens sees `reloading`).
  coverFight() {
    const ai = this.ai, P = this.P, now = this.now, rng = this.game.rng, w = this.npc.weapon, st = w && w.state;
    this.setBehavior('cover');
    if (ai.coverPhase === 'none') this.setPhase('idle');
    const suppressing = ai.suppressUntil > now;
    if (st && st.reloading) { if (ai.coverPhase !== 'reload') this.setPhase('reload'); return; }
    if (ai.coverPhase === 'reload') { this.setPhase('idle'); ai.aimReadyAt = now + 0.2; }
    if (st && st.mag <= 0) { w.reload(); this.setPhase('reload'); return; }
    const canFire = !!(ai.post && ai.post.fire);
    const holder = ai.tok || suppressing;
    switch (ai.coverPhase) {
      case 'idle':
        if (holder && canFire && now >= ai.aimReadyAt) {
          const blind = rng() < P('ai.cover.blindfire');
          this.setPhase(blind ? 'blind' : 'aim');
          ai.phaseUntil = now + randRange(rng, P('ai.cover.exposeMin'), P('ai.cover.exposeMax'));
          ai.nextShotT = now + randRange(rng, P('ai.shoot.firstMin'), P('ai.shoot.firstMax'));
          this.burst.shots = 0;
        } else if (!holder && canFire && now >= ai.peekAt) {
          this.setPhase('peek');
          ai.phaseUntil = now + randRange(rng, P('ai.cover.peekMin'), P('ai.cover.peekMax'));
        } else if (!holder && st && st.mag < P('ai.cover.tacticalReload') * magSize(w)) {
          if (w.reload()) this.setPhase('reload');
        }
        break;
      case 'peek':
        if (holder) { this.setPhase('idle'); ai.aimReadyAt = now; }
        else if (now >= ai.phaseUntil) { this.setPhase('idle'); ai.peekAt = now + randRange(rng, P('ai.cover.peekGapMin'), P('ai.cover.peekGapMax')); }
        break;
      case 'aim':
      case 'blind':
        if (!holder || now >= ai.phaseUntil) {
          this.setPhase('idle');
          ai.aimReadyAt = now + randRange(rng, P('ai.cover.hiddenMin'), P('ai.cover.hiddenMax'));
          ai.peekAt = now + randRange(rng, P('ai.cover.peekGapMin'), P('ai.cover.peekGapMax'));
        } else this.fireControl(ai.coverPhase === 'blind');
        break;
      default: break;
    }
  }

  openFight() {
    const ai = this.ai, now = this.now, w = this.npc.weapon, st = w && w.state;
    this.setBehavior('open');
    if (st && st.reloading) { this.setPhase('reload'); return; }
    if (st && st.mag <= 0) { w.reload(); this.setPhase('reload'); return; }
    const holder = ai.tok || ai.suppressUntil > now;
    if (holder && ai.coverPhase !== 'aim') {
      this.setPhase('aim');
      ai.nextShotT = now + randRange(this.game.rng, this.P('ai.shoot.firstMin'), this.P('ai.shoot.firstMax'));
      this.burst.shots = 0;
    } else if (!holder && ai.coverPhase !== 'idle') this.setPhase('idle');
    if (holder) this.fireControl(false);
  }

  // Bursts (R): plan a burst, fire its rounds at the burst's gap, pause, repeat. Needs line of fire to the LKP unless
  // suppressing, and a fresh enough LKP.
  fireControl(blind) {
    const ai = this.ai, P = this.P, now = this.now, D = this.dir, w = this.npc.weapon;
    if (!w || now < ai.nextShotT) return;
    const suppressing = ai.suppressUntil > now;
    if (!suppressing && (!ai.fireLos || now - D.lkp.t > P('ai.shoot.lkpFireTime'))) return;
    const kind = this.kind;
    if (this.burst.shots <= 0) planBurst(this.game.rng, kind, P, this.burst);
    if (this.fireRound(blind)) {
      this.burst.shots--;
      ai.nextShotT = now + (this.burst.shots > 0 ? this.burst.gap : burstPause(this.game.rng, kind, P));
    } else {
      ai.nextShotT = now + 0.05;
    }
  }

  // One round: roll hit/miss with the accuracy model, aim at a body point or a near-miss point, fire through the weapon.
  fireRound(blind) {
    const ai = this.ai, P = this.P, D = this.dir, rng = this.game.rng, now = this.now;
    const from = this.firePoint(this.fireFrom) || this.fireFrom.set(this.npc.pos.x, this.npc.pos.y + 1.5, this.npc.pos.z);
    const pl = D.player;
    const L = D.lkp;
    const dist = Math.hypot(L.x - from.x, L.z - from.z);
    const crouched = ai.perceived ? playerCrouched(pl) : true;
    const hc = this._hc || (this._hc = { dist: 0, tSpot: 0, tExposed: 0, motion: 'stand', kind: 'rifle' });
    hc.dist = dist; hc.tSpot = ai.spotT < 0 ? 0 : now - ai.spotT; hc.tExposed = D.tExposed(); hc.motion = D.playerMotion; hc.kind = this.kind;
    let p = hitChance(hc, P);
    if (blind) p *= P('ai.cover.blindAccMul');
    const hit = rng() < p;
    const tgt = ai.perceived && pl ? pl.pos : L;
    aimPoint(rng, hit, from, tgt, crouched ? 0.75 : 1.3, crouched && !hit, P, this.aim);
    if (this.allyInLine(from, this.aim)) return false;                 // hold fire rather than shoot an ally [ASSUMED]
    const w = this.npc.weapon;
    if (typeof w.setBlind === 'function') w.setBlind(!!blind);
    const ok = w.fireAt(this.aim);
    if (ok) {
      ai.shotTimes[ai.shotI] = now; ai.shotI = (ai.shotI + 1) % SHOT_RING;
      ai.lastShotT = now;
      ai.lastHitRoll = hit; ai.lastP = p;
    }
    return ok;
  }

  get kind() { return this.npc.weaponKind || 'rifle'; }

  // An ally's body within 0.6 m of the muzzle → aim-point segment (extended 3 m past the point).
  allyInLine(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.hypot(dx, dy, dz) || 1;
    for (const o of this.dir.npcs) {
      if (o === this.npc || !o.alive) continue;
      const px = o.pos.x - a.x, py = o.pos.y + 1.0 - a.y, pz = o.pos.z - a.z;
      const t = (px * dx + py * dy + pz * dz) / L;
      if (t < 0 || t > L + 3) continue;
      const cx = px - dx / L * t, cy = py - dy / L * t, cz = pz - dz / L * t;
      if (cx * cx + cz * cz < 0.36 && Math.abs(cy) < 0.9) return true;
    }
    return false;
  }

  // Muzzle for the weapon (createWeapon override): the post's pop-up / lean point while fighting from cover, else the
  // rig's muzzle socket, else chest height in front.
  muzzle(out) {
    const ai = this.ai, npc = this.npc;
    const pf = ai.atPost && ai.post && !ai.moving ? (ai.perchMode && ai.post.perchFire) || (isCoverLike(ai.post) && ai.post.fire) : null;
    if (pf) return out.set(pf.x, pf.y - 0.1, pf.z);
    const sock = npc.rig && typeof npc.rig.socket === 'function' ? npc.rig.socket('muzzle') : null;
    if (sock && typeof sock.getWorldPosition === 'function') return sock.getWorldPosition(out);
    return out.set(npc.pos.x + Math.sin(npc.yaw) * 0.45, npc.pos.y + 1.42, npc.pos.z + Math.cos(npc.yaw) * 0.45);
  }

  // ---- director requests -------------------------------------------------------------------------------------------
  startFlank(post, route, rating) {
    const ai = this.ai;
    this.claim(post);
    ai.flanker = true; ai.flankPost = post; ai.flankRoute = route; ai.flankRating = rating;
    ai.path = route; ai.pathI = route.length > 1 ? 1 : 0; ai.moving = true; ai.speed = this.P('ai.move.run');
    ai.goal.x = post.x; ai.goal.y = post.y; ai.goal.z = post.z; ai.goal.valid = true; ai.goalKind = 'post';
    ai.atPost = false;
    this.setPhase('none');
    this.dir.bark(this.npc, 'Moving around!');
  }

  startConfirm() { this.ai.confirmLKP = true; this.ai.confirmArrived = false; this.release(); this.stop(); }
  endConfirm() { this.ai.confirmLKP = false; this.ai.confirmArrived = false; this.ai.queryDueT = 0; }

  requestThrow(x, y, z) {
    const ai = this.ai;
    ai.throwTarget.x = x; ai.throwTarget.y = y; ai.throwTarget.z = z;
    ai.throwPhase = 'bark'; ai.throwT = this.now; ai.released = false;
    this.stop();
    this.dir.bark(this.npc, 'Grenade out!');
    this.setBehavior('throw');
  }

  // Bark at request, release exactly barkLead s later (spec §8: bark 0.6 s before release), anim around the release.
  updateThrow() {
    const ai = this.ai, P = this.P, now = this.now, g = this.game;
    const lead = P('ai.grenade.barkLead'), dur = P('ai.grenade.throwTime'), rel = P('ai.grenade.releaseAt') * dur;
    const animStart = ai.throwT + Math.max(0, lead - rel);
    ai.throwPhase = now < animStart ? 'bark' : 'throw';
    if (!ai.released && now >= ai.throwT + lead) {
      ai.released = true;
      const ok = g.grenades && g.grenades.throwAt(this.npc, ai.throwTarget, { arc: 'high' });
      emitState(g, this.npc, 'ai.throw', 'windup', ok ? 'release' : 'failed');
    }
    if (now >= animStart + dur) { ai.throwPhase = null; this.setBehavior('idle'); ai.queryDueT = 0; }
  }

  warnGrenade(gr, land, delay) {
    const ai = this.ai;
    if (ai.flee === gr || ai.fleePending === gr) return;
    ai.fleePending = gr; ai.fleeAt = this.now + delay;
    ai.fleeLand.x = land.x; ai.fleeLand.y = land.y; ai.fleeLand.z = land.z;
  }

  beginFlee() {
    const ai = this.ai, P = this.P, npc = this.npc, gr = ai.fleePending;
    ai.fleePending = null;
    const live = this.game.grenades && this.game.grenades.live;
    if (!gr || !live || live.indexOf(gr) < 0 || gr.alive === false) return;
    const L = ai.fleeLand, R = P('ai.grenade.fleeRadius');
    const dx = npc.pos.x - L.x, dz = npc.pos.z - L.z, d = Math.hypot(dx, dz);
    if (d > R) return;
    ai.throwPhase = null;
    if (gr.fuseLeft !== undefined && gr.fuseLeft < P('ai.grenade.diveFuse')) {      // no time to run: dive in place
      ai.hitUntil = this.now + 0.6; this._dv = this._dv || { x: 0, y: 0, z: 0 }; this._dv.x = dx; this._dv.z = dz; this.setHit(this._dv, 'dive', this.now);
      this.setBehavior('hitreact');
      return;
    }
    const ux = d > 1e-3 ? dx / d : Math.sin(npc.yaw), uz = d > 1e-3 ? dz / d : Math.cos(npc.yaw);
    const run = R - d + 1.5;
    const tx = npc.pos.x + ux * run, tz = npc.pos.z + uz * run;
    this.release();
    if (this.goTo(tx, npc.pos.y, tz, P('ai.move.sprint'), 'flee')) {
      ai.flee = gr;
      this.setBehavior('flee');
      this.setPhase('none');
      this.dir.bark(npc, 'Grenade!');
    }
  }

  updateFlee() {
    const ai = this.ai, live = this.game.grenades && this.game.grenades.live;
    const gone = !live || live.indexOf(ai.flee) < 0 || ai.flee.alive === false;
    if (gone || (!ai.moving && dist2D(this.npc.pos, ai.fleeLand) > this.P('ai.grenade.fleeRadius'))) {
      if (gone) { ai.flee = null; ai.queryDueT = 0; this.setBehavior('idle'); }
    }
  }

  // ---- investigate (§2) --------------------------------------------------------------------------------------------
  startInvestigate(role, pos, delay) {
    const ai = this.ai;
    this.setAlert('suspicious');
    ai.inv = { role, x: pos.x, y: pos.y, z: pos.z, startAt: this.now + delay, phase: 'wait', lookUntil: 0 };
    emitState(this.game, this.npc, 'ai.investigate', 'none', role);
  }

  endInvestigate() {
    const ai = this.ai;
    ai.inv = null;
    ai.meter = Math.min(ai.meter, 0.99);
    this.setAlert('unaware');
    this.goTo(this.home.x, this.home.y, this.home.z, this.P('ai.move.walk'), 'home');
  }

  investigate() {
    const ai = this.ai, P = this.P, now = this.now, inv = ai.inv;
    if (!inv) { this.setAlert('unaware'); return; }
    this.setBehavior(ai.moving ? 'move' : 'look');
    if (inv.phase === 'wait') { if (now >= inv.startAt) inv.phase = inv.role === 'investigator' ? 'go' : 'watch'; return; }
    if (inv.phase === 'go') {
      const d = dist2D(this.npc.pos, inv);
      if (d <= P('ai.investigate.standOff')) { this.stop(); inv.phase = 'look'; inv.lookUntil = now + P('ai.investigate.lookAround'); return; }
      if (!ai.moving && !this.goTo(inv.x, inv.y, inv.z, P('ai.move.walk'), 'investigate')) { inv.phase = 'look'; inv.lookUntil = now + P('ai.investigate.lookAround'); }
      return;
    }
    if (inv.phase === 'look' && now >= inv.lookUntil) this.dir.investigationOver();
  }

  // ---- search (§2) -------------------------------------------------------------------------------------------------
  search() {
    const ai = this.ai, P = this.P, D = this.dir;
    if (D.vantage && D.vantage.searchStep(this)) return;          // defenders search from their hard point (vantage.js)
    this.setBehavior(ai.moving ? 'search' : 'look');
    if (ai.detour) {
      if (!ai.moving || ai.goalKind !== 'detour') {
        if (dist2D(this.npc.pos, ai.detour) < 1.0 || !this.goTo(ai.detour.x, ai.detour.y, ai.detour.z, P('ai.move.searchSpeed'), 'detour')) ai.detour = null;
      }
      return;
    }
    const loop = D.loops[ai.searchLoop];
    if (!loop || !loop.length) return;
    if (!ai.moving) {
      const p = loop[ai.searchI];
      if (dist2D(this.npc.pos, p) < 1.0) ai.searchI = (ai.searchI + ai.searchDir + loop.length) % loop.length;
      const q = loop[ai.searchI];
      if (!this.goTo(q.x, q.y, q.z, P('ai.move.searchSpeed'), 'search')) ai.searchI = (ai.searchI + ai.searchDir + loop.length) % loop.length;
    }
  }

  // ---- ambient (unaware) -------------------------------------------------------------------------------------------
  ambient() {
    const ai = this.ai;
    this.setBehavior(ai.moving ? 'move' : 'idle');
    this.setPhase('none');
  }

  // ================================================================================================ movement
  claim(post) {
    const ai = this.ai;
    if (ai.post && ai.post !== post && ai.post.claimedBy === this.npc) ai.post.claimedBy = null;
    post.claimedBy = this.npc;
    ai.post = post;
    ai.atPost = false;
  }

  release() {
    const ai = this.ai;
    if (ai.post && ai.post.claimedBy === this.npc) ai.post.claimedBy = null;
    ai.post = null; ai.atPost = false;
  }

  // Path to a goal (level.nav.findPath; allocates only when the goal changes). Returns false if unreachable.
  goTo(x, y, z, speed, kind) {
    const ai = this.ai, npc = this.npc;
    ai.speed = speed;
    if (ai.moving && ai.goal.valid && Math.hypot(ai.goal.x - x, ai.goal.z - z) < 0.3 && Math.abs(ai.goal.y - y) < 1) { ai.goalKind = kind; return true; }
    const nav = this.dir.nav;
    const g = this.tmp.target.set(x, y, z);
    const path = nav && nav.findPath ? nav.findPath(npc.pos, g) : null;
    if (!path || !path.length) return false;
    ai.path = path; ai.pathI = path.length > 1 ? 1 : 0;
    ai.goal.x = x; ai.goal.y = y; ai.goal.z = z; ai.goal.valid = true; ai.goalKind = kind;
    ai.moving = true; ai.atPost = false;
    this.lastProgress.x = npc.pos.x; this.lastProgress.z = npc.pos.z; this.lastProgress.t = this.now; this.lastProgress.repaths = 0;
    return true;
  }

  stop() { const ai = this.ai; ai.moving = false; ai.path = null; ai.goal.valid = false; }
  stopInPlace() { this.npc.vel.x *= 0.8; this.npc.vel.z *= 0.8; }

  arrived(kind) {
    const ai = this.ai, P = this.P, now = this.now, rng = this.game.rng;
    ai.moving = false; ai.path = null;
    if (kind === 'post' && ai.post) {
      ai.atPost = true; ai.postArriveT = now;
      this.setPhase(isCoverLike(ai.post) ? 'idle' : 'none');
      ai.aimReadyAt = now + randRange(rng, 0.2, 0.6);                                         // [ASSUMED] settle
      ai.peekAt = now + randRange(rng, P('ai.cover.peekGapMin'), P('ai.cover.peekGapMax'));
      ai.fireLosNext = 0;
    }
    if (kind === 'flee') ai.queryDueT = 0;
  }

  move(dt) {
    const ai = this.ai, P = this.P, npc = this.npc, v = npc.vel, now = this.now;
    let tx = 0, tz = 0;
    if (ai.moving && ai.path && npc.alive && ai.hitUntil <= now && !ai.throwPhase) {
      const path = ai.path, arrive = P('ai.move.arrive');
      while (ai.pathI < path.length) {
        const wp = path[ai.pathI];
        const last = ai.pathI === path.length - 1;
        if (Math.hypot(wp.x - npc.pos.x, wp.z - npc.pos.z) <= (last ? 0.15 : arrive)) ai.pathI++;
        else break;
      }
      if (ai.pathI >= path.length) this.arrived(ai.goalKind);
      else {
        const wp = path[ai.pathI];
        const dx = wp.x - npc.pos.x, dz = wp.z - npc.pos.z, d = Math.hypot(dx, dz) || 1;
        const last = ai.pathI === path.length - 1;
        const sp = ai.speed * (last ? Math.min(1, 0.25 + d / 0.8) : 1);
        tx = dx / d * sp; tz = dz / d * sp;
        // stuck: under 0.3 m of progress in 1 s → re-path, then give up
        if (now - this.lastProgress.t > 1) {
          const prog = Math.hypot(npc.pos.x - this.lastProgress.x, npc.pos.z - this.lastProgress.z);
          this.lastProgress.x = npc.pos.x; this.lastProgress.z = npc.pos.z; this.lastProgress.t = now;
          if (prog < 0.3) {
            if (++this.lastProgress.repaths > 2) { this.stop(); ai.queryDueT = 0; }
            else { const gk = ai.goalKind; ai.moving = false; if (!this.goTo(ai.goal.x, ai.goal.y, ai.goal.z, ai.speed, gk)) this.stop(); }
          }
        }
      }
    }
    // separation from allies (actors don't collide with each other in world.js)
    const sep = P('ai.move.separation');
    for (const o of this.dir.npcs) {
      if (o === npc || !o.alive) continue;
      const dx = npc.pos.x - o.pos.x, dz = npc.pos.z - o.pos.z, d = Math.hypot(dx, dz);
      if (d < sep && d > 1e-4 && Math.abs(npc.pos.y - o.pos.y) < 1) { const k = (sep - d) / sep * 2.0; tx += dx / d * k; tz += dz / d * k; }
    }
    const acc = P('ai.move.accel') * dt;
    const ex = tx - v.x, ez = tz - v.z, e = Math.hypot(ex, ez);
    if (e <= acc) { v.x = tx; v.z = tz; } else { v.x += ex / e * acc; v.z += ez / e * acc; }
    if (!npc.alive) { v.x = 0; v.z = 0; }
    this.delta.set(v.x * dt, this.vy * dt, v.z * dt);
    const res = this.game.world.moveCapsule(npc, this.delta, MOVE_OPTS);
    this.vy = res.grounded ? 0 : Math.max(-20, this.vy - 9.81 * dt);
  }

  face(dt) {
    const ai = this.ai, npc = this.npc, D = this.dir, P = this.P, v = npc.vel;
    if (!npc.alive) return;
    let target = null;
    const sp = Math.hypot(v.x, v.z);
    if (ai.hitUntil > this.now) return;
    if (ai.alert === 'combat' && !ai.moving && D.lkp.valid) {
      if (ai.atPost && isCoverLike(ai.post)) {
        target = yawTo(-ai.post.nx, -ai.post.nz);              // root faces INTO the wall in cover (animator contract)
      } else target = yawTo(D.lkp.x - npc.pos.x, D.lkp.z - npc.pos.z);
    } else if (ai.throwPhase) target = yawTo(ai.throwTarget.x - npc.pos.x, ai.throwTarget.z - npc.pos.z);
    else if (sp > 0.3) target = yawTo(v.x, v.z);
    else if (ai.inv) {
      const base = yawTo(ai.inv.x - npc.pos.x, ai.inv.z - npc.pos.z);
      target = ai.inv.phase === 'look' ? base + Math.sin(this.now * 1.1) * 0.9 : base;
    } else if ((ai.alert === 'unaware' || ai.alert === 'search') && ai.meter > 0 && ai.lastSeen.valid) {
      target = yawTo(ai.lastSeen.x - npc.pos.x, ai.lastSeen.z - npc.pos.z);   // white phase: stop and look (P)
    } else if (ai.lookAt != null && !ai.moving) target = ai.lookAt;   // defend search: look outward (vantage.js)
    else if (ai.alert === 'unaware' && !ai.moving) target = this.home.yaw;
    if (target === null) { this.turnRate = 0; return; }
    const d = wrapAngle(target - npc.yaw), max = P('ai.move.turnRate') * dt;
    const step = clamp(d, -max, max);
    npc.yaw = wrapAngle(npc.yaw + step);
    this.turnRate = step / dt;
  }

  // ================================================================================================ outputs
  setBehavior(b) {
    const ai = this.ai;
    if (ai.behavior === b) return;
    emitState(this.game, this.npc, 'ai.behavior', ai.behavior, b);
    ai.behavior = b;
  }

  setPhase(p) {
    const ai = this.ai;
    if (ai.coverPhase === p) return;
    emitState(this.game, this.npc, 'ai.cover', ai.coverPhase, p);
    ai.coverPhase = p;
    ai.phaseT = this.now;
  }

  // animState for character/animator.js (design.md "character/*: rig").
  writeAnim() {
    const npc = this.npc, ai = this.ai, a = npc.anim, now = this.now, v = npc.vel, D = this.dir;
    const c = Math.cos(npc.yaw), s = Math.sin(npc.yaw);
    a.speed = Math.hypot(v.x, v.z);
    a.localVel.z = v.x * s + v.z * c;                              // forward = (sin yaw, cos yaw)
    a.localVel.x = v.x * c - v.z * s;                              // local +X (character's left) = (cos yaw, −sin yaw)
    a.turnRate = this.turnRate || 0;
    a.fireT = now - ai.lastShotT;
    a.action = null;
    a.aim.on = false; a.aim.weight = 0;
    if (!npc.alive) {
      a.mode = 'death';
      a.death.t = now - ai.deathT; a.death.dir = ai.deathDir;
      return;
    }
    if (ai.hitUntil > now && ai.hit) {
      a.mode = 'hitreact';
      a.hit.dir = ai.hit.dir; a.hit.part = ai.hit.part; a.hit.t = now - ai.hit.t0;
      return;
    }
    const inCover = ai.alert === 'combat' && ai.atPost && isCoverLike(ai.post) && !ai.moving && !ai.flee;
    a.mode = inCover ? 'cover' : 'locomotion';
    if (inCover) {
      const post = ai.post, cv = a.cover;
      cv.height = post.height; cv.top = post.top;
      // side +1 = facing the character's right (root −X) along the wall
      const rx = -c, rz = s;
      cv.side = post.lean ? (post.tx * post.lean * rx + post.tz * post.lean * rz >= 0 ? 1 : -1) : 1;
      const ph = ai.coverPhase;
      cv.pose = ph === 'aim' || ph === 'peek' ? (post.height === 'high' ? 'lean' : 'popup') : ph === 'blind' ? 'blind' : 'idle';
      cv.t = clamp((now - ai.phaseT) / 0.25, 0, 1);
    }
    const aiming = (ai.coverPhase === 'aim' || ai.coverPhase === 'blind' || ai.coverPhase === 'peek') && D.lkp.valid;
    if (aiming) {
      const dx = D.lkp.x - npc.pos.x, dz = D.lkp.z - npc.pos.z;
      a.aim.on = true; a.aim.weight = ai.coverPhase === 'peek' ? 0.5 : 1;
      a.aim.yaw = wrapAngle(yawTo(dx, dz) - npc.yaw);
      a.aim.pitch = Math.atan2(D.lkp.y + 1.2 - (npc.pos.y + 1.5), Math.hypot(dx, dz) || 1);
    }
    const st = npc.weapon && npc.weapon.state;
    if (st && st.reloading) { a.action = this._act || (this._act = { type: 'reload', t: 0 }); a.action.type = 'reload'; a.action.t = st.reloadDur ? clamp(st.reloadT / st.reloadDur, 0, 1) : 0.5; }
    if (ai.throwPhase) {
      const P = this.P, dur = P('ai.grenade.throwTime'), rel = P('ai.grenade.releaseAt') * dur;
      const animStart = ai.throwT + Math.max(0, P('ai.grenade.barkLead') - rel);
      a.action = this._act || (this._act = { type: 'throw', t: 0 });
      a.action.type = ai.throwPhase === 'bark' ? 'throwAim' : 'throw';
      a.action.t = clamp((now - animStart) / dur, 0, 1);
    }
  }

  // U4 indicator (C): white while noticing, yellow when suspicious / searching, orange in combat.
  hud() {
    const hud = this.game.hud, ai = this.ai;
    if (!hud || typeof hud.awareness !== 'function') return;
    if (ai.alert === 'unaware') hud.awareness(this.npc, Math.min(1, ai.meter), 'unaware');
    else if (ai.alert === 'suspicious') hud.awareness(this.npc, clamp(ai.meter - 1, 0, 1), 'suspicious');
    else if (ai.alert === 'search') hud.awareness(this.npc, clamp(ai.meter / 2, 0, 1), 'search');
    else if (ai.alert === 'combat') hud.awareness(this.npc, 1, 'combat');
  }
}

function magSize(w) {
  if (typeof w.magSize === 'number') return w.magSize;
  if (typeof w.param === 'function') { try { return w.param('magSize'); } catch { /* fall through */ } }
  return 30;
}
