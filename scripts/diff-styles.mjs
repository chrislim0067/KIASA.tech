/**
 * Diffs computed styles for the shared chrome elements between the original and
 * the rebuild, for one route. Pinpoints visual drift that a pixel diff only
 * hints at.
 *
 *   node scripts/diff-styles.mjs /about
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROUTE = process.argv[2] ?? '/';
const LEGACY = process.env.LEGACY_ORIGIN ?? 'http://127.0.0.1:8140';
const NEXT = process.env.NEXT_ORIGIN ?? 'http://127.0.0.1:3000';
const PORT = 9555;
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--hide-scrollbars', '--no-first-run', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP ?? '.', 'wt-style-profile')}`,
  '--window-size=1440,900', 'about:blank',
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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const PROPS = ['background-color', 'background-image', 'opacity', 'transform', 'mix-blend-mode', 'z-index', 'display', 'visibility', 'filter', 'backdrop-filter'];
const SELECTORS = ['body', 'html', '.grain', '#wt-page-wipe', '#wt-cursor-ring', '#wt-cursor-dot', 'nav', '.page-hero', 'footer'];

const PROBE = `JSON.stringify((()=>{
  const props=${JSON.stringify(PROPS)};
  const out={};
  for (const sel of ${JSON.stringify(SELECTORS)}) {
    const el=document.querySelector(sel);
    if(!el){out[sel]=null;continue;}
    const cs=getComputedStyle(el); const o={};
    for(const p of props) o[p]=cs.getPropertyValue(p);
    const r=el.getBoundingClientRect();
    o['__rect']=[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)];
    o['__classes']=el.className&&typeof el.className==='string'?el.className:'';
    out[sel]=o;
  }
  out['__htmlClass']=document.documentElement.className;
  out['__bodyClass']=document.body.className;
  // What is actually painted at a mid-hero point, top of stack down.
  out['__stack']=document.elementsFromPoint(700,300).slice(0,6).map(e=>{
    const cs=getComputedStyle(e);
    return e.tagName
      +(e.id?'#'+e.id:'')
      +(typeof e.className==='string'&&e.className?'.'+e.className.trim().split(/\\s+/).join('.'):'')
      +' bg='+cs.backgroundColor
      +' bgi='+cs.backgroundImage.slice(0,50)
      +' op='+cs.opacity
      +' blend='+cs.mixBlendMode;
  }).join('\\n    ');
  return out;
})())`;

async function grab(url) {
  await send('Page.navigate', { url });
  await sleep(Number(process.env.SETTLE_MS ?? 7000));
  const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
  return JSON.parse(r.result.result.value);
}

const a = await grab(LEGACY + ROUTE);
const b = await grab(NEXT + ROUTE);

console.log(`route ${ROUTE}\n`);
for (const sel of [...SELECTORS, '__htmlClass', '__bodyClass', '__stack']) {
  const x = a[sel], y = b[sel];
  if (typeof x === 'string' || typeof y === 'string') {
    if (x !== y) console.log(`${sel}\n  legacy: ${x}\n  next:   ${y}\n`);
    continue;
  }
  if (!x && !y) continue;
  if (!x || !y) { console.log(`${sel}: present legacy=${!!x} next=${!!y}\n`); continue; }
  const diffs = Object.keys(x).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
  if (diffs.length) {
    console.log(sel);
    for (const d of diffs) console.log(`  ${d.padEnd(18)} legacy=${JSON.stringify(x[d])}  next=${JSON.stringify(y[d])}`);
    console.log('');
  }
}
chrome.kill();
process.exit(0);
