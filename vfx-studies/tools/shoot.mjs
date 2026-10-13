#!/usr/bin/env node
// Headless Chrome screenshot + real-input harness for vfx-studies. No dependencies (Node 22+ global fetch/WebSocket).
// Chrome's own --screenshot/--dump-dom modes hang on this Mac instead of exiting, so this drives Chrome
// over the DevTools protocol and always kills it afterwards. Each call gets its own throwaway profile,
// so several agents can run it at once without touching the chrome-devtools MCP browser.
//
// usage: node shoot.mjs <url> <out.png> [--w 1280] [--h 720] [--reduced-motion]
//                       [--wait-title "PREFLIGHT READY"] [--settle 1500] [--timeout 20000] [--eval "<js expr>"]
//                       [--actions '<json array>']
// prints one JSON line: { ok, title, consoleErrors, evalResult, actionResults, out }
//
// --actions runs after the page is ready and before the final screenshot. Input goes through
// Input.dispatchMouseEvent / dispatchKeyEvent, the same path a real mouse and keyboard take
// (and the same one the chrome-devtools MCP uses). Selectors are only used to find where to click.
//   {"click": "#fire"} or {"click": [x, y]}     real left click at the element centre or a point
//   {"drag": {"from": "#knob" | [x, y], "to": [x, y], "steps": 12}}
//   {"key": "Space"}  {"key": "1"}  {"key": "Enter"}  {"key": "d"}
//   {"type": "0.35"}                             inserts text into the focused field
//   {"wait": 250}                                wall-clock milliseconds
//   {"shot": "/abs/path.png"}                    extra screenshot mid-sequence
//   {"eval": "window.__range.simTime"}           read-only check, result recorded
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const [url, out] = argv;
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i < 0 ? def : argv[i + 1]; };
const flag = (name) => argv.includes('--' + name);
if (!url || !out) { console.log(JSON.stringify({ ok: false, error: 'usage: node shoot.mjs <url> <out.png> [options]' })); process.exit(2); }

const W = +opt('w', 1280), H = +opt('h', 720), TIMEOUT = +opt('timeout', 20000);
const WAIT_TITLE = opt('wait-title', null), SETTLE = +opt('settle', 1500), EVAL = opt('eval', null);
let ACTIONS = [];
try { ACTIONS = JSON.parse(opt('actions', '[]')); } catch (err) { console.log(JSON.stringify({ ok: false, error: `bad --actions JSON: ${err.message}` })); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'shoot-'));
// Apple silicon: node started from an Intel (Rosetta) parent, such as the anaconda python3 on this Mac, starts Chrome translated
// as well (35-45 s a frame instead of under 1 s; same pixels). arch -arm64 execs Chrome natively in the same process, so kill()
// still reaches it. (Orchestrator, 12 Oct 09:05.)
const ARM_MAC = process.platform === 'darwin' && (() => { try { return execSync('sysctl -in hw.optional.arm64').toString().trim() === '1'; } catch { return false; } })();
const launch = (bin, args, o) => (ARM_MAC ? spawn('/usr/bin/arch', ['-arm64', bin, ...args], o) : spawn(bin, args, o));
const chrome = launch(CHROME, [
  '--headless=new', `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run',
  '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} };
// stdout to a pipe is asynchronous on macOS, so exiting right after a write cuts large results off.
// finish() exits only once the line has flushed; it never resolves, so `await finish(...)` stops the script there.
let finished = false;
const finish = (result, code) => {
  if (!finished) {
    finished = true;
    cleanup();
    process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(code));
  }
  return new Promise(() => {});
};
const fail = (error) => finish({ ok: false, error }, 1);
setTimeout(() => fail('timeout'), TIMEOUT + 30000).unref();

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

let nextId = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    consoleErrors.push(d?.exception?.description || d?.text);
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    consoleErrors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`.trim());
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++nextId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
const screenshot = async (file) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
};

// Resolve a click target: [x, y] as given, or the centre of the first element matching a selector.
const point = async (target) => {
  if (Array.isArray(target)) return target;
  const p = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(target)}); if (!el) return null;
    const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  if (!p) throw new Error(`no element matches ${target}`);
  return p;
};
const mouse = (type, [x, y], extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
const KEYS = {
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
};
const keyInfo = (name) => {
  if (KEYS[name]) return KEYS[name];
  if (name.length === 1) {
    const upper = name.toUpperCase();
    const code = /[0-9]/.test(name) ? `Digit${name}` : `Key${upper}`;
    return { key: name, code, windowsVirtualKeyCode: upper.charCodeAt(0), text: name };
  }
  return { key: name, code: name };
};

const runAction = async (a) => {
  if ('click' in a) {
    const p = await point(a.click);
    await mouse('mouseMoved', p);
    await mouse('mousePressed', p, { clickCount: 1 });
    await mouse('mouseReleased', p, { clickCount: 1 });
    return { click: p };
  }
  if ('drag' in a) {
    const from = await point(a.drag.from), to = await point(a.drag.to), steps = a.drag.steps || 12;
    await mouse('mouseMoved', from);
    await mouse('mousePressed', from, { clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', [from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps], { buttons: 1 });
    }
    await mouse('mouseReleased', to, { clickCount: 1 });
    return { drag: [from, to] };
  }
  if ('key' in a) {
    const k = keyInfo(a.key);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
    return { key: a.key };
  }
  if ('type' in a) { await send('Input.insertText', { text: String(a.type) }); return { type: a.type }; }
  if ('wait' in a) { await sleep(a.wait); return { wait: a.wait }; }
  if ('shot' in a) { await screenshot(a.shot); return { shot: a.shot }; }
  if ('eval' in a) return { eval: a.eval, value: await evaluate(a.eval) };
  throw new Error(`unknown action ${JSON.stringify(a)}`);
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
if (flag('reduced-motion')) {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
}
await send('Page.navigate', { url });

const start = Date.now();
let title = '';
while (Date.now() - start < TIMEOUT) {
  const [state, t] = String(await evaluate('document.readyState + "|" + document.title')).split('|');
  title = t;
  if (WAIT_TITLE ? t === WAIT_TITLE : state === 'complete') break;
  await sleep(200);
}
if (!WAIT_TITLE) await sleep(SETTLE);

const actionResults = [];
for (const a of ACTIONS) {
  try { actionResults.push(await runAction(a)); }
  catch (err) { actionResults.push({ error: err.message, action: a }); break; }
}

const evalResult = EVAL ? await evaluate(EVAL) : undefined;
await screenshot(out);
const actionsOk = actionResults.every((r) => !r.error);
await finish({ ok: (!WAIT_TITLE || title === WAIT_TITLE) && actionsOk, title, consoleErrors, evalResult, actionResults, out }, 0);
