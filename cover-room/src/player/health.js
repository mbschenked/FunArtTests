// Player health = "luck" (B1). Spec: refs/player-spec.md §7. No health bar: damage drives the HUD's health look
// (desaturation + vignette through render.setGrade), the damage-direction streak and the camera's damage wobble.
//
//   createHealth(game, actor, ctrl) -> health    (controller.js calls it; update(dt) runs inside the player system)
//   health.hp, health.luck (0..1), health.lastHitT, health.dead
//   health.damage(amount, dirWorld?, source?, part?)   also fed by 'damage' events whose target is the player
//   health.reset()                                   full hp (respawn)
//   health.restart()                                 = ctrl.respawn()
//
// It keeps its own hp and writes actor.health; actor.takeDamage is a no-op so B2's applyDamage leaves hp to this module.
// On a hit: hud.damage(travelDir, strength) (unless player.health.driveHud is off, e.g. when hud.wire() is used),
// cameraRig.wobble(), anim.hit. hp <= 0: mode 'dead', a 'death' event, a fade to black after player.deathFade, then
// "R / click to restart" (the reload action or the button).
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function defineParams(P) {
  const d = (k, v, o) => P.define(k, v, o);
  d('player.maxHp', 100, { min: 1, max: 1000, step: 1, label: 'max hp' });                          // PS §7 [INFERRED]
  // Max 12 Nov: health regenerates over time and any hit stops it (damage() resets lastHitT, update() waits regenDelay).
  d('player.regenDelay', 1.5, { min: 0, max: 10, step: 0.05, label: 'regen delay (s)' });            // PS §7 [MEASURED low → split INFERRED] F1 ≈2.3 s total (yt-workaround)
  d('player.regenRate', 120, { min: 1, max: 1000, step: 1, label: 'regen (hp/s)' });                 // PS §7 [INFERRED] full in ~0.8 s
  d('player.damageTakenMult', 1, { min: 0, max: 5, step: 0.05, label: 'damage taken ×' });           // PS §7 difficultyTakenMult [WIKI: same on all U4 difficulties]
  d('player.deathFade', 1.5, { min: 0, max: 5, step: 0.05, label: 'death fade (s)' });               // PS §7 [INFERRED]
  d('player.restartDelay', 0.6, { min: 0, max: 5, step: 0.05, label: 'restart allowed after fade (s)' }); // [INFERRED]
  d('player.health.driveHud', true, { label: 'drive HUD damage/health' });                            // off if hud.wire() handles player damage
  d('player.health.godMode', false, { label: 'god mode' });                                          // debug
}

