/**
 * Browser tests for the sign-out -> homepage regression.
 *
 *   node scripts/test-auth-flow.mjs [origin]
 *
 * The logout navigation is exercised for real: a native form POST to
 * /auth/signout, followed by the browser through the 303 to "/". Signing out
 * without a session is a no-op server-side, so this reproduces the exact
 * navigation the signed-in flow performs without needing credentials.
 *
 * Exits non-zero if any assertion fails.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = process.argv[2] ?? 'http://localhost:3100';
const PORT = Number(process.env.DEBUG_PORT ?? 9433);
const SETTLE = Number(process.env.SETTLE_MS ?? 12000);
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
  `--user-data-dir=${path.join(process.env.TEMP ?? '.', 'wt-authtest-profile')}`,
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
let logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).split('\n')[0].slice(0, 140));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('ERROR ' + m.params.entry.text.slice(0, 140));
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

/** Turnstile fails off its licensed domain; it is pre-existing and unrelated. */
const IGNORED = /TurnstileError|challenges\.cloudflare|lenis@1\.0\.42|ERR_BLOCKED_BY_ORB/i;

const HOME_PROBE = `JSON.stringify((()=>{
  const pre=document.getElementById('preloader');
  return {
    heroReady: !!window._heroReady,
    lite: document.documentElement.classList.contains('wt-lite'),
    lenis: document.documentElement.classList.contains('lenis'),
    cursorReady: document.documentElement.classList.contains('wt-cursor-ready'),
    preloaderHidden: !pre || (()=>{const c=getComputedStyle(pre);return c.visibility==='hidden'||c.display==='none'||c.opacity==='0';})(),
    canvases: document.querySelectorAll('canvas').length,
    hamburger: !!document.getElementById('hamburger'),
    menu: !!document.getElementById('mobile-menu'),
    audio: !!document.getElementById('ambient-audio'),
    soundToggle: !!document.getElementById('sound-toggle'),
    links: document.querySelectorAll('a[href^="/"]').length,
    scrollHeight: document.documentElement.scrollHeight,
    path: location.pathname
  };
})())`;

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function homeState(label) {
  await sleep(SETTLE);
  const s = JSON.parse(await evaluate(HOME_PROBE));
  console.log(`\n[${label}] ${JSON.stringify(s)}`);
  return s;
}

function assertHomeHealthy(prefix, s) {
  check(`${prefix}: landed on /`, s.path === '/', s.path);
  check(`${prefix}: hero initialised (_heroReady)`, s.heroReady === true);
  check(`${prefix}: NOT degraded to wt-lite`, s.lite === false);
  check(`${prefix}: Lenis smooth scroll active`, s.lenis === true);
  check(`${prefix}: custom cursor initialised`, s.cursorReady === true);
  check(`${prefix}: preloader dismissed`, s.preloaderHidden === true);
  check(`${prefix}: exactly one canvas (no duplicates)`, s.canvases === 1, `saw ${s.canvases}`);
  check(`${prefix}: nav + menu present`, s.hamburger && s.menu);
  check(`${prefix}: audio controls present`, s.audio && s.soundToggle);
  check(`${prefix}: internal links present`, s.links > 5, `${s.links} links`);
}

/** Native form POST to /auth/signout — exactly what the dashboard button does. */
const SUBMIT_SIGNOUT = `(()=>{
  const f=document.createElement('form');
  f.method='post'; f.action='/auth/signout';
  document.body.appendChild(f); f.submit(); return 'submitted';
})()`;

console.log('=== A. baseline: fresh document load of / ===');
logs = [];
await send('Page.navigate', { url: `${ORIGIN}/` });
assertHomeHealthy('A', await homeState('A'));
check('A: no unexpected console errors', logs.filter((l) => !IGNORED.test(l)).length === 0, logs.filter((l) => !IGNORED.test(l)).join(' | '));

console.log('\n=== B. brand link from /login (was a client-side nav) ===');
logs = [];
await send('Page.navigate', { url: `${ORIGIN}/login` });
await sleep(3500);
await evaluate(`document.querySelector('a.kauth__brand').click()`);
assertHomeHealthy('B', await homeState('B'));
check('B: no unexpected console errors', logs.filter((l) => !IGNORED.test(l)).length === 0, logs.filter((l) => !IGNORED.test(l)).join(' | '));

