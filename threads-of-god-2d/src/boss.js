// boss.js — Arelius AI. WP-C implements.
// HARD RULES (from TOG source design):
// - NEVER imports input.js. No action queuing/buffering of any kind: decisions
//   happen only on decision ticks after cooldown (assertion #5b).
// - Weighted-random selection with pity counters — never fixed sequences.
// - Reactive defense escalates against repeated player moves.
// - Poise decay scale follows smoothstep01(hp/hpMax) — TOG's Arelius curve.

import { CONFIG } from './config.js';
import { STATES } from './fighter.js';
import { smoothstep01, clamp } from './utils.js';

export class BossAI {
  /**
   * @param {object} o
   * @param {import('./fighter.js').Fighter} o.fighter
   * @param {object} o.config CONFIG
   * @param {import('./utils.js').RNG} o.rng  (the single shared seeded RNG)
   * @param {import('./utils.js').EventBus} o.bus
   */
  constructor({ fighter, config, rng, bus }) {
    this.fighter = fighter;
    this.config = config;
    this.rng = rng;
    this.bus = bus;
    this.phase = 1;
    this.enabled = true;            // false = stands idle (assertion setup)
    this._forcedAttackId = null;

    const B = config.BOSS;
    const ph1 = B.phases[1];

    this._decisionCooldown = rng.int(
      B.decisionCooldownFrames[0],
      B.decisionCooldownFrames[1]
    );

    this._nonFollowUpStreak = 0;
    this._followUpPityAt = rng.int(ph1.followUpPityRange[0], ph1.followUpPityRange[1]);

    this._nonSequenceStreak = 0;
    this._sequencePityAt = rng.int(ph1.sequencePityRange[0], ph1.sequencePityRange[1]);

    // Sliding window of recent player attack ids
    this._recentPlayerMoves = [];

    this._stuckSwordX = null;
    this._lastDecision = null;
    this._rangeBand = 'mid';

    // Attack-end tracking
    this._prevWasAttacking = false;
    // The def of the most recently started attack (read by _onAttackEnd)
    this._lastStartedAttackDef = null;
    // Whether the completed attack hit anyone
    this._lastCompletedAttackHitSomeone = false;
    // Whether the attack currently in progress has hit someone this swing
    this._currentAttackHitSomeone = false;

    // Follow-up trigger: set after attack ends, consumed at top of next update
    this._pendingFollowUpDef = null;

    // teleportStrike: after TELEPORT exits, trigger immediate strike
    this._pendingTeleportStrike = false;
    // Whether PHASE_TRANSITION just ended and we need to clear invuln
    this._clearInvulnAfterTransition = false;
    // Phase of the previous tick (to detect PHASE_TRANSITION exit)
    this._prevState = STATES.IDLE;

    this._tick = 0;
  }

  _phaseCfg() {
    return this.config.BOSS.phases[this.phase];
  }

  /** All attack ids available to the current phase (keys in attackWeights + unlocks). */
  _availableAttackIds() {
    const B = this.config.BOSS;
    const ph = this._phaseCfg();
    // Phase 1: only non-phase2-tagged attacks
    // Phase 2: base + unlocks (phase2 tag gated by unlocks list)
    return Object.keys(ph.attackWeights).filter(id => {
      const def = B.attacks[id];
      if (!def) return false;
      if (def.tags && def.tags.includes('phase2') && this.phase < 2) return false;
      return true;
    });
  }

  /**
   * Build a working copy of phase attackWeights filtered to a range band and
   * current phase unlocks, with teleportStrike boost if sword is stuck.
   * NEVER mutates CONFIG.
   */
  _buildWeightMap(rangeBand) {
    const B = this.config.BOSS;
    const ph = this._phaseCfg();
    const rawWeights = ph.attackWeights;
    const available = new Set(this._availableAttackIds());

    const copy = {};
    for (const id of available) {
      const def = B.attacks[id];
      if (!def) continue;
      if (def.rangeBands && def.rangeBands.length > 0 && !def.rangeBands.includes(rangeBand)) {
        continue;
      }
      copy[id] = id in rawWeights ? rawWeights[id] : 0;
    }

    if (this._stuckSwordX !== null && this.phase >= 2 && 'teleportStrike' in copy) {
      copy['teleportStrike'] = ph.teleportStrikeWeightWhenSwordStuck;
    }

    return copy;
  }

  _rangeBandFor(dx) {
    const rb = this.config.BOSS.rangeBands;
    const absDx = Math.abs(dx);
    if (absDx <= rb.close) return 'close';
    if (absDx <= rb.mid) return 'mid';
    return 'far';
  }

