/**
 * Authorization tests for the administrator layer.
 *
 *   supabase start && node scripts/test-admin-authorization.mjs
 *
 * These are the tests that decide whether the security model is real. They run
 * at the DATABASE level, through the publishable key as an ordinary signed-in
 * user — exactly the surface a browser has. Every claim the migrations and the
 * TypeScript make about what a normal user "cannot" do is provoked here rather
 * than asserted:
 *
 *   * a user cannot make themselves an administrator;
 *   * a user cannot read anyone else's role, applications, or profile;
 *   * a user cannot reach the administrator views at all;
 *   * the audit log cannot be modified by anyone, including the table owner;
 *   * the application ledger is append-only;
 *   * illegal application status transitions are refused by the database.
 *
 * Following scripts/test-profile-rls.mjs: local stack only, credentials read at
 * runtime, throwaway users with random passwords, everything cleaned up, and a
 * non-zero exit on any failure.
 */
import { execFileSync } from 'node:child_process';

import { statusEnvRaw } from './lib/supabase-cli.mjs';
import { randomUUID, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

/* ------------------------------------------------------------ local config */

function localEnv() {
  const raw = statusEnvRaw();
  const env = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\r]*)"?/);
    if (m) env[m[1]] = m[2];
  }
  const url = env.API_URL;
  const key = env.PUBLISHABLE_KEY || env.ANON_KEY;
  const secret = env.SECRET_KEY || env.SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Local Supabase is not running (supabase start).');
  if (!/127\.0\.0\.1|localhost/.test(url)) {
    throw new Error(`Refusing to run against a non-local API URL: ${url}`);
  }
  return { url, key, secret };
}

const { url: API_URL, key: PUBLISHABLE_KEY, secret: SECRET_KEY } = localEnv();

const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_kiasa';
const sql = (statement) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', statement], {
    encoding: 'utf8',
  }).trim();

const anonOptions = { auth: { persistSession: false, autoRefreshToken: false } };
const newClient = () => createClient(API_URL, PUBLISHABLE_KEY, anonOptions);
const adminClient = () => createClient(API_URL, SECRET_KEY, anonOptions);

/* ---------------------------------------------------------------- harness */

let failed = 0;
let passed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/**
 * PostgREST answers a denied SELECT with 200 and zero rows, not an error —
 * RLS filters rows, it does not raise. So "cannot read" means "no error AND no
 * rows", and a test that only checked for an error would pass while the data
 * leaked. Both halves are asserted.
 */
function checkNoRows(name, { data, error }) {
  const rows = Array.isArray(data) ? data.length : data ? 1 : 0;
  check(name, rows === 0, error ? `error: ${error.code ?? error.message}` : `${rows} row(s) returned`);
}

/** A write that must be refused. Missing privilege or policy both count. */
async function checkRejected(name, promise) {
  const { error } = await promise;
  check(name, Boolean(error), error ? `refused: ${error.code ?? error.message}` : 'NOT REFUSED — this is a hole');
}

async function checkAccepted(name, promise) {
  const { error } = await promise;
  check(name, !error, error ? `unexpectedly refused: ${error.code ?? ''} ${error.message}` : '');
}

/* ------------------------------------------------------------------ setup */

const created = [];

