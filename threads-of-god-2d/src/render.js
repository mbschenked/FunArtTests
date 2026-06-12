// render.js — single-canvas painter. WP-D implements.
// Cosmetic-only event listener: NEVER mutates game state (single-writer rule).
//
// Draw order (frozen): backdrop gradient → ambient fate-threads → ground →
// stuck giant sword → projectiles → back fighter → front fighter → sword
// trails → particles → screen-flash → vignette. (HUD drawn after by main.)
//
// Visual identity — "Threads of God":
// - Micheal: steel/cyan palette (#9fd8ff blade glow). Arelius: gold/black
//   (#ffc24d), drawn at SKELETON.bossScale.
// - Deflect: burst of taut golden thread particles + radial spark ring.
// - Poise break: a visible thread SNAP — stretched line across the victim that
//   splits and whips away.
// - Finisher & phase ceremony: golden thread lattice converges on the victim.
// - Particles and screen shake advance on REAL dt — sparks keep flying through
//   hitstop; that contrast is the core of the freeze-frame feel.

import { CONFIG } from './config.js';
import { RNG } from './utils.js';
import { POSES, SKELETON, samplePose } from './poses.js';

// ─── palette ────────────────────────────────────────────────────────────────
const PAL = {
  micheal:      '#9fd8ff',
  michealDim:   '#4a8ab5',
  michealBody:  '#c8e8ff',
  arelius:      '#ffc24d',
  areliusDim:   '#8a6620',
  areliusBody:  '#ffe0a0',
  ground:       '#1a1a2e',
  groundLine:   '#2a2a4e',
  backdrop1:    '#0a0a14',
  backdrop2:    '#12102a',
  thread:       '#ffc24d',
  threadDim:    'rgba(255,194,77,0.18)',
  spark:        '#fff5c0',
  sparkRed:     '#ff6040',
  vignette:     'rgba(0,0,0,0.55)',
  flash:        'rgba(255,255,255,1)',
  rimLight:     'rgba(120,160,255,0.10)',
};

// ─── particle types ──────────────────────────────────────────────────────────
// Each particle: { x, y, vx, vy, life, maxLife, type, color, size, angle, va }

class ParticlePool {
  constructor() { this._p = []; }

  spawn(o) { this._p.push(o); }

  update(dt) {
    for (let i = this._p.length - 1; i >= 0; i--) {
      const p = this._p[i];
      p.life -= dt;
      if (p.life <= 0) { this._p.splice(i, 1); continue; }
      p.x  += p.vx * dt;
      p.y  += p.vy * dt;
      p.vy += (p.gravity ?? 0) * dt;
      if (p.va) p.angle += p.va * dt;
      if (p.drag) { p.vx *= 1 - p.drag * dt; p.vy *= 1 - p.drag * dt; }
    }
  }

