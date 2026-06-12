// hud.js — bars, prompts, banners. WP-D implements. Read-only over fighters.
//
// Layout (frozen):
// - Bottom-left: "MICHEAL" — HP bar (steel) above a poise bar drawn as a
//   thread that TAUTENS and brightens as it fills toward break (0→max).
// - Top-center: "ARELIUS" — boss HP bar (gold, long) + poise thread + phase
//   pips (I / II, lit by phase).
// - Finisher prompt: "J — SEVER THE THREAD" floating over a STAGGERED fighter.
// - Charge level pips while a charge is held (1–3).
// - Dodge-cooldown: subtle dim on a small roll icon while dodgeCooldown > 0.
// - Key reference strip (toggle H): A/D move · J slash · K thrust · L charge ·
//   Space dodge · S guard (tap deflect / hold block).
// - Banners: "THE THREAD IS CUT" (victory), "FATE RECLAIMED" (defeat),
//   "ARELIUS UNBOUND" (phase 2 ceremony).

import { CONFIG } from './config.js';

const PALETTE = {
  gold:        '#ffc24d',
  goldDim:     '#a07820',
  steel:       '#9fd8ff',
  steelDim:    '#3a6080',
  dark:        'rgba(0,0,0,0.72)',
  darkPanel:   'rgba(10,6,2,0.82)',
  poiseThread0: '#7a9aaa',   // cold, slack thread at poise=0
  poiseThread1: '#ffffff',   // taut, bright thread near break
  white:       '#ffffff',
  dim:         'rgba(255,255,255,0.35)',
  bannerBg:    'rgba(0,0,0,0.78)',
  pilosDim:    'rgba(255,194,77,0.25)',
  pilosLit:    '#ffc24d',
};

// Layout constants (visual-only, not balance)
const HP_BAR = { w: 260, h: 14, rx: 3 };
const BOSS_HP_BAR = { w: 520, h: 14, rx: 3 };
const THREAD_H = 6;
const PLAYER_ORIGIN = { x: 24, y: 0 };   // bottom-left anchor; y resolved in render
const PLAYER_BOTTOM_PAD = 64;
const BOSS_TOP_PAD = 28;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawHpBar(ctx, x, y, w, h, frac, fillColor, bgColor = 'rgba(0,0,0,0.55)') {
  ctx.fillStyle = bgColor;
  roundRect(ctx, x, y, w, h, HP_BAR.rx);
  ctx.fill();

  if (frac > 0) {
    ctx.fillStyle = fillColor;
    roundRect(ctx, x, y, Math.max(HP_BAR.rx * 2, w * frac), h, HP_BAR.rx);
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, HP_BAR.rx);
  ctx.stroke();
}

function drawPoiseThread(ctx, x, y, w, poiseFrac, isPlayer) {
  // Thread tautens and brightens as poise fills toward break (0→max).
  // At poiseFrac=0: slack (wavy), cold color, thin.
  // At poiseFrac=1: taut (straight), bright near-white, thick.
  const bright = isPlayer
    ? lerpColor(PALETTE.poiseThread0, PALETTE.poiseThread1, poiseFrac)
    : lerpColor(PALETTE.goldDim, PALETTE.gold, poiseFrac);

  const thickness = 1 + poiseFrac * 2.5;
  const waveMag = (1 - poiseFrac) * 5;   // slack at low poise, flat at high
  const segments = 24;

  ctx.save();
  ctx.strokeStyle = bright;
  ctx.lineWidth = thickness;
  ctx.shadowColor = bright;
  ctx.shadowBlur = poiseFrac * 8;
  ctx.beginPath();

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const px = x + t * w;
    const py = y + Math.sin(t * Math.PI * 3) * waveMag * (1 - t * t);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.restore();
}

function lerpColor(hex0, hex1, t) {
  const r0 = parseInt(hex0.slice(1, 3), 16);
  const g0 = parseInt(hex0.slice(3, 5), 16);
  const b0 = parseInt(hex0.slice(5, 7), 16);
  const r1 = parseInt(hex1.slice(1, 3), 16);
  const g1 = parseInt(hex1.slice(3, 5), 16);
  const b1 = parseInt(hex1.slice(5, 7), 16);
  const r = Math.round(r0 + (r1 - r0) * t);
  const g = Math.round(g0 + (g1 - g0) * t);
  const b = Math.round(b0 + (b1 - b0) * t);
  return `rgb(${r},${g},${b})`;
}

