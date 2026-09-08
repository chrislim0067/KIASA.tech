/**
 * End-to-end logout regression, with a real authenticated session.
 *
 *   node scripts/test-logout-e2e.mjs
 *
 * Replaces scripts/test-auth-flow.mjs, which could not be trusted as a
 * regression test:
 *
 *   * it only ever looked for Chrome in two Windows paths, so it could not run
 *     on Linux and was therefore absent from CI;
 *   * it assumed a server was already running on a fixed port, and did not
 *     start or stop one;
 *   * it signed out WITHOUT EVER SIGNING IN — `signOut()` with no session is a
 *     server-side no-op, so the assertions passed whether or not logout
 *     actually cleared anything;
 *   * its mobile-overflow assertion was literally `check(..., true)`;
 *   * it used one fixed temp profile directory and a fixed debugging port, so
 *     two runs collided.
 *
 * WHAT THIS DOES INSTEAD
 *
 * Creates a throwaway user in the LOCAL Supabase stack, signs in for real,
 * hands the resulting Supabase cookies to a real Chrome, confirms the browser
 * is genuinely authenticated by loading the protected dashboard, then clicks
 * the application's own sign-out button and proves the session is gone: the
 * auth cookies are cleared, /dashboard no longer serves, and the homepage
 * still finishes loading and stays interactive.
 *
 * Everything is bounded by timeouts, every resource is cleaned up in a
 * `finally`, and the temp user, browser profile, server and its children are
 * removed even when an assertion fails.
 *
 * Environment:
 *   CHROME_BIN     explicit path to a Chrome/Chromium binary (overrides discovery)
 *   LOGOUT_E2E_PORT fixed server port (default: an OS-assigned free port)
 */
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';

import { localStatusEnv } from './lib/supabase-cli.mjs';

/* ------------------------------------------------------------- constants */

const OVERALL_BUDGET_MS = 20 * 60 * 1000; // hard ceiling; CI must never hang
const SERVER_START_MS = 120_000;
const CHROME_START_MS = 60_000;
const PAGE_READY_MS = 45_000;

/**
 * The homepage preloader gets its own, much larger budget.
 *
 * Measured on this hardware, headless with software GL: the loader counter
 * climbs from 15% to 100% over 25-29 SECONDS on every single load, as the
 * hero's seven textures decode through swiftshader. It is not a stall and not
 * a flake — that is simply how long it takes without a GPU.
 *
 * The first version of this test allowed 45s, which is only ~1.6x the observed
 * time. Under concurrent load, or on a slower runner, it tipped over and the
 * test failed intermittently on a page that was working correctly. A timeout
 * set just above the happy path is a timeout that will flake; this one is set
 * from measurement with real headroom.
 */
const PRELOADER_MS = 150_000;
const NAV_SETTLE_MS = 1_500;

/** Turnstile fails off its licensed domain; pre-existing and unrelated. */
const IGNORED_CONSOLE =
  /TurnstileError|challenges\.cloudflare|lenis@1\.0\.42|ERR_BLOCKED_BY_ORB|favicon/i;

/* --------------------------------------------------------------- harness */

let passed = 0;
let failed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------- chrome discovery */

/**
 * Find a usable Chrome/Chromium.
 *
 * `CHROME_BIN` wins, and is validated rather than trusted — a wrong value
 * should say so, not fail later as "browser did not start". Otherwise the
 * candidates are platform-specific and each is checked to be an existing,
 * executable file.
 */
function discoverChrome() {
  const validate = (p, source) => {
    if (!existsSync(p)) return `${source}: no such file: ${p}`;
    if (!statSync(p).isFile()) return `${source}: not a file: ${p}`;
    if (process.platform !== 'win32') {
      try {
        accessSync(p, constants.X_OK);
      } catch {
        return `${source}: not executable: ${p}`;
      }
    }
    return null;
  };

  if (process.env.CHROME_BIN) {
    const problem = validate(process.env.CHROME_BIN, 'CHROME_BIN');
    if (problem) throw new Error(`CHROME_BIN is set but unusable — ${problem}`);
    return process.env.CHROME_BIN;
  }

  const candidates = {
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/opt/google/chrome/chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
  }[process.platform] ?? [];

  for (const c of candidates) {
    if (c && validate(c, 'candidate') === null) return c;
  }
  throw new Error(
    `No Chrome or Chromium found for platform ${process.platform}. ` +
      `Set CHROME_BIN to a browser binary. Tried:\n  ${candidates.join('\n  ')}`
  );
}

