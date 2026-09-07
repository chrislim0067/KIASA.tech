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
import { randomUUID, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';

/* ---------------------------------------------------------------- config */

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

const { url: API_URL, key: PUBLISHABLE_KEY } = localEnv();
const PORT = process.env.ADMIN_TEST_PORT ?? '3199';
const BASE = `http://127.0.0.1:${PORT}`;
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
    env: { ...process.env, PORT },
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
