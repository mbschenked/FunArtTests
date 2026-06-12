// combat.js — hit detection + victim arbitration + atomic outcome application.
// WP-A implements (with fighter.js). THE single writer of combat-outcome state.
//
// The paired deflect reaction (TOG's #1 feel priority — "two combatants
// animated as one synchronized exchange") is guaranteed here by construction:
// both fighters' states are written in the same atomic block of the same tick
// and both freeze under shared hitstop at their contact poses.

import { CONFIG } from './config.js';
import { STATES } from './fighter.js';
import { aabbOverlap, clamp } from './utils.js';

export class CombatSystem {
  /**
   * @param {object} o {config: CONFIG, bus: EventBus, rng: RNG}
   */
  constructor({ config, bus, rng }) {
    this.config = config;
    this.bus = bus;
    this.rng = rng;
    /** Seconds of freeze remaining. Game.step is the ONLY reader/decrementer. */
    this.hitstop = 0;
    /** @type {Array<{x,y,vx,owner,def,hitVictims:Set,stuck:boolean,stuckX:number|null}>} */
    this.projectiles = [];
  }

  /**
   * Per-tick resolution.
   * @param {number} dt @param {Fighter} player @param {Fighter} boss
   */
  update(dt, player, boss) {
    const C = this.config.COMBAT;

    // Projectile-attack launch: any attack row with a projectile def spawns it
    // once when the attack enters its active window (the "release" frame).
    for (const f of [player, boss]) {
      if (
        f.attack && f.attack.def.projectile && !f.attack._projectileSpawned &&
        f.attackPhase === 'active'
      ) {
        f.attack._projectileSpawned = true;
        this.spawnProjectile({
          x: f.x + f.facing * this.config.BOSS.projectileSpawnOffsetX,
          y: this.config.ARENA.groundY - this.config.BOSS.projectileSpawnOffsetY,
          vx: f.facing * f.attack.def.projectile.speed,
          owner: f.id,
          def: f.attack.def,
        });
      }
    }

    // Melee hit detection
    for (const [attacker, victim] of [[player, boss], [boss, player]]) {
      const hitbox = attacker.worldHitbox();
      if (!hitbox) continue;

      const hurtbox = victim.hurtbox();
      if (!aabbOverlap(hitbox, hurtbox)) continue;

      // Dedup: skip if victim already registered this swing
      if (attacker.attack && attacker.attack.hitVictims.has(victim.id)) continue;

      // Skip silently if victim is i-framed
      if (victim.iframes) continue;

      const contactPoint = {
        x: (hitbox.x + hitbox.x + hitbox.w) / 2,
        y: (hitbox.y + hitbox.y + hitbox.h) / 2,
      };

      this.resolveHit(attacker, victim, attacker.attack.def, contactPoint);

      // Register victim in dedup set
      if (attacker.attack) {
        attacker.attack.hitVictims.add(victim.id);
      }
    }

    // Projectile advancement and resolution
    const arena = this.config.ARENA;
    const toRemove = [];
    for (let i = 0; i < this.projectiles.length; i++) {
      const proj = this.projectiles[i];
      if (proj.stuck) continue;

      // Advance
      proj.x += proj.vx * dt;

      // Ground contact check (projectiles travel horizontally at y ≈ mid-body)
      const hitGround = proj.y >= arena.groundY;
      const hitWall = proj.x < arena.wallPad || proj.x > arena.width - arena.wallPad;

      if (hitGround || hitWall) {
        if (proj.def.projectile && proj.def.projectile.sticks) {
          proj.stuck = true;
          proj.stuckX = proj.x;
        } else {
          toRemove.push(i);
        }
        continue;
      }

      // Hit detection vs the non-owner
      const victim = proj.owner === 'player' ? boss : player;

      const projHitbox = {
        x: proj.x - proj.def.projectile.hitbox.w / 2,
        y: proj.y - proj.def.projectile.hitbox.h / 2,
        w: proj.def.projectile.hitbox.w,
        h: proj.def.projectile.hitbox.h,
      };
      const hurtbox = victim.hurtbox();
      if (!aabbOverlap(projHitbox, hurtbox)) continue;

      if (proj.hitVictims.has(victim.id)) continue;
      if (victim.iframes) continue;

      const contactPoint = { x: proj.x, y: proj.y };
      this.resolveHit(
        proj.owner === 'player' ? player : boss,
        victim,
        proj.def,
        contactPoint,
        { isProjectile: true, projectile: proj }
      );
      proj.hitVictims.add(victim.id);

      // If deflected: the resolveHit call handles state; drop the projectile
      // (deflect negates and drops it — handled below via _projDeflected flag)
      if (proj._deflected) {
        toRemove.push(i);
      } else if (!proj.def.projectile.sticks) {
        toRemove.push(i);
      }
    }

    // Remove spent projectiles (reverse order to preserve indices)
    for (let i = toRemove.length - 1; i >= 0; i--) {
      this.projectiles.splice(toRemove[i], 1);
    }

    // Finisher impact check: watch FINISHING/BEING_FINISHED pair
    // The impact frame is at the end of windup (attack def windup end frame)
    for (const [attacker, victim] of [[player, boss], [boss, player]]) {
      if (
        attacker.state === STATES.FINISHING &&
        victim.state === STATES.BEING_FINISHED &&
        attacker.attack
      ) {
        const def = attacker.attack.def;
        const impactFrame = def.windup;
        if (attacker.attack.frame === impactFrame && !attacker.attack._impactFired) {
          attacker.attack._impactFired = true;

          // Apply damage
          victim.hp = Math.max(0, victim.hp - def.damage);
          victim.poise = 0;

          this.bus.emit('finisherImpact', {
            attackerId: attacker.id,
            victimId: victim.id,
            damage: def.damage,
          });

          // Death via finisher
          if (victim.hp <= 0) {
            victim.setState(STATES.DEAD, { byCombat: true });
            this.bus.emit('death', { id: victim.id, victimId: victim.id, x: victim.x });
          }
        }

        // Attacker finisher ends when attack completes (recovery done)
        if (attacker.attack && attacker.stateFrame >= def.windup + def.active + def.recovery) {
          attacker.setState(STATES.IDLE);
          if (victim.state !== STATES.DEAD) {
            victim.setState(STATES.IDLE);
          }
        }
      }
    }
  }