  draw(ctx) {
    for (const p of this._p) {
      const a = Math.max(0, p.life / p.maxLife);
      ctx.save();
      ctx.globalAlpha = a * (p.baseAlpha ?? 1);
      ctx.translate(p.x, p.y);
      if (p.angle) ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      if (p.type === 'thread') {
        // Thin elongated line segment
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size ?? 1.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(p.len ?? 18, 0);
        ctx.stroke();
      } else if (p.type === 'spark') {
        ctx.beginPath();
        ctx.arc(0, 0, (p.size ?? 2) * a, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size ?? 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  get list() { return this._p; }
}

// ─── sword trail ─────────────────────────────────────────────────────────────
class SwordTrail {
  constructor() { this._pts = []; }

  push(x1, y1, x2, y2) {
    this._pts.push({ x1, y1, x2, y2, life: 0.12 });
  }

  update(dt) {
    for (let i = this._pts.length - 1; i >= 0; i--) {
      this._pts[i].life -= dt;
      if (this._pts[i].life <= 0) this._pts.splice(i, 1);
    }
  }

  draw(ctx, color) {
    if (this._pts.length < 2) return;
    ctx.save();
    for (let i = 1; i < this._pts.length; i++) {
      const a = this._pts[i].life / 0.12;
      ctx.globalAlpha = a * 0.45;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3 * a;
      ctx.beginPath();
      ctx.moveTo(this._pts[i - 1].x1, this._pts[i - 1].y1);
      ctx.lineTo(this._pts[i].x1, this._pts[i].y1);
      ctx.stroke();
    }
    ctx.restore();
  }

  clear() { this._pts = []; }
}

// ─── ambient thread system ────────────────────────────────────────────────────
class AmbientThreads {
  constructor(count, arena, rng) {
    this._threads = [];
    this._arena = arena;
    this._rng = rng;
    for (let i = 0; i < count; i++) {
      this._threads.push(this._make(i / count));
    }
  }

  _make(phase) {
    const a = this._arena;
    const rng = this._rng;
    return {
      x: a.wallPad + rng.next() * (a.width - a.wallPad * 2),
      y: 50 + rng.next() * (a.groundY - 100),
      len: 30 + rng.next() * 70,
      angle: rng.next() * Math.PI * 2,
      va: (rng.next() - 0.5) * 0.3,
      vy: -10 - rng.next() * 15,
      vx: (rng.next() - 0.5) * 8,
      life: 2 + rng.next() * 4,
      maxLife: 2 + rng.next() * 4,
      phase,
      opacity: 0.06 + rng.next() * 0.08,
    };
  }

  update(dt) {
    for (let i = 0; i < this._threads.length; i++) {
      const t = this._threads[i];
      t.life -= dt;
      t.x += t.vx * dt;
      t.y += t.vy * dt;
      t.angle += t.va * dt;
      if (t.life <= 0) this._threads[i] = this._make(0);
    }
  }

  draw(ctx) {
    ctx.save();
    for (const t of this._threads) {
      const a = Math.min(1, t.life / (t.maxLife * 0.3)) * Math.min(1, t.life / t.maxLife * 3);
      ctx.globalAlpha = t.opacity * a;
      ctx.strokeStyle = PAL.thread;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x + Math.cos(t.angle) * t.len, t.y + Math.sin(t.angle) * t.len);
      ctx.stroke();
    }
    ctx.restore();
  }
}

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} config CONFIG
   * @param {import('./utils.js').EventBus} bus
   * @param {import('./utils.js').RNG} [rng] optional seeded RNG; a default is created if omitted
   */
  constructor(canvas, config, bus, rng) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._config = config;
    this._bus = bus;
    this._rng = rng ?? new RNG(1);

    // Previous-position cache for interpolation
    this._prevPos = { player: null, boss: null };

    // FX state
    this._particles = new ParticlePool();
    this._playerTrail = new SwordTrail();
    this._bossTrail   = new SwordTrail();
    this._flash = 0;            // seconds remaining
    this._flashColor = PAL.flash;
    this._shake = { x: 0, y: 0, mag: 0, decay: 0 };
    this._ambientThreads = new AmbientThreads(28, config.ARENA, this._rng);

    // Stuck giant sword state
    this._stuckSword = null;    // {x, y, angle, color} | null

    // Cached gradients for fixed-coordinate draws (re-used every frame)
    const ctx = this.ctx;
    const { width, height } = config.ARENA;
    this._bgGradient = ctx.createLinearGradient(0, 0, 0, height);
    this._bgGradient.addColorStop(0, PAL.backdrop1);
    this._bgGradient.addColorStop(0.6, PAL.backdrop2);
    this._bgGradient.addColorStop(1, '#0e0c20');

    this._rimGradient = ctx.createRadialGradient(width / 2, 0, 0, width / 2, 0, height * 0.9);
    this._rimGradient.addColorStop(0, 'rgba(80,100,200,0.08)');
    this._rimGradient.addColorStop(1, 'rgba(0,0,0,0)');

    this._vigGradient = ctx.createRadialGradient(width / 2, height / 2, height * 0.3, width / 2, height / 2, height * 0.85);
    this._vigGradient.addColorStop(0, 'rgba(0,0,0,0)');
    this._vigGradient.addColorStop(1, 'rgba(0,0,0,0.62)');

    this._subscribeEvents(bus);
  }

