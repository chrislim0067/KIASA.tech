/**
 * Responsive sweep: every route at every breakpoint, rebuild vs original.
 *
 *   npm run legacy          # original on :8140
 *   npm start               # rebuild on :3100
 *   npm run responsive
 *
 * Per (route, width) it reports:
 *   - overflow: horizontal scroll (scrollWidth > innerWidth) and the widest
 *     offending element, which is the usual cause
 *   - pixels:   difference vs the original at that width
 *   - errors:   console errors the original does not also produce
 *
 * Screenshots land in verify-shots/responsive/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHOTS = path.join(ROOT, 'verify-shots', 'responsive');
const LEGACY = process.env.LEGACY_ORIGIN ?? 'http://127.0.0.1:8140';
const NEXT = process.env.NEXT_ORIGIN ?? 'http://127.0.0.1:3100';
const PORT = 9377;
const SETTLE = Number(process.env.SETTLE_MS ?? 6000);

const VIEWPORTS = [
  { name: 'mobile-320', width: 320, height: 720, mobile: true, dpr: 2 },
  { name: 'mobile-390', width: 390, height: 844, mobile: true, dpr: 3 },
  { name: 'tablet-768', width: 768, height: 1024, mobile: true, dpr: 2 },
  { name: 'laptop-1024', width: 1024, height: 768, mobile: false, dpr: 1 },
  { name: 'desktop-1440', width: 1440, height: 900, mobile: false, dpr: 1 },
  { name: 'wide-1920', width: 1920, height: 1080, mobile: false, dpr: 1 },
];

const ROUTES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['/', '/about', '/gallery', '/pricing', '/contact', '/blog', '/estimate', '/case-studies', '/service?s=immersive-3d', '/ar/arabic-website-design'];

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error('Chrome not found');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP ?? ROOT, 'wt-responsive-profile')}`,
  '--window-size=1920,1080', 'about:blank',
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
let errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown')
    errors.push(String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).split('\n')[0].slice(0, 100));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error')
    errors.push(m.params.entry.text.slice(0, 100));
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

/**
 * Horizontal overflow is the defining responsive failure: the page scrolls
 * sideways. Also name the widest element crossing the right edge, since that is
 * almost always the cause.
 */
const PROBE = `JSON.stringify((()=>{
  const de=document.documentElement, vw=window.innerWidth;
  let worst=null, worstW=0;
  for (const el of document.body.querySelectorAll('*')) {
    const r=el.getBoundingClientRect();
    if (r.width===0||r.height===0) continue;
    const cs=getComputedStyle(el);
    if (cs.position==='fixed') continue;              // fixed chrome is allowed off-canvas
    const over = r.right - vw;
    if (over > 2 && r.width > worstW) {
      worstW = r.width;
      worst = (el.tagName+(el.id?'#'+el.id:'')+(typeof el.className==='string'&&el.className?'.'+el.className.trim().split(/\\s+/)[0]:''))
        + ' w=' + Math.round(r.width) + ' right=' + Math.round(r.right);
    }
  }
  return {
    scrollW: de.scrollWidth, vw,
    overflow: Math.max(0, de.scrollWidth - vw),
    worst,
    els: document.body.querySelectorAll('*').length,
    text: (document.body.innerText||'').replace(/\\s+/g,' ').trim().length,
    navVisible: !!document.querySelector('nav') && getComputedStyle(document.querySelector('nav')).display !== 'none',
    brokenImgs: [...document.images].filter(i=>i.complete&&i.naturalWidth===0).length
  };
})())`;

async function capture(url, vp) {
  errors = [];
  await send('Emulation.setDeviceMetricsOverride', {
    width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: vp.mobile,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: vp.mobile, maxTouchPoints: vp.mobile ? 5 : 0 });
  await send('Page.navigate', { url });
  await sleep(SETTLE);
  const probe = JSON.parse(await evaluate(PROBE));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  return { probe, png: shot.result.data, errors: [...new Set(errors)] };
}

