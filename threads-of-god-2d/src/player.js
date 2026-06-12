// player.js — Micheal's controller: movement, combos, guard, dodge, counter,
// finisher. The ONLY consumer of input.js (player-only buffer is structural).
// WP-B implements.

import { CONFIG } from './config.js';
import { ACTIONS } from './input.js';
import { STATES } from './fighter.js';

export class PlayerController {
  /**
   * @param {object} o
   * @param {import('./fighter.js').Fighter} o.fighter
   * @param {import('./input.js').InputSystem} o.input
   * @param {object} o.config CONFIG
   * @param {import('./utils.js').EventBus} o.bus
   */
  constructor({ fighter, input, config, bus }) {
    this.fighter = fighter;
    this.input = input;
    this.config = config;
    this.bus = bus;
    /** Exposed for debug API. Resets to 0 on any non-chain exit from ATTACK. */
    this.comboIndex = 0;

    // Tracks how many ticks the player has held a movement direction for RUN promotion
    this._runHoldTicks = 0;
    // Tracks the last direction held (to detect direction changes resetting run counter)
    this._lastMoveDir = 0;
    // Whether a CHARGE attack has been started and is currently being held
    this._chargingActive = false;
    // State of the fighter at the previous tick (to detect DODGE exit)
    this._prevState = STATES.IDLE;
    // Data of the dodge at the previous tick (to detect through vs back on exit)
    this._prevDodgeData = null;
  }

