/**
 * Authorization tests for the account-approval gate.
 *
 *   supabase start && node scripts/test-user-approval.mjs
 *
 * The question this suite exists to answer is "can a user let themselves in?".
 * Everything else is secondary. Run at the DATABASE level through the
 * publishable key, which is exactly the surface a browser has.
 */
import { execFileSync } from 'node:child_process';

import { statusEnvRaw } from './lib/supabase-cli.mjs';
import { randomUUID, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

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
const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_kiasa';
const sql = (s) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', s], {
    encoding: 'utf8',
  }).trim();

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const anonClient = () => createClient(API_URL, PUBLISHABLE_KEY, opts);
const svcClient = () => createClient(API_URL, SECRET_KEY, opts);

let failed = 0;
let passed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
async function checkRejected(name, promise) {
  const { error } = await promise;
  check(name, Boolean(error), error ? `refused: ${error.code ?? error.message}` : 'NOT REFUSED — this is a hole');
}

const created = [];

async function makeUser() {
  const email = `apprv_${randomUUID().slice(0, 8)}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const client = anonClient();
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw new Error(`signUp failed: ${error.message}`);
  created.push(data.user.id);
  return { id: data.user.id, email, client };
}

async function main() {
  const mallory = await makeUser();
  const other = await makeUser();

  /* ------------------------------------------------------- default state */
  section('A new signup defaults to pending');

  const rowCount = sql(`select count(*) from public.user_access where user_id = '${mallory.id}'`);
  check('a fresh signup has NO user_access row', rowCount === '0', `rows: ${rowCount}`);

  const dirStatus = sql(
    `select access_status from public.admin_user_directory where user_id = '${mallory.id}'`
  );
  check(
    "the directory reports it as 'pending' anyway (absence is the default)",
    dirStatus === 'pending',
    dirStatus
  );

  /* --------------------------------------------------- self-approval ---- */
  section('Self-approval — the whole point of the gate');

  await checkRejected(
    'INSERT of own approved row is refused',
    mallory.client.from('user_access').insert({ user_id: mallory.id, status: 'approved' })
  );

  await checkRejected(
    'UPSERT of own approved row is refused',
    mallory.client.from('user_access').upsert({ user_id: mallory.id, status: 'approved' })
  );

  // Give them a real row, then try to change it from the browser role.
  sql(
    `insert into public.user_access (user_id, status, decided_at, decided_by)
     values ('${mallory.id}', 'rejected', now(), null)`
  );

  await checkRejected(
    'UPDATE of own row from rejected to approved is refused',
    mallory.client.from('user_access').update({ status: 'approved' }).eq('user_id', mallory.id)
  );

  await checkRejected(
    'DELETE of own rejection is refused',
    mallory.client.from('user_access').delete().eq('user_id', mallory.id)
  );

  const stillRejected = sql(
    `select status from public.user_access where user_id = '${mallory.id}'`
  );
  check('the row is still rejected after every attempt', stillRejected === 'rejected', stillRejected);

  /* ---------------------------------------------------------- visibility */
  section('Visibility');

  const own = await mallory.client.from('user_access').select('status').eq('user_id', mallory.id);
  check(
    'a user may read their OWN status (the waiting screen needs it)',
    !own.error && own.data?.length === 1,
    own.error ? own.error.message : `status=${own.data?.[0]?.status}`
  );

  const foreign = await mallory.client
    .from('user_access')
    .select('status')
    .eq('user_id', other.id);
  check(
    "a user cannot read anyone else's status",
    !foreign.error && (foreign.data?.length ?? 0) === 0,
    `${foreign.data?.length ?? 0} row(s)`
  );

  const anon = anonClient();
  const anonRead = await anon.from('user_access').select('status').limit(5);
  check(
    'anonymous cannot read the table at all',
    Boolean(anonRead.error) || (anonRead.data?.length ?? 0) === 0,
    anonRead.error ? `refused: ${anonRead.error.code}` : `${anonRead.data?.length} row(s) LEAKED`
  );

  /* ------------------------------------------------------ admin decision */
  section('An administrator can decide');

  const svc = svcClient();
  const { error: approveError } = await svc.from('user_access').upsert(
    { user_id: mallory.id, status: 'approved', decided_at: new Date().toISOString(), decided_by: other.id },
    { onConflict: 'user_id' }
  );
  check('service_role can approve', !approveError, approveError?.message ?? '');

  const nowApproved = sql(`select status from public.user_access where user_id = '${mallory.id}'`);
  check('the account is approved', nowApproved === 'approved', nowApproved);

  const reasonCleared = sql(
    `select coalesce(reason, 'NULL') from public.user_access where user_id = '${mallory.id}'`
  );
  check('approving carries no reason', reasonCleared === 'NULL', reasonCleared);

  /* -------------------------------------------------------- constraints */
  section('Integrity constraints');

  let pendingWithDecider = false;
  try {
    sql(
      `insert into public.user_access (user_id, status, decided_at)
       values ('${other.id}', 'pending', now())`
    );
  } catch {
    pendingWithDecider = true;
  }
  check('a pending row cannot claim a decision timestamp', pendingWithDecider);

  let approvedWithReason = false;
  try {
    sql(
      `insert into public.user_access (user_id, status, decided_at, reason)
       values ('${other.id}', 'approved', now(), 'why')`
    );
  } catch {
    approvedWithReason = true;
  }
  check('only a rejection may carry a reason', approvedWithReason);

  let badStatus = false;
  try {
    sql(
      `insert into public.user_access (user_id, status, decided_at)
       values ('${other.id}', 'maybe', now())`
    );
  } catch {
    badStatus = true;
  }
  check('an unknown status is refused', badStatus);

  /* ------------------------------------------------------------ backfill */
  section('Backfill and cascade');

  const orphans = sql(
    `select count(*) from auth.users u
     left join public.user_access a on a.user_id = u.id
     where a.user_id is null and u.created_at < (select min(created_at) from auth.users where id = '${mallory.id}')`
  );
  check('no pre-existing account was left without a row', orphans === '0', `orphans: ${orphans}`);

  sql(`delete from auth.users where id = '${mallory.id}'`);
  const afterDelete = sql(`select count(*) from public.user_access where user_id = '${mallory.id}'`);
  check('deleting the account cascades the access row away', afterDelete === '0', afterDelete);
  created.splice(created.indexOf(mallory.id), 1);

  /* -------------------------------------------------------- stats view */
  section('Platform stats expose the queue');

  const pendingCount = sql(`select users_pending_approval from public.admin_platform_stats`);
  check('users_pending_approval is a number', /^\d+$/.test(pendingCount), pendingCount);
}

function cleanup() {
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
