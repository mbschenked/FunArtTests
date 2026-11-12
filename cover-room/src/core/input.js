// Input: action map over keyboard/mouse and the Gamepad API (standard mapping). Contract: refs/design.md "core/input.js".
//
//   down(a) / pressed(a) / released(a)   button state; edges are per SIM STEP (taps shorter than a step still register)
//   heldTime(a)                          seconds (sim) the button has been down, 0 when up
//   axis('move') -> {x, y}               deadzone-shaped, |v| <= 1, +y = forward, +x = right. Reused object: copy, don't keep.
//   axis('look') -> {x, y}               the right stick (or injected look stick) after its deadzone, before the curve
//   lookDelta() -> {yaw, pitch}          radians this step. +yaw = turn left (counter-clockwise seen from above, same sense
//                                        as three.js rotation.y with forward +Z), +pitch = look up. Reused object.
//   device                               'kbm' or 'pad', whichever was used last (emits 'input:device' on change)
//   inject(obj, merge=false) / inject(null)
//       Overrides ALL real input from the next step until inject(null). obj replaces the injected state unless merge.
//       Buttons: {fire: true, aim: true, ...}. Axes: {move: {x, y} or [x, y]}, {look: {x, y}} (a stick: goes through
//       the pad look curve, rate and acceleration), {lookDelta: {yaw, pitch}} (radians added every step), {device: 'pad'}.
//
// The Input object is itself the 'input' system (order 0): update() latches this step's state from the raw devices.
// Pointer lock is requested on a canvas click (off in ?test). Every feel number is a param ('input.*').
// Bindings and look/deadzone defaults follow refs/player-spec.md §1 and §3 (set by B1, 2026-11-11).

export const BUTTONS = ['aim', 'fire', 'reload', 'grenade', 'cover', 'jump', 'swapShoulder', 'walk', 'melee'];
export const AXES = ['move', 'look'];

// Bindings table. Keyboard entries are KeyboardEvent.code values; mouse buttons are 'Mouse0' (left), 'Mouse1' (middle),
// 'Mouse2' (right). Pad entries are standard-mapping button indices
// (0 Cross/A, 1 Circle/B, 2 Square/X, 3 Triangle/Y, 4 L1, 5 R1, 6 L2, 7 R2, 8 Share, 9 Options, 10 L3, 11 R3, 12-15 d-pad).
// refs/player-spec.md §1 [WIKI]: PC RMB aim, LMB fire, G grenade, Left Shift cover/roll, Space jump (and shoulder swap
// while aiming), R reload, Left Ctrl slow walk; PS4 L2 aim, R2 fire, R1 grenade, Circle cover/roll, X jump (shoulder swap
// while aiming), Triangle reload, light stick push = walk. Cover is also the roll in the open (U4); swapShoulder shares
// the jump key and the player controller picks one from context (aim held = swap).
// Walk: Left Ctrl as on PC, but only on macOS: on Windows/Linux Ctrl+W closes the tab and can't be blocked, so walk
// there is C (C is "mark enemy" in the game, out of scope here). C also works on macOS. [ASSUMED key choice]
// Melee: F on PC, Square on PS4 (refs/player-spec.md §1 [WIKI]). In this room melee is only the stealth takedown
// (src/player/stealth.js); there is no open-fight melee yet.
const MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent || '');
export const DEFAULT_BINDINGS = {
  kbm: {
    moveForward: ['KeyW'], moveBack: ['KeyS'], moveLeft: ['KeyA'], moveRight: ['KeyD'],
    aim: ['Mouse2'], fire: ['Mouse0'], reload: ['KeyR'], grenade: ['KeyG'], cover: ['ShiftLeft'],
    jump: ['Space'], swapShoulder: ['Space'], walk: MAC ? ['ControlLeft', 'KeyC'] : ['KeyC'], melee: ['KeyF'],
  },
  pad: {
    aim: [6], fire: [7], grenade: [5], cover: [1], jump: [0], reload: [3], swapShoulder: [0], walk: [], melee: [2],
    moveStick: 0, lookStick: 1,          // 0 = left stick (axes 0, 1), 1 = right stick (axes 2, 3)
  },
};

const ANALOG_TRIGGERS = new Set([6, 7]);
const DEG = Math.PI / 180;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function isEditable(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && el.type !== 'checkbox' && el.type !== 'button' && el.type !== 'range';
}

