/**
 * Loads one URL in headless Chrome and dumps what actually happened:
 * scripts present, body children, console output, and non-200 requests.
 *
 *   node scripts/debug-page.mjs http://127.0.0.1:3000/start
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const URL_ARG = process.argv[2];
if (!URL_ARG) throw new Error('usage: node scripts/debug-page.mjs <url>');

const PORT = Number(process.env.DEBUG_PORT ?? 9444);
const SETTLE = Number(process.env.SETTLE_MS ?? 9000);
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error('Chrome not found');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(process.env.TEMP ?? '.', 'wt-debug-profile');

const chrome = spawn(CHROME, [
  '--headless=new',
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--window-size=1440,900',
  'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());

for (let i = 0; i < 60; i++) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(250); }
}

const target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let id = 0;
const pending = new Map();
const logs = [];
const net = [];
const reqUrl = new Map();

ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled')
    logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
  if (m.method === 'Runtime.exceptionThrown')
    logs.push('[EXCEPTION] ' + String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).split('\n').slice(0, 2).join(' | ').slice(0, 260));
  if (m.method === 'Log.entryAdded' && m.params.entry.level !== 'verbose')
    logs.push(`[${m.params.entry.level}] ` + m.params.entry.text.slice(0, 200));
  if (m.method === 'Network.requestWillBeSent') reqUrl.set(m.params.requestId, m.params.request.url);
  if (m.method === 'Network.responseReceived') net.push([m.params.response.status, m.params.response.url]);
  if (m.method === 'Network.loadingFailed') net.push(['FAIL:' + (m.params.errorText ?? '?'), reqUrl.get(m.params.requestId) ?? '?']);
};

const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url: URL_ARG });
await sleep(SETTLE);

console.log('=== scripts in DOM ===');
console.log(await evaluate(`JSON.stringify([...document.scripts].map(s=>s.src?s.src.replace(location.origin,''):'(inline)'),null,0)`));

console.log('\n=== body children ===');
console.log(await evaluate(`JSON.stringify([...document.body.children].map(e=>e.tagName+(e.id?'#'+e.id:'')+(typeof e.className==='string'&&e.className?'.'+e.className.trim().split(/\\s+/)[0]:'')))`));

console.log('\n=== counts ===');
console.log(await evaluate(`JSON.stringify({els:document.body.querySelectorAll('*').length,text:(document.body.innerText||'').trim().length,canvas:document.querySelectorAll('canvas').length})`));

if (process.env.PROBE) {
  console.log('\n=== custom probe ===');
  console.log(await evaluate(process.env.PROBE));
}

if (process.env.SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(process.env.SHOT, Buffer.from(shot.result.data, 'base64'));
  console.log('\nscreenshot -> ' + process.env.SHOT);
}

console.log('\n=== console ===');
console.log([...new Set(logs)].slice(0, 40).join('\n') || '(none)');

console.log('\n=== non-200 responses ===');
const bad = net.filter(([s]) => s !== 200);
console.log(bad.length ? bad.slice(0, 30).map(([s, u]) => `${s}  ${u}`).join('\n') : '(none)');

chrome.kill();
process.exit(0);