/** An OS-assigned free port, so parallel runs cannot collide. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/* ----------------------------------------------------------------- state */

const env = localStatusEnv();
const API_URL = env.API_URL;
const PUBLISHABLE_KEY = env.PUBLISHABLE_KEY || env.ANON_KEY;
const SECRET_KEY = env.SECRET_KEY || env.SERVICE_ROLE_KEY;
if (!SECRET_KEY) throw new Error('No local service key in `supabase status`; cannot create a user.');

const admin = createClient(API_URL, SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let chromeProc = null;
let serverProc = null;
let profileDir = null;
let ws = null;
const createdUsers = [];
let watchdog = null;

/* ------------------------------------------------------------ server */

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // Started detached, so the negative pid signals the whole group: `npm`
      // spawns `next`, and killing only npm leaves the port held.
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

async function startServer(port) {
  // `localhost`, not `127.0.0.1`, and this matters.
  //
  // /auth/signout enforces same-origin: it compares the browser's `Origin`
  // header against `request.nextUrl.origin`. Next resolves that origin as
  // `http://localhost:<port>`, so a browser driven to `http://127.0.0.1:<port>`
  // sends a mismatching Origin and the route correctly answers 403 -- the
  // logout never runs, and the test would be measuring a rejected request.
  const base = `http://localhost:${port}`;
  serverProc = spawn('npm', ['start', '--', '-p', String(port)], {
    cwd: process.cwd(),
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: API_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
      SUPABASE_SECRET_KEY: SECRET_KEY,
      NEXT_PUBLIC_SITE_URL: base,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});

  const deadline = Date.now() + SERVER_START_MS;
  while (Date.now() < deadline) {
    if (serverProc.exitCode !== null) {
      throw new Error(`the server exited early with code ${serverProc.exitCode}`);
    }
    try {
      const r = await fetch(`${base}/login`, { redirect: 'manual' });
      if (r.status > 0) return base;
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  throw new Error(`server did not become ready within ${SERVER_START_MS}ms`);
}

/* ------------------------------------------------------------ chrome/CDP */

let nextId = 0;
const pending = new Map();
let consoleLog = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out`));
    }, 30_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return res.result?.result?.value;
}

/** Poll a JS boolean expression until true, or fail on a bounded deadline. */
async function waitFor(expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true;
    } catch {
      /* page may be mid-navigation */
    }
    await sleep(250);
  }
  console.log(`    (timed out waiting for ${label})`);
  return false;
}

async function startChrome(chromePath) {
  profileDir = mkdtempSync(path.join(tmpdir(), 'kiasa-logout-e2e-'));
  const port = await freePort();

  chromeProc = spawn(
    chromePath,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      // All three are needed together. The homepage lifts its preloader only
      // once an animated loader counter reaches 100%, and that counter runs on
      // a setInterval. Headless Chrome throttles timers in renderers it
      // considers backgrounded or occluded, so with only the first flag the
      // counter crawled and the preloader stayed up past the timeout --
      // intermittently, which is the worst way for it to fail.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  const deadline = Date.now() + CHROME_START_MS;
  let target = null;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  if (!target) throw new Error(`Chrome devtools did not come up within ${CHROME_START_MS}ms`);

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP websocket did not open')), 20_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`CDP websocket error: ${e?.message ?? 'unknown'}`));
    };
  });

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      consoleLog.push(
        'EXCEPTION ' +
          String(d.exception?.description ?? d.text).split('\n')[0].slice(0, 160)
      );
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      consoleLog.push('ERROR ' + m.params.entry.text.slice(0, 160));
    }
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');
}

const unexpected = () => consoleLog.filter((l) => !IGNORED_CONSOLE.test(l));

/* ------------------------------------------------------------ session */

const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_kiasa';

/** `-q` so psql's command tag ("INSERT 0 1") never contaminates captured output. */
const sql = (statement) =>
  execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-qtAc', statement],
    { encoding: 'utf8' }
  ).trim();

async function makeUser() {
  const email = `logout_e2e_${randomUUID().slice(0, 8)}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`could not create the test user: ${error.message}`);
  createdUsers.push(data.user.id);

  // Approve out of band, exactly as the profile suite does. A new account is
  // "pending" and /dashboard sends it to /pending, so without this the test
  // would never reach the protected page it exists to sign out of.
  sql(
    `insert into public.user_access (user_id, status, decided_at)
     values ('${data.user.id}', 'approved', now())
     on conflict (user_id) do update set status = 'approved', decided_at = now()`
  );

  return { email, password, id: data.user.id };
}

/**
 * Sign in for real and return the Supabase cookies a browser would hold.
 *
 * Driving @supabase/ssr rather than hand-rolling the cookie shape: the format
 * is chunked and versioned, and a test that forged its own could pass while
 * real sign-in was broken. This is the same approach the admin and profile
 * HTTP suites use.
 */
async function sessionCookies({ email, password }) {
  const anon = createClient(API_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed: ${error.message}`);

  const jar = new Map();
  const ssr = createServerClient(API_URL, PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value } of list) jar.set(name, value);
      },
    },
  });
  await ssr.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  if (jar.size === 0) throw new Error('no cookies written; the @supabase/ssr contract changed');
  return [...jar.entries()].map(([name, value]) => ({ name, value }));
}

/** Auth cookies currently held by the browser for this origin. */
async function authCookies(base) {
  const res = await send('Network.getCookies', { urls: [base] });
  return (res.result?.cookies ?? []).filter(
    (c) => /^sb-/.test(c.name) && c.value !== ''
  );
}

/* ------------------------------------------------------------ page probes */

const HOME_PROBE = `JSON.stringify((()=>{
  const pre=document.getElementById('preloader');
  const de=document.documentElement;
  return {
    path: location.pathname,
    heroReady: !!window._heroReady,
    lite: de.classList.contains('wt-lite'),
    lenis: de.classList.contains('lenis'),
    preloaderHidden: !pre || (()=>{const c=getComputedStyle(pre);return c.visibility==='hidden'||c.display==='none'||c.opacity==='0';})(),
    preloaderStyle: pre ? (()=>{const c=getComputedStyle(pre);return c.opacity+'/'+c.visibility+'/'+c.display;})() : 'removed',
    loaderProgress: (document.getElementById('loader-progress')||{}).textContent || '(none)',
    loaderBarWidth: (()=>{const b=document.querySelector('.loader-line-inner');return b?getComputedStyle(b).width:'(none)';})(),
    canvases: document.querySelectorAll('canvas').length,
    hamburger: !!document.getElementById('hamburger'),
    links: document.querySelectorAll('a[href^="/"]').length,
    scrollWidth: de.scrollWidth,
    clientWidth: de.clientWidth,
    bodyScrollWidth: document.body.scrollWidth
  };
})())`;

/**
 * The preloader is dismissed by a CSS transition that starts after the hero
 * reports ready, so `_heroReady` alone is not "finished loading".
 *
 * Waited for rather than slept past: a fixed delay is a guess that is either
 * too short (flaky) or too long (slow), and this is a real readiness
 * condition. The wait is bounded, and the assertion still runs afterwards --
 * a preloader that never dismisses still fails.
 */
const PRELOADER_HIDDEN = `(()=>{
  // Mid-navigation there is no #preloader element at all, which would read as
  // "dismissed" and let the wait fall through onto a page that has not started
  // loading yet. Require a settled document first.
  if(document.readyState==='loading') return false;
  const pre=document.getElementById('preloader');
  if(!pre) return true;
  const c=getComputedStyle(pre);
  return c.visibility==='hidden'||c.display==='none'||c.opacity==='0';
})()`;

async function homeState() {
  await waitFor('!!window._heroReady', PAGE_READY_MS, 'window._heroReady');
  await waitFor(PRELOADER_HIDDEN, PRELOADER_MS, 'the preloader to be dismissed');
  await sleep(NAV_SETTLE_MS);
  return JSON.parse(await evaluate(HOME_PROBE));
}

function assertHomeHealthy(prefix, s) {
  check(`${prefix}: landed on /`, s.path === '/', s.path);
  check(`${prefix}: hero initialised`, s.heroReady === true);
  check(`${prefix}: not degraded to wt-lite`, s.lite === false);
  check(
    `${prefix}: preloader dismissed`,
    s.preloaderHidden === true,
    `opacity/visibility/display = ${s.preloaderStyle}, counter = ${s.loaderProgress}, bar = ${s.loaderBarWidth}`
  );
  check(`${prefix}: exactly one canvas`, s.canvases === 1, `saw ${s.canvases}`);
  check(`${prefix}: internal links present`, s.links > 5, `${s.links} links`);
}

/**
 * A MEASURED horizontal-overflow assertion.
 *
 * The predecessor asserted the literal `true` here, so it could never fail and
 * proved nothing. Scrollbars are hidden via --hide-scrollbars, so any excess of
 * scrollWidth over clientWidth is real content overflowing. One pixel of
 * rounding slack, and no more.
 */
function assertNoHorizontalOverflow(prefix, s) {
  const overflow = s.scrollWidth - s.clientWidth;
  check(
    `${prefix}: no horizontal overflow (measured)`,
    overflow <= 1,
    `scrollWidth ${s.scrollWidth} vs clientWidth ${s.clientWidth} (overflow ${overflow}px)`
  );
}

/** Click the application's real sign-out control, not a synthesised form. */
const CLICK_SIGN_OUT = `(()=>{
  const form = document.querySelector('form[action="/auth/signout"]');
  if (!form) return 'no-form';
  const button = form.querySelector('button[type="submit"]');
  if (!button) return 'no-button';
  button.click();
  return 'clicked';
})()`;

/* ----------------------------------------------------------------- main */

async function main() {
  const chromePath = discoverChrome();
  console.log(`Chrome:   ${chromePath}`);
  console.log(`Supabase: ${API_URL}`);

  const port = Number(process.env.LOGOUT_E2E_PORT ?? (await freePort()));
  const BASE = await startServer(port);
  console.log(`Server:   ${BASE}`);
  await startChrome(chromePath);
  console.log(`Profile:  ${profileDir}\n`);

  /* ---------------------------------------------- 1. authenticated session */

  section('1. A real authenticated browser session');
  const user = await makeUser();
  const cookies = await sessionCookies(user);
  check('signing in produced Supabase cookies', cookies.length > 0, `${cookies.length} cookie(s)`);

  for (const c of cookies) {
    await send('Network.setCookie', {
      url: BASE,
      name: c.name,
      value: c.value,
      path: '/',
      httpOnly: false,
      secure: false,
    });
  }
  const held = await authCookies(BASE);
  check('the browser holds the auth cookies', held.length > 0, `${held.length} sb-* cookie(s)`);

  /* --------------------------------------------------- 2. protected route */

  section('2. The protected dashboard serves while signed in');
  consoleLog = [];
  await send('Page.navigate', { url: `${BASE}/dashboard` });
  await waitFor(`location.pathname === '/dashboard'`, PAGE_READY_MS, '/dashboard');
  await sleep(NAV_SETTLE_MS);
  const dashPath = await evaluate('location.pathname');
  check('/dashboard is served, not redirected to /login', dashPath === '/dashboard', String(dashPath));

  const hasSignOut = await evaluate(
    `!!document.querySelector('form[action="/auth/signout"] button[type="submit"]')`
  );
  check('the real sign-out control is present', hasSignOut === true);

  /* ------------------------------------------------------ 3. sign out */

  section('3. Clicking the real sign-out control ends the session');
  consoleLog = [];
  const clicked = await evaluate(CLICK_SIGN_OUT);
  check('the sign-out button was clicked', clicked === 'clicked', String(clicked));

  const home = await homeState();
  check('sign-out lands on the homepage', home.path === '/', home.path);

  const after = await authCookies(BASE);
  check(
    'every Supabase auth cookie is cleared',
    after.length === 0,
    after.length === 0 ? 'no sb-* cookies remain' : after.map((c) => c.name).join(', ')
  );

  const dashAfter = await fetch(`${BASE}/dashboard`, { redirect: 'manual' });
  check(
    '/dashboard redirects once signed out',
    dashAfter.status === 307 || dashAfter.status === 302,
    `status ${dashAfter.status}`
  );
  check(
    'and the redirect target is /login',
    (dashAfter.headers.get('location') ?? '').includes('/login'),
    dashAfter.headers.get('location') ?? '(none)'
  );

  /* ------------------------------------------- 4. homepage after logout */

  section('4. The homepage finishes loading and stays interactive');
  assertHomeHealthy('desktop', home);
  assertNoHorizontalOverflow('desktop', home);

  const scrolled = JSON.parse(
    await evaluate(`(async()=>{
      const before=Math.round(window.scrollY);
      window.scrollTo(0, 1200);
      await new Promise(r=>setTimeout(r,1200));
      return JSON.stringify({before, after: Math.round(window.scrollY)});
    })()`)
  );
  check('the page scrolls', scrolled.after > 100, JSON.stringify(scrolled));

  const menu = JSON.parse(
    await evaluate(`(async()=>{
      const h=document.getElementById('hamburger');
      if(!h) return JSON.stringify({error:'no hamburger'});
      h.click(); await new Promise(r=>setTimeout(r,700));
      const m=document.getElementById('mobile-menu');
      const open=!!m&&(m.classList.contains('open')||document.body.classList.contains('menu-open'));
      h.click(); await new Promise(r=>setTimeout(r,600));
      const closed=!!m&&!m.classList.contains('open')&&!document.body.classList.contains('menu-open');
      return JSON.stringify({open, closed});
    })()`)
  );
  check('the menu opens and closes', menu.open === true && menu.closed === true, JSON.stringify(menu));
  check('no unexpected console errors after sign-out', unexpected().length === 0, unexpected().join(' | '));

  /* -------------------------------------------------- 5. repeated logout */

  section('5. Signing out repeatedly is safe');
  for (let i = 1; i <= 3; i++) {
    consoleLog = [];
    const r = await fetch(`${BASE}/auth/signout`, { method: 'POST', redirect: 'manual' });
    check(`repeat ${i}: POST /auth/signout answers 303`, r.status === 303, `status ${r.status}`);
    check(
      `repeat ${i}: redirects to /`,
      (r.headers.get('location') ?? '').endsWith('/'),
      r.headers.get('location') ?? ''
    );
    check(
      `repeat ${i}: response is no-store`,
      (r.headers.get('cache-control') ?? '').includes('no-store'),
      r.headers.get('cache-control') ?? ''
    );
  }

  /* ------------------------------------------------ 6. back / forward */

  section('6. Back and forward after sign-out');
  await send('Page.navigate', { url: `${BASE}/login` });
  await waitFor(`location.pathname === '/login'`, PAGE_READY_MS, '/login');
  await send('Page.navigate', { url: `${BASE}/` });
  await homeState();

  await evaluate('history.back()');
  await sleep(3000);
  const backPath = await evaluate('location.pathname');
  check('back leaves the homepage', backPath === '/login', String(backPath));

  await evaluate('history.forward()');
  const fwd = await homeState();
  check('forward returns a working homepage', fwd.path === '/' && fwd.heroReady === true,
    JSON.stringify({ path: fwd.path, heroReady: fwd.heroReady, lite: fwd.lite }));
  assertNoHorizontalOverflow('after back/forward', fwd);

  /* ------------------------------------------------------- 7. mobile */

  section('7. Mobile viewport');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  consoleLog = [];
  await send('Page.navigate', { url: `${BASE}/` });
  const mob = await homeState();
  check('mobile homepage healthy', mob.heroReady === true && mob.lite === false,
    JSON.stringify({ heroReady: mob.heroReady, lite: mob.lite }));
  assertNoHorizontalOverflow('mobile', mob);
  check('mobile viewport is 390 wide', mob.clientWidth === 390, `clientWidth ${mob.clientWidth}`);
  check('no unexpected console errors on mobile', unexpected().length === 0, unexpected().join(' | '));
  await send('Emulation.clearDeviceMetricsOverride');
}

/* ---------------------------------------------------------------- cleanup */

async function cleanup() {
  try {
    if (ws && ws.readyState === 1) ws.close();
  } catch { /* best effort */ }

  killTree(chromeProc);
  killTree(serverProc);

  for (const id of createdUsers) {
    try {
      await admin.auth.admin.deleteUser(id);
    } catch { /* best effort */ }
  }

  if (profileDir) {
    // Chrome can hold the profile briefly after exit on Windows.
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(400);
      }
    }
  }
  if (watchdog) clearTimeout(watchdog);
}

/* ------------------------------------------------------------------ run */

watchdog = setTimeout(() => {
  console.error(`\nFATAL: exceeded the ${OVERALL_BUDGET_MS}ms budget; forcing exit.`);
  cleanup().finally(() => process.exit(1));
}, OVERALL_BUDGET_MS);
watchdog.unref?.();

/*
 * Clean up when this process is killed from outside, not only when it fails on
 * its own terms.
 *
 * The `finally` below covers an assertion failure or a thrown error. It does
 * not run when the process is terminated by a signal -- Ctrl-C, a CI job
 * cancellation, a harness timeout -- and that path leaves the spawned Next
 * server alive holding its port. Observed exactly that after an interrupted
 * run: an orphaned `next` process still serving.
 */
let cleaningUp = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => {
    if (cleaningUp) return;
    cleaningUp = true;
    console.error(`\nReceived ${signal}; cleaning up before exiting.`);
    cleanup().finally(() => process.exit(1));
  });
}

let fatal = null;
try {
  await main();
} catch (error) {
  fatal = error;
} finally {
  await cleanup();
}

if (fatal) {
  console.error(`\nFATAL: ${fatal.message}`);
  failed++;
}

console.log('\n========================================================');
if (failed === 0) {
  console.log(`ALL ${passed} LOGOUT E2E CHECKS PASSED`);
  process.exit(0);
}
console.log(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