export class Input {
  constructor(game, { canvas = null, pointerLock = true, bindings = DEFAULT_BINDINGS } = {}) {
    this.game = game;
    this.name = 'input';
    this.order = 0;
    this.canvas = canvas;
    this.bindings = structuredClone(bindings);
    this.device = 'kbm';

    const n = BUTTONS.length;
    this._index = Object.create(null);
    BUTTONS.forEach((a, i) => { this._index[a] = i; });
    this._down = new Uint8Array(n);       // state this step
    this._prev = new Uint8Array(n);
    this._pressed = new Uint8Array(n);
    this._released = new Uint8Array(n);
    this._latch = new Uint8Array(n);      // a press event arrived since the last step (catches sub-step taps)
    this._held = new Float64Array(n);
    this._inj = new Uint8Array(n);

    this._keys = new Set();               // KeyboardEvent.code / 'MouseN' currently down
    this._mouseDX = 0; this._mouseDY = 0; // accumulated since the last step
    this._move = { x: 0, y: 0 };
    this._tmp = { x: 0, y: 0 };
    this._look = { x: 0, y: 0 };
    this._lookDelta = { yaw: 0, pitch: 0 };
    this._accelT = 0;                     // seconds the look stick has been past the acceleration threshold
    this._padIndex = -1;                  // a connected pad, or -1 (no polling, no allocation, while none is connected)

    this._injecting = false;
    this._injMove = { x: 0, y: 0 };
    this._injLook = { x: 0, y: 0 };
    this._injLookDelta = { yaw: 0, pitch: 0 };

    this._defineParams(game.params);
    this._actionsFor = this._buildKeyMap();
    if (typeof window !== 'undefined') this._attach(pointerLock);
  }

  _defineParams(P) {
    // Defaults from refs/player-spec.md §1 (control map) and §3 (look.* rows). Raw mouse input (no acceleration): §1
    // recommends it [WIKI + choice]. PC has separate Camera and Aiming mouse sliders [WIKI] = degPerPx and aimScale.
    P.define('input.mouse.degPerPx', 0.12, { min: 0.01, max: 0.6, step: 0.005, label: 'mouse deg/px' });        // [INFERRED] no source
    P.define('input.mouse.aimScale', 1.0, { min: 0.2, max: 1.5, step: 0.01, label: 'mouse aim scale' });       // [INFERRED] §3 look.mouse.aiming
    P.define('input.mouse.invertY', false, { label: 'mouse invert Y' });
    P.define('input.pad.moveDeadzone', 0.15, { min: 0, max: 0.5, step: 0.01, label: 'move deadzone' });       // §2 player.move.deadzone [INFERRED]
    P.define('input.pad.lookDeadzone', 0.15, { min: 0, max: 0.5, step: 0.01, label: 'look deadzone' });       // [INFERRED]
    P.define('input.pad.outerDeadzone', 0.95, { min: 0.7, max: 1, step: 0.01, label: 'outer deadzone' });     // [INFERRED]
    P.define('input.pad.triggerThreshold', 0.35, { min: 0.05, max: 0.9, step: 0.01, label: 'L2/R2 threshold' }); // [INFERRED]
    P.define('input.pad.yawRate', 200, { min: 30, max: 720, step: 5, label: 'yaw rate deg/s' });              // §3 look.pad.yawRate [INFERRED]
    P.define('input.pad.pitchRate', 120, { min: 30, max: 480, step: 5, label: 'pitch rate deg/s' });          // §3 look.pad.pitchRate 0.6 x yaw [INFERRED]
    P.define('input.pad.curve', 2.0, { min: 1, max: 4, step: 0.05, label: 'response exponent' });             // §3 look.pad.curve power 2 [INFERRED]
    P.define('input.pad.aimScale', 0.55, { min: 0.1, max: 1.5, step: 0.01, label: 'aim rate scale' });        // §3 aimYawRate 110 / yawRate 200 [INFERRED]
    P.define('input.pad.invertY', false, { label: 'pad invert Y' });
    // Turn acceleration: past `threshold` deflection for `delay` s, the yaw rate ramps to x`mult` over `time` s.
    P.define('input.pad.accel.threshold', 0.9, { min: 0.5, max: 1, step: 0.01, label: 'threshold' });       // [INFERRED] "full deflection"
    P.define('input.pad.accel.delay', 0.25, { min: 0, max: 1, step: 0.01, label: 'delay s' });              // §3 look.pad.accelDelay [INFERRED]
    P.define('input.pad.accel.time', 0.35, { min: 0.01, max: 2, step: 0.01, label: 'ramp s' });             // §3 look.pad.accelRamp [INFERRED]
    P.define('input.pad.accel.mult', 1.6, { min: 1, max: 4, step: 0.05, label: 'max mult' });               // §3 look.pad.accelRamp "to 1.6x" [INFERRED]
  }

