#!/usr/bin/env python3
"""combine.py: build u4-range-combined.html, the test range on which every shot fires BOTH Uncharted 4 studies
(the muzzle flash and the bullet tracer). Re-run it whenever a study page changes; it never edits its sources.

usage (any working directory):
  python3 vfx-studies/tools/combine.py            write vfx-studies/u4-range-combined.html (only if it changed)
  python3 vfx-studies/tools/combine.py --check    exit 1 if that page is out of date with the study pages; writes nothing
  python3 vfx-studies/tools/combine.py --out F    write F instead

Sources, read only: range.html (the shared range: the common ancestor of the pages' range code), u4-muzzle-flash.html
and u4-tracer.html (each = the range plus its own additions, plus one EFFECT SLOT block).
 1. RANGE CODE  Each page minus its slot is three-way merged over range.html (git merge-file --diff3). A change only one
    page made is taken as it is, the same change on both pages once, and two insertions at the same spot are both kept
    (the muzzle-flash page's lines first). Anything else (both pages changed the same lines differently) stops the script
    with the conflict printed: settle it in a study page or teach merge_range() a rule.
 2. PAGE FIXES  The title and a "generated" note; the camera keys: the buttons are put in CAMERA_ORDER and numbered 1..N,
    the Digit / Numpad cases and the camera table's rows and "key N" comments follow, and the key hint and the TEST
    MODE doc list all N cameras; the bottom bar's max-width grows to BAR_MAX_PX so six camera buttons fit one row.
 3. SLOT  Each page's EFFECT SLOT is pasted verbatim into its own function scope (so the two `const EFFECT`s cannot
    collide), followed by a composite EFFECT that forwards to both. COMPOSITE below is that code; its header comment
    explains how the two studies share the range (pass order, panel, lights, bloom weight, query routing).
"""
import argparse
import hashlib
import os
import re
import subprocess
import sys
import tempfile

STUDIES = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))     # vfx-studies/
RANGE = 'range.html'
# (query / state id, page, the name its slot gets here)
PAGES = [('muzzle', 'u4-muzzle-flash.html', 'fxMuzzleFlash'), ('tracer', 'u4-tracer.html', 'fxTracer')]
OUT = 'u4-range-combined.html'
TITLE = 'Uncharted 4 range: muzzle flash + tracer'
# Camera keys 1..N in this order. A camera a study adds later goes after these, in page order.
CAMERA_ORDER = ['shoulder', 'side', 'incoming', 'muzzle', 'lens', 'hero']
BAR_MAX_PX = 1400                       # bottom bar max-width: one row at 1920 px with six camera buttons

BEGIN_RE = re.compile(r'^/\* =+\n \* ===== EFFECT SLOT: BEGIN [^\n]*\n', re.M)
END_RE = re.compile(r'^/\* ===== EFFECT SLOT: END =+ \*/\n', re.M)
TITLE_RE = re.compile(r'<title>[^<\n]*</title>')
SLOT_MARK = '/*@@EFFECT_SLOT@@*/\n'
TITLE_MARK = '<title>@@TITLE@@</title>'
MARK = 15                                                                  # conflict marker size: never in the pages


class CombineError(Exception):
    pass


def need(cond, msg):
    if not cond:
        raise CombineError(msg)


def read(name):
    with open(os.path.join(STUDIES, name), encoding='utf-8') as f:
        return f.read()


def short_hash(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:12]


def split_page(name, text):
    """-> (range code with the slot replaced by SLOT_MARK, slot body without its BEGIN / END marker lines)."""
    b, e = list(BEGIN_RE.finditer(text)), list(END_RE.finditer(text))
    need(len(b) == 1 and len(e) == 1 and b[0].start() < e[0].start(),
         f'{name}: expected one EFFECT SLOT BEGIN marker (two lines) and one END marker after it')
    return text[:b[0].start()] + SLOT_MARK + text[e[0].end():], text[b[0].end():e[0].start()]


