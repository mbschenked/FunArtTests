// fighter.js — shared fighter entity: FSM, resources, timers, hitboxes.
// WP-A implements (together with combat.js — they are the coupled heart).
//
// SINGLE-WRITER RULE: combat-outcome states (HITSTUN, BLOCKSTUN, DEFLECT_RECOIL,
// DEFLECT_SUCCESS, STAGGERED, FINISHING, BEING_FINISHED, DEAD) are set ONLY by
// CombatSystem. Controllers (player.js / boss.js) set volitional states only
// (MOVE, RUN, ATTACK, DODGE, BLOCK, DEFLECT, KNEEL, TELEPORT, PHASE_TRANSITION).

import { CONFIG } from './config.js';
import { clamp } from './utils.js';

export const STATES = Object.freeze({
  IDLE: 'IDLE', MOVE: 'MOVE', RUN: 'RUN',
  DODGE: 'DODGE', BLOCK: 'BLOCK', DEFLECT: 'DEFLECT',
  ATTACK: 'ATTACK',
  HITSTUN: 'HITSTUN', BLOCKSTUN: 'BLOCKSTUN',
  DEFLECT_RECOIL: 'DEFLECT_RECOIL',     // you got deflected (attacker side)
  DEFLECT_SUCCESS: 'DEFLECT_SUCCESS',   // you deflected (defender side; counter window)
  STAGGERED: 'STAGGERED',               // poise broke at max — finisher-eligible
  FINISHING: 'FINISHING', BEING_FINISHED: 'BEING_FINISHED',
  KNEEL: 'KNEEL',                       // boss-only whiff vulnerability
  TELEPORT: 'TELEPORT',                 // boss-only, i-framed
  PHASE_TRANSITION: 'PHASE_TRANSITION', // boss-only, invulnerable ceremony
  DEAD: 'DEAD',
});

// States that are written only by CombatSystem
const COMBAT_STATES = new Set([
  STATES.HITSTUN, STATES.BLOCKSTUN,
  STATES.DEFLECT_RECOIL, STATES.DEFLECT_SUCCESS,
  STATES.STAGGERED, STATES.FINISHING, STATES.BEING_FINISHED,
  STATES.DEAD,
]);

export class Fighter {
  /**
   * @param {object} o
   * @param {'player'|'boss'} o.id
   * @param {object} o.config CONFIG.PLAYER or CONFIG.BOSS
   * @param {number} o.x  @param {1|-1} o.facing
   * @param {import('./utils.js').EventBus} o.bus for 'attackStart' emits
   */
  constructor({ id, config, x, facing, bus }) {
    this.id = id;
    this.config = config;
    this.bus = bus;
    // Public mutable fields (the whole sim reads these):
    this.hp = config.hpMax;
    this.poise = 0;                  // FILLS 0→max, breaks AT max (Sekiro/TOG)
    this.x = x;
    this.vx = 0;
    this.facing = facing;
    this.state = STATES.IDLE;
    this.stateFrame = 0;             // frames in current state
    this.stateDuration = 0;          // 0 = open-ended
    this.stateData = null;           // per-state payload (e.g. dodge direction)
    this.attack = null;              // AttackInstance | null (only in ATTACK/FINISHING)
    this.dodgeCooldown = 0;          // frames; ticks down only when not dodging
    this.poiseRegenPause = 0;        // seconds; poise decay halted while > 0
    this.counterWindow = 0;          // frames; riposte allowed while > 0
    this.poiseDecayScale = 1;        // boss AI sets to smoothstep01(hp/hpMax) per tick
    this.invulnerable = false;       // debug flag (window.__game)

    // Track previous state for poise reset on STAGGERED exit
    this._prevState = STATES.IDLE;
  }

  /**
   * True during DODGE iframe window, TELEPORT, PHASE_TRANSITION, or debug invuln.
   * DODGE branch MUST be guarded: `this.config.dodge && state === DODGE &&
   * stateFrame >= dodge.iframeStart && stateFrame <= dodge.iframeEnd` —
   * CONFIG.BOSS has no `dodge` sub-object (boss never dodges); unguarded
   * access throws for the boss.
   */
  get iframes() {
    if (this.invulnerable) return true;
    if (this.state === STATES.TELEPORT) return true;
    if (this.state === STATES.PHASE_TRANSITION) return true;
    if (this.config.dodge && this.state === STATES.DODGE) {
      const d = this.config.dodge;
      return this.stateFrame >= d.iframeStart && this.stateFrame <= d.iframeEnd;
    }
    return false;
  }

  /** @returns {'windup'|'active'|'recovery'|null} derived from attack.frame vs def */
  get attackPhase() {
    if (!this.attack) return null;
    const { def, frame } = this.attack;
    if (frame < def.windup) return 'windup';
    if (frame < def.windup + def.active) return 'active';
    if (frame < def.windup + def.active + def.recovery) return 'recovery';
    return null;
  }