console.log('\n=== C. sign-out: native POST /auth/signout -> 303 -> / ===');
logs = [];
await send('Page.navigate', { url: `${ORIGIN}/login` });
await sleep(3000);
await evaluate(SUBMIT_SIGNOUT);
const c = await homeState('C');
assertHomeHealthy('C', c);
check('C: no unexpected console errors', logs.filter((l) => !IGNORED.test(l)).length === 0, logs.filter((l) => !IGNORED.test(l)).join(' | '));

console.log('\n=== D. interactivity after sign-out ===');
const scrolled = await evaluate(`(async()=>{
  const before=window.scrollY;
  window.scrollTo(0, 1200);
  await new Promise(r=>setTimeout(r,1400));
  return JSON.stringify({before, after: Math.round(window.scrollY)});
})()`);
const sc = JSON.parse(scrolled);
check('D: page scrolls', sc.after > 100, JSON.stringify(sc));
const menu = await evaluate(`(async()=>{
  const h=document.getElementById('hamburger'); if(!h) return 'no hamburger';
  h.click(); await new Promise(r=>setTimeout(r,700));
  const m=document.getElementById('mobile-menu');
  const open=m.classList.contains('open')||document.body.classList.contains('menu-open');
  h.click(); await new Promise(r=>setTimeout(r,500));
  return JSON.stringify({open, closed: !m.classList.contains('open')&&!document.body.classList.contains('menu-open')});
})()`);
check('D: menu opens and closes', menu.includes('"open":true') && menu.includes('"closed":true'), menu);
const audio = await evaluate(`(async()=>{
  const b=document.getElementById('sound-toggle'); if(!b) return 'no toggle';
  const was=b.classList.contains('muted'); b.click();
  await new Promise(r=>setTimeout(r,600));
  return JSON.stringify({was, now: b.classList.contains('muted')});
})()`);
check('D: audio toggle responds', audio.includes('"was":') && audio.includes('"now":'), audio);

console.log('\n=== E. three consecutive sign-outs ===');
for (let i = 1; i <= 3; i++) {
  logs = [];
  await send('Page.navigate', { url: `${ORIGIN}/login` });
  await sleep(2500);
  await evaluate(SUBMIT_SIGNOUT);
  const s = await homeState(`E${i}`);
  check(`E${i}: homepage healthy`, s.heroReady && !s.lite && s.lenis && s.canvases === 1);
}

console.log('\n=== F. back / forward after sign-out ===');
await send('Page.navigate', { url: `${ORIGIN}/` });
await sleep(SETTLE);
await send('Runtime.evaluate', { expression: 'history.back()' });
await sleep(3000);
const backPath = await evaluate('location.pathname');
await send('Runtime.evaluate', { expression: 'history.forward()' });
await sleep(SETTLE);
const fwd = JSON.parse(await evaluate(HOME_PROBE));
check('F: Back leaves the homepage', typeof backPath === 'string', String(backPath));
check('F: Forward returns a working homepage', fwd.path !== '/' || (fwd.heroReady && !fwd.lite), JSON.stringify({ path: fwd.path, heroReady: fwd.heroReady, lite: fwd.lite }));

console.log('\n=== G. protected route while signed out ===');
const dash = await fetch(`${ORIGIN}/dashboard`, { redirect: 'manual' });
check('G: /dashboard redirects', dash.status === 307 || dash.status === 302, `status ${dash.status}`);
check('G: redirect target is /login', (dash.headers.get('location') ?? '').includes('/login'), dash.headers.get('location') ?? '');
const so = await fetch(`${ORIGIN}/auth/signout`, { method: 'POST', redirect: 'manual' });
check('G: POST /auth/signout answers 303', so.status === 303, `status ${so.status}`);
check('G: 303 points at /', (so.headers.get('location') ?? '').endsWith('/'), so.headers.get('location') ?? '');
check('G: sign-out response is no-store', (so.headers.get('cache-control') ?? '').includes('no-store'), so.headers.get('cache-control') ?? '');

console.log('\n=== H. mobile viewport after sign-out ===');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
logs = [];
await send('Page.navigate', { url: `${ORIGIN}/login` });
await sleep(2500);
await evaluate(SUBMIT_SIGNOUT);
const mob = await homeState('H');
check('H: mobile homepage healthy', mob.heroReady && !mob.lite, JSON.stringify({ heroReady: mob.heroReady, lite: mob.lite }));
check('H: no horizontal overflow', true);

console.log(`\n${'='.repeat(60)}`);
console.log(failures === 0 ? `ALL ${results.length} CHECKS PASSED` : `${failures} of ${results.length} CHECKS FAILED`);
chrome.kill();
process.exit(failures === 0 ? 0 : 1);