export class HUD {
  /** @param {object} config CONFIG */
  constructor(config) {
    this.config = config;
    this.showHelp = true;        // visible until first toggle
  }

  /**
   * @param {CanvasRenderingContext2D} ctx2d same context, drawn last
   * @param {object} player fighter (read-only)
   * @param {object} boss
   * @param {object} meta {phase:number, finisherAvailableFor:'player'|'boss'|null,
   *   banner:{text,untilTick}|null, tick:number, chargeLevel:number|null}
   */
  render(ctx2d, player, boss, meta) {
    const W = this.config.ARENA.width;
    const H = this.config.ARENA.height;
    const ctx = ctx2d;
    const { phase, finisherAvailableFor, banner, tick, chargeLevel } = meta;

    ctx.save();
    ctx.font = '13px Georgia, serif';
    ctx.textBaseline = 'middle';

    // ── MICHEAL — bottom-left ──────────────────────────────────────────────
    const py = H - PLAYER_BOTTOM_PAD;
    const px = PLAYER_ORIGIN.x;
    const playerHpFrac = Math.max(0, player.hp / this.config.PLAYER.hpMax);
    const playerPoiseFrac = Math.max(0, player.poise / this.config.PLAYER.poiseMax);

    // Name label
    ctx.fillStyle = PALETTE.steel;
    ctx.font = 'bold 13px Georgia, serif';
    ctx.textBaseline = 'bottom';
    ctx.fillText('MICHEAL', px, py - HP_BAR.h - THREAD_H - 10);

    // HP bar
    drawHpBar(ctx, px, py - HP_BAR.h - THREAD_H - 4, HP_BAR.w, HP_BAR.h, playerHpFrac, PALETTE.steel);

    // Poise thread below HP bar
    const pThreadY = py - THREAD_H + 2;
    drawPoiseThread(ctx, px, pThreadY, HP_BAR.w, playerPoiseFrac, true);

    // Dodge cooldown icon (small circle, dimmed when on cooldown)
    this._drawDodgeIcon(ctx, px + HP_BAR.w + 14, py - HP_BAR.h / 2 - 4, player.dodgeCooldown > 0);

    // ── ARELIUS — top-center ───────────────────────────────────────────────
    const bossHpFrac = Math.max(0, boss.hp / this.config.BOSS.hpMax);
    const bossPoiseFrac = Math.max(0, boss.poise / this.config.BOSS.poiseMax);
    const bx = (W - BOSS_HP_BAR.w) / 2;
    const by = BOSS_TOP_PAD;

    // Phase pips (I / II) — top-right of the boss bar area
    this._drawPhasePips(ctx, bx + BOSS_HP_BAR.w + 12, by + HP_BAR.h / 2, phase);

    // Name label
    ctx.fillStyle = PALETTE.gold;
    ctx.font = 'bold 13px Georgia, serif';
    ctx.textBaseline = 'top';
    ctx.fillText('ARELIUS', bx, by);

    const bBarY = by + 18;
    drawHpBar(ctx, bx, bBarY, BOSS_HP_BAR.w, HP_BAR.h, bossHpFrac, PALETTE.gold);

    const bThreadY = bBarY + HP_BAR.h + 6;
    drawPoiseThread(ctx, bx, bThreadY, BOSS_HP_BAR.w, bossPoiseFrac, false);

    // ── Finisher prompt ────────────────────────────────────────────────────
    if (finisherAvailableFor === 'player') {
      this._drawFinisherPrompt(ctx, W / 2, boss.x ?? W / 2, H, 'boss');
    } else if (finisherAvailableFor === 'boss') {
      this._drawFinisherPrompt(ctx, W / 2, player.x ?? W / 4, H, 'player');
    }

    // ── Charge level pips ─────────────────────────────────────────────────
    if (chargeLevel !== null && chargeLevel !== undefined) {
      this._drawChargePips(ctx, px, py - HP_BAR.h - THREAD_H - 30, chargeLevel);
    }

    // ── Banner ────────────────────────────────────────────────────────────
    if (banner && tick <= banner.untilTick) {
      this._drawBanner(ctx, W, H, banner.text);
    }

    // ── Help strip ────────────────────────────────────────────────────────
    if (this.showHelp) {
      this._drawHelpStrip(ctx, W, H);
    }

    ctx.restore();
  }