  /** IDLE | MOVE | RUN — or controllers may also allow cancel windows. */
  canAct() {
    return (
      this.state === STATES.IDLE ||
      this.state === STATES.MOVE ||
      this.state === STATES.RUN
    );
  }

  /**
   * @param {string} state STATES member
   * @param {object} [opts] {duration?: frames, data?: any, byCombat?: boolean}
   *   byCombat is the single-writer authorship token: CombatSystem passes
   *   true on every combat-outcome write; anyone else writing one of those
   *   states throws in dev mode (window.__game present).
   */
  setState(state, opts = {}) {
    if (
      COMBAT_STATES.has(state) && !opts.byCombat &&
      typeof window !== 'undefined' && window.__game
    ) {
      throw new Error('Single-writer violation: ' + state + ' may only be set by CombatSystem');
    }
    // Poise reset: whenever STAGGERED is exited (including forced overrides)
    if (this.state === STATES.STAGGERED && state !== STATES.STAGGERED) {
      this.poise = 0;
    }
    this._prevState = this.state;
    this.state = state;
    this.stateFrame = 0;
    this.stateDuration = opts.duration ?? 0;
    this.stateData = opts.data ?? null;
    // Clear attack instance when leaving ATTACK/FINISHING
    if (state !== STATES.ATTACK && state !== STATES.FINISHING) {
      this.attack = null;
    }
  }

  /**
   * Begin an attack: state→ATTACK (unless finisher), creates AttackInstance:
   * { def, frame: 0, phase: 'windup', hitVictims: new Set(),
   *   chargeHeldFrames: 0, isCounter, isFollowUp, chargeLevel: 0 }
   * hitVictims is the per-swing dedup set (TOG: one registration per swing).
   * EMITS: bus.emit('attackStart', { tick: undefined, ownerId: this.id,
   * attackId: attackDef.id, sfx: attackDef.sfx })
   * @param {object} attackDef config attack row
   * @param {object} [o] {isCounter?, isFollowUp?}
   */
  startAttack(attackDef, { isCounter = false, isFollowUp = false } = {}) {
    this.attack = {
      def: attackDef,
      frame: 0,
      phase: 'windup',
      hitVictims: new Set(),
      chargeHeldFrames: 0,
      isCounter,
      isFollowUp,
      chargeLevel: 0,
      // hold flag set by controller each tick while charge button held
      _chargeHeld: false,
    };
    // Finisher attacks don't use ATTACK state (they go to FINISHING, set by CombatSystem)
    if (!attackDef.tags || !attackDef.tags.includes('finisher')) {
      this.setState(STATES.ATTACK, {
        // Chargeable attacks use open-ended duration (0) so the charge hold doesn't
        // trigger _autoExit before the attack phase machine completes naturally.
        duration: attackDef.chargeable ? 0 : attackDef.windup + attackDef.active + attackDef.recovery,
      });
      // Restore attack after setState clears it
      this.attack = {
        def: attackDef,
        frame: 0,
        phase: 'windup',
        hitVictims: new Set(),
        chargeHeldFrames: 0,
        isCounter,
        isFollowUp,
        chargeLevel: 0,
        _chargeHeld: false,
      };
    }
    this.bus.emit('attackStart', {
      tick: undefined,
      ownerId: this.id,
      attackId: attackDef.id,
      sfx: attackDef.sfx,
    });
  }

  /**
   * World-space attack hitbox, mirrored by facing.
   * @returns {{x,y,w,h}|null} null unless attackPhase === 'active' and def.hitbox
   */
  worldHitbox() {
    if (this.attackPhase !== 'active') return null;
    if (!this.attack || !this.attack.def.hitbox) return null;
    const hb = this.attack.def.hitbox;
    // +x is facing direction, -y is up; origin is fighter's feet
    const wx = this.facing === 1
      ? this.x + hb.x
      : this.x - hb.x - hb.w;
    // y is negative offset from feet (ground); feet are at groundY (y increases downward)
    // hb.y is negative (up from feet), so world y = groundY + hb.y
    const wy = CONFIG.ARENA.groundY + hb.y;
    return { x: wx, y: wy, w: hb.w, h: hb.h };
  }

  /** @returns {{x,y,w,h}} world-space body hurtbox */
  hurtbox() {
    const hb = this.id === 'boss' ? CONFIG.BOSS_HURTBOX : CONFIG.PLAYER_HURTBOX;
    return {
      x: this.x - hb.w / 2,
      y: CONFIG.ARENA.groundY - hb.h,
      w: hb.w,
      h: hb.h,
    };
  }