export function createHealth(game, actor, ctrl) {
  const P = game.params;
  defineParams(P);
  const pg = (k) => P.get(k);
  const travel = actor.pos.clone().set(0, 0, 0);
  const deathEvt = { actor, source: null };

  const h = {
    hp: pg('player.maxHp'), luck: 1, lastHitT: -1e9, dead: false, deathT: 0, _overlay: null,

    damage(amount, dir, source, part) {
      if (h.dead || !(amount > 0)) return;
      if (!pg('player.health.godMode')) h.hp -= amount * pg('player.damageTakenMult');
      h.lastHitT = game.time;
      ctrl.lastCombatT = game.time;
      // travel direction (attacker -> player): prefer the attacker's position, it holds for bullets and blasts alike
      if (source && source.pos) travel.subVectors(actor.pos, source.pos);
      else if (dir) travel.copy(dir);
      else travel.set(0, 0, 0);
      travel.y = 0;
      const l = travel.length();
      if (l > 1e-6) travel.multiplyScalar(1 / l);
      const a = actor.anim;
      a.hit.dir.copy(travel); a.hit.part = part || 'torso'; a.hit.t = 0;
      if (game.cameraRig && game.cameraRig.wobble) game.cameraRig.wobble();
      if (pg('player.health.driveHud') && game.hud && game.hud.damage && l > 1e-6) {
        game.hud.damage(travel, clamp(0.55 + (amount / pg('player.maxHp')) * 2, 0, 1));
      }
      if (h.hp <= 0) {
        h.hp = 0;
        h.dead = true;
        h.deathT = 0;
        actor.health = 0;
        ctrl.setMode('dead', { dir: l > 1e-6 ? travel : null, source });
        deathEvt.source = source || null;
        game.events.emit('death', deathEvt);
      }
      actor.health = h.hp;
    },

    reset() {
      h.hp = pg('player.maxHp'); h.dead = false; h.deathT = 0; h.lastHitT = -1e9;
      actor.health = h.hp; actor.maxHealth = h.hp; actor.alive = true;
      h.luck = 1;
      if (game.hud && game.hud.setHealthLook) game.hud.setHealthLook(1);
      overlay(0, false);
    },

    restart() { ctrl.respawn(); },

    update(dt) {
      const max = pg('player.maxHp');
      actor.maxHealth = max;
      if (!h.dead && ctrl.mode === 'dead') {   // e.g. a lethal fall
        h.dead = true; h.hp = 0; h.deathT = 0;
        deathEvt.source = null;
        game.events.emit('death', deathEvt);
      }
      if (h.dead) {
        h.deathT += dt;
        const fade = pg('player.deathFade');
        const ready = h.deathT >= fade + pg('player.restartDelay');
        overlay(fade > 0 ? clamp(h.deathT / fade, 0, 1) : 1, ready);
        if (ready && game.input && game.input.pressed('reload')) { h.restart(); return; }
      } else if (game.time - h.lastHitT > pg('player.regenDelay')) {
        h.hp = Math.min(max, h.hp + pg('player.regenRate') * dt);
      }
      actor.health = h.hp;
      h.luck = clamp(h.hp / max, 0, 1);
      if (pg('player.health.driveHud') && game.hud && game.hud.setHealthLook) game.hud.setHealthLook(h.luck);
    },
  };

  game.events.on('damage', (e) => {
    if (!e || e.target !== actor) return;
    h.damage(+e.amount || 0, e.dir, e.source, e.part);
  });
  // B2's applyDamage calls target.takeDamage(payload) instead of subtracting health when it exists, then emits the
  // 'damage' event handled above: so hp, death and the 'death' event are applied once, here.
  actor.takeDamage = () => {};

  // Fade-to-black + restart button. Built on first use; DOM only (no WebGL cost).
  let ov = null, btn = null, lastA = -1, lastReady = null;
  function overlay(alpha, ready) {
    if (typeof document === 'undefined') return;
    if (!ov) {
      if (alpha <= 0) return;
      ov = document.createElement('div');
      ov.className = 'cr-death';
      ov.style.cssText = 'position:fixed;inset:0;z-index:15;background:#000;opacity:0;pointer-events:none;'
        + 'display:flex;align-items:center;justify-content:center;';
      btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Restart  [R]';
      btn.style.cssText = 'font:600 13px/1 ui-monospace,Menlo,monospace;letter-spacing:.18em;text-transform:uppercase;'
        + 'color:#e8ecf2;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.35);border-radius:3px;'
        + 'padding:12px 20px;cursor:pointer;visibility:hidden;pointer-events:auto;';
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); if (h.dead) h.restart(); });
      ov.appendChild(btn);
      document.body.appendChild(ov);
    }
    const q = Math.round(alpha * 100) / 100;
    if (q !== lastA) { ov.style.opacity = String(q * 0.92); ov.style.display = q > 0 ? 'flex' : 'none'; lastA = q; }
    if (ready !== lastReady) {
      btn.style.visibility = ready ? 'visible' : 'hidden';
      lastReady = ready;
      if (ready && typeof document.exitPointerLock === 'function' && document.pointerLockElement) document.exitPointerLock();
    }
  }

  actor.health = h.hp; actor.maxHealth = h.hp;
  return h;
}