  /**
   * Per-tick decisions. Priority: finisher > counter > dodge > guard > attacks > movement.
   * @param {number} dt seconds
   * @param {{boss: import('./fighter.js').Fighter, combat: object}} ctx
   */
  update(dt, ctx) {
    const f = this.fighter;
    const input = this.input;
    const pcfg = this.config.PLAYER;
    const boss = ctx.boss;
    const combat = ctx.combat;

    // --- Detect through-dodge completion (facing flip) ---
    // If we were in DODGE with dir:'through' last tick and now we're not DODGING,
    // flip facing toward the boss.
    if (this._prevState === STATES.DODGE &&
        f.state !== STATES.DODGE &&
        this._prevDodgeData && this._prevDodgeData.dir === 'through') {
      // Flip facing toward the boss
      f.facing = boss.x > f.x ? 1 : -1;
    }
    this._prevState = f.state;
    this._prevDodgeData = f.state === STATES.DODGE ? f.stateData : null;

    // --- Dodge motion: controller drives velocity every dodge tick ---
    // (fighter.update applies friction to non-movement states, so we re-set vx
    // each tick; dash covers its full config distance across the duration)
    if (f.state === STATES.DODGE && f.stateData) {
      const d = pcfg.dodge;
      const dist = f.stateData.dir === 'back' ? d.dashBackDist : d.dashThroughDist;
      f.vx = (f.stateData.sign ?? f.facing) * (dist / d.durationFrames) * CONFIG.TIMING.fps;
      return;
    }

    // --- Guard: BLOCK release → IDLE ---
    if (f.state === STATES.BLOCK && !input.held(ACTIONS.GUARD)) {
      f.setState(STATES.IDLE);
      return;
    }

    // --- Guard: DEFLECT preempt at last frame → BLOCK ---
    // player.js runs before fighter.update(), so this fires before the auto-exit.
    if (f.state === STATES.DEFLECT &&
        f.stateFrame === pcfg.deflectWindowFrames - 1 &&
        input.held(ACTIONS.GUARD)) {
      f.setState(STATES.BLOCK);
      return;
    }

    // --- Charge: cancel if no longer held ---
    if (this._chargingActive) {
      if (f.state === STATES.ATTACK && f.attack && f.attack.def.chargeable) {
        if (!input.held(ACTIONS.CHARGE)) {
          // Release — clear the hold flag; fighter.update() will let the swing proceed
          f.attack._chargeHeld = false;
          const level = f.attack.chargeLevel;
          this._chargingActive = false;
          this.bus.emit('chargeRelease', { ownerId: 'player', level });
        } else {
          // Keep the hold flag set
          f.attack._chargeHeld = true;
        }
      } else {
        // Attack ended somehow
        this._chargingActive = false;
      }
    }

    // Non-volitional states: don't take new actions (except combo window check below)
    const nonVolitional = (
      f.state === STATES.HITSTUN ||
      f.state === STATES.BLOCKSTUN ||
      f.state === STATES.DEFLECT_RECOIL ||
      f.state === STATES.STAGGERED ||
      f.state === STATES.FINISHING ||
      f.state === STATES.BEING_FINISHED ||
      f.state === STATES.DEAD
    );

    // --- Combo window check (while in ATTACK recovery) ---
    if (f.state === STATES.ATTACK && f.attack) {
      const atk = f.attack;
      const def = atk.def;

      // Check if we're in recovery phase and if a combo advance is valid
      const recoveryFrame = atk.frame - def.windup - def.active;
      const hasComboNext = def.comboNext && def.comboWindow;

      if (hasComboNext && recoveryFrame >= def.comboWindow[0] && recoveryFrame <= def.comboWindow[1]) {
        // Determine which action drives this combo chain
        const isThrustChain = def.tags && def.tags.includes('pierce');
        const chainAction = isThrustChain ? ACTIONS.THRUST : ACTIONS.SLASH;
        const livePress = input.pressed(chainAction);
        const bufferedPress = !livePress && input.consumeBuffered(chainAction, pcfg.inputBufferMs);

        if (livePress || bufferedPress) {
          const nextDef = this.config.PLAYER.attacks[def.comboNext];
          if (nextDef) {
            this.comboIndex++;
            f.startAttack(nextDef);
            return;
          }
        }
      } else if (hasComboNext && recoveryFrame > def.comboWindow[1]) {
        // Combo window lapsed without input — reset
        this.comboIndex = 0;
      }

      // If in any attack phase, don't process further unless recovery
      // (The return above handles combo advance; fall through to allow movement
      //  later only if in IDLE)
      return;
    }

    if (nonVolitional) return;

    // --- DEFLECT_SUCCESS: check for counter but don't process other inputs ---
    if (f.state === STATES.DEFLECT_SUCCESS) {
      if (f.counterWindow > 0 && (input.pressed(ACTIONS.SLASH) || input.consumeBuffered(ACTIONS.SLASH, pcfg.inputBufferMs))) {
        this.comboIndex = 0;
        f.startAttack(pcfg.attacks.counter, { isCounter: true });
        return;
      }
      return;
    }

    const canAct = f.canAct();

    // Priority 1: FINISHER — SLASH while boss STAGGERED and in range
    if (canAct || f.state === STATES.IDLE || f.state === STATES.MOVE || f.state === STATES.RUN) {
      const dx = Math.abs(boss.x - f.x);
      if (boss.state === STATES.STAGGERED &&
          dx <= this.config.COMBAT.finisherSnapMax &&
          input.pressed(ACTIONS.SLASH)) {
        this.comboIndex = 0;
        combat.tryFinisher(f, boss);
        return;
      }

      // Priority 2: COUNTER — SLASH while counterWindow > 0
      if (f.counterWindow > 0 && input.pressed(ACTIONS.SLASH)) {
        this.comboIndex = 0;
        f.startAttack(pcfg.attacks.counter, { isCounter: true });
        return;
      }
    }

    if (!canAct) return;

    // Priority 3: DODGE
    if (input.pressed(ACTIONS.DODGE)) {
      if (f.dodgeCooldown <= 0) {
        // LEFT held → dash-back (away from boss); else dash-through (crosses to
        // far side). Direction sign LOCKED at start so crossing the boss
        // mid-dodge can't flip it.
        const dir = input.held(ACTIONS.LEFT) ? 'back' : 'through';
        const towardBoss = ctx.boss.x > f.x ? 1 : -1;
        const sign = dir === 'back' ? -towardBoss : towardBoss;
        f.setState(STATES.DODGE, {
          duration: pcfg.dodge.durationFrames,
          data: { dir, sign },
        });
        this.bus.emit('dodge', { ownerId: 'player', dir, x: this.fighter.x, y: CONFIG.ARENA.groundY });
        return;
      }
    }

    // Priority 4: GUARD — press → DEFLECT
    if (input.pressed(ACTIONS.GUARD)) {
      f.setState(STATES.DEFLECT, { duration: pcfg.deflectWindowFrames });
      return;
    }

    // Priority 5a: Charge attack
    if (input.pressed(ACTIONS.CHARGE)) {
      this.comboIndex = 0;
      f.startAttack(pcfg.attacks.charge);
      f.attack._chargeHeld = true;
      this._chargingActive = true;
      this.bus.emit('chargeStart', { ownerId: 'player' });
      return;
    }

    // Priority 5b: Thrust combo
    if (input.pressed(ACTIONS.THRUST)) {
      this.comboIndex = 0;
      f.startAttack(pcfg.attacks.thrust1);
      return;
    }

    // Priority 5c: Slash (chain start) — or running attack
    if (input.pressed(ACTIONS.SLASH)) {
      this.comboIndex = 0;
      if (f.state === STATES.RUN) {
        f.startAttack(pcfg.attacks.runningAttack);
      } else {
        f.startAttack(pcfg.attacks.slash1);
      }
      return;
    }

    // Priority 6: Movement
    const leftHeld = input.held(ACTIONS.LEFT);
    const rightHeld = input.held(ACTIONS.RIGHT);
    const moveDir = rightHeld && !leftHeld ? 1 : leftHeld && !rightHeld ? -1 : 0;

    if (moveDir !== 0) {
      // Always face the boss when idle/moving
      f.facing = boss.x > f.x ? 1 : -1;

      if (moveDir === this._lastMoveDir) {
        this._runHoldTicks++;
      } else {
        this._runHoldTicks = 1;
        this._lastMoveDir = moveDir;
      }

      if (this._runHoldTicks >= pcfg.runPromoteTicks) {
        if (f.state !== STATES.RUN) {
          f.setState(STATES.RUN);
        }
      } else {
        if (f.state !== STATES.MOVE && f.state !== STATES.RUN) {
          f.setState(STATES.MOVE);
        } else if (f.state === STATES.RUN && this._runHoldTicks < pcfg.runPromoteTicks) {
          // Direction just changed — demote from RUN to MOVE
          f.setState(STATES.MOVE);
        }
      }

      // Set velocity
      const speed = f.state === STATES.RUN ? pcfg.runSpeed : pcfg.walkSpeed;
      f.vx = moveDir * speed;
    } else {
      this._runHoldTicks = 0;
      this._lastMoveDir = 0;
      if (f.state === STATES.MOVE || f.state === STATES.RUN) {
        f.setState(STATES.IDLE);
        f.vx = 0;
      }
      // Still face the boss when idle
      f.facing = boss.x > f.x ? 1 : -1;
    }
  }
}