  // code -> [button indices] for the keyboard/mouse table (rebuilt by rebind()).
  _buildKeyMap() {
    const map = new Map();
    for (const a of BUTTONS) {
      for (const code of this.bindings.kbm[a] || []) {
        if (!map.has(code)) map.set(code, []);
        map.get(code).push(this._index[a]);
      }
    }
    this._boundCodes = new Set(map.keys());
    for (const k of ['moveForward', 'moveBack', 'moveLeft', 'moveRight']) for (const c of this.bindings.kbm[k] || []) this._boundCodes.add(c);
    return map;
  }

  rebind(action, device, codes) {
    this.bindings[device][action] = codes;
    this._actionsFor = this._buildKeyMap();
  }

  _attach(pointerLock) {
    const kbm = () => this._setDevice('kbm');
    const press = (code) => {
      this._keys.add(code);
      const list = this._actionsFor.get(code);
      if (list) for (const i of list) this._latch[i] = 1;
    };
    window.addEventListener('keydown', (e) => {
      if (isEditable(e.target) || e.metaKey) return;
      kbm();
      if (!e.repeat) press(e.code);
      if (this._isBound(e.code)) e.preventDefault();      // Space would scroll, etc. (Ctrl+W can't be stopped: see report)
    });
    window.addEventListener('keyup', (e) => { this._keys.delete(e.code); });
    window.addEventListener('blur', () => this._keys.clear());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this._keys.clear(); });

    const locked = () => !pointerLock || document.pointerLockElement === this.canvas;
    const target = this.canvas || window;
    target.addEventListener('mousedown', (e) => {
      if (!locked()) return;                              // the click that captures the mouse doesn't fire
      kbm();
      press('Mouse' + e.button);
      e.preventDefault();
    });
    window.addEventListener('mouseup', (e) => { this._keys.delete('Mouse' + e.button); });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!pointerLock || document.pointerLockElement !== this.canvas) return;
      this._mouseDX += e.movementX; this._mouseDY += e.movementY;
      if (e.movementX || e.movementY) kbm();
    });
    if (pointerLock && this.canvas) {
      this.canvas.addEventListener('click', () => {
        if (document.pointerLockElement !== this.canvas) {
          try { const p = this.canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* not allowed here */ }
        }
      });
      document.addEventListener('pointerlockchange', () => {
        if (document.pointerLockElement !== this.canvas) {
          for (const k of this._keys) if (k.startsWith('Mouse')) this._keys.delete(k);
        }
      });
    }
    window.addEventListener('gamepadconnected', () => this._findPad());
    window.addEventListener('gamepaddisconnected', () => this._findPad());
    this._findPad();
  }

  _isBound(code) { return this._boundCodes.has(code); }

  _anyKey(codes) {
    for (let j = 0; j < codes.length; j++) if (this._keys.has(codes[j])) return 1;
    return 0;
  }

  _findPad() {
    this._padIndex = -1;
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    let any = -1;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || !p.connected) continue;
      if (p.mapping === 'standard') { this._padIndex = i; return; }
      if (any < 0) any = i;
    }
    this._padIndex = any;
  }

  _setDevice(d) {
    if (this.device === d) return;
    this.device = d;
    this.game.events.emit('input:device', d);
  }

  // --- injection (headless tests) -------------------------------------------------------------------

  inject(obj, merge = false) {
    if (obj == null) { this._injecting = false; return; }
    if (!merge || !this._injecting) {
      this._inj.fill(0);
      this._injMove.x = this._injMove.y = 0;
      this._injLook.x = this._injLook.y = 0;
      this._injLookDelta.yaw = this._injLookDelta.pitch = 0;
    }
    this._injecting = true;
    for (const k in obj) {
      const v = obj[k];
      if (k in this._index) this._inj[this._index[k]] = v ? 1 : 0;
      else if (k === 'move' || k === 'look') {
        const o = k === 'move' ? this._injMove : this._injLook;
        o.x = Array.isArray(v) ? +v[0] || 0 : +(v && v.x) || 0;
        o.y = Array.isArray(v) ? +v[1] || 0 : +(v && v.y) || 0;
        const len = Math.hypot(o.x, o.y);
        if (len > 1) { o.x /= len; o.y /= len; }
      } else if (k === 'lookDelta') {
        this._injLookDelta.yaw = +(v && v.yaw) || 0;
        this._injLookDelta.pitch = +(v && v.pitch) || 0;
      } else if (k === 'device') this._setDevice(v);
      else console.warn(`[input] inject: unknown action '${k}'`);
    }
  }

  get injecting() { return this._injecting; }

  // --- per-step latch (system update, order 0) ----------------------------------------------------

  update(dt, game) {
    const P = game.params;
    let pad = null;
    if (this._padIndex >= 0 && !this._injecting) {
      const pads = navigator.getGamepads();               // only polled while a pad is connected
      pad = pads[this._padIndex];
      if (!pad || !pad.connected) { pad = null; this._findPad(); }
    }
    const trig = P.get('input.pad.triggerThreshold');
    let padActive = false;

    // buttons
    const pb = this.bindings.pad;
    for (let i = 0; i < BUTTONS.length; i++) {
      let raw;
      if (this._injecting) raw = this._inj[i] === 1;
      else {
        raw = this._latch[i] === 1;
        if (!raw) {
          const codes = this.bindings.kbm[BUTTONS[i]];
          for (let j = 0; j < codes.length && !raw; j++) raw = this._keys.has(codes[j]);
        }
        if (pad) {
          const idx = pb[BUTTONS[i]];
          for (let j = 0; j < idx.length; j++) {
            const b = pad.buttons[idx[j]];
            if (!b) continue;
            const on = ANALOG_TRIGGERS.has(idx[j]) ? b.value > trig : b.pressed;
            if (on) { raw = true; padActive = true; }
          }
        }
      }
      this._latch[i] = 0;
      const was = this._down[i] === 1;
      this._pressed[i] = raw && !was ? 1 : 0;
      this._released[i] = !raw && was ? 1 : 0;
      this._down[i] = raw ? 1 : 0;
      this._held[i] = raw ? this._held[i] + dt : 0;
    }

    // move axis
    const m = this._move;
    if (this._injecting) { m.x = this._injMove.x; m.y = this._injMove.y; }
    else {
      const kb = this.bindings.kbm;
      m.x = this._anyKey(kb.moveRight) - this._anyKey(kb.moveLeft);
      m.y = this._anyKey(kb.moveForward) - this._anyKey(kb.moveBack);
      if (m.x && m.y) { m.x *= Math.SQRT1_2; m.y *= Math.SQRT1_2; }
      if (pad) {
        const s = pb.moveStick * 2;
        const sx = pad.axes[s] || 0, sy = -(pad.axes[s + 1] || 0);
        if (this._stick(sx, sy, P.get('input.pad.moveDeadzone'), P.get('input.pad.outerDeadzone'), this._tmp)) {
          padActive = true;
          if (!m.x && !m.y) { m.x = this._tmp.x; m.y = this._tmp.y; }
        }
      }
    }

    // look: mouse
    const ld = this._lookDelta;
    const aiming = this._down[this._index.aim] === 1;
    const mouseK = P.get('input.mouse.degPerPx') * DEG * (aiming ? P.get('input.mouse.aimScale') : 1);
    ld.yaw = -this._mouseDX * mouseK;
    ld.pitch = -this._mouseDY * mouseK * (P.get('input.mouse.invertY') ? -1 : 1);
    this._mouseDX = 0; this._mouseDY = 0;

    // look: stick (pad right stick, or an injected look stick)
    const lk = this._look;
    lk.x = 0; lk.y = 0;
    let padInvert = P.get('input.pad.invertY');
    if (this._injecting) { lk.x = this._injLook.x; lk.y = this._injLook.y; padInvert = false; }
    else if (pad) {
      const s = pb.lookStick * 2;
      if (this._stick(pad.axes[s] || 0, -(pad.axes[s + 1] || 0), P.get('input.pad.lookDeadzone'), P.get('input.pad.outerDeadzone'), lk)) padActive = true;
    }
    const mag = Math.hypot(lk.x, lk.y);
    if (mag > 0) {
      const curved = Math.pow(mag, P.get('input.pad.curve')) / mag;   // radial response curve, direction kept
      if (mag >= P.get('input.pad.accel.threshold')) this._accelT += dt; else this._accelT = 0;
      const ramp = clamp01((this._accelT - P.get('input.pad.accel.delay')) / P.get('input.pad.accel.time'));
      const accel = 1 + (P.get('input.pad.accel.mult') - 1) * ramp;     // yaw only [INFERRED] TODO(spec)
      const aimK = aiming ? P.get('input.pad.aimScale') : 1;
      ld.yaw += -lk.x * curved * P.get('input.pad.yawRate') * DEG * accel * aimK * dt;
      ld.pitch += lk.y * curved * P.get('input.pad.pitchRate') * DEG * aimK * dt * (padInvert ? -1 : 1);
    } else this._accelT = 0;

    if (this._injecting) { ld.yaw += this._injLookDelta.yaw; ld.pitch += this._injLookDelta.pitch; }
    if (padActive) this._setDevice('pad');
  }

  // Paused or slowed: mouse motion between steps is dropped while paused so un-pausing doesn't jump the camera.
  frame(realDt, game) {
    if (game.paused && !game.stepOnce) { this._mouseDX = 0; this._mouseDY = 0; }
  }

  // Radial deadzone: magnitude rescaled from [inner, outer] to [0, 1], direction kept. Writes out; returns true if active.
  _stick(x, y, inner, outer, out) {
    const len = Math.hypot(x, y);
    if (len <= inner) { out.x = 0; out.y = 0; return false; }
    const k = clamp01((len - inner) / Math.max(1e-6, outer - inner)) / len;
    out.x = x * k; out.y = y * k;
    return true;
  }

  // --- queries ------------------------------------------------------------------------------------

  down(a) { return this._down[this._index[a]] === 1; }
  pressed(a) { return this._pressed[this._index[a]] === 1; }
  released(a) { return this._released[this._index[a]] === 1; }
  heldTime(a) { return this._held[this._index[a]]; }
  axis(a) { return a === 'look' ? this._look : this._move; }
  lookDelta() { return this._lookDelta; }
}

