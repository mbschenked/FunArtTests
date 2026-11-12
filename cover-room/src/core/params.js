// Tunable parameter registry + lil-gui panel. Contract: refs/design.md "core/params.js".
//
//   define(key, default, {min, max, step, label, options, color}) -> value   (re-defining keeps the current value)
//   get(key) / set(key, v) / onChange(key, fn) -> off / changed() / toJSON() / reset(key?) / apply(obj)
//   buildPanel(GUI, {title, hidden}) / togglePanel(show?) / copySettings() / addPreset(name, values)
//
// Value precedence when a param is defined: URL ?set=key:val,key:val  >  localStorage  >  default.
// Keys are dotted; every segment but the last is a (nested) panel folder: 'player.run.speed' -> player / run / speed.
// Params defined after the panel is built are added to it on the spot.
// lil-gui is passed in (buildPanel(GUI)) rather than imported, so this file also loads in node for unit tests.
export const STORAGE_KEY = 'cover-room-params-v1';

const storage = () => { try { return globalThis.localStorage || null; } catch { return null; } };

export class Params {
  // storageKey: localStorage key, or null to turn persistence off (?test pages use null so runs repeat).
  constructor({ storageKey = STORAGE_KEY, search } = {}) {
    this.defs = new Map();     // key -> {key, value, def, min, max, step, label, options, color}
    this.listeners = new Map();
    this.storageKey = storageKey;
    const query = search ?? (typeof location !== 'undefined' ? location.search : '');
    this._urlOverrides = Params.parseSet(new URLSearchParams(query).get('set'));
    this._stored = this._load();        // values saved by earlier visits (including keys this page never defines)
    this._saveTimer = 0;
    this.presets = new Map();
    this.lastCopied = null;             // the last Copy settings text (also handy for headless checks)

    // panel state
    this.gui = null;
    this._GUI = null;
    this._folders = new Map();          // 'player.run' -> lil-gui folder
    this._ctrls = new Map();            // key -> controller
    this._proxy = {};                   // accessor object the controllers bind to
    this._presetCtrl = null;
    this._presetState = { preset: '' };
  }

  static parseSet(str) {
    const out = {};
    if (!str) return out;
    for (const pair of str.split(',')) {
      const i = pair.indexOf(':');
      if (i < 0) continue;
      const k = pair.slice(0, i).trim();
      const raw = pair.slice(i + 1).trim();
      const n = Number(raw);
      out[k] = raw === 'true' ? true : raw === 'false' ? false : (raw !== '' && Number.isFinite(n)) ? n : raw;
    }
    return out;
  }

  // Register a param and return its current value. Re-defining an existing key keeps its value.
  define(key, value, opts = {}) {
    if (this.defs.has(key)) return this.defs.get(key).value;
    const d = { key, def: value, value, ...opts };
    if (key in this._urlOverrides) d.value = this._urlOverrides[key];
    else if (this._stored && key in this._stored && typeof this._stored[key] === typeof value) d.value = this._stored[key];
    this.defs.set(key, d);
    if (this.gui) this._addController(d);
    return d.value;
  }

  has(key) { return this.defs.has(key); }

  get(key) {
    const d = this.defs.get(key);
    if (!d) throw new Error(`param not defined: ${key}`);
    return d.value;
  }

  set(key, value) {
    const d = this.defs.get(key);
    if (!d) throw new Error(`param not defined: ${key}`);
    if (d.value === value) return;
    d.value = value;
    const list = this.listeners.get(key);
    if (list) for (const fn of list) fn(value, key);
    const c = this._ctrls.get(key);
    if (c) { c.updateDisplay(); this._markChanged(d, c); }
    this._scheduleSave();
  }

  onChange(key, fn) {
    let list = this.listeners.get(key);
    if (!list) { list = []; this.listeners.set(key, list); }
    list.push(fn);
    return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  }

  // Only values that differ from their defaults, as {key: value}.
  changed() {
    const out = {};
    for (const [k, d] of this.defs) if (d.value !== d.def) out[k] = d.value;
    return out;
  }

  toJSON() {
    const out = {};
    for (const [k, d] of this.defs) out[k] = d.value;
    return out;
  }

  // Back to defaults: one key, or every defined key when called without one.
  reset(key) {
    if (key !== undefined) { const d = this.defs.get(key); if (d) this.set(key, d.def); return; }
    for (const [k, d] of this.defs) this.set(k, d.def);
  }

  // Set many at once from {key: value} (a pasted Copy settings JSON, a preset). Unknown keys are kept for later defines.
  apply(values) {
    for (const k in values) {
      if (this.defs.has(k)) this.set(k, values[k]);
      else this._urlOverrides[k] = values[k];
    }
  }

  addPreset(name, values) {
    this.presets.set(name, values);
    if (this.gui) this._buildPresetCtrl();
  }

  // --- persistence --------------------------------------------------------------------------------

