/**
 * HTTP authorization tests for the administrator surface.
 *
 *   npm run build && node scripts/test-admin-api.mjs
 *
 * The database tests in scripts/test-admin-authorization.mjs prove that RLS and
 * grants hold. These prove the HTTP layer in front of them holds too — that
 * `guardApi()` and `requireAdminPage()` actually run, return the right status
 * codes, and cannot be walked past by changing a URL.
 *
 * Sessions are real. Rather than guessing at the cookie format, this drives
 * @supabase/ssr itself with a capturing cookie store, so the Cookie header sent
 * here is byte-identical to what a browser would hold after signing in. A test
 * that forged its own cookie shape could pass while real sign-in was broken.
 *
 * The server is started and stopped by this script. It runs against the LOCAL
 * stack only.
 */
import { execFileSync, spawn } from 'node:child_process';

import { statusEnvRaw } from './lib/supabase-cli.mjs';
import { randomUUID, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';

/* ---------------------------------------------------------------- config */

function localEnv() {
  const raw = statusEnvRaw();
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
const PORT = process.env.ADMIN_TEST_PORT ?? '3199';
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

const sql = (statement) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', statement], {
    encoding: 'utf8',
  }).trim();

/* --------------------------------------------------------------- harness */

let failed = 0;
let passed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ------------------------------------------------------------- sessions */

/**
 * Build the Cookie header a browser would send after this user signs in.
 *
 * @supabase/ssr owns the cookie name, the `base64-` encoding and the chunking
 * threshold. Letting it write into a Map and reading the Map back means this
 * test cannot drift from the real format.
 */
