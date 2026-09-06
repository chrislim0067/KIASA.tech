/**
 * Reproduces the post-logout homepage failure.
 *
 * The sign-out Server Action ends with `redirect('/')`, which the App Router
 * performs as a *client-side* navigation, not a document load. This script
 * exercises that exact mechanism without needing Supabase credentials: the
 * KIASA brand link on /login is a next/link, so clicking it produces the same
 * client-side navigation into the legacy homepage that redirect('/') produces.
 *
 *   node scripts/repro-logout.mjs [origin]
 *
 * Prints, for both a fresh document load and a client-side navigation:
 * console errors, whether the hero module signalled ready, the preloader's
 * computed state, <html> classes, canvas count and scroll/pointer locks.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = process.argv[2] ?? 'http://localhost:3100';
const PORT = Number(process.env.DEBUG_PORT ?? 9412);
const WAIT = Number(process.env.WAIT_MS ?? 13000); // past the 10s safety net
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
  `--user-data-dir=${path.join(process.env.TEMP ?? '.', 'wt-repro-profile')}`,
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
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION ' + String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).split('\n')[0].slice(0, 150));
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('ERROR ' + m.params.entry.text.slice(0, 150));
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const PROBE = `JSON.stringify((()=>{
  const pre = document.getElementById('preloader');
  const preStyle = pre ? getComputedStyle(pre) : null;
  const bodyStyle = getComputedStyle(document.body);
  return {
    heroReady: !!window._heroReady,
    htmlClass: document.documentElement.className || '(none)',
    bodyClass: document.body.className || '(none)',
    preloader: pre ? { opacity: preStyle.opacity, visibility: preStyle.visibility, display: preStyle.display } : 'REMOVED',
    canvases: document.querySelectorAll('canvas').length,
    bodyOverflow: bodyStyle.overflow,
    bodyPointerEvents: bodyStyle.pointerEvents,
    htmlOverflow: getComputedStyle(document.documentElement).overflow,
    importMapTags: document.querySelectorAll('script[type="importmap"]').length,
    legacyScripts: [...document.scripts].filter(s=>s.src.includes('/generated/')||s.src.includes('/Assets/')).length,
    lenis: document.documentElement.classList.contains('lenis'),
    scrollHeight: document.documentElement.scrollHeight,
    text: (document.body.innerText||'').trim().length
  };
})())`;

async function report(label) {
  await sleep(WAIT);
  const probe = JSON.parse(await evaluate(PROBE));
  console.log(`\n--- ${label} ---`);
  for (const [k, v] of Object.entries(probe)) console.log(`  ${k.padEnd(18)} ${JSON.stringify(v)}`);
  const unique = [...new Set(logs)];
  console.log(`  console errors     ${unique.length ? '' : '(none)'}`);
  for (const l of unique.slice(0, 6)) console.log(`     ${l}`);
  return probe;
}

// ---------------------------------------------------------------- baseline
logs = [];
await send('Page.navigate', { url: `${ORIGIN}/` });
const fresh = await report('A. FRESH DOCUMENT LOAD of /  (expected: works)');

// ------------------------------------------- client-side navigation into /
logs = [];
await send('Page.navigate', { url: `${ORIGIN}/login` });
await sleep(4000);
// The brand link is a next/link — clicking it is a client-side navigation,
// the same kind redirect('/') performs from the sign-out Server Action.
const clicked = await evaluate(`(()=>{
  const a=[...document.querySelectorAll('a.kauth__brand')][0];
  if(!a) return 'brand link not found';
  a.click();
  return 'clicked ' + a.getAttribute('href');
})()`);
console.log(`\nclient-side nav: ${clicked}`);
const afterNav = await report('B. CLIENT-SIDE NAVIGATION to /  (the logout path)');

console.log('\n=== VERDICT ===');
console.log(`  heroReady   fresh=${fresh.heroReady}   after client nav=${afterNav.heroReady}`);
console.log(`  canvases    fresh=${fresh.canvases}    after client nav=${afterNav.canvases}`);
console.log(`  html class  fresh="${fresh.htmlClass}"  after="${afterNav.htmlClass}"`);

chrome.kill();
process.exit(0);