def check_slot(name, body):
    """The slot must fit the wrapper: one top-level `const EFFECT`, no top-level import (an import cannot sit inside a
    function), and nothing of `location` but location.search (the wrapper hands each slot its own `location`)."""
    need(len(re.findall(r'^const EFFECT = ', body, re.M)) == 1, f'{name}: expected exactly one top-level "const EFFECT = "')
    need(not re.search(r'^\s*import\b(?!\s*\()', body, re.M),            # a static import; import(...) is fine anywhere
         f'{name}: the slot has an import statement; move it into the combined slot (fx-prefixed) in combine.py')
    need('window.location' not in body,
         f'{name}: the slot reads window.location; use location.search, which combine.py routes per study')
    props = set(re.findall(r'(?<![\w.$])location\.(\w+)', body))
    need(props <= {'search'}, f'{name}: the slot reads location.{sorted(props - {"search"})}; only location.search is routed')


def merge_range(base, muzzle, tracer):
    """Three-way merge of the pages' range code over range.html. Returns (merged text, number of union resolutions)."""
    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        for label, text in (('muzzle', muzzle), ('range', base), ('tracer', tracer)):
            p = os.path.join(tmp, label)
            with open(p, 'w', encoding='utf-8') as f:
                f.write(text)
            paths.append(p)
        r = subprocess.run(['git', 'merge-file', '-p', '--diff3', f'--marker-size={MARK}',
                            '-L', 'muzzle', '-L', 'range', '-L', 'tracer', *paths], capture_output=True, text=True)
    need(r.returncode < 128 and not r.stderr.strip(), f'git merge-file failed ({r.returncode}): {r.stderr.strip()}')
    out, unions, state, ours, base_part, theirs = [], 0, None, [], [], []
    for line in r.stdout.splitlines(keepends=True):
        if line.startswith('<' * MARK + ' muzzle'):
            state, ours, base_part, theirs = 'ours', [], [], []
        elif state == 'ours' and line.startswith('|' * MARK + ' range'):
            state = 'base'
        elif state == 'base' and line.rstrip('\n') == '=' * MARK:
            state = 'theirs'
        elif state == 'theirs' and line.startswith('>' * MARK + ' tracer'):
            if any(s.strip() for s in base_part):
                raise CombineError('both study pages changed the same range lines differently:\n'
                                   + ''.join(['--- range.html\n'] + base_part + ['--- u4-muzzle-flash.html\n'] + ours
                                             + ['--- u4-tracer.html\n'] + theirs))
            out += ours + theirs                     # two insertions at one spot: keep both, the muzzle-flash page's first
            unions += 1
            state = None
        elif state == 'ours':
            ours.append(line)
        elif state == 'base':
            base_part.append(line)
        elif state == 'theirs':
            theirs.append(line)
        else:
            out.append(line)
    need(state is None, 'unterminated conflict in the git merge-file output')
    return ''.join(out), unions


def sub_once(pattern, repl, text, what, flags=0):
    new, n = re.subn(pattern, repl, text, flags=flags)
    need(n == 1, f'range fix "{what}": expected one match, found {n}')
    return new


def fix_cameras(text):
    """Camera buttons in CAMERA_ORDER, keys 1..N on the buttons, the Digit / Numpad cases, the camera table's comments,
    the key hint and the TEST MODE doc."""
    btn_re = re.compile(r'^\s*<button type="button" data-cam="(\w+)"[^\n]*<kbd>\d+</kbd>[^\n]*</button>\n', re.M)
    btns = list(btn_re.finditer(text))
    need(btns and all(btns[i].end() == btns[i + 1].start() for i in range(len(btns) - 1)),
         'camera buttons: expected one contiguous block of data-cam buttons')
    names = [m.group(1) for m in btns]
    need(len(set(names)) == len(names), f'camera buttons: a camera appears twice: {names}')
    order = [c for c in CAMERA_ORDER if c in names] + [c for c in names if c not in CAMERA_ORDER]
    need(len(order) <= 9, 'more than 9 cameras: keys 1-9 run out')
    key = {c: i + 1 for i, c in enumerate(order)}
    by_name = {m.group(1): m.group(0) for m in btns}
    block = ''.join(re.sub(r'<kbd>\d+</kbd>', f'<kbd>{key[c]}</kbd>', by_name[c], count=1) for c in order)
    text = text[:btns[0].start()] + block + text[btns[-1].end():]

    case_re = re.compile(r"^(\s*)case 'Digit(\d)': case 'Numpad\2': setCamera\('(\w+)'\); break;\n", re.M)
    cases = list(case_re.finditer(text))
    need(cases and all(cases[i].end() == cases[i + 1].start() for i in range(len(cases) - 1)),
         'camera keys: expected one contiguous block of Digit / Numpad cases')
    need(sorted(m.group(3) for m in cases) == sorted(order), f'camera keys: cases {[m.group(3) for m in cases]} vs buttons {order}')
    ind = cases[0].group(1)
    block = ''.join(f"{ind}case 'Digit{key[c]}': case 'Numpad{key[c]}': setCamera('{c}'); break;\n" for c in order)
    text = text[:cases[0].start()] + block + text[cases[-1].end():]

    row_re = re.compile(r'^  (\w+):\s+\{ pos: [^\n]*?// key (\d+):[^\n]*\n', re.M)
    start = text.index('const CAMERAS = {\n') + len('const CAMERAS = {\n')
    rows = list(row_re.finditer(text, start))
    need(rows and rows[0].start() == start and all(rows[i].end() == rows[i + 1].start() for i in range(len(rows) - 1))
         and sorted(m.group(1) for m in rows) == sorted(order),
         f'camera table: expected one row per camera right after "const CAMERAS = {{", got {[m.group(1) for m in rows]}')
    by_name = {m.group(1): m for m in rows}
    block = ''.join(by_name[c].group(0)[:by_name[c].start(2) - by_name[c].start()] + str(key[c])
                    + by_name[c].group(0)[by_name[c].end(2) - by_name[c].start():] for c in order)
    text = text[:start] + block + text[rows[-1].end():]

    text = sub_once(r'1-\d camera', f'1-{len(order)} camera', text, 'key hint')
    text = sub_once(r'\?preflight&cam=<[\w|]+>', '?preflight&cam=<' + '|'.join(order) + '>', text, 'TEST MODE doc')
    return text, order