  /** Boss giant-sword throw. spec: {x, y, vx, owner, def}. Emits 'projectileSpawn'. */
  spawnProjectile(spec) {
    const proj = {
      x: spec.x,
      y: spec.y,
      vx: spec.vx,
      owner: spec.owner,
      def: spec.def,
      hitVictims: new Set(),
      stuck: false,
      stuckX: null,
      _deflected: false,
    };
    this.projectiles.push(proj);
    this.bus.emit('projectileSpawn', { x: proj.x, y: proj.y, owner: proj.owner });
  }

  /**
   * Finisher attempt.
   * @returns {boolean} accepted
   */
  tryFinisher(attacker, victim) {
    const C = this.config.COMBAT;

    // Validate: victim must be STAGGERED
    if (victim.state !== STATES.STAGGERED) return false;
    // Reject if already being finished
    if (victim.state === STATES.BEING_FINISHED) return false;

    const dx = Math.abs(attacker.x - victim.x);
    if (dx > C.finisherSnapMax) return false;

    // Determine finisher attack def
    const finisherDef = attacker.id === 'player'
      ? this.config.PLAYER.attacks.finisherPlayer
      : this.config.BOSS.attacks.finisherBoss;

    // Snap attacker toward victim, clamped to [finisherSnapMin, finisherSnapMax]
    const snapDist = clamp(dx, C.finisherSnapMin, C.finisherSnapMax);
    const dir = attacker.x < victim.x ? 1 : -1;
    // Position attacker at snapDist away from victim (on their facing side)
    attacker.x = victim.x - dir * snapDist;

    // Set FINISHING / BEING_FINISHED atomically
    attacker.setState(STATES.FINISHING, {
      duration: finisherDef.windup + finisherDef.active + finisherDef.recovery,
      byCombat: true,
    });
    // Restore attack on attacker after setState
    attacker.attack = {
      def: finisherDef,
      frame: 0,
      phase: 'windup',
      hitVictims: new Set(),
      chargeHeldFrames: 0,
      isCounter: false,
      isFollowUp: false,
      chargeLevel: 0,
      _chargeHeld: false,
      _impactFired: false,
    };

    victim.setState(STATES.BEING_FINISHED, {
      duration: finisherDef.windup + finisherDef.active + finisherDef.recovery,
      byCombat: true,
    });

    this.bus.emit('finisherStart', {
      attackerId: attacker.id,
      victimId: victim.id,
      victimX: victim.x,
    });

    return true;
  }

