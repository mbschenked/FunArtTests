// config.js — THE data table. Every tunable number in the game lives here,
// mirroring TOG's UE5 DataTable-driven design (DT_MichealSwordCombo,
// DT_AreliusFinishers, etc.). No other file may contain balance literals.
//
// Units: distances in px (1px ≈ 2 UE units), durations in frames @60fps
// unless the key ends in Ms or Sec. Hitboxes are facing-local offsets from
// the fighter's feet origin; +x is the facing direction, -y is up.
//
// Attack row format:
// {
//   id, owner: 'player'|'boss',
//   windup, active, recovery,        // frames
//   damage, poiseDamage,
//   hitbox: {x,y,w,h} | null,        // null = no melee hitbox (projectile-only)
//   blockable, deflectable,          // blockable:false = perilous (dodge it)
//   motion: {phase, dx} | null,      // root motion applied across that phase
//   comboNext: id|null, comboWindow: [start,end] | null,  // frames into recovery
//   chargeable: bool, levels: [{holdFrames,damageMult,poiseMult}] | null,
//   onWhiffKneel: bool,              // boss heavies: kneel roll if swing hit nobody
//   rangeBands: ['close'|'mid'|'far'], // boss AI eligibility filter
//   followUpPool: [id],              // boss follow-up candidates
//   projectile: {speed,hitbox,damage,poiseDamage,sticks} | null,
//   pose: string, sfx: string, tags: [string]
// }