async function pixelDiff(a, b) {
  const expr = `(async()=>{
    const load=(x)=>new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src='data:image/png;base64,'+x;});
    const [p,q]=await Promise.all([load(${JSON.stringify(a)}),load(${JSON.stringify(b)})]);
    const w=Math.min(p.width,q.width),h=Math.min(p.height,q.height);
    const ca=new OffscreenCanvas(w,h),cb=new OffscreenCanvas(w,h);
    const xa=ca.getContext('2d'),xb=cb.getContext('2d');
    xa.drawImage(p,0,0);xb.drawImage(q,0,0);
    const da=xa.getImageData(0,0,w,h).data,db=xb.getImageData(0,0,w,h).data;
    let d=0; for(let i=0;i<da.length;i+=4){ if(Math.abs(da[i]-db[i])+Math.abs(da[i+1]-db[i+1])+Math.abs(da[i+2]-db[i+2])>24) d++; }
    return (100*d/(w*h)).toFixed(2);
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value ?? '?';
}

fs.mkdirSync(SHOTS, { recursive: true });

// Warm both sides so dev compilation is not measured as layout breakage.
for (const route of ROUTES) for (const o of [LEGACY, NEXT]) { try { await fetch(o + route); } catch {} }

const problems = [];
console.log('route                          viewport        overflow(orig->new)   pixels   els        text');
console.log('-'.repeat(96));

for (const route of ROUTES) {
  for (const vp of VIEWPORTS) {
    const slug = (route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home') + '.' + vp.name;
    const a = await capture(LEGACY + route, vp);
    const b = await capture(NEXT + route, vp);
    fs.writeFileSync(path.join(SHOTS, slug + '.next.png'), Buffer.from(b.png, 'base64'));

    const px = await pixelDiff(a.png, b.png);
    const newErrors = b.errors.filter((e) => !a.errors.some((x) => x.slice(0, 50) === e.slice(0, 50)) && !/hmr|devtools/i.test(e));

    const flag = [];
    if (b.probe.overflow > 2 && b.probe.overflow > a.probe.overflow + 2) flag.push('OVERFLOW-NEW');
    else if (b.probe.overflow > 2) flag.push('overflow-both');
    if (b.probe.text < a.probe.text * 0.6) flag.push('TEXT-MISSING');
    if (b.probe.brokenImgs > a.probe.brokenImgs) flag.push('BROKEN-IMG');
    if (!b.probe.navVisible && a.probe.navVisible) flag.push('NAV-GONE');
    if (newErrors.length) flag.push('JS-ERROR');

    console.log(
      route.padEnd(30) + vp.name.padEnd(16) +
      `${String(a.probe.overflow).padStart(5)} -> ${String(b.probe.overflow).padEnd(6)}` +
      String(px).padStart(8) + '%' +
      `${String(a.probe.els).padStart(6)}->${String(b.probe.els).padEnd(6)}` +
      `${String(a.probe.text).padStart(6)}->${String(b.probe.text).padEnd(6)}` +
      (flag.length ? '  ' + flag.join(',') : '')
    );

    if (flag.length) problems.push({ route, vp: vp.name, flag, worst: b.probe.worst, legacyWorst: a.probe.worst, newErrors });
  }
}

console.log('\n' + '='.repeat(96));
if (!problems.length) {
  console.log('No responsive problems found.');
} else {
  console.log(`${problems.length} problem(s):\n`);
  for (const p of problems) {
    console.log(`${p.route} @ ${p.vp}  [${p.flag.join(',')}]`);
    if (p.worst) console.log(`   widest overflowing (new):    ${p.worst}`);
    if (p.legacyWorst) console.log(`   widest overflowing (orig):  ${p.legacyWorst}`);
    for (const e of p.newErrors.slice(0, 2)) console.log(`   error: ${e}`);
  }
}
console.log(`\nshots: ${SHOTS}`);

chrome.kill();
process.exit(0);
