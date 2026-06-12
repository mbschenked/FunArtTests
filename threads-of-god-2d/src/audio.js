// audio.js — procedural WebAudio SFX. WP-D implements. No imports, no assets.
// Cosmetic-only event listener (never mutates state).
//
// Recipes (oscillators/noise → per-voice gain → master gain 0.5):
// - whooshLight:  bandpassed noise burst, sweep 800→300Hz, ~90ms
// - whooshHeavy:  same, 600→200Hz, ~130ms, louder
// - whooshGiant:  500→120Hz, ~200ms + sub sine
// - clang (deflect): two detuned triangles ~1800/2400Hz + noise transient,
//   250ms ring — METALLIC, deliberately the loudest sound in the game
// - thud (hit):   sine pitch-drop 120→60Hz + click, ~100ms
// - blockThunk:   200Hz triangle, 60ms
// - poiseSnap:    noise snap + descending saw zip + sub thump (thread snapping)
// - finisherSting: rising saw sweep into low boom, ~600ms
// - chargeLoop:   pulsing low sine while held (start/stop pair)
// - teleportShimmer: fast high-sine arpeggio, ~250ms
// - swordThrow:   whoosh + doppler-ish down-sweep
// - phaseRoar:    stacked detuned saws, slow attack, ~900ms
// - deathToll:    low sine toll, long decay

export class AudioSystem {
  /**
   * @param {import('./utils.js').EventBus} bus subscribes to combat events and
   *   maps: hit→thud, blocked→blockThunk, deflect→clang, poiseBreak→poiseSnap,
   *   finisherImpact→finisherSting, phaseChange→phaseRoar, dodge→whooshLight,
   *   projectileSpawn→swordThrow, death→deathToll,
   *   attackStart→play(payload.sfx)  (fighter.startAttack emits {sfx}),
   *   chargeStart→startChargeLoop(), chargeRelease→stopChargeLoop().
   */
  constructor(bus) {
    this.ctx = null;             // lazily created AudioContext
    this.enabled = true;
    this._masterGain = null;
    this._chargeOsc = null;
    this._chargeLfoOsc = null;
    this._chargeEnvGain = null;

    if (bus) {
      bus.on('hit',              () => this.play('thud'));
      bus.on('blocked',          () => this.play('blockThunk'));
      bus.on('deflect',          () => this.play('clang'));
      bus.on('poiseBreak',       () => this.play('poiseSnap'));
      bus.on('finisherImpact',   () => this.play('finisherSting'));
      bus.on('phaseChange',      () => this.play('phaseRoar'));
      bus.on('dodge',            () => this.play('whooshLight'));
      bus.on('projectileSpawn',  () => this.play('swordThrow'));
      bus.on('death',            () => this.play('deathToll'));
      bus.on('attackStart',      (payload) => { if (payload && payload.sfx) this.play(payload.sfx); });
      bus.on('chargeStart',      () => this.startChargeLoop());
      bus.on('chargeRelease',    () => this.stopChargeLoop());
    }
  }

  /** Create/resume AudioContext. Called by main on first user gesture
   *  (browser autoplay policy). Safe to call repeatedly. */
  resume() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this._masterGain = this.ctx.createGain();
      this._masterGain.gain.value = 0.5;
      this._masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /** @param {string} name recipe key; unknown names no-op silently */
  play(name) {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    const recipe = this._recipes[name];
    if (!recipe) return;
    recipe.call(this);
  }

  /** chargeLoop control */
  startChargeLoop() {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    if (this._chargeOsc) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 55;

    const lfoOsc = ctx.createOscillator();
    lfoOsc.type = 'sine';
    lfoOsc.frequency.value = 3.5;

    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.4;

    const envGain = ctx.createGain();
    envGain.gain.setValueAtTime(0, now);
    envGain.gain.linearRampToValueAtTime(0.55, now + 0.15);

    lfoOsc.connect(lfoGain);
    lfoGain.connect(envGain.gain);
    osc.connect(envGain);
    envGain.connect(this._masterGain);

    osc.start(now);
    lfoOsc.start(now);

    this._chargeOsc = osc;
    this._chargeLfoOsc = lfoOsc;
    this._chargeEnvGain = envGain;
  }

  stopChargeLoop() {
    if (!this._chargeOsc) return;
    const ctx = this.ctx;
    if (!ctx) { this._chargeOsc = null; return; }
    const now = ctx.currentTime;
    this._chargeEnvGain.gain.setValueAtTime(this._chargeEnvGain.gain.value, now);
    this._chargeEnvGain.gain.linearRampToValueAtTime(0, now + 0.08);
    this._chargeOsc.stop(now + 0.09);
    this._chargeLfoOsc.stop(now + 0.09);
    this._chargeOsc = null;
    this._chargeLfoOsc = null;
    this._chargeEnvGain = null;
  }