  _load() {
    if (!this.storageKey) return null;
    try {
      const s = storage();
      const raw = s && s.getItem(this.storageKey);
      const obj = raw ? JSON.parse(raw) : null;
      return obj && typeof obj === 'object' ? obj : {};
    } catch { return {}; }
  }

  _scheduleSave() {
    if (!this.storageKey || this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = 0; this.save(); }, 150);
  }

  // Writes changed values. Keys saved by other pages (not defined here) are kept; keys back at default are dropped;
  // a value that only comes from ?set= and was never touched is not written, so a shared link doesn't stick.
  save() {
    if (!this.storageKey) return false;
    try {
      const s = storage();
      if (!s) return false;
      const out = {};
      if (this._stored) for (const k in this._stored) if (!this.defs.has(k)) out[k] = this._stored[k];
      for (const [k, d] of this.defs) {
        if (k in this._urlOverrides && this._urlOverrides[k] === d.value) {
          if (this._stored && k in this._stored) out[k] = this._stored[k];   // the URL masks it this visit; keep it
          continue;
        }
        if (d.value !== d.def) out[k] = d.value;
      }
      s.setItem(this.storageKey, JSON.stringify(out));
      this._stored = out;
      return true;
    } catch { return false; }
  }

  // --- Copy settings ------------------------------------------------------------------------------

  copySettings() {
    const text = JSON.stringify(this.changed(), null, 2);
    this.lastCopied = text;
    const setStr = Object.entries(this.changed()).map(([k, v]) => `${k}:${v}`).join(',');
    console.info(`[params] settings (${Object.keys(this.changed()).length} changed):\n${text}\n?set=${setStr}`);
    let ok = false;
    try {
      if (typeof document !== 'undefined') {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta); ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      }
    } catch { ok = false; }
    try { if (!ok && navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {}); } catch { /* no clipboard: the console line above has it */ }
    return text;
  }

  // --- panel --------------------------------------------------------------------------------------

  buildPanel(GUI, { title = 'tuning', hidden = false, container } = {}) {
    if (this.gui) return this.gui;
    this._GUI = GUI;
    this.gui = new GUI({ title, container, width: 300 });
    this.gui.domElement.classList.add('cr-params');
    const actions = {
      reset: () => this.reset(),
      copy: () => {
        this.copySettings();
        const n = Object.keys(this.changed()).length;
        this._copyCtrl.name(`Copied (${n} changed)`);
        setTimeout(() => this._copyCtrl.name('Copy settings'), 1400);
      },
    };
    this._copyCtrl = this.gui.add(actions, 'copy').name('Copy settings');
    this._resetCtrl = this.gui.add(actions, 'reset').name('Reset all');
    if (this.presets.size) this._buildPresetCtrl();
    for (const d of this.defs.values()) this._addController(d);
    if (hidden) this.gui.hide();
    return this.gui;
  }

  togglePanel(show) {
    if (!this.gui) return false;
    const vis = show ?? this.gui._hidden;
    this.gui.show(vis);
    return vis;
  }

  _buildPresetCtrl() {
    if (this._presetCtrl) this._presetCtrl.destroy();
    const names = { '(none)': '' };
    for (const n of this.presets.keys()) names[n] = n;
    this._presetCtrl = this.gui.add(this._presetState, 'preset', names).name('Preset').onChange((name) => {
      if (!name) return;
      this.reset();
      this.apply(this.presets.get(name));
    });
    this._resetCtrl.domElement.after(this._presetCtrl.domElement);   // keep it under the buttons, above the folders
  }

  _folder(path) {
    if (!path) return this.gui;
    let f = this._folders.get(path);
    if (f) return f;
    const i = path.lastIndexOf('.');
    const parent = this._folder(i < 0 ? '' : path.slice(0, i));
    f = parent.addFolder(i < 0 ? path : path.slice(i + 1));
    f.close();
    this._folders.set(path, f);
    return f;
  }

  _addController(d) {
    const key = d.key;
    if (this._ctrls.has(key)) return;
    if (!Object.prototype.hasOwnProperty.call(this._proxy, key)) {
      Object.defineProperty(this._proxy, key, {
        get: () => this.defs.get(key).value,
        set: (v) => this.set(key, v),
        enumerable: true,
      });
    }
    const dot = key.lastIndexOf('.');
    const folder = this._folder(dot < 0 ? '' : key.slice(0, dot));
    const label = d.label ?? key.slice(dot + 1);
    let c;
    if (d.options) c = folder.add(this._proxy, key, d.options);
    else if (d.color || (typeof d.def === 'string' && /^#[0-9a-f]{6}$/i.test(d.def))) c = folder.addColor(this._proxy, key);
    else if (typeof d.def === 'number') c = folder.add(this._proxy, key, d.min, d.max, d.step);
    else c = folder.add(this._proxy, key);
    c.name(label);
    this._ctrls.set(key, c);
    this._markChanged(d, c);
  }

  _markChanged(d, c) {
    c.domElement.classList.toggle('cr-changed', d.value !== d.def);
  }
}