// Debug keys (no gameplay bind uses them): P pause, . step one sim step, [ ] cycle time scale 1 / 0.25 / 0.05,
// ` (backquote) tuning panel, H hide HUD. A small badge shows pause / slow-mo.
export const TIME_SCALES = [1, 0.25, 0.05];

export function installDebugKeys(game, { badge = true } = {}) {
  let el = null;
  if (badge && typeof document !== 'undefined') {
    el = document.createElement('div');
    el.className = 'cr-debug-badge';
    el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:25;pointer-events:none;font:600 11px/1.4 ui-monospace,Menlo,monospace;'
      + 'letter-spacing:.12em;color:#ffb454;text-shadow:0 1px 2px #000;display:none';
    document.body.appendChild(el);
  }
  const show = () => {
    if (!el) return;
    const parts = [];
    if (game.paused) parts.push('PAUSED  (P resume, . step)');
    if (game.timeScale !== 1) parts.push(`TIME x${game.timeScale}`);
    el.textContent = parts.join('   ');
    el.style.display = parts.length ? '' : 'none';
  };
  const cycle = (dir) => {
    let i = TIME_SCALES.indexOf(game.timeScale);
    if (i < 0) i = 0;
    game.timeScale = TIME_SCALES[(i + dir + TIME_SCALES.length) % TIME_SCALES.length];
  };
  const onKey = (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return;
    switch (e.code) {
      case 'KeyP': game.paused = !game.paused; break;
      case 'Period': game.paused = true; game.stepOnce = true; break;
      case 'BracketLeft': cycle(1); break;     // slower
      case 'BracketRight': cycle(-1); break;   // faster
      case 'Backquote': game.params.togglePanel(); break;
      case 'KeyH': if (game.hud && game.hud.toggle) game.hud.toggle(); break;
      default: return;
    }
    e.preventDefault();
    show();
  };
  window.addEventListener('keydown', onKey);
  return { show, dispose: () => { window.removeEventListener('keydown', onKey); if (el) el.remove(); } };
}