  _countRepeats(attackId) {
    return this._recentPlayerMoves.filter(id => id === attackId).length;
  }

  _recordPlayerMove(attackId) {
    const mem = this.config.BOSS.defense.repeatMemory;
    this._recentPlayerMoves.push(attackId);
    if (this._recentPlayerMoves.length > mem) this._recentPlayerMoves.shift();
  }

  _isAttackAvailable(id) {
    return this._availableAttackIds().includes(id);
  }

  _resetDecisionCooldown() {
    const B = this.config.BOSS;
    this._decisionCooldown = this.rng.int(
      B.decisionCooldownFrames[0],
      B.decisionCooldownFrames[1]
    );
  }

  _emitDecision(decision, attackId, rangeBand, rolls, pity) {
    this._lastDecision = decision;
    const payload = { tick: this._tick, decision, rangeBand, rolls, pity };
    if (attackId != null) payload.attackId = attackId;
    this.bus.emit('bossDecision', payload);
  }

  /**
   * Per-tick. LAYERS, in priority order:
   * L0 Reactive defense → L1 Opportunity → L2 Decision tick.
   */
  update(dt, ctx) {
    const { player, combat } = ctx;
    const f = this.fighter;
    const B = this.config.BOSS;
    this._tick++;

    // Always: poise decay scale curve
    f.poiseDecayScale = smoothstep01(f.hp / B.hpMax);

    // Sync stuck sword
    this._syncStuckSword(combat);

    // Detect PHASE_TRANSITION exit → clear invuln
    if (
      this._clearInvulnAfterTransition &&
      f.state !== STATES.PHASE_TRANSITION
    ) {
      f.invulnerable = false;
      this._clearInvulnAfterTransition = false;
    }
    this._prevState = f.state;

    if (!this.enabled) {
      if (this._pendingTeleportStrike) this._pendingTeleportStrike = false;
      return;
    }

    // Detect pending teleport-strike: TELEPORT just exited → start the strike
    if (this._pendingTeleportStrike && f.state !== STATES.TELEPORT) {
      this._pendingTeleportStrike = false;
      this._startAttackById('teleportStrike', false);
      this._emitDecision('teleportStrike', 'teleportStrike', this._rangeBand, {}, {});
      return;
    }

    // Record player's current attack on the first frame of the windup
    if (player.state === STATES.ATTACK && player.attack && player.stateFrame === 1) {
      this._recordPlayerMove(player.attack.def.id);
    }

    // Track whether the current boss attack hits anyone (combat updates after this,
    // so we check last tick's hit state via the attack's hitVictims set size)
    const isAttacking = f.state === STATES.ATTACK;
    if (isAttacking && f.attack) {
      if (f.attack.hitVictims && f.attack.hitVictims.size > 0) {
        this._currentAttackHitSomeone = true;
      }
    }

    // Detect attack just ended
    if (this._prevWasAttacking && !isAttacking) {
      this._onAttackEnd();
    }
    this._prevWasAttacking = isAttacking;

    // Pending follow-up (set by _onAttackEnd, consumed here — skips decision cooldown)
    if (this._pendingFollowUpDef !== null) {
      if (!f.canAct()) {
        // Boss is in HITSTUN or other non-volitional state — discard, do not retry
        this._pendingFollowUpDef = null;
      } else {
        const fuDef = this._pendingFollowUpDef;
        this._pendingFollowUpDef = null;
        if (this._tryFollowUp(fuDef)) return;
      }
    }

    // L0: Reactive defense — only while idle or moving
    if (f.state === STATES.IDLE || f.state === STATES.MOVE) {
      if (this._tryReactiveDefense(player)) return;
    }

    // L1: Opportunity
    if (f.canAct()) {
      if (this._tryOpportunity(player, combat)) return;
    }

    // Decision cooldown countdown
    if (this._decisionCooldown > 0) {
      this._decisionCooldown--;
      return;
    }

    // L2: Decision tick
    if (!f.canAct()) return;
    this._doDecisionTick(player, combat);
  }

  _syncStuckSword(combat) {
    if (!combat || !combat.projectiles) return;
    const stuck = combat.projectiles.find(p => p.stuck && p.owner === 'boss');
    this._stuckSwordX = stuck ? stuck.stuckX : null;
  }