  _noiseBuf(duration) {
    const ctx = this.ctx;
    const sampleRate = ctx.sampleRate;
    const bufLen = Math.ceil(sampleRate * duration);
    const buf = ctx.createBuffer(1, bufLen, sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      let x = i * 0x9e3779b9;
      x = ((x >>> 15) ^ x) * 0x85ebca6b;
      x = ((x >>> 13) ^ x) * 0xc2b2ae35;
      x ^= x >>> 16;
      data[i] = ((x & 0xffff) / 0x8000) - 1.0;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  get _recipes() {
    return {
      whooshLight:      this._whooshLight.bind(this),
      whooshHeavy:      this._whooshHeavy.bind(this),
      whooshGiant:      this._whooshGiant.bind(this),
      clang:            this._clang.bind(this),
      thud:             this._thud.bind(this),
      blockThunk:       this._blockThunk.bind(this),
      poiseSnap:        this._poiseSnap.bind(this),
      finisherSting:    this._finisherSting.bind(this),
      teleportShimmer:  this._teleportShimmer.bind(this),
      swordThrow:       this._swordThrow.bind(this),
      phaseRoar:        this._phaseRoar.bind(this),
      deathToll:        this._deathToll.bind(this),
    };
  }

  _whooshLight() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.09;

    const src = this._noiseBuf(dur);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(800, now);
    filter.frequency.linearRampToValueAtTime(300, now + dur);
    filter.Q.value = 1.2;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.55, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(filter);
    filter.connect(env);
    env.connect(this._masterGain);
    src.start(now);
    src.stop(now + dur + 0.01);
  }

  _whooshHeavy() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.13;

    const src = this._noiseBuf(dur);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(600, now);
    filter.frequency.linearRampToValueAtTime(200, now + dur);
    filter.Q.value = 1.0;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.8, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(filter);
    filter.connect(env);
    env.connect(this._masterGain);
    src.start(now);
    src.stop(now + dur + 0.01);
  }

  _whooshGiant() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.20;

    const src = this._noiseBuf(dur);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(500, now);
    filter.frequency.linearRampToValueAtTime(120, now + dur);
    filter.Q.value = 0.8;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.75, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(filter);
    filter.connect(env);
    env.connect(this._masterGain);
    src.start(now);
    src.stop(now + dur + 0.01);

