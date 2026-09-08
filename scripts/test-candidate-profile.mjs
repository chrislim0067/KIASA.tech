/**
 * The candidate profile gate, over HTTP.
 *
 *   npm run build && node scripts/test-candidate-profile.mjs
 *
 * The database-level rules are already covered by test-profile-rls.mjs (RLS)
 * and test-user-approval.mjs (self-approval). What is new here is the ROUTE
 * gate: an approved candidate reaches /profile, a pending one does not, and an
 * anonymous one does not. Sessions are real — driven through @supabase/ssr, so
 * the Cookie header is byte-identical to a browser's.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';

function localEnv() {
  const raw = execFileSync('npx', ['supabase', 'status', '-o', 'env'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const env = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\r]*)"?/);
    if (m) env[m[1]] = m[2];
  }
  if (!env.API_URL || !/127\.0\.0\.1|localhost/.test(env.API_URL)) {
    throw new Error('Local Supabase is not running, or the API URL is not local.');
  }
  return {
    url: env.API_URL,
    key: env.PUBLISHABLE_KEY || env.ANON_KEY,
    secret: env.SECRET_KEY || env.SERVICE_ROLE_KEY,
  };
}

const { url: API_URL, key: PUBLISHABLE_KEY, secret: SECRET_KEY } = localEnv();
const PORT = process.env.PROFILE_TEST_PORT ?? '3197';
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * The environment the spawned Next server needs.
 *
 * Every value comes from `supabase status` on the LOCAL stack, which this
 * file has already refused to run without. Passing them explicitly is what
 * lets the suite run on a clean checkout and in CI: inheriting only
 * process.env meant the server started with no Supabase configuration at
 * all, the admin surface answered 503 to everything, and the suite could
 * only pass on a machine that happened to have a hand-made .env.local.
 */
const SERVER_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: API_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
  SUPABASE_SECRET_KEY: SECRET_KEY,
  NEXT_PUBLIC_SITE_URL: BASE,
};
const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_kiasa';

const sql = (s) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', s], {
    encoding: 'utf8',
  }).trim();

let failed = 0;
let passed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const created = [];

async function makeUser() {
  const email = `prof_${randomUUID().slice(0, 8)}@example.com`;
  const password = `${randomBytes(18).toString('base64url')}Aa1!`;
  const plain = createClient(API_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await plain.auth.signUp({ email, password });
  if (error) throw new Error(`signUp failed: ${error.message}`);
  created.push(data.user.id);
  return { id: data.user.id, email, password };
}

async function cookieFor(email, password) {
  const plain = createClient(API_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await plain.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed: ${error.message}`);

  const jar = new Map();
  const ssr = createServerClient(API_URL, PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (l) => l.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  await ssr.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  return [...jar.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
}

let server;

async function startServer() {
  server = spawn('npm', ['start', '--', '-p', PORT], {
    shell: process.platform === 'win32',
    env: { ...process.env, ...SERVER_ENV, PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/login`, { redirect: 'manual' });
      if (r.status > 0) return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`server did not become ready on ${BASE}`);
}

function stopServer() {
  if (!server) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-server.pid, 'SIGTERM');
    }
  } catch {
    server.kill('SIGKILL');
  }
}

const req = (path, cookie) =>
  fetch(`${BASE}${path}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });

const PAGES = [
  '/profile',
  '/profile/about',
  '/profile/authorization',
  '/profile/experience',
  '/profile/preferences',
  '/profile/skills',
];

async function main() {
  const pending = await makeUser();
  const approved = await makeUser();

  // Approve one of them the only way the system allows — out of band.
  sql(
    `insert into public.user_access (user_id, status, decided_at)
     values ('${approved.id}', 'approved', now())
     on conflict (user_id) do update set status = 'approved', decided_at = now()`
  );
  // and make sure the other really is pending.
  sql(`delete from public.user_access where user_id = '${pending.id}'`);

  const pendingCookie = await cookieFor(pending.email, pending.password);
  const approvedCookie = await cookieFor(approved.email, approved.password);

  console.log(`  starting the server on ${BASE} …`);
  await startServer();

  section('Anonymous');
  for (const page of PAGES) {
    const r = await req(page);
    const loc = r.headers.get('location') ?? '';
    check(`${page} redirects to login`, r.status === 307 && loc.includes('/login'), `status ${r.status}`);
  }

  section('Signed in but NOT approved');
  for (const page of PAGES) {
    const r = await req(page, pendingCookie);
    const loc = r.headers.get('location') ?? '';
    check(
      `${page} redirects to /pending`,
      r.status === 307 && loc.includes('/pending'),
      `status ${r.status} -> ${loc}`
    );
  }

  section('Approved candidate');
  for (const page of PAGES) {
    const r = await req(page, approvedCookie);
    check(`${page} is served`, r.status === 200, `status ${r.status}`);
  }

  section('The profile row is created on first visit');
  const profileRows = sql(
    `select count(*) from public.profiles where user_id = '${approved.id}'`
  );
  check('ensureProfile created the row', profileRows === '1', `rows: ${profileRows}`);

  const pendingProfile = sql(
    `select count(*) from public.profiles where user_id = '${pending.id}'`
  );
  check(
    'and NOT for the unapproved user, who never reached the page',
    pendingProfile === '0',
    `rows: ${pendingProfile}`
  );

  section('The hub reports what is still missing');
  const hub = await req('/profile', approvedCookie);
  // React inserts an empty comment between adjacent expressions when it
  // server-renders, so `{doneCount} of {requiredSteps.length} required` arrives
  // as `0<!-- --> of <!-- -->4 required`. Strip those separators before matching
  // text, or every assertion about rendered copy breaks on markup React chose.
  const html = (await hub.text()).split('<!-- -->').join('');
  check('a fresh profile is not reported as ready', !/Your profile is ready/.test(html));
  check('the required-step count is shown', /of 4 required/.test(html), 'expected "0 of 4 required"');
  check(
    'work authorisation is called unknown, never "not authorised"',
    !/not authorised/i.test(html) || /treated as unknown/i.test(html)
  );
}

function cleanup() {
  stopServer();
  for (const id of created) {
    try {
      sql(`delete from auth.users where id = '${id}'`);
    } catch {
      /* best effort */
    }
  }
}

main()
  .then(cleanup, (error) => {
    console.error('\nFATAL:', error.message);
    cleanup();
    process.exit(1);
  })
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
  });