  /** Called the tick the boss attack state exits. */
  _onAttackEnd() {
    const B = this.config.BOSS;
    const f = this.fighter;

    // Capture the def before it's gone (attack is now null on the fighter)
    // We track _lastStartedAttackDef set when startAttack was called
    const prevDef = this._lastStartedAttackDef;
    const hitSomeone = this._currentAttackHitSomeone;
    this._currentAttackHitSomeone = false;

    // Whiff kneel: heavy attack that hit nobody
    if (prevDef && prevDef.onWhiffKneel && !hitSomeone) {
      if (this.rng.chance(B.kneelChanceOnHeavyWhiff)) {
        f.setState(STATES.KNEEL, { duration: B.kneelDurationFrames });
        this.bus.emit('kneel', { ownerId: 'boss' });
        return;
      }
    }

    // Signal follow-up opportunity for next tick
    this._pendingFollowUpDef = prevDef || null;
  }

  /** Try follow-up attack from prevDef.followUpPool. Returns true if started. */
  _tryFollowUp(prevDef) {
    // No opportunity: prev attack had no follow-up pool at all — don't burn the pity clock
    if (!prevDef || !prevDef.followUpPool || prevDef.followUpPool.length === 0) {
      return false;
    }

    const ph = this._phaseCfg();
    const guaranteed = this._nonFollowUpStreak >= this._followUpPityAt;
    const roll = this.rng.next();
    const pity = { nonFollowUpStreak: this._nonFollowUpStreak, followUpPityAt: this._followUpPityAt };

    if (guaranteed || roll < ph.followUpChance) {
      const available = prevDef.followUpPool.filter(id => this._isAttackAvailable(id));
      if (available.length > 0) {
        const id = this.rng.pick(available);
        this._startAttackById(id, true);
        this._nonFollowUpStreak = 0;
        // Re-roll pity threshold
        this._followUpPityAt = this.rng.int(ph.followUpPityRange[0], ph.followUpPityRange[1]);
        this._emitDecision('followUp', id, this._rangeBand, { roll, followUpChance: ph.followUpChance }, pity);
        return true;
      }
      // Pool exists but no available attack after phase filtering: guarantee was swallowed — reset
      if (guaranteed) {
        this._nonFollowUpStreak = 0;
        this._followUpPityAt = this.rng.int(ph.followUpPityRange[0], ph.followUpPityRange[1]);
      }
    }

    this._nonFollowUpStreak++;
    // Re-roll pity if we just hit it
    if (this._nonFollowUpStreak >= this._followUpPityAt) {
      this._followUpPityAt = this.rng.int(ph.followUpPityRange[0], ph.followUpPityRange[1]);
      this._nonFollowUpStreak = 0;
    }
    return false;
  }

  /** L0: Reactive defense. Returns true if acted. */
  _tryReactiveDefense(player) {
    const B = this.config.BOSS;
    const f = this.fighter;

    if (player.state !== STATES.ATTACK || !player.attack) return false;
    const def = player.attack.def;
    if (!def.deflectable && !def.blockable) return false;

    const framesUntilActive = def.windup - player.stateFrame;
    if (framesUntilActive < 0 || framesUntilActive > B.deflectWindowFrames + B.defense.reactiveLookaheadFrames) return false;

    // Reach check: is the boss within the attack's reach on the player's facing side?
    const dx = f.x - player.x;
    const facedDx = dx * player.facing;
    const reach = def.hitbox ? (def.hitbox.x + def.hitbox.w) : 0;
    if (facedDx < 0 || facedDx > reach + B.defense.reachPaddingPx) return false;

    const ph = this._phaseCfg();
    const aggression = ph.aggression;
    const defense = B.defense;

    let deflectChance = 0;
    if (def.deflectable) {
      const repeats = this._countRepeats(def.id);
      deflectChance = clamp(
        (defense.baseDeflectChance + defense.perRepeatDeflectBonus * (repeats - 1)) * aggression,
        0,
        defense.maxDeflectChance
      );
    }
    const blockChance = defense.baseBlockChance * aggression;

    const deflectRoll = this.rng.next();
    const rolls = { deflectChance, blockChance, deflectRoll };

    if (def.deflectable && deflectRoll < deflectChance) {
      f.setState(STATES.DEFLECT, { duration: framesUntilActive + B.deflectWindowFrames });
      this._emitDecision('reactiveDeflect', null, this._rangeBand, rolls, {});
      return true;
    }

    if (def.blockable) {
      const blockRoll = this.rng.next();
      rolls.blockRoll = blockRoll;
      if (blockRoll < blockChance) {
        f.setState(STATES.BLOCK);
        this._emitDecision('reactiveBlock', null, this._rangeBand, rolls, {});
        return true;
      }
    }

    return false;
  }