export const CONFIG = {
  TIMING: {
    fps: 60,
    fixedDtMs: 1000 / 60,
  },

  ARENA: {
    width: 1280,
    height: 720,
    groundY: 600,
    wallPad: 60,
    playerSpawnX: 420,
    bossSpawnX: 860,
  },

  COMBAT: {
    hitstopSec: 0.1,             // exact TOG constant (TOGAbilityTypes.h)
    blockRegenPauseSec: 1.0,     // poise decay pause after blocking a hit
    blockChipMult: 0.6,          // blocker takes poiseDamage * this
    poiseDecayPerSec: 12,        // toward 0 when not paused/staggered
    deflectPoiseToAttacker: 24,  // P4 round-3: 5 deflects to break (was 4) — longer stagger cycle  // heavy poise punishment for being deflected
    deflectPoiseSelfCost: 2,     // near-zero cost to the deflector
    deflectHitstopSec: 0.12,     // deflect clash freezes slightly longer than a hit
    blockHitstopSec: 0.05,
    finisherSnapMin: 25,         // px — TOG MotionWarp 50uu
    finisherSnapMax: 150,        // px — TOG MotionWarp 300uu
    staggerDurationFrames: 150,  // poise-broken vulnerability window
    hitstunFrames: 16,
    blockstunFrames: 10,
    deflectRecoilFrames: 26,     // attacker recoil after being deflected
    deflectSuccessFrames: 18,    // defender recovery (counter window overlaps)
    knockbackPx: 26,
    knockbackImpulseScale: 0.5,
    blockPushbackPx: 12,
    velocityFriction: 0.8,
    velocityDeadzone: 1,
  },

  PLAYER_HURTBOX: { w: 40, h: 100 },
  BOSS_HURTBOX: { w: 44, h: 120 },

  PLAYER: {
    name: 'MICHEAL',
    hpMax: 100,
    poiseMax: 100,
    walkSpeed: 220,              // px/s
    runSpeed: 380,
    runPromoteTicks: 20,         // hold direction this long → RUN
    deflectWindowFrames: 8,      // guard tap = deflect attempt window
    inputBufferMs: 200,          // PLAYER-ONLY input buffer (TOG design rule)
    counterWindowFrames: 30,     // riposte window after a successful deflect
    counterHeal: 4,                 // P4 round-3: 6 made deflect-counter loop self-sustaining              // TOG: counters heal the player slightly
    counterPoiseRecover: 15,     // TOG: counters recover player poise
    counterBonusPoiseDmg: 12,    // TOG: counters deal bonus poise to boss
    dodge: {
      durationFrames: 22,
      iframeStart: 2,
      iframeEnd: 16,
      postCooldownFrames: 24,    // TOG rule: no back-to-back dodges
      dashBackDist: 140,
      dashThroughDist: 200,
    },
    attacks: {
      slash1: {
        id: 'slash1', owner: 'player', windup: 10, active: 5, recovery: 18,
        damage: 12, poiseDamage: 14,
        hitbox: { x: 44, y: -64, w: 70, h: 44 },
        blockable: true, deflectable: true,
        motion: { phase: 'windup', dx: 26 },
        comboNext: 'slash2', comboWindow: [4, 14],
        chargeable: false, levels: null, onWhiffKneel: false,
        rangeBands: null, followUpPool: null, projectile: null,
        pose: 'slash1', sfx: 'whooshLight', tags: ['chain'],
      },
      slash2: {
        id: 'slash2', owner: 'player', windup: 8, active: 5, recovery: 20,
        damage: 14, poiseDamage: 16,
        hitbox: { x: 46, y: -66, w: 74, h: 46 },
        blockable: true, deflectable: true,
        motion: { phase: 'windup', dx: 30 },
        comboNext: 'slash3', comboWindow: [5, 15],
        chargeable: false, levels: null, onWhiffKneel: false,
        rangeBands: null, followUpPool: null, projectile: null,
        pose: 'slash2', sfx: 'whooshLight', tags: ['chain'],
      },
      slash3: {
        id: 'slash3', owner: 'player', windup: 14, active: 6, recovery: 26,
        damage: 22, poiseDamage: 24,
        hitbox: { x: 50, y: -70, w: 84, h: 54 },
        blockable: true, deflectable: true,
        motion: { phase: 'windup', dx: 44 },
        comboNext: null, comboWindow: null,
        chargeable: false, levels: null, onWhiffKneel: false,
        rangeBands: null, followUpPool: null, projectile: null,
        pose: 'slash3', sfx: 'whooshHeavy', tags: ['chain', 'heavy'],
      },
      thrust1: {
        id: 'thrust1', owner: 'player', windup: 8, active: 4, recovery: 14,
        damage: 9, poiseDamage: 10,
        hitbox: { x: 52, y: -58, w: 84, h: 26 },
        blockable: true, deflectable: true,
        motion: { phase: 'windup', dx: 22 },
        comboNext: 'thrust2', comboWindow: [3, 12],
        chargeable: false, levels: null, onWhiffKneel: false,
        rangeBands: null, followUpPool: null, projectile: null,
        pose: 'thrust1', sfx: 'whooshLight', tags: ['pierce'],
      },
      thrust2: {
        id: 'thrust2', owner: 'player', windup: 9, active: 4, recovery: 18,
        damage: 12, poiseDamage: 12,
        hitbox: { x: 56, y: -58, w: 92, h: 26 },
        blockable: true, deflectable: true,
        motion: { phase: 'windup', dx: 30 },
        comboNext: null, comboWindow: null,
        chargeable: false, levels: null, onWhiffKneel: false,
        rangeBands: null, followUpPool: null, projectile: null,
        pose: 'thrust2', sfx: 'whooshLight', tags: ['pierce'],
      },
      charge: {
        id: 'charge', owner: 'player', windup: 12, active: 6, recovery: 28,
        damage: 16, poiseDamage: 20,
        hitbox: { x: 48, y: -72, w: 88, h: 60 },
        blockable: true, deflectable: true,
        motion: { phase: 'active', dx: 36 },
        comboNext: null, comboWindow: null,
        chargeable: true,
        levels: [                 // 3-stage hold (TOG_Power_Attack_Loop Stage1-3)
          { holdFrames: 0,  damageMult: 1.0, poiseMult: 1.0 },
          { holdFrames: 30, damageMult: 1.6, poiseMult: 1.8 },
          { holdFrames: 60, damageMult: 2.4, poiseMult: 2.6 },
        ],
        onWhiffKneel: false,
        rangeBands: null, followUpPool: null, projectile: null,
        pose: 'charge', sfx: 'whooshHeavy', tags: ['heavy', 'charge'],
      },
      runningAttack: {
        id: 'runningAttack', owner: 'player', windup: 8, active: 5, recovery: 22,
        damage: 14, poiseDamage: 16,
        hitbox: { x: 46, y: -64, w: 78, h: 48 },
        blockable: true, deflectable: true,
        motion: { phase: 'windup', dx: 60 },
        comboNext: null, comboWindow: null,
        chargeable: false, levels: null, onWhiffKneel: false,
        rangeBands: null, followUpPool: null, projectile: null,
        pose: 'runningAttack', sfx: 'whooshHeavy', tags: ['running'],
      },
      counter: {
        id: 'counter', owner: 'player', windup: 5, active: 4, recovery: 14,
        damage: 14, poiseDamage: 18,   // combat adds counterBonusPoiseDmg on connect
        hitbox: { x: 48, y: -62, w: 80, h: 40 },
        blockable: false, deflectable: false,  // ripostes punish — can't be defended
        motion: { phase: 'windup', dx: 34 },
        comboNext: null, comboWindow: null,
        chargeable: false, levels: null, onWhiffKneel: false,
        rangeBands: null, followUpPool: null, projectile: null,
        pose: 'counter', sfx: 'whooshHeavy', tags: ['counter'],
      },
      finisherPlayer: {
        id: 'finisherPlayer', owner: 'player', windup: 20, active: 4, recovery: 30,
        damage: 45, poiseDamage: 0,
        hitbox: null,               // scripted impact via tryFinisher, not a sweep
        blockable: false, deflectable: false,
        motion: null,
        comboNext: null, comboWindow: null,
        chargeable: false, levels: null, onWhiffKneel: false,
        rangeBands: null, followUpPool: null, projectile: null,
        pose: 'finisherPlayer', sfx: 'finisherSting', tags: ['finisher'],
      },
    },
  },

  BOSS: {
    name: 'ARELIUS',
    hpMax: 360,                 // P4 round-1: 300 too short a fight (52s win)
    poiseMax: 120,
    walkSpeed: 185,              // P4 round-1: 160 let the player disengage freely
    dashSpeed: 520,
    deflectWindowFrames: 8,
    decisionCooldownFrames: [14, 36], // P4: tightened from [18,42] — // re-rolled each decision — boss "thinking", NOT a buffer
    rangeBands: { close: 120, mid: 320 },  // |dx| <= close → close band; <= mid → mid; else far
    velocityGate: {                  // adapted from TOG's 100–1000 u/s gate:
      speedThreshold: 300,           // don't commit to attacks while player retreats fast
      onlyWhenRetreating: true,
    },
    defense: {                       // TOG defensive tree: escalates vs move-spam
      baseDeflectChance: 0.12,
      baseBlockChance: 0.25,
      perRepeatDeflectBonus: 0.15,   // per repeat of same player attack id
      repeatMemory: 6,               // window of remembered player attacks
      maxDeflectChance: 0.65,
      reactiveLookaheadFrames: 4,    // extra frames of lookahead beyond deflectWindowFrames
      reachPaddingPx: 20,            // px added to attack reach for reactive defense check
    },
    movementWeights: {
      farDashChance: 0.3,
      closeRetreatChance: 0.4,
      midAdvanceChance: 0.25,
      midRetreatCutoff: 0.45,
      midFallbackAdvanceChance: 0.7,
      strafeMult: 0.5,
      walkMult: 1.0,
      dashMult: 2.0,
    },
    kneelChanceOnHeavyWhiff: 0.5,
    kneelDurationFrames: 90,
    kneelPoiseMult: 1.5,             // takes extra poise damage while kneeling
    projectileSpawnOffsetX: 40,      // px forward from feet at release
    projectileSpawnOffsetY: 60,      // px above ground (mid-body)
    teleportFrames: 20,              // i-framed warp duration
    phaseTransitionFrames: 120,      // invulnerable phase-2 ceremony
    phases: {
      1: {
        hpThreshold: 1.0,
        followUpChance: 0.4,         // P4 round-1: 0.3 gave no phase-1 pressure (TOG range 0.25–0.75)
        followUpPityRange: [2, 5],   // guaranteed follow-up after N misses (TOG pity)
        sequencePityRange: [2, 3],
        aggression: 1.0,
        unlocks: [],
        attackWeights: { thrustFwd: 3, thrustOverhead: 2, slashA: 3, jumpPlunge: 1, chargeSlash: 1, slashB: 0, slashC: 0 },
      },
      2: {
        hpThreshold: 0.5,            // TOG: BTD_CheckBossHealth at 0.5
        followUpChance: 0.6,
        followUpPityRange: [2, 3],
        sequencePityRange: [2, 2],
        aggression: 1.5,
        unlocks: ['giantSwordThrow', 'giantSwordSlice', 'teleportStrike'],
        attackWeights: {
          thrustFwd: 2, thrustOverhead: 2, slashA: 3, jumpPlunge: 2, chargeSlash: 2,
          giantSwordThrow: 3, giantSwordSlice: 2,  // P4: throw never fired at weight 2
          teleportStrike: 0,         // dynamic: boss.js raises this while a sword is stuck
          slashB: 0, slashC: 0,
        },
        teleportStrikeWeightWhenSwordStuck: 5,
      },
    },
    attacks: {
      thrustFwd: {
        id: 'thrustFwd', owner: 'boss', windup: 22, active: 5, recovery: 24,
        damage: 11, poiseDamage: 16,
        hitbox: { x: 58, y: -60, w: 100, h: 28 },
        blockable: true, deflectable: true,
        motion: { phase: 'windup', dx: 90 },
        comboNext: null, comboWindow: null,
        chargeable: false, levels: null, onWhiffKneel: false,
        rangeBands: ['mid'], followUpPool: ['slashA', 'thrustOverhead'],
        projectile: null,
        pose: 'bossThrustFwd', sfx: 'whooshHeavy', tags: ['pierce'],
      },
      thrustOverhead: {
        id: 'thrustOverhead', owner: 'boss', windup: 26, active: 6, recovery: 28,
        damage: 14, poiseDamage: 20,
        hitbox: { x: 40, y: -90, w: 80, h: 80 },
        blockable: true, deflectable: true,
        motion: { phase: 'windup', dx: 40 },
        comboNext: null, comboWindow: null,
        chargeable: false, levels: null, onWhiffKneel: false,
        rangeBands: ['close', 'mid'], followUpPool: ['slashA'],
        projectile: null,
        pose: 'bossThrustOverhead', sfx: 'whooshHeavy', tags: ['overhead'],
      },
      slashA: {
        id: 'slashA', owner: 'boss', windup: 18, active: 5, recovery: 20,
        damage: 10, poiseDamage: 14,
        hitbox: { x: 46, y: -66, w: 84, h: 50 },
        blockable: true, deflectable: true,
        motion: { phase: 'windup', dx: 30 },
        comboNext: null, comboWindow: null,
        chargeable: false, levels: null, onWhiffKneel: false,
        rangeBands: ['close'], followUpPool: ['slashB'],
        projectile: null,
        pose: 'bossSlashA', sfx: 'whooshLight', tags: ['chain'],
      },
      slashB: {
        id: 'slashB', owner: 'boss', windup: 14, active: 5, recovery: 18,
        damage: 10, poiseDamage: 14,
        hitbox: { x: 46, y: -66, w: 84, h: 50 },
        blockable: true, deflectable: true,
        motion: { phase: 'windup', dx: 30 },
        comboNext: null, comboWindow: null,
        chargeable: false, levels: null, onWhiffKneel: false,
        rangeBands: ['close'], followUpPool: ['slashC'],
        projectile: null,
        pose: 'bossSlashB', sfx: 'whooshLight', tags: ['chain'],
      },
      slashC: {
        id: 'slashC', owner: 'boss', windup: 20, active: 6, recovery: 30,
        damage: 16, poiseDamage: 26,
        hitbox: { x: 50, y: -70, w: 96, h: 58 },
        blockable: true, deflectable: true,
        motion: { phase: 'windup', dx: 44 },
        comboNext: null, comboWindow: null,
        chargeable: false, levels: null, onWhiffKneel: true,
        rangeBands: ['close'], followUpPool: null,
        projectile: null,
        pose: 'bossSlashC', sfx: 'whooshHeavy', tags: ['chain', 'heavy'],
      },
      chargeSlash: {
        id: 'chargeSlash', owner: 'boss', windup: 30, active: 8, recovery: 34,
        damage: 21, poiseDamage: 30,
        hitbox: { x: 44, y: -76, w: 110, h: 66 },
        blockable: false, deflectable: true,   // PERILOUS: unblockable, deflect or dodge
        motion: { phase: 'active', dx: 50 },
        comboNext: null, comboWindow: null,
        chargeable: true,
        levels: [
          { holdFrames: 0,  damageMult: 1.0, poiseMult: 1.0 },
          { holdFrames: 40, damageMult: 1.4, poiseMult: 1.4 },
          { holdFrames: 80, damageMult: 1.9, poiseMult: 1.9 },
        ],
        onWhiffKneel: true,
        rangeBands: ['close', 'mid'], followUpPool: null,
        projectile: null,
        pose: 'bossChargeSlash', sfx: 'whooshHeavy', tags: ['heavy', 'charge', 'perilous'],
      },
      jumpPlunge: {
        id: 'jumpPlunge', owner: 'boss', windup: 24, active: 6, recovery: 30,
        damage: 16, poiseDamage: 22,
        hitbox: { x: 20, y: -50, w: 90, h: 50 },
        blockable: true, deflectable: true,
        motion: { phase: 'windup', dx: 180 },  // leaping arc toward player
        comboNext: null, comboWindow: null,
        chargeable: false, levels: null, onWhiffKneel: false,
        rangeBands: ['mid', 'far'], followUpPool: ['slashA'],
        projectile: null,
        pose: 'bossJumpPlunge', sfx: 'whooshHeavy', tags: ['aerial'],
      },
      giantSwordThrow: {
        id: 'giantSwordThrow', owner: 'boss', windup: 30, active: 2, recovery: 26,
        damage: 0, poiseDamage: 0,
        hitbox: null,                          // projectile-only attack
        blockable: true, deflectable: true,    // flags apply to the projectile
        motion: null,
        comboNext: null, comboWindow: null,
        chargeable: false, levels: null, onWhiffKneel: false,
        rangeBands: ['mid', 'far'], followUpPool: null,
        projectile: { speed: 840, hitbox: { w: 90, h: 22 }, damage: 13, poiseDamage: 18, sticks: true },
        pose: 'bossSwordThrow', sfx: 'swordThrow', tags: ['projectile', 'phase2'],
      },
      giantSwordSlice: {
        id: 'giantSwordSlice', owner: 'boss', windup: 28, active: 7, recovery: 36,
        damage: 19, poiseDamage: 28,
        hitbox: { x: 50, y: -90, w: 130, h: 86 },
        blockable: false, deflectable: true,   // PERILOUS giant arc
        motion: { phase: 'windup', dx: 36 },
        comboNext: null, comboWindow: null,
        chargeable: false, levels: null, onWhiffKneel: true,
        rangeBands: ['close', 'mid'], followUpPool: null,
        projectile: null,
        pose: 'bossGiantSlice', sfx: 'whooshGiant', tags: ['heavy', 'perilous', 'phase2'],
      },
      teleportStrike: {
        id: 'teleportStrike', owner: 'boss', windup: 12, active: 5, recovery: 24,
        damage: 13, poiseDamage: 18,
        hitbox: { x: 46, y: -66, w: 84, h: 50 },
        blockable: true, deflectable: true,
        motion: null,                          // position set by the teleport itself
        comboNext: null, comboWindow: null,
        chargeable: false, levels: null, onWhiffKneel: false,
        rangeBands: ['close', 'mid', 'far'],   // range-free: comes from the stuck sword
        followUpPool: ['slashA'],
        projectile: null,
        pose: 'bossTeleportStrike', sfx: 'teleportShimmer', tags: ['phase2', 'teleport'],
      },
      finisherBoss: {
        id: 'finisherBoss', owner: 'boss', windup: 24, active: 4, recovery: 34,
        damage: 55, poiseDamage: 0,
        hitbox: null,                          // scripted impact via tryFinisher
        blockable: false, deflectable: false,
        motion: null,
        comboNext: null, comboWindow: null,
        chargeable: false, levels: null, onWhiffKneel: false,
        rangeBands: null, followUpPool: null, projectile: null,
        pose: 'finisherBoss', sfx: 'finisherSting', tags: ['finisher'],
      },
    },
  },
};