  /**
   * Core arbitration, exported for projectiles too.
   * @param {Fighter} attacker @param {Fighter} victim
   * @param {object} attackDef @param {{x,y}} contactPoint
   * @param {object} [opts] {isProjectile?: boolean, projectile?: object}
   */
  resolveHit(attacker, victim, attackDef, contactPoint, opts = {}) {
    const C = this.config.COMBAT;
    const isProjectile = opts.isProjectile ?? false;

    // For projectile attacks, damage/poiseDamage come from the projectile sub-object
    const dmgSrc = (isProjectile && attackDef.projectile) ? attackDef.projectile : attackDef;

    // Faces attacker: attacker is on victim's facing side
    const facesAttacker = (attacker.x - victim.x) * victim.facing >= 0;

    // Arbitrate outcome
    let outcome = 'hit';

    if (
      victim.state === STATES.DEFLECT &&
      attackDef.deflectable &&
      facesAttacker
    ) {
      outcome = 'deflected';
    } else if (
      (victim.state === STATES.BLOCK || victim.state === STATES.BLOCKSTUN) &&
      attackDef.blockable &&
      facesAttacker
    ) {
      outcome = 'blocked';
    }

    // Cannot hit if victim is in certain terminal states
    if (
      victim.state === STATES.DEAD ||
      victim.state === STATES.BEING_FINISHED
    ) {
      return;
    }

    // Charge multipliers (from attacker's live attack instance; projectiles carry none)
    let damageMult = 1;
    let poiseMult = 1;
    if (!isProjectile && attacker.attack && attackDef.chargeable && attackDef.levels) {
      const level = attacker.attack.chargeLevel;
      if (level >= 0 && level < attackDef.levels.length) {
        damageMult = attackDef.levels[level].damageMult;
        poiseMult = attackDef.levels[level].poiseMult;
      }
    }

    if (outcome === 'deflected') {
      // Deflect: no damage. Atomic state writes for both fighters.
      attacker.poise = Math.min(
        attacker.config.poiseMax,
        attacker.poise + C.deflectPoiseToAttacker
      );
      victim.poise = Math.min(
        victim.config.poiseMax,
        victim.poise + C.deflectPoiseSelfCost
      );

      // Attacker → DEFLECT_RECOIL
      attacker.setState(STATES.DEFLECT_RECOIL, {
        duration: C.deflectRecoilFrames,
        byCombat: true,
      });
      // Victim → DEFLECT_SUCCESS, open counter window
      victim.setState(STATES.DEFLECT_SUCCESS, {
        duration: C.deflectSuccessFrames,
        byCombat: true,
      });
      victim.counterWindow = victim.config.counterWindowFrames ?? C.deflectSuccessFrames;

      // Knockback: push attacker away
      attacker.vx = -attacker.facing * C.knockbackPx * CONFIG.TIMING.fps * C.knockbackImpulseScale;

      // Shared hitstop
      this.hitstop = C.deflectHitstopSec;

      this.bus.emit('deflect', {
        attackerId: attacker.id,
        victimId: victim.id,
        attackId: attackDef.id,
        contactPoint,
      });

      // If projectile: mark for removal
      if (isProjectile && opts.projectile) {
        opts.projectile._deflected = true;
      }

      // Check poise break on attacker after deflect poise damage
      this._checkPoiseBreak(attacker);
      // Check poise break on victim (deflectPoiseSelfCost may push them over)
      this._checkPoiseBreak(victim);

    } else if (outcome === 'blocked') {
      // Block: no hp damage; chip poise damage
      const chipPoise = dmgSrc.poiseDamage * poiseMult * C.blockChipMult;
      victim.poise = Math.min(victim.config.poiseMax, victim.poise + chipPoise);
      victim.poiseRegenPause = C.blockRegenPauseSec;

      // Pushback
      const pushDir = victim.x < attacker.x ? -1 : 1;
      victim.x += pushDir * C.blockPushbackPx;

      victim.setState(STATES.BLOCKSTUN, { duration: C.blockstunFrames, byCombat: true });

      this.hitstop = C.blockHitstopSec;

      this.bus.emit('blocked', {
        attackerId: attacker.id,
        victimId: victim.id,
        attackId: attackDef.id,
        contactPoint,
      });

      this._checkPoiseBreak(victim);

    } else {
      // HIT
      const rawDamage = dmgSrc.damage * damageMult;
      const rawPoiseDmg = dmgSrc.poiseDamage * poiseMult;

      // Kneel multiplier
      const kneelMult =
        victim.state === STATES.KNEEL
          ? (this.config.BOSS.kneelPoiseMult ?? 1)
          : 1;

      victim.hp = Math.max(0, victim.hp - rawDamage);
      victim.poise = Math.min(
        victim.config.poiseMax,
        victim.poise + rawPoiseDmg * kneelMult
      );

      // Counter mechanics
      if (!isProjectile && attacker.attack && attacker.attack.isCounter) {
        const playerCfg = this.config.PLAYER;
        const playerFighter = attacker.id === 'player' ? attacker : victim;
        const bossFighter = attacker.id === 'player' ? victim : attacker;

        if (attacker.id === 'player' && victim.id === 'boss') {
          // Heal and poise recover the player
          playerFighter.hp = Math.min(
            playerCfg.hpMax,
            playerFighter.hp + playerCfg.counterHeal
          );
          playerFighter.poise = Math.max(
            0,
            playerFighter.poise - playerCfg.counterPoiseRecover
          );
          // Extra poise damage to boss
          victim.poise = Math.min(
            victim.config.poiseMax,
            victim.poise + playerCfg.counterBonusPoiseDmg
          );
          this.bus.emit('counterLanded', {
            attackerId: attacker.id,
            victimId: victim.id,
            contactPoint,
          });
        }
      }

      // Knockback — push victim AWAY from the attacker
      const kbDir = victim.x < attacker.x ? -1 : 1;
      victim.vx = kbDir * C.knockbackPx * CONFIG.TIMING.fps * C.knockbackImpulseScale;

      // Hitstun
      victim.setState(STATES.HITSTUN, { duration: C.hitstunFrames, byCombat: true });

      this.hitstop = C.hitstopSec;

      this.bus.emit('hit', {
        attackerId: attacker.id,
        victimId: victim.id,
        attackId: attackDef.id,
        damage: rawDamage,
        contactPoint,
      });

      // Poise break check
      this._checkPoiseBreak(victim);

      // Death check (after poise break — DEAD takes priority)
      if (victim.hp <= 0 && victim.state !== STATES.DEAD) {
        victim.setState(STATES.DEAD, { byCombat: true });
        this.bus.emit('death', { id: victim.id, victimId: victim.id, x: victim.x });
      }
    }
  }

  /** Internal: check if a fighter's poise broke and apply STAGGERED. */
  _checkPoiseBreak(fighter) {
    if (
      fighter.poise >= fighter.config.poiseMax &&
      fighter.state !== STATES.STAGGERED &&
      fighter.state !== STATES.BEING_FINISHED &&
      fighter.state !== STATES.DEAD
    ) {
      fighter.poise = fighter.config.poiseMax; // clamp
      fighter.setState(STATES.STAGGERED, {
        duration: this.config.COMBAT.staggerDurationFrames,
        byCombat: true,
      });
      this.bus.emit('poiseBreak', { id: fighter.id, x: fighter.x });
    }
  }
}