  /** L1: Opportunity attacks. Returns true if acted. */
  _tryOpportunity(player, combat) {
    const B = this.config.BOSS;
    const C = this.config.COMBAT;
    const f = this.fighter;
    const dx = Math.abs(player.x - f.x);

    // Finisher if player is staggered and in snap range
    if (player.state === STATES.STAGGERED && dx <= C.finisherSnapMax) {
      const finDef = B.attacks.finisherBoss;
      if (finDef && combat && combat.tryFinisher) {
        const accepted = combat.tryFinisher(f, player);
        if (accepted) {
          // tryFinisher sets FINISHING/BEING_FINISHED atomically on both fighters
          this._emitDecision('finisher', 'finisherBoss', this._rangeBand, {}, {});
          this._resetDecisionCooldown();
          return true;
        }
      }
    }

    // Punish: player in recovery at close range
    if (
      player.state === STATES.ATTACK &&
      player.attack &&
      player.attackPhase === 'recovery' &&
      dx <= B.rangeBands.close
    ) {
      const weightMap = this._buildWeightMap('close');
      const id = this.rng.weightedPick(weightMap);
      if (id) {
        this._startAttackById(id, false);
        this._emitDecision('punish', id, 'close', {}, {});
        this._resetDecisionCooldown();
        return true;
      }
    }

    return false;
  }

  /** L2 decision tick: movement + attack selection. */
  _doDecisionTick(player, combat) {
    const B = this.config.BOSS;
    const MW = B.movementWeights;
    const f = this.fighter;
    const dx = player.x - f.x;
    const band = this._rangeBandFor(dx);
    this._rangeBand = band;

    // Forced attack override (debug)
    if (this._forcedAttackId) {
      const id = this._forcedAttackId;
      this._forcedAttackId = null;
      if (this._isAttackAvailable(id)) {
        this._doAttack(id, dx, combat);
        this._emitDecision('forced', id, band, {}, {});
        this._resetDecisionCooldown();
        return;
      }
    }

    const vg = B.velocityGate;
    // Player retreating means moving away from boss
    const awayDir = dx > 0 ? -1 : 1;  // direction player would move to retreat
    const playerRetreating = vg.onlyWhenRetreating
      ? (player.vx !== 0 && Math.sign(player.vx) === awayDir)
      : false;
    const velocityGated = Math.abs(player.vx) > vg.speedThreshold && playerRetreating;

    const rolls = {};
    let decision = 'idle';
    let attackId = null;

    if (band === 'far') {
      if (velocityGated) {
        decision = 'advance';
        this._doAdvance(dx, MW.walkMult);
      } else {
        const r = this.rng.next();
        rolls.movementRoll = r;
        if (r < MW.farDashChance) {
          decision = 'dash';
          this._doAdvance(dx, MW.dashMult);
        } else {
          decision = 'advance';
          this._doAdvance(dx, MW.walkMult);
        }
      }
    } else if (band === 'close') {
      if (velocityGated) {
        decision = 'retreat';
        this._doRetreat(dx);
      } else {
        const r = this.rng.next();
        rolls.closeBandRoll = r;
        if (r < MW.closeRetreatChance) {
          decision = 'retreat';
          this._doRetreat(dx);
        } else {
          attackId = this._pickAttack(band);
          if (attackId) {
            decision = 'attack';
            this._doAttack(attackId, dx, combat);
          } else {
            decision = 'retreat';
            this._doRetreat(dx);
          }
        }
      }
    } else {
      // mid: strafe oscillation + attack rolls
      if (velocityGated) {
        decision = 'advance';
        this._doAdvance(dx, MW.strafeMult);
      } else {
        const r = this.rng.next();
        rolls.midBandRoll = r;
        if (r < MW.midAdvanceChance) {
          decision = 'advance';
          this._doAdvance(dx, MW.strafeMult);
        } else if (r < MW.midRetreatCutoff) {
          decision = 'retreat';
          this._doRetreat(dx);
        } else {
          attackId = this._pickAttack(band);
          if (attackId) {
            decision = 'attack';
            this._doAttack(attackId, dx, combat);
          } else {
            decision = r < MW.midFallbackAdvanceChance ? 'advance' : 'retreat';
            if (decision === 'advance') this._doAdvance(dx, MW.strafeMult);
            else this._doRetreat(dx);
          }
        }
      }
    }

    const pity = {
      nonFollowUpStreak: this._nonFollowUpStreak,
      followUpPityAt: this._followUpPityAt,
    };
    this._emitDecision(decision, attackId, band, rolls, pity);
    this._resetDecisionCooldown();
  }