async function cookieHeaderFor(email, password) {
  const plain = createClient(API_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await plain.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);

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

  if (jar.size === 0) throw new Error('no cookies were written; the ssr cookie contract changed');
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

const created = [];

async function makeUser() {
  const email = `apitest_${randomUUID().slice(0, 8)}@example.com`;
  const password = `${randomBytes(18).toString('base64url')}Aa1!`;
  const plain = createClient(API_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await plain.auth.signUp({ email, password });
  if (error) throw new Error(`signUp failed: ${error.message}`);
  created.push(data.user.id);
  return { id: data.user.id, email, password };
}

/* ---------------------------------------------------------------- server */

let server;

async function startServer() {
  server = spawn('npm', ['start', '--', '-p', PORT], {
    cwd: process.cwd(),
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

/* ------------------------------------------------------------- requests */

const req = (path, { cookie, method = 'GET', body } = {}) =>
  fetch(`${BASE}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

/* ------------------------------------------------------------------ main */

async function main() {
  const ordinary = await makeUser();
  const admin = await makeUser();
  sql(`insert into public.user_roles (user_id, role) values ('${admin.id}', 'admin')`);

  console.log('  building session cookies…');
  const userCookie = await cookieHeaderFor(ordinary.email, ordinary.password);
  const adminCookie = await cookieHeaderFor(admin.email, admin.password);

  console.log(`  starting the server on ${BASE} …`);
  await startServer();

  /* ------------------------------------------------------------ anonymous */
  section('Anonymous callers');

  for (const path of [
    '/api/admin/users',
    `/api/admin/users/${admin.id}`,
    `/api/admin/users/${admin.id}/role`,
    '/api/admin/users/invite',
  ]) {
    const r = await req(path);
    check(`GET ${path} is not served to anonymous`, r.status === 401 || r.status === 405, `status ${r.status}`);
  }

  const anonInvite = await req('/api/admin/users/invite', {
    method: 'POST',
    body: { email: 'attacker@example.com' },
  });
  check('anonymous cannot invite', anonInvite.status === 401, `status ${anonInvite.status}`);

  const anonDelete = await req(`/api/admin/users/${ordinary.id}`, {
    method: 'DELETE',
    body: { confirmUserId: ordinary.id },
  });
  check('anonymous cannot delete', anonDelete.status === 401, `status ${anonDelete.status}`);

  // The live-pulse endpoint is polled every few seconds, so it is the most
  // frequently hit admin route by a wide margin. It must be exactly as closed
  // as the rest.
  const anonPulse = await req('/api/admin/pulse');
  check('anonymous cannot read the live pulse', anonPulse.status === 401, `status ${anonPulse.status}`);

  const anonPage = await req('/admin');
  check(
    'anonymous GET /admin redirects to login',
    anonPage.status === 307 && (anonPage.headers.get('location') ?? '').includes('/login'),
    `status ${anonPage.status} -> ${anonPage.headers.get('location')}`
  );

  /* ------------------------------------------------ ordinary signed-in user */
  section('Ordinary signed-in user — authenticated but not authorised');

  const userList = await req('/api/admin/users', { cookie: userCookie });
  check('ordinary user gets 403 from the user list', userList.status === 403, `status ${userList.status}`);

  const listBody = await userList.json().catch(() => ({}));
  check(
    'the 403 body carries no user data',
    !('users' in listBody) && listBody.code === 'forbidden',
    JSON.stringify(listBody).slice(0, 120)
  );

  const userInvite = await req('/api/admin/users/invite', {
    cookie: userCookie,
    method: 'POST',
    body: { email: `escalate_${randomUUID().slice(0, 6)}@example.com` },
  });
  check('ordinary user cannot invite', userInvite.status === 403, `status ${userInvite.status}`);

  const userDelete = await req(`/api/admin/users/${admin.id}`, {
    cookie: userCookie,
    method: 'DELETE',
    body: { confirmUserId: admin.id },
  });
  check('ordinary user cannot delete an administrator', userDelete.status === 403, `status ${userDelete.status}`);

  const userRole = await req(`/api/admin/users/${ordinary.id}/role`, {
    cookie: userCookie,
    method: 'PUT',
    body: { role: 'admin' },
  });
  check(
    'ordinary user cannot grant themselves the admin role over HTTP',
    userRole.status === 403,
    `status ${userRole.status}`
  );

  const escalated = sql(`select count(*) from public.user_roles where user_id = '${ordinary.id}'`);
  check('no role was actually granted', escalated === '0', `rows: ${escalated}`);

  // Self-approval over HTTP — the other half of the gate, tested at the API
  // layer to complement the database-level checks in test-user-approval.mjs.
  const userApprove = await req(`/api/admin/users/${ordinary.id}/access`, {
    cookie: userCookie,
    method: 'PUT',
    body: { status: 'approved' },
  });
  check(
    'ordinary user cannot approve themselves over HTTP',
    userApprove.status === 403,
    `status ${userApprove.status}`
  );

  const selfApproved = sql(
    `select count(*) from public.user_access where user_id = '${ordinary.id}' and status = 'approved'`
  );
  check('no approval was actually granted', selfApproved === '0', `rows: ${selfApproved}`);

  const userPulse = await req('/api/admin/pulse', { cookie: userCookie });
  check('ordinary user cannot read the live pulse', userPulse.status === 403, `status ${userPulse.status}`);

  /* ---------------------------------------------- the candidate's own view */
  section("A candidate's own status endpoint");

  const anonStatus = await req('/api/access/status');
  check('anonymous cannot read an access status', anonStatus.status === 401, `status ${anonStatus.status}`);

  // Reject the ordinary user with a reason, as an administrator would.
  const rejected = await req(`/api/admin/users/${ordinary.id}/access`, {
    cookie: adminCookie,
    method: 'PUT',
    body: { status: 'rejected', reason: 'Not a fit for this cohort.' },
  });
  check('administrator can reject with a reason', rejected.status === 200, `status ${rejected.status}`);

  const ownStatus = await req('/api/access/status', { cookie: userCookie });
  const ownBody = await ownStatus.json().catch(() => ({}));
  check(
    'the candidate can read their OWN status',
    ownStatus.status === 200 && ownBody.status === 'rejected',
    `status ${ownStatus.status} -> ${ownBody.status}`
  );
  check(
    'and is given the reason',
    ownBody.reason === 'Not a fit for this cohort.',
    String(ownBody.reason)
  );

  // The endpoint reads through the caller's own session, so an administrator
  // asking it gets THEIR row, never the person they just rejected.
  const adminOwnStatus = await req('/api/access/status', { cookie: adminCookie });
  const adminOwnBody = await adminOwnStatus.json().catch(() => ({}));
  check(
    'it always answers about the caller, never about anyone else',
    adminOwnStatus.status === 200 && adminOwnBody.status !== 'rejected',
    `admin sees '${adminOwnBody.status}', not the rejected user's status`
  );

  // Put them back, so the later invitation/deletion checks are unaffected.
  await req(`/api/admin/users/${ordinary.id}/access`, {
    cookie: adminCookie,
    method: 'PUT',
    body: { status: 'approved' },
  });

  const userAdminPage = await req('/admin', { cookie: userCookie });
  check(
    'ordinary user is redirected away from /admin',
    userAdminPage.status === 307 && (userAdminPage.headers.get('location') ?? '').includes('/dashboard'),
    `status ${userAdminPage.status} -> ${userAdminPage.headers.get('location')}`
  );

  // IDOR: substituting someone else's id must not help.
  const userOtherDetail = await req(`/admin/users/${admin.id}`, { cookie: userCookie });
  check(
    "ordinary user cannot open another user's detail page",
    userOtherDetail.status === 307,
    `status ${userOtherDetail.status}`
  );

  /* ------------------------------------------------------------ administrator */
  section('Administrator — authorised');

  const adminList = await req('/api/admin/users?page=1&pageSize=5', { cookie: adminCookie });
  check('administrator can list users', adminList.status === 200, `status ${adminList.status}`);

  const adminPulse = await req('/api/admin/pulse', { cookie: adminCookie });
  const pulseBody = await adminPulse.json().catch(() => ({}));
  check(
    'administrator can read the live pulse',
    adminPulse.status === 200 && typeof pulseBody.pulse?.pendingApproval === 'number',
    `status ${adminPulse.status}`
  );
  check(
    'the pulse returns counts only — no personal data',
    !/@|email|user_id/i.test(JSON.stringify(pulseBody)),
    JSON.stringify(pulseBody).slice(0, 120)
  );

  const adminBody = await adminList.json().catch(() => ({}));
  check(
    'the list is paginated and counted',
    adminBody.ok === true &&
      Array.isArray(adminBody.users) &&
      typeof adminBody.pagination?.total === 'number',
    JSON.stringify(adminBody.pagination ?? {}).slice(0, 120)
  );
  check(
    'pageSize is honoured',
    (adminBody.users?.length ?? 0) <= 5,
    `${adminBody.users?.length ?? 0} row(s)`
  );

  const noSecrets = JSON.stringify(adminBody);
  check(
    'no password hash or token appears in the response',
    !/encrypted_password|recovery_token|confirmation_token|refresh_token|access_token/.test(noSecrets),
    ''
  );

  const searched = await req(
    `/api/admin/users?search=${encodeURIComponent(ordinary.email)}`,
    { cookie: adminCookie }
  );
  const searchBody = await searched.json().catch(() => ({}));
  check(
    'search by email finds exactly the one account',
    searched.status === 200 && searchBody.users?.length === 1 && searchBody.users[0].email === ordinary.email,
    `${searchBody.users?.length ?? 0} result(s)`
  );

  // A search string full of PostgREST filter metacharacters must not break the
  // query or widen it — this is the filter-injection case quoteFilterValue exists for.
  const nasty = await req(
    `/api/admin/users?search=${encodeURIComponent('a,b)(c"d\\e')}`,
    { cookie: adminCookie }
  );
  check(
    'a search containing PostgREST metacharacters is handled safely',
    nasty.status === 200,
    `status ${nasty.status}`
  );
  const nastyBody = await nasty.json().catch(() => ({}));
  check(
    'and does not return the whole table',
    (nastyBody.users?.length ?? 0) === 0,
    `${nastyBody.users?.length ?? 0} row(s)`
  );

  const adminPage = await req('/admin', { cookie: adminCookie });
  check('administrator can open /admin', adminPage.status === 200, `status ${adminPage.status}`);

  const adminUsersPage = await req('/admin/users', { cookie: adminCookie });
  check('administrator can open /admin/users', adminUsersPage.status === 200, `status ${adminUsersPage.status}`);

  const adminDetailPage = await req(`/admin/users/${ordinary.id}`, { cookie: adminCookie });
  check(
    "administrator can open another user's detail page",
    adminDetailPage.status === 200,
    `status ${adminDetailPage.status}`
  );

  /* ------------------------------------------------------------ job board */
  section('The job board — a second project, read with its own secret key');

  /*
   * /admin/jobs reads ANOTHER Supabase project's `saved_jobs` with a key that
   * bypasses that project's row-level security. Nothing over there knows what a
   * KIASA administrator is, so the guard on these routes is the only thing
   * between a caller and everybody's saved postings.
   *
   * scripts/test-admin-jobs.mjs proves what the projection does with a row.
   * These prove the door in front of it is shut.
   */

  /*
   * The stream is a long-lived response, so each request to it is aborted the
   * moment its headers arrive — `fetch` resolves on the headers, which is all
   * these checks read. Leaving the body open would hold the connection for the
   * remainder of the run.
   */
  async function openStream(cookie) {
    const controller = new AbortController();
    try {
      const response = await fetch(`${BASE}/api/admin/jobs/stream`, {
        redirect: 'manual',
        headers: cookie ? { cookie } : {},
        signal: controller.signal,
      });
      return { status: response.status, type: response.headers.get('content-type') ?? '' };
    } finally {
      controller.abort();
    }
  }

  const anonJobsPage = await req('/admin/jobs');
  check(
    'anonymous GET /admin/jobs redirects to login',
    anonJobsPage.status === 307 && (anonJobsPage.headers.get('location') ?? '').includes('/login'),
    `status ${anonJobsPage.status} -> ${anonJobsPage.headers.get('location')}`
  );

  const anonJobDetail = await req(`/admin/jobs/${randomUUID()}`);
  check(
    '  and so does a job detail page, whatever id is guessed',
    anonJobDetail.status === 307,
    `status ${anonJobDetail.status}`
  );

  const anonStream = await openStream(null);
  check('anonymous cannot open the live stream', anonStream.status === 401, `status ${anonStream.status}`);
  check(
    '  and is not handed an event stream to sit on',
    !anonStream.type.includes('text/event-stream'),
    anonStream.type || 'no content-type'
  );

  const userJobsPage = await req('/admin/jobs', { cookie: userCookie });
  check(
    'an ordinary signed-in user is redirected away from /admin/jobs',
    userJobsPage.status === 307 &&
      (userJobsPage.headers.get('location') ?? '').includes('/dashboard'),
    `status ${userJobsPage.status} -> ${userJobsPage.headers.get('location')}`
  );

  const userStream = await openStream(userCookie);
  check(
    'an ordinary signed-in user is refused the live stream',
    userStream.status === 403,
    `status ${userStream.status}`
  );
  check(
    '  and is not handed one either',
    !userStream.type.includes('text/event-stream'),
    userStream.type || 'no content-type'
  );

  const adminJobsPage = await req('/admin/jobs', { cookie: adminCookie });
  check(
    'administrator can open /admin/jobs',
    adminJobsPage.status === 200,
    `status ${adminJobsPage.status}`
  );

  /*
   * An administrator gets past the guard. What they meet next depends on
   * whether this deployment holds the job board's credentials — the suite does
   * not set them, so the expected answer is 503 `unconfigured`. Either way, the
   * distinction that matters is that authorization is not what stopped them.
   */
  const adminStream = await openStream(adminCookie);
  check(
    'an administrator is not refused by the guard',
    adminStream.status !== 401 && adminStream.status !== 403,
    `status ${adminStream.status}`
  );
  check(
    '  and meets either a live stream or an honest "not configured"',
    adminStream.status === 503 || adminStream.type.includes('text/event-stream'),
    `status ${adminStream.status}, ${adminStream.type || 'no content-type'}`
  );

  /* ------------------------------------------------- the second gate */
  section('The job board grant — a second permission, separately guarded');

  /*
   * Approving an account and granting the job board are different decisions
   * writing different tables. These prove the second one is a real gate over
   * HTTP: that nobody can grant themselves, that an approved candidate does not
   * get the board for free, and that /job-board refuses without it.
   */

  const anonGrant = await req(`/api/admin/users/${ordinary.id}/job-board`, {
    method: 'PUT',
    body: { status: 'granted' },
  });
  check('anonymous cannot grant the job board', anonGrant.status === 401, `status ${anonGrant.status}`);

  const selfGrant = await req(`/api/admin/users/${ordinary.id}/job-board`, {
    cookie: userCookie,
    method: 'PUT',
    body: { status: 'granted' },
  });
  check(
    'an ordinary user cannot grant themselves the job board',
    selfGrant.status === 403,
    `status ${selfGrant.status}`
  );

  const grantedRows = sql(
    `select count(*) from public.job_board_access where user_id = '${ordinary.id}'`
  );
  check('and no grant was written', grantedRows === '0', `rows: ${grantedRows}`);

  /*
   * THE HEART OF IT. This account is APPROVED — the checks above put it back to
   * approved — and still must not see the board, because approval is the first
   * gate and this is the second.
   */
  const boardBeforeGrant = await req('/job-board', { cookie: userCookie });
  const beforeBody = boardBeforeGrant.status === 200 ? await boardBeforeGrant.text() : '';
  check(
    'an approved candidate without the grant does not get the board',
    boardBeforeGrant.status === 307 || /do not have access to the job board/i.test(beforeBody),
    `status ${boardBeforeGrant.status}`
  );
  check(
    '  and no posting data is in that response',
    !/opportunities<\/|kjb__rows/.test(beforeBody),
    'a locked panel, not a hidden list'
  );

  const anonBoard = await req('/job-board');
  check(
    'anonymous is bounced from /job-board to login',
    anonBoard.status === 307 && (anonBoard.headers.get('location') ?? '').includes('/login'),
    `status ${anonBoard.status} -> ${anonBoard.headers.get('location')}`
  );

  const badStatus = await req(`/api/admin/users/${ordinary.id}/job-board`, {
    cookie: adminCookie,
    method: 'PUT',
    body: { status: 'approved' },
  });
  check(
    'a status from the OTHER gate’s vocabulary is rejected',
    badStatus.status === 400,
    `status ${badStatus.status}`
  );

  const granted = await req(`/api/admin/users/${ordinary.id}/job-board`, {
    cookie: adminCookie,
    method: 'PUT',
    body: { status: 'granted' },
  });
  check('an administrator can grant it', granted.status === 200, `status ${granted.status}`);

  const grantedRow = sql(
    `select status from public.job_board_access where user_id = '${ordinary.id}'`
  );
  check('and the row says granted', grantedRow === 'granted', `status: ${grantedRow}`);

  // Granting the board must not have touched the account-approval gate.
  const accessUntouched = sql(
    `select status from public.user_access where user_id = '${ordinary.id}'`
  );
  check(
    'the two gates are independent — approval was not rewritten',
    accessUntouched === 'approved',
    `user_access: ${accessUntouched}`
  );

  const boardAfterGrant = await req('/job-board', { cookie: userCookie });
  check(
    'and now the candidate reaches the board',
    boardAfterGrant.status === 200,
    `status ${boardAfterGrant.status}`
  );

  const revoked = await req(`/api/admin/users/${ordinary.id}/job-board`, {
    cookie: adminCookie,
    method: 'PUT',
    body: { status: 'revoked' },
  });
  check('it can be revoked again', revoked.status === 200, `status ${revoked.status}`);
  check(
    '  and the row is kept rather than deleted',
    sql(`select status from public.job_board_access where user_id = '${ordinary.id}'`) === 'revoked',
    'a withdrawn grant is history, not an absence'
  );

  const grantAudit = sql(
    `select count(*) from public.admin_audit_log ` +
      `where action in ('user.job_board_granted', 'user.job_board_revoked')`
  );
  check('both decisions were audited', Number(grantAudit) >= 2, `${grantAudit} row(s)`);

  /* ---------------------------------------------------- destructive guards */
  section('Deletion guards');

  const badUuid = await req('/api/admin/users/not-a-uuid', {
    cookie: adminCookie,
    method: 'DELETE',
    body: { confirmUserId: 'not-a-uuid' },
  });
  check('a malformed user id is rejected', badUuid.status === 400, `status ${badUuid.status}`);

  const noConfirm = await req(`/api/admin/users/${ordinary.id}`, {
    cookie: adminCookie,
    method: 'DELETE',
    body: {},
  });
  check('deletion without confirmation is refused', noConfirm.status === 400, `status ${noConfirm.status}`);

  const mismatched = await req(`/api/admin/users/${ordinary.id}`, {
    cookie: adminCookie,
    method: 'DELETE',
    body: { confirmUserId: admin.id },
  });
  check(
    'deletion with a mismatched confirmation id is refused',
    mismatched.status === 400,
    `status ${mismatched.status}`
  );

  const stillThere = sql(`select count(*) from auth.users where id = '${ordinary.id}'`);
  check('the account survived all refused deletions', stillThere === '1', `rows: ${stillThere}`);

  const self = await req(`/api/admin/users/${admin.id}`, {
    cookie: adminCookie,
    method: 'DELETE',
    body: { confirmUserId: admin.id },
  });
  check('an administrator cannot delete their own account', self.status === 409, `status ${self.status}`);

  /* ------------------------------------------------------------- invitation */
  section('Invitation');

  const inviteEmail = `invited_${randomUUID().slice(0, 8)}@example.com`;
  const invited = await req('/api/admin/users/invite', {
    cookie: adminCookie,
    method: 'POST',
    body: { email: inviteEmail },
  });
  check('administrator can invite a new address', invited.status === 201, `status ${invited.status}`);

  const invitedBody = await invited.json().catch(() => ({}));
  if (invitedBody?.user?.id) created.push(invitedBody.user.id);

  const duplicate = await req('/api/admin/users/invite', {
    cookie: adminCookie,
    method: 'POST',
    body: { email: inviteEmail },
  });
  const dupBody = await duplicate.json().catch(() => ({}));
  check(
    'inviting the same address again is handled gracefully (resend, not error)',
    duplicate.status === 201 && dupBody.resent === true,
    `status ${duplicate.status} resent=${dupBody.resent}`
  );

  const existing = await req('/api/admin/users/invite', {
    cookie: adminCookie,
    method: 'POST',
    body: { email: ordinary.email },
  });
  check(
    'inviting an already-active account is refused with 409',
    existing.status === 409,
    `status ${existing.status}`
  );

  const badEmail = await req('/api/admin/users/invite', {
    cookie: adminCookie,
    method: 'POST',
    body: { email: 'not-an-email' },
  });
  check('an invalid address is rejected', badEmail.status === 400, `status ${badEmail.status}`);

  /* ------------------------------------------------------------------ audit */
  section('Audit trail was written');

  const auditRows = sql(
    `select count(*) from public.admin_audit_log where actor_user_id = '${admin.id}'`
  );
  check('privileged actions were audited', Number(auditRows) >= 3, `${auditRows} row(s)`);

  const failedAudited = sql(
    `select count(*) from public.admin_audit_log where actor_user_id = '${admin.id}' and result = 'failed'`
  );
  check(
    'refused actions were audited too, not just successful ones',
    Number(failedAudited) >= 1,
    `${failedAudited} row(s)`
  );

  const secretsInAudit = sql(
    `select count(*) from public.admin_audit_log where detail::text ~* '(password|secret|token|api_key)'`
  );
  check('no secret-shaped key reached the audit detail', secretsInAudit === '0', `${secretsInAudit} row(s)`);
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
  try {
    sql(`delete from public.admin_audit_log where target_email like '%@example.com'`);
  } catch {
    /* best effort */
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