  /**
   * Per-tick update.
   * @param {number} dt seconds (fixed)
   */
  update(dt) {
    const C = CONFIG.COMBAT;
    const arena = CONFIG.ARENA;

    // --- Timer decrements ---
    if (this.state !== STATES.DODGE && this.dodgeCooldown > 0) {
      this.dodgeCooldown = Math.max(0, this.dodgeCooldown - 1);
    }
    if (this.counterWindow > 0) {
      this.counterWindow = Math.max(0, this.counterWindow - 1);
    }
    if (this.poiseRegenPause > 0) {
      this.poiseRegenPause = Math.max(0, this.poiseRegenPause - dt);
    }

    // --- Poise decay ---
    if (this.poiseRegenPause <= 0 && this.state !== STATES.STAGGERED) {
      this.poise = Math.max(
        0,
        this.poise - C.poiseDecayPerSec * this.poiseDecayScale * dt
      );
    }

    // --- Attack phase machine ---
    if (this.attack) {
      const atk = this.attack;
      const def = atk.def;

      if (def.chargeable && this.attackPhase === 'windup') {
        if (atk._chargeHeld) {
          // Loop windup at last frame when held
          if (atk.frame >= def.windup - 1) {
            atk.frame = def.windup - 1;
            atk.chargeHeldFrames++;
          } else {
            atk.frame++;
          }
        } else {
          // Not held: advance normally
          atk.frame++;
        }
      } else {
        atk.frame++;
      }

      // Maintain chargeLevel every tick
      if (def.chargeable && def.levels) {
        let level = 0;
        for (let i = 0; i < def.levels.length; i++) {
          if (atk.chargeHeldFrames >= def.levels[i].holdFrames) {
            level = i;
          }
        }
        atk.chargeLevel = level;
      }

      // For chargeable attacks (stateDuration=0), self-terminate when all phases done.
      if (def.chargeable && atk.frame >= def.windup + def.active + def.recovery) {
        this._autoExit();
        return;
      }

      // Update the phase field on the instance (derived, but kept in sync)
      atk.phase = this.attackPhase ?? 'recovery';
    }

    // --- Root motion ---
    if (this.attack && this.attack.def.motion) {
      const motion = this.attack.def.motion;
      const phase = this.attackPhase;
      if (phase === motion.phase) {
        // Distribute dx across the phase duration
        let phaseDuration;
        const def = this.attack.def;
        if (motion.phase === 'windup') phaseDuration = def.windup;
        else if (motion.phase === 'active') phaseDuration = def.active;
        else phaseDuration = def.recovery;
        if (phaseDuration > 0) {
          this.vx = (motion.dx / phaseDuration) * this.facing * CONFIG.TIMING.fps;
        }
      } else {
        // Outside motion phase: zero vx from motion
        if (this.state === STATES.ATTACK || this.state === STATES.FINISHING) {
          this.vx = 0;
        }
      }
    }

    // Apply velocity
    if (this.vx !== 0) {
      this.x += this.vx * dt;
    }

    // Friction: dampen vx when not under active motion or movement
    const isMovementState =
      this.state === STATES.MOVE || this.state === STATES.RUN;
    const hasActiveMotion =
      this.attack &&
      this.attack.def.motion &&
      this.attackPhase === this.attack.def.motion.phase;
    if (!isMovementState && !hasActiveMotion) {
      this.vx *= C.velocityFriction;
      if (Math.abs(this.vx) < C.velocityDeadzone) this.vx = 0;
    }

    // Arena clamp
    this.x = clamp(this.x, arena.wallPad, arena.width - arena.wallPad);

    // --- State frame advance and auto-exit ---
    this.stateFrame++;
    if (this.stateDuration > 0 && this.stateFrame >= this.stateDuration) {
      this._autoExit();
    }
  }

  _autoExit() {
    switch (this.state) {
      case STATES.DODGE:
        // Set post-cooldown before leaving
        if (this.config.dodge) {
          this.dodgeCooldown = this.config.dodge.postCooldownFrames;
        }
        this.setState(STATES.IDLE);
        break;
      case STATES.DEFLECT:
      case STATES.HITSTUN:
      case STATES.BLOCKSTUN:
      case STATES.DEFLECT_RECOIL:
      case STATES.DEFLECT_SUCCESS:
      case STATES.STAGGERED:
      case STATES.KNEEL:
      case STATES.TELEPORT:
      case STATES.PHASE_TRANSITION:
        this.setState(STATES.IDLE);
        break;
      case STATES.ATTACK:
        this.setState(STATES.IDLE);
        break;
      default:
        break;
    }
  }

  /**
   * Deep plain-JSON snapshot.
   */
  snapshot() {
    return {
      id: this.id,
      hp: this.hp,
      poise: this.poise,
      x: this.x,
      vx: this.vx,
      facing: this.facing,
      state: this.state,
      stateFrame: this.stateFrame,
      stateDuration: this.stateDuration,
      attack: this.attack
        ? {
            id: this.attack.def.id,
            frame: this.attack.frame,
            phase: this.attack.phase,
            chargeLevel: this.attack.chargeLevel,
            chargeHeldFrames: this.attack.chargeHeldFrames,
            isCounter: this.attack.isCounter,
            isFollowUp: this.attack.isFollowUp,
          }
        : null,
      dodgeCooldown: this.dodgeCooldown,
      poiseRegenPause: this.poiseRegenPause,
      counterWindow: this.counterWindow,
      iframes: this.iframes,
      attackPhase: this.attackPhase,
    };
  }
}