def wrap_slot(page, var, qid, body, digest):
    head = (f'/* ---- {page}: its EFFECT SLOT, pasted verbatim by tools/combine.py (sha256 {digest}; the slot\'s BEGIN / END\n'
            f' * marker lines are left out). Runs in its own function scope: its `const EFFECT` is local, `location` is the\n'
            f' * page query routed for it (QUERY). ----\n')
    return (f'const {var} = ((location) => {{\n{head}{body.rstrip()}\n'
            f'return EFFECT;\n}})(fxSlotLocation(\'{qid}\'));\n')


def build():
    base_text = read(RANGE)
    pages = {qid: read(page) for qid, page, _ in PAGES}
    digests = {RANGE: short_hash(base_text), **{page: short_hash(pages[qid]) for qid, page, _ in PAGES}}

    base_range, _ = split_page(RANGE, base_text)
    ranges, slots = {}, {}
    for qid, page, _ in PAGES:
        ranges[qid], slots[qid] = split_page(page, pages[qid])
        check_slot(page, slots[qid])
    def untitled(text, name):                  # the titles differ on every page: set aside, so they cannot conflict
        need(len(TITLE_RE.findall(text)) == 1, f'{name}: expected one <title>')
        return TITLE_RE.sub(TITLE_MARK, text)
    merged, unions = merge_range(untitled(base_range, RANGE), untitled(ranges['muzzle'], PAGES[0][1]),
                                 untitled(ranges['tracer'], PAGES[1][1]))

    merged = merged.replace(TITLE_MARK, f'<title>{TITLE}</title>')
    merged = sub_once(r'^<!doctype html>\n', '<!doctype html>\n<!-- GENERATED by vfx-studies/tools/combine.py from range.html, '
                      'u4-muzzle-flash.html and u4-tracer.html: do not edit this file, re-run the script. -->\n',
                      merged, 'generated note', flags=re.M)
    merged, cams = fix_cameras(merged)
    # the bottom bar holds one more camera button than either page's: 1339 px wide at 1920 (dusk label; night adds ~7),
    # so the pages' 1330 px cap wrapped its last group onto a second row
    m = re.search(r'(\.bar \{[^}]*?max-width: min\(100%, )(\d+)(px\))', merged)
    need(m, 'range fix "bar width": .bar max-width not found')
    merged = merged[:m.start(2)] + str(max(int(m.group(2)), BAR_MAX_PX)) + merged[m.end(2):]

    wrapped = ''.join(wrap_slot(page, var, qid, slots[qid], digests[page]) + '\n' for qid, page, var in PAGES)
    slot = (COMPOSITE_HEAD.replace('@@H_MUZZLE@@', digests['u4-muzzle-flash.html'])
            .replace('@@H_TRACER@@', digests['u4-tracer.html']).replace('@@H_RANGE@@', digests[RANGE])
            + QUERY_HELPER + '\n' + wrapped + COMPOSITE + '/* ===== EFFECT SLOT: END ===================================================== */\n')
    need(merged.count(SLOT_MARK) == 1, 'the slot placeholder did not survive the merge exactly once')
    return merged.replace(SLOT_MARK, slot), unions, cams, digests


