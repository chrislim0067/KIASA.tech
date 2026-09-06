/**
 * Compares the rebuilt app against the crawled original, route for route.
 *
 *   node scripts/serve-legacy.mjs 8140     # original
 *   npm run dev                            # rebuild on :3000
 *   npm run verify
 *
 * For each route it loads both sides in headless Chrome, waits for scripts to
 * settle, then reports:
 *   - a real pixel difference (both shots drawn to a canvas and diffed in-page,
 *     so there is no image-decoding dependency)
 *   - DOM shape: element count and tag histogram distance
 *   - console errors on each side
 *
 * Screenshots land in verify-shots/ for eyeballing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHOTS = path.join(ROOT, 'verify-shots');
const LEGACY = process.env.LEGACY_ORIGIN ?? 'http://127.0.0.1:8140';
const NEXT = process.env.NEXT_ORIGIN ?? 'http://127.0.0.1:3000';
const PORT = 9333;

const ROUTES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      '/',
      '/about',
      '/gallery',
      '/pricing',
      '/contact',
      '/blog',
      '/case-studies',
      '/start',
      '/privacy',
      '/terms',
      '/web-design-agency-dubai',
      '/service?s=immersive-3d',
      '/blog-post?slug=core-web-vitals-inp',
      '/ar/arabic-website-design',
    ];

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error('Chrome not found');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- CDP client */

class Tab {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).split('\n')[0]);
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        this.errors.push(m.params.entry.text.slice(0, 120));
      }
    };
  }
  send(method, params = {}) {
    return new Promise((res) => {
      const id = ++this.id;
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  }
}

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const tab = new Tab(ws);
  await tab.send('Runtime.enable');
  await tab.send('Log.enable');
  await tab.send('Page.enable');
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  return tab;
}

/* ------------------------------------------------------------------ capture */

const PROBE = `JSON.stringify((()=>{
  const els=[...document.body.querySelectorAll('*')];
  const tags={};
  for(const e of els){const t=e.tagName;tags[t]=(tags[t]||0)+1;}
  return {
    count: els.length,
    tags,
    canvases: document.querySelectorAll('canvas').length,
    text: (document.body.innerText||'').replace(/\\s+/g,' ').trim().length,
    title: document.title,
    lang: document.documentElement.lang,
    dir: document.documentElement.dir || 'ltr',
    bodyChildren: document.body.children.length,
    brokenImgs: [...document.images].filter(i=>i.complete&&i.naturalWidth===0).length
  };
})())`;

async function capture(tab, url, settleMs) {
  tab.errors.length = 0;
  await tab.send('Page.navigate', { url });
  await sleep(settleMs);
  const probe = JSON.parse(await tab.evaluate(PROBE));
  const shot = await tab.send('Page.captureScreenshot', { format: 'png' });
  return { probe, png: shot.result.data, errors: [...tab.errors] };
}

/** Diff two PNG data URLs inside the page — avoids an image-decoding dependency. */
async function pixelDiff(tab, aB64, bB64) {
  const expr = `(async()=>{
    const load=(b64)=>new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src='data:image/png;base64,'+b64;});
    const [a,b]=await Promise.all([load(${JSON.stringify(aB64)}),load(${JSON.stringify(bB64)})]);
    const w=Math.min(a.width,b.width),h=Math.min(a.height,b.height);
    const ca=new OffscreenCanvas(w,h),cb=new OffscreenCanvas(w,h);
    const xa=ca.getContext('2d'),xb=cb.getContext('2d');
    xa.drawImage(a,0,0);xb.drawImage(b,0,0);
    const da=xa.getImageData(0,0,w,h).data,db=xb.getImageData(0,0,w,h).data;
    let diff=0,total=w*h;
    for(let i=0;i<da.length;i+=4){
      const d=Math.abs(da[i]-db[i])+Math.abs(da[i+1]-db[i+1])+Math.abs(da[i+2]-db[i+2]);
      if(d>24) diff++;
    }
    return JSON.stringify({w,h,pctDifferent:+(100*diff/total).toFixed(2)});
  })()`;
  return JSON.parse(await tab.evaluate(expr));
}

/* --------------------------------------------------------------------- main */

const chrome = spawn(CHROME, [
  '--headless=new',
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  // keep the throwaway Chrome profile out of the project tree
  `--user-data-dir=${path.join(process.env.TEMP ?? ROOT, 'wt-verify-profile')}`,
  '--window-size=1440,900',
  'about:blank',
], { stdio: 'ignore' });

process.on('exit', () => chrome.kill());

for (let i = 0; i < 60; i++) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`);
    break;
  } catch {
    await sleep(250);
  }
}

fs.mkdirSync(SHOTS, { recursive: true });

// Warm every route first. In dev, the first hit to a route pays Turbopack
// compilation, so an un-warmed page is still assembling when the screenshot is
// taken and reports a huge, meaningless pixel difference.
for (const route of ROUTES) {
  for (const origin of [LEGACY, NEXT]) {
    try { await fetch(origin + route); } catch { /* reported per-route below */ }
  }
}

const tab = await connect();
const settle = Number(process.env.SETTLE_MS ?? 7000);
const rows = [];

for (const route of ROUTES) {
  const slug = route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home';
  const a = await capture(tab, LEGACY + route, settle);
  const b = await capture(tab, NEXT + route, settle);
  fs.writeFileSync(path.join(SHOTS, `${slug}.legacy.png`), Buffer.from(a.png, 'base64'));
  fs.writeFileSync(path.join(SHOTS, `${slug}.next.png`), Buffer.from(b.png, 'base64'));

  const px = await pixelDiff(tab, a.png, b.png);
  const elDelta = b.probe.count - a.probe.count;
  rows.push({ route, px: px.pctDifferent, elDelta, a: a.probe, b: b.probe, aErr: a.errors, bErr: b.errors });

  console.log(
    `${route.padEnd(38)} pixels:${String(px.pctDifferent).padStart(6)}%  els:${String(a.probe.count).padStart(4)}->${String(b.probe.count).padEnd(4)}` +
    ` bodyKids:${a.probe.bodyChildren}->${b.probe.bodyChildren} canvas:${a.probe.canvases}->${b.probe.canvases}` +
    ` text:${a.probe.text}->${b.probe.text}` +
    (b.probe.brokenImgs ? `  brokenImgs:${b.probe.brokenImgs}` : '')
  );
}

console.log('\n--- console errors (rebuild only, excluding ones the original also has) ---');
for (const r of rows) {
  const newOnly = r.bErr.filter((e) => !r.aErr.some((x) => x.slice(0, 60) === e.slice(0, 60)));
  if (newOnly.length) console.log(`${r.route}\n  ${[...new Set(newOnly)].slice(0, 5).join('\n  ')}`);
}

const worst = [...rows].sort((x, y) => y.px - x.px).slice(0, 5);
console.log('\n--- largest pixel differences ---');
for (const r of worst) console.log(`  ${String(r.px).padStart(6)}%  ${r.route}`);
console.log(`\nshots: ${SHOTS}`);

chrome.kill();
process.exit(0);