  _subscribeEvents(bus) {
    bus.on('hit', ({ contactPoint, damage, victim }) => {
      this._spawnHitSparks(contactPoint, damage);
      const mag = 2 + damage * 0.12;
      this._addShake(mag, 0.14);
      this._flash = 0.04;
      this._flashColor = damage >= 20 ? 'rgba(255,120,60,0.55)' : 'rgba(255,255,255,0.4)';
    });

    bus.on('blocked', ({ contactPoint }) => {
      if (contactPoint) this._spawnBlockSparks(contactPoint);
      this._addShake(1.5, 0.06);
    });

    bus.on('deflect', ({ contactPoint }) => {
      if (contactPoint) this._spawnDeflectFX(contactPoint);
      this._addShake(3, 0.10);
      this._flash = 0.05;
      this._flashColor = 'rgba(255,220,100,0.50)';
    });

    bus.on('counterLanded', ({ contactPoint }) => {
      if (contactPoint) this._spawnCounterFX(contactPoint);
    });

    bus.on('poiseBreak', ({ victim, x }) => {
      this._spawnPoiseBreakFX(x ?? 640, victim);
    });

    bus.on('finisherStart', ({ attacker, victim, victimX }) => {
      this._spawnFinisherThreads(victimX ?? 640);
      this._flash = 0.08;
      this._flashColor = 'rgba(255,200,80,0.45)';
    });

    bus.on('finisherImpact', () => {
      this._addShake(8, 0.25);
      this._flash = 0.12;
      this._flashColor = 'rgba(255,255,255,0.80)';
    });

    bus.on('phaseChange', ({ phase, bossX }) => {
      this._spawnPhaseThreadLattice(bossX ?? 640);
      this._flash = 0.15;
      this._flashColor = 'rgba(255,194,77,0.60)';
    });

    bus.on('projectileSpawn', ({ x, y, owner }) => {
      // Spawn glow burst at throw origin
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        this._particles.spawn({
          x, y,
          vx: Math.cos(a) * 80, vy: Math.sin(a) * 80,
          life: 0.3, maxLife: 0.3,
          type: 'spark', color: PAL.arelius, size: 3,
          gravity: 0, drag: 3,
        });
      }
    });

    bus.on('dodge', ({ x, y }) => {
      this._spawnDustStreak(x ?? 640, y ?? CONFIG.ARENA.groundY);
    });