  _pickAttack(band) {
    return this.rng.weightedPick(this._buildWeightMap(band));
  }

  /** Start an attack, handling teleportStrike specially. */
  _doAttack(id, dx, combat) {
    if (id === 'teleportStrike' && this._stuckSwordX !== null) {
      this._doTeleportStrike(combat);
    } else {
      this._startAttackById(id, false);
    }
  }

  _doTeleportStrike(combat) {
    const B = this.config.BOSS;
    const f = this.fighter;
    if (this._stuckSwordX === null) return;

    const targetX = this._stuckSwordX;

    // Consume the stuck projectile
    if (combat && combat.projectiles) {
      const idx = combat.projectiles.findIndex(p => p.stuck && p.owner === 'boss');
      if (idx !== -1) combat.projectiles.splice(idx, 1);
    }
    this._stuckSwordX = null;

    // Warp to sword position, i-framed
    f.x = targetX;
    f.setState(STATES.TELEPORT, { duration: B.teleportFrames });
    this._pendingTeleportStrike = true;
  }

  _doAdvance(dx, speedMult) {
    const f = this.fighter;
    const B = this.config.BOSS;
    const dir = dx > 0 ? 1 : -1;
    f.facing = dir;
    f.vx = dir * (speedMult >= B.movementWeights.dashMult ? B.dashSpeed : B.walkSpeed);
    f.setState(STATES.MOVE);
  }

  _doRetreat(dx) {
    const f = this.fighter;
    const B = this.config.BOSS;
    const dir = dx > 0 ? -1 : 1;
    f.facing = dx > 0 ? 1 : -1;
    f.vx = dir * B.walkSpeed;
    f.setState(STATES.MOVE);
  }

  _startAttackById(id, isFollowUp) {
    const B = this.config.BOSS;
    const def = B.attacks[id];
    if (!def) return false;
    this.fighter.startAttack(def, { isFollowUp });
    this._lastStartedAttackDef = def;
    this._currentAttackHitSomeone = false;
    return true;
  }

  _currentDeflectChance() {
    const B = this.config.BOSS;
    const defense = B.defense;
    const ph = this._phaseCfg();
    const lastId = this._recentPlayerMoves.length > 0
      ? this._recentPlayerMoves[this._recentPlayerMoves.length - 1]
      : null;
    const repeats = lastId ? this._countRepeats(lastId) : 1;
    return clamp(
      (defense.baseDeflectChance + defense.perRepeatDeflectBonus * (repeats - 1)) * ph.aggression,
      0,
      defense.maxDeflectChance
    );
  }

  /** Force next decision to be this attack (debug). Rejects ids not unlocked
   *  in the current phase → returns false. */
  forceAttack(attackId) {
    if (!this._isAttackAvailable(attackId)) return false;
    this._forcedAttackId = attackId;
    return true;
  }

  /** Debug/main: escalate to phase n. If rising: PHASE_TRANSITION ceremony
   *  (invulnerable, phaseTransitionFrames) and EMITS bus.emit('phaseChange',
   *  {phase: n}). Idempotent — same/lower n is a no-op. */
  setPhase(n) {
    if (n <= this.phase) return;
    this.phase = n;
    const B = this.config.BOSS;
    const f = this.fighter;
    f.invulnerable = true;
    f.setState(STATES.PHASE_TRANSITION, { duration: B.phaseTransitionFrames });
    this._clearInvulnAfterTransition = true;

    const ph = this._phaseCfg();
    this._followUpPityAt = this.rng.int(ph.followUpPityRange[0], ph.followUpPityRange[1]);
    this._sequencePityAt = this.rng.int(ph.sequencePityRange[0], ph.sequencePityRange[1]);
    this._nonFollowUpStreak = 0;
    this._nonSequenceStreak = 0;

    this.bus.emit('phaseChange', { phase: n, bossX: this.fighter.x });
  }

  /** Tuning/verification surface. */
  info() {
    return {
      phase: this.phase,
      rangeBand: this._rangeBand,
      nonFollowUpStreak: this._nonFollowUpStreak,
      followUpPityAt: this._followUpPityAt,
      sequencePityAt: this._sequencePityAt,
      recentPlayerMoves: this._recentPlayerMoves.slice(),
      currentDeflectChance: this._currentDeflectChance(),
      lastDecision: this._lastDecision,
      decisionCooldown: this._decisionCooldown,
      stuckSwordX: this._stuckSwordX,
    };
  }
}