    // Sub sine layer
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(80, now);
    sub.frequency.linearRampToValueAtTime(40, now + dur);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.5, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    sub.connect(subGain);
    subGain.connect(this._masterGain);
    sub.start(now);
    sub.stop(now + dur + 0.01);
  }

  _clang() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.25;

    // Two detuned triangles ~1800/2400Hz — LOUDEST sound
    [1800, 2400].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(1.2, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur);
      osc.connect(g);
      g.connect(this._masterGain);
      osc.start(now);
      osc.stop(now + dur + 0.01);
    });

    // Noise transient at attack
    const src = this._noiseBuf(0.025);
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 1200;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(1.0, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
    src.connect(filter);
    filter.connect(tg);
    tg.connect(this._masterGain);
    src.start(now);
    src.stop(now + 0.03);
  }

  _thud() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.10;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(60, now + dur);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.9, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + dur);

    osc.connect(env);
    env.connect(this._masterGain);
    osc.start(now);
    osc.stop(now + dur + 0.01);

    // Click
    const click = this._noiseBuf(0.008);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.6, now);
    cg.gain.exponentialRampToValueAtTime(0.001, now + 0.008);
    click.connect(cg);
    cg.connect(this._masterGain);
    click.start(now);
    click.stop(now + 0.01);
  }

  _blockThunk() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.06;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 200;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.7, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + dur);

    osc.connect(env);
    env.connect(this._masterGain);
    osc.start(now);
    osc.stop(now + dur + 0.01);
  }

  _poiseSnap() {
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Noise snap burst
    const snap = this._noiseBuf(0.04);
    const snapFilter = ctx.createBiquadFilter();
    snapFilter.type = 'highpass';
    snapFilter.frequency.value = 2000;
    const snapGain = ctx.createGain();
    snapGain.gain.setValueAtTime(0.9, now);
    snapGain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    snap.connect(snapFilter);
    snapFilter.connect(snapGain);
    snapGain.connect(this._masterGain);
    snap.start(now);
    snap.stop(now + 0.05);

    // Descending saw zip
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(800, now);
    saw.frequency.exponentialRampToValueAtTime(80, now + 0.18);
    const sawGain = ctx.createGain();
    sawGain.gain.setValueAtTime(0.5, now);
    sawGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    saw.connect(sawGain);
    sawGain.connect(this._masterGain);
    saw.start(now);
    saw.stop(now + 0.19);

    // Sub thump
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(55, now);
    sub.frequency.exponentialRampToValueAtTime(30, now + 0.12);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.8, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    sub.connect(subGain);
    subGain.connect(this._masterGain);
    sub.start(now);
    sub.stop(now + 0.13);
  }

  _finisherSting() {
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Rising saw sweep
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(80, now);
    saw.frequency.exponentialRampToValueAtTime(600, now + 0.35);
    const sawGain = ctx.createGain();
    sawGain.gain.setValueAtTime(0, now);
    sawGain.gain.linearRampToValueAtTime(0.7, now + 0.05);
    sawGain.gain.setValueAtTime(0.7, now + 0.3);
    sawGain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    saw.connect(sawGain);
    sawGain.connect(this._masterGain);
    saw.start(now);
    saw.stop(now + 0.61);

    // Low boom at ~0.35s
    const boom = ctx.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(80, now + 0.33);
    boom.frequency.exponentialRampToValueAtTime(30, now + 0.6);
    const boomGain = ctx.createGain();
    boomGain.gain.setValueAtTime(0, now);
    boomGain.gain.setValueAtTime(1.0, now + 0.35);
    boomGain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    boom.connect(boomGain);
    boomGain.connect(this._masterGain);
    boom.start(now + 0.33);
    boom.stop(now + 0.61);
  }

  _teleportShimmer() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const baseFreqs = [1200, 1600, 2000, 1800, 2400];
    const step = 0.04;

    baseFreqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      const t = now + i * step;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      osc.connect(g);
      g.connect(this._masterGain);
      osc.start(t);
      osc.stop(t + 0.08);
    });
  }

  _swordThrow() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.18;

    // Whoosh component
    const src = this._noiseBuf(dur);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(700, now);
    filter.frequency.linearRampToValueAtTime(180, now + dur);
    filter.Q.value = 1.1;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.7, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(filter);
    filter.connect(env);
    env.connect(this._masterGain);
    src.start(now);
    src.stop(now + dur + 0.01);

    // Doppler-ish down-sweep
    const tone = ctx.createOscillator();
    tone.type = 'sawtooth';
    tone.frequency.setValueAtTime(420, now);
    tone.frequency.exponentialRampToValueAtTime(80, now + dur);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.3, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + dur);
    tone.connect(tg);
    tg.connect(this._masterGain);
    tone.start(now);
    tone.stop(now + dur + 0.01);
  }

  _phaseRoar() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.9;

    // Stacked detuned saws, slow attack
    [80, 83, 77].forEach((freq) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.45, now + 0.35);
      g.gain.setValueAtTime(0.45, now + 0.65);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur);
      osc.connect(g);
      g.connect(this._masterGain);
      osc.start(now);
      osc.stop(now + dur + 0.01);
    });

    // Noise texture
    const src = this._noiseBuf(dur);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    const eg = ctx.createGain();
    eg.gain.setValueAtTime(0, now);
    eg.gain.linearRampToValueAtTime(0.3, now + 0.3);
    eg.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(filter);
    filter.connect(eg);
    eg.connect(this._masterGain);
    src.start(now);
    src.stop(now + dur + 0.01);
  }

  _deathToll() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 2.5;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(110, now);
    osc.frequency.exponentialRampToValueAtTime(55, now + 0.4);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.9, now + 0.05);
    env.gain.setValueAtTime(0.9, now + 0.1);
    env.gain.exponentialRampToValueAtTime(0.001, now + dur);

    osc.connect(env);
    env.connect(this._masterGain);
    osc.start(now);
    osc.stop(now + dur + 0.01);

    // Second harmonic for bell character
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(220, now);
    const eg2 = ctx.createGain();
    eg2.gain.setValueAtTime(0, now);
    eg2.gain.linearRampToValueAtTime(0.3, now + 0.03);
    eg2.gain.exponentialRampToValueAtTime(0.001, now + 1.0);
    osc2.connect(eg2);
    eg2.connect(this._masterGain);
    osc2.start(now);
    osc2.stop(now + 1.1);
  }
}
