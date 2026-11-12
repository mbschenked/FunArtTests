#!/usr/bin/env node
// Deterministic headless runner for Cover Room (the timing seam in refs/design.md). No dependencies (Node 22+).
// Drives headless Chrome over the DevTools protocol like tools/shoot.mjs, but never uses wall-clock time for the sim:
// it calls __game.step() in-page until each timeline entry's sim time, applies that entry's input injection, renders
// a frame before each screenshot, and evaluates expressions.
//
// usage: node tools/play.mjs <url-with-?test> <timeline.json | inline JSON> [--out dir] [--w 1280] [--h 720]
//                            [--timeout 30000] [--console]
//   timeline: [{t: seconds, inject?: {...} | null, shot?: "name.png", eval?: "expr"}, ...]   (sorted by t, stable)
//     inject   -> __game.input.inject(value) at sim time t (null releases); see src/core/input.js for the shape
//     shot     -> written to --out (default: a new temp dir), after one renderFrame()
//     eval     -> any page expression; the value is returned in `evals`
//   Within an entry the order is: step to t, inject, shot, eval.
// prints one JSON line: { ok, url, consoleErrors, simTime, frames, measure: __measure.log(), evals, shots, outDir, error? }
//   consoleErrors excludes favicon and web-font noise. --console adds every console message as `console`.
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const [url, timelineArg] = argv;
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i < 0 ? def : argv[i + 1]; };
const flag = (name) => argv.includes('--' + name);
if (!url || !timelineArg) {
  console.log(JSON.stringify({ ok: false, error: 'usage: node tools/play.mjs <url-with-?test> <timeline.json | inline JSON> [--out dir]' }));
  process.exit(2);
}

let timeline;
try {
  const text = timelineArg.trim().startsWith('[') ? timelineArg : readFileSync(timelineArg, 'utf8');
  timeline = JSON.parse(text);
  if (!Array.isArray(timeline)) throw new Error('timeline must be a JSON array');
  timeline = timeline.map((e, i) => ({ ...e, t: +e.t || 0, _i: i })).sort((a, b) => a.t - b.t || a._i - b._i);
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: `bad timeline: ${err.message}` }));
  process.exit(2);
}

const W = +opt('w', 1280), H = +opt('h', 720), TIMEOUT = +opt('timeout', 30000), LOG_CONSOLE = flag('console');
const outDir = resolve(opt('out', '') || mkdtempSync(join(tmpdir(), 'play-out-')));
if (timeline.some((e) => e.shot)) mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'play-chrome-'));
// Apple silicon: a node started under Rosetta would start Chrome translated too (35-45 s a frame). arch -arm64 execs
// Chrome natively in the same process, so kill() still reaches it (as tools/shoot.mjs does).
const ARM_MAC = process.platform === 'darwin' && (() => { try { return execSync('sysctl -in hw.optional.arm64').toString().trim() === '1'; } catch { return false; } })();
const launch = (bin, args, o) => (ARM_MAC ? spawn('/usr/bin/arch', ['-arm64', bin, ...args], o) : spawn(bin, args, o));
const chrome = launch(CHROME, [
  '--headless=new', `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run',
  '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} };
// stdout to a pipe is asynchronous on macOS: exit only once the line has flushed.
let finished = false;
const finish = (result, code) => {
  if (!finished) {
    finished = true;
    cleanup();
    process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(code));
  }
  return new Promise(() => {});
};
const fail = (error, extra = {}) => finish({ ok: false, url, error, consoleErrors, ...extra }, 1);
const consoleErrors = [];
const consoleAll = [];
setTimeout(() => fail('timeout (whole run)'), TIMEOUT + 120000).unref();

let port;
for (let i = 0; i < 150 && !port; i++) {
  await sleep(100);
  const f = join(dir, 'DevToolsActivePort');
  if (existsSync(f)) port = readFileSync(f, 'utf8').split('\n')[0];
}
if (!port) await fail('chrome did not start');

const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

const NOISE = /favicon|fonts\.(googleapis|gstatic)\.com|\.woff2?(\b|$)|\.ttf(\b|$)/i;
const addError = (text) => { if (text && !NOISE.test(text)) consoleErrors.push(text); };
let nextId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    addError(d?.exception?.description || d?.text);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    const text = m.params.args.map((a) => a.value ?? a.description).join(' ');
    if (m.params.type === 'error') addError(text);
    if (LOG_CONSOLE) consoleAll.push(`${m.params.type}: ${text}`);
  } else if (m.method === 'Log.entryAdded') {
    const text = `${m.params.entry.text} ${m.params.entry.url || ''}`.trim();
    if (m.params.entry.level === 'error') addError(text);
    if (LOG_CONSOLE) consoleAll.push(`log.${m.params.entry.level}: ${text}`);
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++nextId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
// Evaluate in the page; throws with the page's exception text, so a failing step() surfaces as an error.
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description || ex.text || 'evaluation failed');
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });

const start = Date.now();
let ready = false;
while (Date.now() - start < TIMEOUT) {
  try { ready = (await evaluate('window.__ready === true && !!window.__game && !!window.__measure')) === true; } catch { ready = false; }
  if (ready) break;
  await sleep(100);
}
if (!ready) await fail('page never set window.__ready (is ?test in the URL, and did boot finish?)');

const info = await evaluate('({ dt: __game.dt, frame: __game.frame, time: __game.time })');
const startFrame = info.frame;
const evals = [];
const shots = [];
let runError = null;

for (const e of timeline) {
  try {
    const target = startFrame + Math.round(e.t / info.dt);
    await evaluate(`(() => { const g = __game; while (g.frame < ${target}) g.step(); return g.frame; })()`);
    if ('inject' in e) await evaluate(`__game.input.inject(${JSON.stringify(e.inject)})`);
    if (e.shot) {
      await evaluate('new Promise((r) => { __game.renderFrame(__game.dt); requestAnimationFrame(() => r(true)); })');
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const file = join(outDir, e.shot);
      writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
      shots.push({ t: e.t, file });
    }
    if (e.eval) {
      try { evals.push({ t: e.t, expr: e.eval, value: await evaluate(e.eval) }); }
      catch (err) { evals.push({ t: e.t, expr: e.eval, error: err.message }); }
    }
  } catch (err) {
    runError = `at t=${e.t}: ${err.message}`;
    break;
  }
}

let measure = null, end = null;
try {
  measure = await evaluate('__measure.log()');
  end = await evaluate('({ time: +__game.time.toFixed(6), frame: __game.frame })');
} catch (err) { runError = runError || `reading __measure: ${err.message}`; }

const result = {
  ok: !runError && consoleErrors.length === 0 && evals.every((v) => !v.error),
  url, consoleErrors, simTime: end?.time, frames: end ? end.frame - startFrame : undefined,
  measure, evals, shots, outDir: shots.length ? outDir : undefined,
};
if (runError) result.error = runError;
if (LOG_CONSOLE) result.console = consoleAll;
await finish(result, 0);