COMPOSITE_HEAD = r'''/* ===========================================================================
 * ===== EFFECT SLOT: BEGIN (replace everything down to the END marker) ======
 * COMBINED RANGE: the UNCHARTED 4 MUZZLE FLASH and BULLET TRACER studies, both fired by every shot.
 * GENERATED by tools/combine.py; do not edit this page. Change a study page, then run
 *   python3 vfx-studies/tools/combine.py          (--check only reports whether this page is out of date)
 * Built from u4-muzzle-flash.html @@H_MUZZLE@@, u4-tracer.html @@H_TRACER@@ and range.html @@H_RANGE@@ (sha256, first 12).
 * The two study slots below are pasted verbatim; the code written for this page is the QUERY helper below and the
 * composite EFFECT at the end of the slot. The range code around the slot is both pages' range code merged over
 * range.html: six cameras (key 5 = lens pass, from the tracer page; 6 = hero, from the muzzle-flash page), three looks
 * (N cycles dusk, night, day), tone map E, and the muzzle-flash page's per-texel bloom weight.
 *
 * HOW THE TWO STUDIES SHARE ONE RANGE
 *   NAMES   Both slots declare `const EFFECT`. Each runs inside its own function here (fxMuzzleFlash, fxTracer), so both
 *           stay local; the top level gains fxSlotLocation, fxMuzzleFlash, fxTracer and the composite EFFECT.
 *   ORDER   fire / update / render / dispose reach the muzzle flash first, then the tracer (the round leaves through
 *           the flash). init runs the tracer first: each study inserts its pass right before bloom, so the tracer's
 *           (mist, streak) lands BEFORE the flash's. The flash then draws over the mist (drawn after it, the mist, a
 *           normal-blended layer, would grey the flame by up to its 38% opacity) and lowers the bloom weight last
 *           (BLOOM). The panel still lists the flash first.
 *   SHOTS   fire(n) gives each study its own fresh mulberry32(n), so shot n here is shot n on both study pages.
 *   PANEL   Each study's ctx.gui is its own top-level folder ("Muzzle flash", "Tracer") with its own Preset, Reset,
 *           Copy settings and layer folders. Each keeps its own localStorage key, the same one as on its study page
 *           ("u4-vfx:muzzle-flash:v1", "u4-vfx:tracer:v1"), so tuning carries over between this page and the study
 *           page. Regenerate this page after every study change: a stale copy whose settings VERSION is older than the
 *           study page's ignores what that page stored, and overwrites it on its next panel edit.
 *   LIGHT   ctx.muzzleLight is the flash's (the tracer never touches it). The tracer adds its pool of 3 point lights
 *           to the scene in init, so the lit materials compile once, with 4 point lights, as on the tracer page.
 *   BLOOM   The range weights each texel's bloom by its alpha; the flash multiplies it down under its defined flame
 *           (1.5% bloom by default). The tracer's streak and impact glow blend additively (alpha + 1) and its mist
 *           with normal blending, so in a frame the tracer draws anything, one full-screen draw right after its pass
 *           clamps alpha back to <= 1 (MIN blend, colour untouched). The flash's cut is then exactly what it is on its
 *           own page; without the clamp the flame bloomed twice as much wherever a tracer quad covered it.
 *   KEYS    Neither study adds shortcuts; key events typed into the flash's folder stop there, as on its page.
 *   QUERY   Both studies read their options from location.search. Inside each study's scope `location` is
 *           fxSlotLocation(id): the page's query with &set and &preset routed. Unprefixed items reach both studies
 *           (a study ignores keys it does not have); "muzzle/" or "tracer/" in front sends an item to that study
 *           only, which matters for the keys both have (light.on, light.reach, halo.on):
 *             &set=mist.on:0                the tracer's mist off
 *             &set=light.on:0               both lights off;  &set=muzzle/light.on:0  the flash's light only
 *             &preset=cinematic             both studies' Cinematic;  &preset=muzzle/02,tracer/u4  one each
 *           &fx=muzzle or &fx=tracer runs that study alone on this range (it then renders as on its own page).
 *   TEST    ?preflight&cam=..&look=..&shot=N&t=s fires shot N for both studies; __range.effect.state is
 *           { muzzle: the flash's state(), tracer: the tracer's state() }.
 * BUDGET  Draw calls: 42 between shots (the range alone); while a round is alive + 4 (flash) + 2 (tracer: mist, streak;
 *   + 1 with the impact placeholder on) + 1 (the alpha clamp) = 49 of 60 (shoulder view). Frame cost at 1920x1080 under
 *   600 rpm auto-fire (__range.benchmark, Apple M1 Pro, 12 Oct, a busy machine: load average ~8): 9.6-11.7 ms; in the same
 *   session range.html alone 9.4-10.5, the flash page 9.8-11.5, the tracer page 8.9-11.4; the HUD held 58-60 fps. The
 *   composite allocates nothing per frame (heap sampling, 120 frames at 600 rpm); per shot, one mulberry32 for the tracer.
 *   dispose() frees what both studies made (GPU geometries and textures back to the pre-init count, passes, lights, panel).
 * ========================================================================= */

'''