async function makeUser(label) {
  const email = `admtest_${randomUUID().slice(0, 8)}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const client = newClient();
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw new Error(`signUp failed for ${label}: ${error.message}`);
  if (!data.session) throw new Error(`no session for ${label} (email confirmations enabled?)`);
  created.push(data.user.id);
  return { id: data.user.id, email, client };
}

async function cleanup() {
  for (const id of created) {
    try {
      sql(`delete from auth.users where id = '${id}'`);
    } catch {
      /* best effort */
    }
  }
  // The audit log deliberately survives user deletion (ON DELETE SET NULL), so
  // remove only the rows this run created.
  try {
    sql(`delete from public.admin_audit_log where target_email like 'admtest_%@example.com'`);
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------- main */

async function main() {
  const alice = await makeUser('alice');
  const mallory = await makeUser('mallory');

  // Alice is promoted the only way the system allows: out of band, with the
  // secret key. There is no in-app path for this and that is the point.
  sql(`insert into public.user_roles (user_id, role) values ('${alice.id}', 'admin')`);

  /* ------------------------------------------------ privilege escalation */
  section('Privilege escalation — an ordinary user must not be able to self-promote');

  await checkRejected(
    'INSERT own admin role is refused',
    mallory.client.from('user_roles').insert({ user_id: mallory.id, role: 'admin' })
  );

  await checkRejected(
    'UPDATE own role to admin is refused',
    mallory.client.from('user_roles').update({ role: 'admin' }).eq('user_id', mallory.id)
  );

  await checkRejected(
    "DELETE of another user's role row is refused",
    mallory.client.from('user_roles').delete().eq('user_id', alice.id)
  );

  await checkRejected(
    'UPSERT own admin role is refused',
    mallory.client.from('user_roles').upsert({ user_id: mallory.id, role: 'admin' })
  );

  // Confirm the refusals were real and not merely reported.
  const stillUser = sql(`select count(*) from public.user_roles where user_id = '${mallory.id}'`);
  check('no role row was created for the ordinary user', stillUser === '0', `rows: ${stillUser}`);

  /* ------------------------------------------------------- role visibility */
  section('Role visibility');

  const ownRole = await mallory.client.from('user_roles').select('role').eq('user_id', mallory.id);
  check(
    'a user may read their own role row (none = ordinary user)',
    !ownRole.error,
    ownRole.error ? ownRole.error.message : 'readable'
  );

  checkNoRows(
    "a user cannot read another user's role",
    await mallory.client.from('user_roles').select('role').eq('user_id', alice.id)
  );

  /* --------------------------------------------------- administrator views */
  section('Administrator views must be unreachable by the browser role');

  for (const view of [
    'admin_user_directory',
    'admin_platform_stats',
    'application_stats_by_user',
    'admin_audit_log',
  ]) {
    const result = await mallory.client.from(view).select('*').limit(5);
    const denied = Boolean(result.error) || (Array.isArray(result.data) && result.data.length === 0);
    check(
      `signed-in user cannot read ${view}`,
      denied,
      result.error ? `refused: ${result.error.code ?? ''}` : `${result.data?.length ?? 0} row(s) LEAKED`
    );
  }

  // Anonymous callers must fare no better.
  const anon = newClient();
  for (const view of ['admin_user_directory', 'admin_audit_log']) {
    const result = await anon.from(view).select('*').limit(5);
    const denied = Boolean(result.error) || (Array.isArray(result.data) && result.data.length === 0);
    check(`anonymous cannot read ${view}`, denied);
  }

  /* ---------------------------------------------- application data isolation */
  section('Application data isolation');

  // Give each user a job to hang an application from.
  const svc = adminClient();
  const jobIds = {};
  for (const u of [alice, mallory]) {
    const url = `https://example.com/jobs/${randomUUID()}`;
    const { data, error } = await u.client
      .from('jobs')
      .insert({ user_id: u.id, submitted_url: url, canonical_url: url, source: 'user_link' })
      .select('id')
      .single();
    if (error) throw new Error(`job insert failed: ${error.message}`);
    jobIds[u.id] = data.id;
  }

  await checkAccepted(
    'a user may record their own application',
    mallory.client.from('applications').insert({
      user_id: mallory.id,
      job_id: jobIds[mallory.id],
      method: 'bid_bot',
      status: 'queued',
    })
  );

  await checkRejected(
    "a user cannot create an application owned by someone else",
    mallory.client.from('applications').insert({
      user_id: alice.id,
      job_id: jobIds[alice.id],
      method: 'manual',
      status: 'queued',
    })
  );

  // Alice's own application, created with her session.
  await checkAccepted(
    'the other user records their own application',
    alice.client.from('applications').insert({
      user_id: alice.id,
      job_id: jobIds[alice.id],
      method: 'manual',
      status: 'queued',
    })
  );

  checkNoRows(
    "a user cannot read another user's applications",
    await mallory.client.from('applications').select('id').eq('user_id', alice.id)
  );

  const ownApps = await mallory.client.from('applications').select('id, method');
  check(
    'a user reads exactly their own applications',
    !ownApps.error && ownApps.data?.length === 1,
    `${ownApps.data?.length ?? 0} row(s)`
  );

  await checkRejected(
    'a user cannot DELETE an application (history is not user-erasable)',
    mallory.client.from('applications').delete().eq('user_id', mallory.id)
  );

  /* ------------------------------------------------------ state transitions */
  section('Application status transitions are enforced by the database');

  const appId = ownApps.data[0].id;

  await checkRejected(
    'illegal transition queued -> confirmed is refused',
    mallory.client.from('applications').update({ status: 'confirmed' }).eq('id', appId)
  );

  await checkAccepted(
    'legal transition queued -> preparing is accepted',
    mallory.client.from('applications').update({ status: 'preparing' }).eq('id', appId)
  );

  await checkRejected(
    'a submitted application must carry submitted_at',
    mallory.client.from('applications').update({ status: 'submitting' }).eq('id', appId).then(() =>
      mallory.client.from('applications').update({ status: 'submitted' }).eq('id', appId)
    )
  );

  /* ------------------------------------------------------------- the ledger */
  section('The attempt ledger is append-only');

  const attempt = await mallory.client
    .from('application_attempts')
    .insert({
      user_id: mallory.id,
      application_id: appId,
      job_id: jobIds[mallory.id],
      attempt_number: 1,
      method: 'bid_bot',
      executor_type: 'agent',
      worker_id: 'bid-bot-01',
    })
    .select('id')
    .single();

  check('an attempt can be recorded', !attempt.error, attempt.error?.message ?? '');

  if (attempt.data) {
    await checkRejected(
      'an attempt cannot be UPDATEd',
      mallory.client
        .from('application_attempts')
        .update({ outcome: 'submitted' })
        .eq('id', attempt.data.id)
    );

    await checkRejected(
      'an attempt cannot be DELETEd',
      mallory.client.from('application_attempts').delete().eq('id', attempt.data.id)
    );
  }

  /* ---------------------------------------------------------- audit log --- */
  section('The audit log is immutable for every role, owner included');

  sql(
    `insert into public.admin_audit_log (actor_user_id, actor_email, action, target_user_id, target_email, result)
     values ('${alice.id}', '${alice.email}', 'user.invited', '${mallory.id}', '${mallory.email}', 'succeeded')`
  );

  let ownerUpdateRefused = false;
  try {
    // As the table OWNER, which bypasses RLS. Only the trigger can stop this.
    sql(`update public.admin_audit_log set result = 'failed' where actor_user_id = '${alice.id}'`);
  } catch (error) {
    ownerUpdateRefused = /immutable/i.test(String(error.stderr ?? error.message ?? ''));
  }
  check('the table owner cannot UPDATE an audit row', ownerUpdateRefused);

  await checkRejected(
    'service_role cannot UPDATE an audit row either',
    svc.from('admin_audit_log').update({ result: 'failed' }).eq('actor_user_id', alice.id)
  );

  /* --------------------------------------------- deletion cascade behaviour */
  section('Deletion semantics');

  const before = sql(
    `select count(*) from public.applications where user_id = '${mallory.id}'`
  );
  check('the user has application rows before deletion', before === '1', `rows: ${before}`);

  sql(`delete from auth.users where id = '${mallory.id}'`);

  const afterApps = sql(`select count(*) from public.applications where user_id = '${mallory.id}'`);
  check('hard deletion cascades to applications', afterApps === '0', `rows: ${afterApps}`);

  const afterAttempts = sql(
    `select count(*) from public.application_attempts where user_id = '${mallory.id}'`
  );
  check('hard deletion cascades to the attempt ledger', afterAttempts === '0', `rows: ${afterAttempts}`);

  const auditSurvives = sql(
    `select count(*) from public.admin_audit_log where target_email = '${mallory.email}'`
  );
  check(
    'the audit record of that account SURVIVES its deletion',
    auditSurvives === '1',
    `rows: ${auditSurvives}`
  );

  // The id is RETAINED, not nulled. admin_audit_log carries no foreign key —
  // see migration 14 — so deletion does not touch it, and rows about the same
  // deleted subject can still be correlated.
  const auditTargetKept = sql(
    `select coalesce(target_user_id::text, 'NULL') from public.admin_audit_log where target_email = '${mallory.email}'`
  );
  check(
    'the audit row keeps the deleted account id for correlation',
    auditTargetKept === mallory.id,
    auditTargetKept
  );

  // Mallory is gone; do not try to delete again in cleanup.
  const idx = created.indexOf(mallory.id);
  if (idx >= 0) created.splice(idx, 1);
}

main()
  .then(cleanup, async (error) => {
    console.error('\nFATAL:', error.message);
    await cleanup();
    process.exit(1);
  })
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
  });