  _drawDodgeIcon(ctx, cx, cy, onCooldown) {
    const r = 9;
    ctx.save();
    ctx.globalAlpha = onCooldown ? 0.28 : 0.75;
    ctx.strokeStyle = PALETTE.steel;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    // Arrow suggesting roll
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy);
    ctx.lineTo(cx + 5, cy);
    ctx.moveTo(cx + 2, cy - 3);
    ctx.lineTo(cx + 5, cy);
    ctx.lineTo(cx + 2, cy + 3);
    ctx.stroke();
    ctx.restore();
  }

  _drawPhasePips(ctx, x, cy, phase) {
    const labels = ['I', 'II'];
    ctx.save();
    ctx.font = '11px Georgia, serif';
    ctx.textBaseline = 'middle';
    labels.forEach((label, i) => {
      const lit = phase >= i + 1;
      ctx.fillStyle = lit ? PALETTE.pilosLit : PALETTE.pilosDim;
      ctx.fillText(label, x + i * 22, cy);
    });
    ctx.restore();
  }

  _drawFinisherPrompt(ctx, canvasMidX, targetX, canvasH, targetSide) {
    const promptY = targetSide === 'boss'
      ? 80                     // near boss bar
      : canvasH - 120;         // above player area

    const text = 'J — SEVER THE THREAD';
    ctx.save();
    ctx.font = 'bold 18px Georgia, serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const tw = ctx.measureText(text).width;
    const pad = 14;
    const halfW = tw / 2 + pad;
    // Clamp so the prompt stays fully on canvas regardless of fighter position
    const cx = Math.max(halfW, Math.min(canvasMidX * 2 - halfW, targetX));
    ctx.fillStyle = PALETTE.bannerBg;
    ctx.fillRect(cx - halfW, promptY - 16, tw + pad * 2, 32);

    // Pulsing gold border
    ctx.strokeStyle = PALETTE.gold;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - halfW, promptY - 16, tw + pad * 2, 32);

    ctx.fillStyle = PALETTE.gold;
    ctx.shadowColor = PALETTE.gold;
    ctx.shadowBlur = 8;
    ctx.fillText(text, cx, promptY);
    ctx.restore();
  }

  _drawChargePips(ctx, x, y, level) {
    // level 0 = holding but not yet stage 1 (show 0 lit pips)
    // level 1/2/3 = show that many lit pips
    const pipCount = 3;
    const pipW = 18;
    const pipH = 6;
    const gap = 4;
    ctx.save();
    for (let i = 0; i < pipCount; i++) {
      const lit = i < level;
      ctx.fillStyle = lit ? PALETTE.gold : 'rgba(255,194,77,0.18)';
      ctx.fillRect(x + i * (pipW + gap), y, pipW, pipH);
      ctx.strokeStyle = lit ? PALETTE.gold : 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + i * (pipW + gap), y, pipW, pipH);
    }
    ctx.restore();
  }

  _drawBanner(ctx, W, H, text) {
    const cy = H / 2;
    ctx.save();
    ctx.font = 'bold 42px Georgia, serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const tw = ctx.measureText(text).width;
    const pad = 32;
    const bh = 72;

    ctx.fillStyle = PALETTE.bannerBg;
    ctx.fillRect(W / 2 - tw / 2 - pad, cy - bh / 2, tw + pad * 2, bh);

    ctx.strokeStyle = PALETTE.gold;
    ctx.lineWidth = 2;
    ctx.strokeRect(W / 2 - tw / 2 - pad, cy - bh / 2, tw + pad * 2, bh);

    ctx.fillStyle = PALETTE.gold;
    ctx.shadowColor = PALETTE.gold;
    ctx.shadowBlur = 22;
    ctx.fillText(text, W / 2, cy);
    ctx.restore();
  }

  _drawHelpStrip(ctx, W, H) {
    const items = [
      'A/D move',
      'J slash',
      'K thrust',
      'L charge',
      'Space dodge',
      'S guard (tap deflect / hold block)',
      'H toggle help',
    ];
    const text = items.join('  ·  ');
    ctx.save();
    ctx.font = '11px Georgia, serif';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'center';

    const tw = ctx.measureText(text).width;
    const ph = 22;
    const py = H - 8;

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(W / 2 - tw / 2 - 10, py - ph, tw + 20, ph);

    ctx.fillStyle = PALETTE.dim;
    ctx.fillText(text, W / 2, py);
    ctx.restore();
  }
}