QUERY_HELPER = r'''// QUERY: the `location` a study slot sees (see QUERY above). It holds only `search`: the studies read nothing else of
// location (combine.py checks that before splicing them in).
function fxSlotLocation(id) {
  const qp = new URLSearchParams(window.location.search);
  const PREFIX = /^\s*(muzzle|tracer)\/(.*)$/;
  if (qp.has('set')) {                         // key:value items: unprefixed ones for both studies, prefixed for one
    const items = [];
    for (const item of qp.get('set').split(',')) {
      const m = PREFIX.exec(item);
      if (!m) items.push(item); else if (m[1] === id) items.push(m[2]);
    }
    if (items.length) qp.set('set', items.join(',')); else qp.delete('set');
  }
  if (qp.has('preset')) {                      // one name per study: its own prefixed one if given, else the shared one
    let shared = null, own = null;
    for (const item of qp.get('preset').split(',')) {
      const m = PREFIX.exec(item);
      if (!m) shared = item; else if (m[1] === id) own = m[2];
    }
    const name = own !== null ? own : shared;
    if (name !== null) qp.set('preset', name); else qp.delete('preset');
  }
  const s = qp.toString();
  return Object.freeze({ search: s ? '?' + s : '' });
}
'''

COMPOSITE = r'''// ------------------------------------------------------------------------------------------------------------
// The composite EFFECT: forwards every call to both studies (see the header of this slot).
const EFFECT = (() => {
  'use strict';
  const ONLY = new URLSearchParams(window.location.search).get('fx');   // &fx=muzzle | tracer: one study alone
  // The studies in fire / update / render / dispose order, which is also the panel order; init goes the other way.
  const PARTS = [
    { id: 'muzzle', fx: fxMuzzleFlash, title: 'Muzzle flash', folder: null },
    { id: 'tracer', fx: fxTracer, title: 'Tracer', folder: null },
  ].filter((p) => (ONLY !== 'muzzle' && ONLY !== 'tracer') || p.id === ONLY);
  const INIT_ORDER = ['tracer', 'muzzle'];      // the tracer's pass must come first in the HDR chain (ORDER)
  const FX = PARTS.map((p) => p.fx);            // the per-frame loops index this array: nothing is allocated per frame
  const both = PARTS.length === 2;
  let C = null, clampQuad = null;

  // BLOOM: stands in for the tracer's pass in the composer (the tracer's own remove function takes it out again). It
  // runs that pass, then, only in a frame the pass drew in, sets alpha = min(alpha, 1) over the HDR image it drew on.
  class FxTracerThenClamp extends Pass {
    constructor(inner) { super(); this.inner = inner; this.needsSwap = inner.needsSwap; }
    setSize(width, height) { this.inner.setSize(width, height); }
    render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
      const inner = this.inner;
      if (!inner.enabled) return;
      const calls = renderer.info.render.calls;          // the range resets renderer.info once per frame (autoReset off)
      inner.renderToScreen = this.renderToScreen;
      inner.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      if (renderer.info.render.calls === calls) return;  // it drew nothing: alpha is still 1 everywhere
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;                        // with autoClear on, the quad would clear the image first
      renderer.setRenderTarget(inner.needsSwap ? writeBuffer : readBuffer);
      clampQuad.render(renderer);
      renderer.autoClear = autoClear;
    }
  }
  function addTracerPass(ctx, pass) {
    const T = ctx.THREE;
    if (!clampQuad) {
      clampQuad = new FullScreenQuad(new T.ShaderMaterial({
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: 'void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }',
        depthTest: false, depthWrite: false, transparent: true,
        blending: T.CustomBlending,
        blendEquation: T.AddEquation, blendSrc: T.ZeroFactor, blendDst: T.OneFactor,              // colour: unchanged
        blendEquationAlpha: T.MinEquation, blendSrcAlpha: T.OneFactor, blendDstAlpha: T.OneFactor, // alpha: min(1, alpha)
      }));
    }
    return ctx.addPass(new FxTracerThenClamp(pass));
  }

  // A study's own ctx: the range's ctx, with gui = the study's folder and, for the tracer when the flash runs as well,
  // addPass routed through the clamp above. Accessors are copied as accessors.
  function studyCtx(ctx, part) {
    const d = Object.getOwnPropertyDescriptors(ctx);
    d.gui = { value: part.folder, enumerable: true };
    if (part.id === 'tracer' && both) d.addPass = { value: (pass) => addTracerPass(ctx, pass), enumerable: true };
    return Object.defineProperties({}, d);
  }

  return {
    name: both ? 'Uncharted 4 muzzle flash + tracer' : PARTS[0].fx.name + ' (alone on the combined range)',
    init(ctx) {
      C = ctx;
      const root = ctx.gui;
      for (const p of PARTS) {                  // made before either init: the flash's folder on top
        p.folder = root ? root.addFolder(p.title) : null;
        if (p.folder) p.folder.$title.style.color = 'var(--accent)';   // the two studies' headings stand out from their layers
      }
      for (const id of INIT_ORDER) for (const p of PARTS) if (p.id === id) p.fx.init(studyCtx(ctx, p));
    },
    fire(n, rng, frame) {
      // the first study draws from the range's mulberry32(n), every other one from its own fresh mulberry32(n), as on its page
      for (let i = 0; i < FX.length; i++) FX[i].fire(n, i === 0 ? rng : C.rng(n), frame);
    },
    update(dt, t) {
      for (let i = 0; i < FX.length; i++) FX[i].update(dt, t);
    },
    render(renderTime, frame) {
      for (let i = 0; i < FX.length; i++) if (FX[i].render) FX[i].render(renderTime, frame);
    },
    dispose() {
      for (let i = 0; i < FX.length; i++) FX[i].dispose();              // each removes its pass, lights and controls
      for (const p of PARTS) if (p.folder) { p.folder.destroy(); p.folder = null; }
      if (clampQuad) { clampQuad.material.dispose(); clampQuad.dispose(); clampQuad = null; }
      C = null;
    },
    state() {
      const s = {};
      for (const p of PARTS) s[p.id] = p.fx.state ? p.fx.state() : null;
      return s;
    },
  };
})();
'''


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--check', action='store_true', help='exit 1 if the combined page is out of date; write nothing')
    ap.add_argument('--out', default=os.path.join(STUDIES, OUT), help='output file (default: vfx-studies/' + OUT + ')')
    a = ap.parse_args()
    try:
        page, unions, cams, digests = build()
    except CombineError as err:
        print('combine.py: ' + str(err), file=sys.stderr)
        return 2
    old = None
    if os.path.exists(a.out):
        with open(a.out, encoding='utf-8') as f:
            old = f.read()
    src = ', '.join(f'{k} {v}' for k, v in digests.items())
    if a.check:
        if old == page:
            print(f'up to date: {a.out} ({src})')
            return 0
        print(f'OUT OF DATE: {a.out}; re-run tools/combine.py ({src})')
        return 1
    if old != page:
        with open(a.out, 'w', encoding='utf-8') as f:
            f.write(page)
    print(f'{"wrote" if old != page else "unchanged"}: {a.out} ({len(page):,} bytes, {page.count(chr(10)):,} lines)')
    print(f'  sources: {src}')
    print(f'  range merge: {unions} spot(s) where both pages inserted lines (both kept); cameras 1-{len(cams)}: {", ".join(cams)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