    bus.on('death', ({ victimId, x }) => {
      this._addShake(6, 0.30);
      this._flash = 0.10;
      this._flashColor = 'rgba(200,80,40,0.55)';
      // Scatter threads from victim
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        const spd = 60 + i * 12;
        this._particles.spawn({
          x: x ?? 640, y: CONFIG.ARENA.groundY - 60,
          vx: Math.cos(a) * spd, vy: Math.sin(a) * spd - 40,
          life: 1.2, maxLife: 1.2,
          type: 'thread', color: PAL.thread, size: 1.5, len: 22,
          angle: a, va: (i % 2 === 0 ? 1 : -1) * 1.5,
          gravity: 40, drag: 1.5,
        });
      }
    });
  }

  /** Clear interpolation cache. Call from main.js _buildWorld on reset. */
  resetTransient() {
    this._prevPos.player = null;
    this._prevPos.boss = null;
  }

  _addShake(mag, duration) {
    this._shake.mag = Math.max(this._shake.mag, mag);
    this._shake.decay = Math.max(this._shake.decay, duration);
  }

  _spawnHitSparks(cp, damage) {
    if (!cp) return;
    const count = 8 + Math.floor(damage / 4);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const spd = 80 + damage * 3;
      this._particles.spawn({
        x: cp.x, y: cp.y,
        vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
        life: 0.25 + this._rng.next() * 0.15, maxLife: 0.40,
        type: 'spark', color: i % 3 === 0 ? '#ffffff' : PAL.sparkRed, size: 2.5,
        gravity: 120, drag: 2,
      });
    }
  }

  _spawnBlockSparks(cp) {
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i / 5 - 0.5) * 1.2;
      this._particles.spawn({
        x: cp.x, y: cp.y,
        vx: Math.cos(a) * 60, vy: Math.sin(a) * 60,
        life: 0.18, maxLife: 0.18,
        type: 'spark', color: '#e0d0ff', size: 2,
        gravity: 80, drag: 3,
      });
    }
  }

  _spawnDeflectFX(cp) {
    // Golden thread burst
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const spd = 120 + this._rng.next() * 80;
      this._particles.spawn({
        x: cp.x, y: cp.y,
        vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
        life: 0.5, maxLife: 0.5,
        type: 'thread', color: PAL.thread, size: 1.5, len: 20,
        angle: a, va: (this._rng.next() - 0.5) * 4,
        gravity: 30, drag: 2,
      });
    }
    // Radial spark ring
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      this._particles.spawn({
        x: cp.x, y: cp.y,
        vx: Math.cos(a) * 180, vy: Math.sin(a) * 180,
        life: 0.22, maxLife: 0.22,
        type: 'spark', color: '#fffacc', size: 2,
        gravity: 0, drag: 4,
      });
    }
  }

  _spawnCounterFX(cp) {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      this._particles.spawn({
        x: cp.x, y: cp.y,
        vx: Math.cos(a) * 140, vy: Math.sin(a) * 140,
        life: 0.35, maxLife: 0.35,
        type: 'thread', color: PAL.micheal, size: 1.5, len: 16,
        angle: a, va: 2, gravity: 20, drag: 2,
      });
    }
  }

  _spawnPoiseBreakFX(x, victim) {
    const y = CONFIG.ARENA.groundY - 60;
    // Thread snap: two lines that whip outward from the center
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 8; i++) {
        const a = (side > 0 ? 0 : Math.PI) + (i / 7 - 0.5) * 1.0;
        const spd = 150 + i * 20;
        this._particles.spawn({
          x, y: y - i * 6,
          vx: Math.cos(a) * spd, vy: Math.sin(a) * spd - 60,
          life: 0.6, maxLife: 0.6,
          type: 'thread', color: PAL.thread, size: 2, len: 28,
          angle: a, va: side * 2.5, gravity: 60, drag: 1.5,
        });
      }
    }
    this._flash = 0.06;
    this._flashColor = 'rgba(255,200,80,0.45)';
  }

  _spawnFinisherThreads(x) {
    const y = CONFIG.ARENA.groundY - 80;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const dist = 180 + this._rng.next() * 120;
      const sx = x + Math.cos(a) * dist;
      const sy = y + Math.sin(a) * dist;
      // Velocity points inward
      const spd = 260 + this._rng.next() * 80;
      this._particles.spawn({
        x: sx, y: sy,
        vx: (x - sx) / dist * spd,
        vy: (y - sy) / dist * spd,
        life: 0.8, maxLife: 0.8,
        type: 'thread', color: PAL.thread, size: 1.8, len: 30,
        angle: a + Math.PI, va: 0, gravity: 0, drag: 0.5,
      });
    }
  }

  _spawnPhaseThreadLattice(bossX) {
    const cx = bossX, cy = CONFIG.ARENA.groundY - 100;
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const r = 200 + this._rng.next() * 150;
      this._particles.spawn({
        x: cx + Math.cos(a) * r,
        y: cy + Math.sin(a) * r,
        vx: (cx - (cx + Math.cos(a) * r)) * 1.2,
        vy: (cy - (cy + Math.sin(a) * r)) * 1.2,
        life: 1.0, maxLife: 1.0,
        type: 'thread', color: PAL.arelius, size: 2, len: 35,
        angle: a + Math.PI, va: 0, gravity: 0, drag: 0.5,
      });
    }
  }

  _spawnDustStreak(x, y) {
    for (let i = 0; i < 8; i++) {
      const a = Math.PI + (i / 7 - 0.5) * 0.6;
      this._particles.spawn({
        x, y,
        vx: Math.cos(a) * (60 + i * 15), vy: Math.sin(a) * 30 - 20,
        life: 0.30, maxLife: 0.30,
        type: 'spark', color: 'rgba(180,160,120,0.7)', size: 3 + i * 0.4,
        gravity: 60, drag: 3,
      });
    }
  }

  /**
   * @param {object} player Fighter snapshot or live ref (read-only!)
   * @param {object} boss
   * @param {Array} projectiles
   * @param {number} alpha interpolation factor [0,1) between prev/current tick
   * @param {number} realDt real seconds since last rAF
   * @param {object} meta {hitstop:number, tick:number}
   */
  render(player, boss, projectiles, alpha, realDt, meta) {
    const ctx = this.ctx;
    const { width, height, groundY } = this._config.ARENA;

    // Advance particles + shake on REAL dt (they move through hitstop)
    this._particles.update(realDt);
    this._ambientThreads.update(realDt);
    this._playerTrail.update(realDt);
    this._bossTrail.update(realDt);

    if (this._flash > 0) this._flash -= realDt;
    if (this._shake.mag > 0) {
      this._shake.x = (this._rng.next() - 0.5) * 2 * this._shake.mag;
      this._shake.y = (this._rng.next() - 0.5) * 2 * this._shake.mag;
      this._shake.mag -= this._shake.mag * realDt / Math.max(this._shake.decay, 0.001);
      if (this._shake.mag < 0.2) { this._shake.mag = 0; this._shake.x = 0; this._shake.y = 0; }
    }

    // Update prev-pos cache
    if (!this._prevPos.player) this._prevPos.player = { x: player.x };
    if (!this._prevPos.boss)   this._prevPos.boss   = { x: boss.x };

    ctx.save();
    ctx.translate(this._shake.x, this._shake.y);

    // ── 1. Backdrop ──────────────────────────────────────────────────────────
    ctx.fillStyle = this._bgGradient;
    ctx.fillRect(0, 0, width, height);

    // Rim/mood light from behind: a soft radial glow at top-center
    ctx.fillStyle = this._rimGradient;
    ctx.fillRect(0, 0, width, height);

    // ── 2. Ambient fate-threads ──────────────────────────────────────────────
    this._ambientThreads.draw(ctx);

    // ── 3. Ground ────────────────────────────────────────────────────────────
    ctx.fillStyle = PAL.ground;
    ctx.fillRect(0, groundY, width, height - groundY);
    ctx.strokeStyle = PAL.groundLine;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(width, groundY);
    ctx.stroke();

    // Ground tile lines (perspective-ish horizontal marks)
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = 'rgba(50,50,80,0.4)';
    for (let i = 1; i <= 4; i++) {
      const gy = groundY + i * (height - groundY) / 5;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(width, gy); ctx.stroke();
    }

    // ── 4. Stuck giant sword ─────────────────────────────────────────────────
    if (this._stuckSword) {
      this._drawStuckSword(ctx);
    }
    // Check projectiles for sticking
    if (projectiles) {
      for (const proj of projectiles) {
        if (proj.stuck) {
          this._stuckSword = { x: proj.x, y: proj.y ?? groundY - 10, angle: -Math.PI / 2 + 0.1 };
        }
      }
    }

    // ── 5. Projectiles ───────────────────────────────────────────────────────
    if (projectiles) {
      for (const proj of projectiles) {
        if (!proj.stuck) this._drawProjectile(ctx, proj);
      }
    }

    // ── 6 + 7. Fighters: back then front ────────────────────────────────────
    // Determine draw order by position (left fighter drawn first)
    const playerX = this._lerpX('player', player.x, alpha);
    const bossX   = this._lerpX('boss',   boss.x,   alpha);

    if (playerX < bossX) {
      this.drawFighter(player, alpha, false);
      this.drawFighter(boss, alpha, true);
    } else {
      this.drawFighter(boss, alpha, true);
      this.drawFighter(player, alpha, false);
    }

    // ── 8. Sword trails ──────────────────────────────────────────────────────
    this._playerTrail.draw(ctx, PAL.micheal);
    this._bossTrail.draw(ctx, PAL.arelius);

    // ── 9. Particles ─────────────────────────────────────────────────────────
    this._particles.draw(ctx);

    // ── 10. Screen flash ────────────────────────────────────────────────────
    if (this._flash > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, this._flash / 0.04);
      ctx.fillStyle = this._flashColor;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }

    // ── 11. Vignette ─────────────────────────────────────────────────────────
    ctx.fillStyle = this._vigGradient;
    ctx.fillRect(0, 0, width, height);

    ctx.restore(); // pop shake transform

    // Update prev positions for next frame
    this._prevPos.player.x = player.x;
    this._prevPos.boss.x   = boss.x;
  }

  _lerpX(who, curX, alpha) {
    const prev = this._prevPos[who];
    if (!prev) return curX;
    return prev.x + (curX - prev.x) * alpha;
  }

  _drawStuckSword(ctx) {
    const s = this._stuckSword;
    const { bossSwordLen } = SKELETON;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.angle ?? -Math.PI / 2);
    ctx.strokeStyle = PAL.arelius;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.shadowColor = PAL.arelius;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(bossSwordLen, 0);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // hilt cross-guard
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(16, -12);
    ctx.lineTo(16, 12);
    ctx.stroke();
    ctx.restore();
  }

  _drawProjectile(ctx, proj) {
    ctx.save();
    ctx.translate(proj.x, proj.y);
    const facing = proj.vx >= 0 ? 1 : -1;
    ctx.scale(facing, 1);
    ctx.rotate(-0.08);
    ctx.strokeStyle = PAL.arelius;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.shadowColor = PAL.arelius;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(SKELETON.bossSwordLen * 0.9, 0);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(12, -8);
    ctx.lineTo(12, 8);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Map a fighter to (trackName, t01, loop) and draw via forward kinematics.
   */
  drawFighter(f, alpha, isBoss = false) {
    const ctx = this.ctx;
    const scale = isBoss ? SKELETON.bossScale : 1;
    const swordLen = isBoss ? SKELETON.bossSwordLen : SKELETON.swordLen;

    // Resolve x position with interpolation
    const prevX = (isBoss ? this._prevPos.boss : this._prevPos.player)?.x ?? f.x;
    const fx = prevX + (f.x - prevX) * alpha;
    const fy = this._config.ARENA.groundY;

    // Determine which pose track to use
    const { trackName, t01, loop } = this._resolveTrack(f);
    const pose = samplePose(trackName, t01, loop);

    // Palette
    const bladeColor = isBoss ? PAL.arelius : PAL.micheal;
    const bodyColor  = isBoss ? PAL.areliusBody : PAL.michealBody;
    const dimColor   = isBoss ? PAL.areliusDim : PAL.michealDim;

    ctx.save();
    ctx.translate(fx, fy);
    ctx.scale(f.facing * scale, scale);

    // Body glow (rim light effect)
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.shadowColor = bladeColor;
    ctx.shadowBlur = 28;
    ctx.fillStyle = bladeColor;
    ctx.beginPath();
    ctx.ellipse(0, -50, 14, 45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Build skeleton joint positions via forward kinematics
    const torsoLen = SKELETON.torsoLen;
    const headR = SKELETON.headR;
    const upperArm = SKELETON.upperArm;
    const foreArm = SKELETON.foreArm;
    const thigh = SKELETON.thigh;
    const shin = SKELETON.shin;

    // Pelvis
    const pelvisY = pose.rootY - 2;
    const pelvisX = 0;

    // Torso lean applied around pelvis
    const torsoAngle = -Math.PI / 2 + pose.lean + pose.torso;
    const shoulderX = pelvisX + Math.cos(torsoAngle) * torsoLen;
    const shoulderY = pelvisY + Math.sin(torsoAngle) * torsoLen;

    // Head
    const headAngle = torsoAngle + pose.head;
    const headX = shoulderX + Math.cos(headAngle) * headR * 1.2;
    const headY = shoulderY + Math.sin(headAngle) * headR * 1.2;

    // Front arm (sword arm)
    const armFShoulderAngle = pose.armF[0];
    const armFElbowAngle = pose.armF[1];
    const elbowFX = shoulderX + Math.cos(armFShoulderAngle) * upperArm;
    const elbowFY = shoulderY + Math.sin(armFShoulderAngle) * upperArm;
    const wristFX = elbowFX + Math.cos(armFShoulderAngle + armFElbowAngle) * foreArm;
    const wristFY = elbowFY + Math.sin(armFShoulderAngle + armFElbowAngle) * foreArm;

    // Back arm
    const armBShoulderAngle = pose.armB[0];
    const armBElbowAngle = pose.armB[1];
    const elbowBX = shoulderX + Math.cos(armBShoulderAngle) * upperArm;
    const elbowBY = shoulderY + Math.sin(armBShoulderAngle) * upperArm;
    const wristBX = elbowBX + Math.cos(armBShoulderAngle + armBElbowAngle) * foreArm;
    const wristBY = elbowBY + Math.sin(armBShoulderAngle + armBElbowAngle) * foreArm;

    // Front leg
    const legFHipAngle  = pose.legF[0];
    const legFKneeAngle = pose.legF[1];
    const kneeFX = pelvisX + Math.cos(Math.PI / 2 + legFHipAngle) * thigh;
    const kneeFY = pelvisY + Math.sin(Math.PI / 2 + legFHipAngle) * thigh;
    const footFX = kneeFX + Math.cos(Math.PI / 2 + legFHipAngle + legFKneeAngle) * shin;
    const footFY = kneeFY + Math.sin(Math.PI / 2 + legFHipAngle + legFKneeAngle) * shin;

    // Back leg
    const legBHipAngle  = pose.legB[0];
    const legBKneeAngle = pose.legB[1];
    const kneeBX = pelvisX + Math.cos(Math.PI / 2 + legBHipAngle) * thigh;
    const kneeBY = pelvisY + Math.sin(Math.PI / 2 + legBHipAngle) * thigh;
    const footBX = kneeBX + Math.cos(Math.PI / 2 + legBHipAngle + legBKneeAngle) * shin;
    const footBY = kneeBY + Math.sin(Math.PI / 2 + legBHipAngle + legBKneeAngle) * shin;

    // Sword tip
    const swordGlobalAngle = armFShoulderAngle + armFElbowAngle + pose.sword;
    const swordTipX = wristFX + Math.cos(swordGlobalAngle) * swordLen;
    const swordTipY = wristFY + Math.sin(swordGlobalAngle) * swordLen;

    // ── Draw back limbs first ────────────────────────────────────────────────
    ctx.strokeStyle = dimColor;
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Back leg
    ctx.beginPath(); ctx.moveTo(pelvisX, pelvisY); ctx.lineTo(kneeBX, kneeBY); ctx.lineTo(footBX, footBY); ctx.stroke();

    // Back arm
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(shoulderX, shoulderY); ctx.lineTo(elbowBX, elbowBY); ctx.lineTo(wristBX, wristBY); ctx.stroke();

    // ── Torso ────────────────────────────────────────────────────────────────
    ctx.strokeStyle = bodyColor;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(pelvisX, pelvisY);
    ctx.lineTo(shoulderX, shoulderY);
    ctx.stroke();

    // ── Head ────────────────────────────────────────────────────────────────
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.arc(headX, headY, headR, 0, Math.PI * 2);
    ctx.fill();
    // Glowing eyes
    ctx.fillStyle = bladeColor;
    ctx.shadowColor = bladeColor;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(headX + 3, headY - 2, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // ── Front leg ────────────────────────────────────────────────────────────
    ctx.strokeStyle = bodyColor;
    ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(pelvisX, pelvisY); ctx.lineTo(kneeFX, kneeFY); ctx.lineTo(footFX, footFY); ctx.stroke();

    // ── Front arm ────────────────────────────────────────────────────────────
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(shoulderX, shoulderY); ctx.lineTo(elbowFX, elbowFY); ctx.lineTo(wristFX, wristFY); ctx.stroke();

    // ── Sword ─────────────────────────────────────────────────────────────────
    ctx.save();
    ctx.strokeStyle = bladeColor;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.shadowColor = bladeColor;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.moveTo(wristFX, wristFY);
    ctx.lineTo(swordTipX, swordTipY);
    ctx.stroke();
    // Blade highlight
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(wristFX, wristFY);
    ctx.lineTo(swordTipX, swordTipY);
    ctx.stroke();
    ctx.restore();

    ctx.restore(); // pop scale/translate

    // Push sword tip world coords to trail (in world space)
    // Un-transform wrist/tip back to world coords for the trail
    const wsWristX = fx + f.facing * scale * wristFX;
    const wsWristY = fy + scale * wristFY;
    const wsTipX   = fx + f.facing * scale * swordTipX;
    const wsTipY   = fy + scale * swordTipY;

    if (f.state === 'ATTACK' && f.attack) {
      if (isBoss) this._bossTrail.push(wsWristX, wsWristY, wsTipX, wsTipY);
      else        this._playerTrail.push(wsWristX, wsWristY, wsTipX, wsTipY);
    } else {
      if (isBoss) this._bossTrail.clear();
      else        this._playerTrail.clear();
    }
  }

  /**
   * Resolve which pose track + t01 + loop to use for the given fighter snapshot.
   */
  _resolveTrack(f) {
    const ARENA = this._config.ARENA;
    const fps = this._config.TIMING.fps;

    switch (f.state) {
      case 'IDLE':
        return { trackName: 'idle', t01: (f.stateFrame % 60) / 60, loop: true };

      case 'MOVE':
        return { trackName: 'walk', t01: (f.stateFrame % 60) / 60, loop: true };

      case 'RUN':
        return { trackName: 'run', t01: (f.stateFrame % 40) / 40, loop: true };

      case 'DODGE':
        return {
          trackName: 'dodge',
          t01: f.stateDuration > 0 ? f.stateFrame / f.stateDuration : 0,
          loop: false,
        };

      case 'BLOCK':
        return { trackName: 'block', t01: (f.stateFrame % 30) / 30, loop: true };

      case 'DEFLECT':
        return {
          trackName: 'deflect',
          t01: f.stateDuration > 0 ? f.stateFrame / f.stateDuration : 0,
          loop: false,
        };

      case 'DEFLECT_SUCCESS':
        return {
          trackName: 'deflectSuccess',
          t01: f.stateDuration > 0 ? f.stateFrame / f.stateDuration : 0,
          loop: false,
        };

      case 'DEFLECT_RECOIL':
        return {
          trackName: 'deflectRecoil',
          t01: f.stateDuration > 0 ? f.stateFrame / f.stateDuration : 0,
          loop: false,
        };

      case 'HITSTUN':
        return {
          trackName: 'hitstun',
          t01: f.stateDuration > 0 ? f.stateFrame / f.stateDuration : 0,
          loop: false,
        };

      case 'BLOCKSTUN':
        return {
          trackName: 'blockstun',
          t01: f.stateDuration > 0 ? f.stateFrame / f.stateDuration : 0,
          loop: false,
        };

      case 'STAGGERED':
        return {
          trackName: 'staggered',
          t01: f.stateDuration > 0 ? f.stateFrame / f.stateDuration : 0,
          loop: false,
        };

      case 'KNEEL':
        return {
          trackName: 'kneel',
          t01: f.stateDuration > 0 ? f.stateFrame / f.stateDuration : 0,
          loop: false,
        };

      case 'DEAD':
        return {
          trackName: 'dead',
          t01: Math.min(1, f.stateFrame / (fps * 1.5)),
          loop: false,
        };

      case 'TELEPORT': {
        const halfFrames = this._config.BOSS.teleportFrames / 2;
        if (f.stateFrame < halfFrames) {
          return {
            trackName: 'teleportOut',
            t01: f.stateFrame / halfFrames,
            loop: false,
          };
        } else {
          const d = f.stateDuration > 0 ? f.stateDuration : this._config.BOSS.teleportFrames;
          return {
            trackName: 'teleportIn',
            t01: (f.stateFrame - halfFrames) / (d - halfFrames),
            loop: false,
          };
        }
      }

      case 'PHASE_TRANSITION':
        return {
          trackName: 'phaseTransition',
          t01: f.stateDuration > 0 ? f.stateFrame / f.stateDuration : 0,
          loop: false,
        };

      case 'ATTACK': {
        if (!f.attack) return { trackName: 'idle', t01: 0, loop: false };
        const atk = f.attack;
        const attackId = atk.id;

        // Charge loop: while in windup phase and chargeable
        if (atk.phase === 'windup' && atk.chargeHeldFrames > 0) {
          const loopPeriod = 30;
          return {
            trackName: 'chargeLoop',
            t01: (atk.chargeHeldFrames % loopPeriod) / loopPeriod,
            loop: true,
          };
        }

        const def = this._getAttackDef(attackId, f);
        if (!def) return { trackName: 'idle', t01: 0, loop: false };
        const total = def.windup + def.active + def.recovery;
        const t01 = total > 0 ? atk.frame / total : 0;
        return { trackName: def.pose, t01, loop: false };
      }

      case 'FINISHING':
        return {
          trackName: f.id === 'player' ? 'finisherPlayer' : 'finisherBoss',
          t01: f.attack ? (() => {
            const def = this._getAttackDef(f.attack.id, f);
            const total = def ? def.windup + def.active + def.recovery : 54;
            return f.attack.frame / total;
          })() : 0,
          loop: false,
        };

      case 'BEING_FINISHED':
        return {
          trackName: 'beingFinished',
          t01: f.stateDuration > 0 ? f.stateFrame / f.stateDuration : 0,
          loop: false,
        };

      default:
        return { trackName: 'idle', t01: 0, loop: false };
    }
  }

  _getAttackDef(id, f) {
    const cfg = this._config;
    return cfg.PLAYER.attacks[id] ?? cfg.BOSS.attacks[id] ?? null;
  }
}
