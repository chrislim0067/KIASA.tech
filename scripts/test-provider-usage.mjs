/**
 * The provider_usage table: privacy, isolation and immutability.
 *
 *   supabase start && node scripts/test-provider-usage.mjs
 *
 * Run at the DATABASE level through the publishable key, which is exactly the
 * surface a browser has. Throwaway users only; every one is deleted afterwards.
 *
 * WHAT THIS SUITE IS FOR
 *
 * `provider_usage` records what an AI call cost and how it went. The one thing
 * this platform sends to a third party is the text of somebody's résumé, and a
 * usage table is exactly the well-meaning "just for debugging" surface that
 * ends up holding a copy of it. So the first section asserts, against the
 * catalogue rather than by reading the migration, that there is nowhere on this
 * table to put a prompt, a completion, a résumé or a key — no free-text column,
 * no jsonb, nothing.
 *
 * The rest is the ordinary boundary: a candidate may read their own rows and
 * nobody else's, may not write one, and nobody may edit or delete one, because
 * a cost record that can be changed is not a cost record.
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

/** `-q` so psql's command tag never contaminates a captured value. */
const sql = (s) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-qtAc', s], {
    encoding: 'utf8',
  }).trim();

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const anonClient = () => createClient(API_URL, PUBLISHABLE_KEY, opts);
const svcClient = () => createClient(API_URL, SECRET_KEY, opts);

let failed = 0;
let passed = 0;
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

const created = [];

async function makeUser() {
  const admin = svcClient();
  const email = `usage_${randomUUID().slice(0, 8)}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`could not create a test user: ${error.message}`);
  created.push(data.user.id);
  return { id: data.user.id, email, password };
}

async function sessionFor({ email, password }) {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed: ${error.message}`);
  const signed = createClient(API_URL, PUBLISHABLE_KEY, opts);
  await signed.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  return signed;
}

/** Insert a successful usage row for `userId`, the way the server would. */
function insertUsage(userId) {
  return sql(
    `insert into public.provider_usage
       (user_id, provider, model, operation, status, latency_ms, attempts,
        prompt_tokens, completion_tokens, total_tokens, cost_usd, provider_request_id)
     values ('${userId}', 'openrouter', 'google/gemini-2.5-flash', 'resume_extraction',
             'succeeded', 1234, 1, 900, 300, 1200, 0.000310, 'gen-${randomUUID().slice(0, 8)}')
     returning id`
  );
}

async function main() {
  /* ------------------------------------------------ 1. the privacy rule */

  section('1. There is nowhere to put candidate content');

  const columns = sql(
    `select string_agg(column_name || ':' || data_type, ', ' order by ordinal_position)
     from information_schema.columns
     where table_schema = 'public' and table_name = 'provider_usage'`
  );
  check('the table exists', columns.length > 0, columns.slice(0, 80) + '…');

  const contentColumns = sql(
    `select coalesce(string_agg(column_name, ', '), '')
     from information_schema.columns
     where table_schema = 'public' and table_name = 'provider_usage'
       and column_name in ('prompt','system','user_prompt','messages','input','output',
                           'completion','response','text','resume','resume_text','extracted',
                           'content','detail','payload','api_key','authorization','headers')`
  );
  check('no content-bearing column exists', contentColumns === '', contentColumns);

  const jsonColumns = sql(
    `select coalesce(string_agg(column_name, ', '), '')
     from information_schema.columns
     where table_schema = 'public' and table_name = 'provider_usage'
       and data_type in ('json', 'jsonb')`
  );
  check('no json column exists to hide a prompt in', jsonColumns === '', jsonColumns);

  const freeText = sql(
    `select coalesce(string_agg(column_name, ', '), '')
     from information_schema.columns
     where table_schema = 'public' and table_name = 'provider_usage'
       and data_type = 'text'
       and column_name not in ('provider','model','operation','status','failure_class',
                               'failure_code','provider_request_id')`
  );
  check('every text column is a known, bounded field', freeText === '', freeText);

  /* --------------------------------------------------- 2. RLS and grants */

  section('2. RLS, grants and isolation');

  const rls = sql(
    `select c.relrowsecurity || '/' || c.relforcerowsecurity
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'provider_usage'`
  );
  check('RLS is enabled and forced', rls === 't/t', rls);

  const anonGrants = sql(
    `select coalesce(string_agg(distinct grantee || ':' || privilege_type, ', '), 'none')
     from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'provider_usage'
       and grantee in ('anon', 'PUBLIC')`
  );
  check('anon and PUBLIC hold nothing', anonGrants === 'none', anonGrants);

  const authGrants = sql(
    `select coalesce(string_agg(distinct privilege_type, ', ' order by privilege_type), 'none')
     from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'provider_usage' and grantee = 'authenticated'`
  );
  check('authenticated holds SELECT only', authGrants === 'SELECT', authGrants);

  const svcGrants = sql(
    `select coalesce(string_agg(distinct privilege_type, ', ' order by privilege_type), 'none')
     from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'provider_usage' and grantee = 'service_role'`
  );
  check('service_role holds SELECT and INSERT only', svcGrants === 'INSERT, SELECT', svcGrants);

  const alice = await makeUser();
  const bob = await makeUser();
  const aliceRow = insertUsage(alice.id);
  insertUsage(bob.id);
  check('the server can record usage', /^[0-9a-f-]{36}$/.test(aliceRow), aliceRow);

  const aliceSession = await sessionFor(alice);
  const own = await aliceSession.from('provider_usage').select('id, model, cost_usd');
  check('the owner sees their own usage', !own.error && own.data?.length === 1,
    own.error?.message ?? `rows: ${own.data?.length}`);
  check('  including the cost', !own.error && own.data?.[0]?.cost_usd !== undefined);

  const other = await aliceSession.from('provider_usage').select('id').neq('user_id', alice.id);
  check('another candidate’s usage is invisible', !other.error && other.data?.length === 0,
    `rows: ${other.data?.length}`);

  const anon = anonClient();
  const anonRead = await anon.from('provider_usage').select('id');
  check('an anonymous caller sees nothing',
    Boolean(anonRead.error) || anonRead.data?.length === 0,
    anonRead.error?.code ?? `rows: ${anonRead.data?.length}`);

  /* ------------------------------------------------ 3. clients cannot write */

  section('3. A browser cannot write, edit or delete a cost record');

  const insert = await aliceSession.from('provider_usage').insert({
    user_id: alice.id,
    provider: 'openrouter',
    model: 'free/everything',
    operation: 'resume_extraction',
    status: 'succeeded',
    latency_ms: 1,
    attempts: 1,
  });
  check('the owner cannot insert usage', Boolean(insert.error), insert.error?.code ?? 'ACCEPTED');

  const update = await aliceSession
    .from('provider_usage')
    .update({ cost_usd: 0 })
    .eq('id', aliceRow)
    .select();
  check('the owner cannot rewrite the cost',
    Boolean(update.error) || update.data?.length === 0,
    update.error?.code ?? `rows: ${update.data?.length}`);

  const del = await aliceSession.from('provider_usage').delete().eq('id', aliceRow).select();
  check('the owner cannot delete a record',
    Boolean(del.error) || del.data?.length === 0,
    del.error?.code ?? `rows: ${del.data?.length}`);

  // Even the elevated role, which holds BYPASSRLS, is stopped by the trigger.
  let updateBlocked = false;
  try {
    sql(`update public.provider_usage set cost_usd = 0 where id = '${aliceRow}'`);
  } catch {
    updateBlocked = true;
  }
  check('even service_role cannot update a row (trigger, not grant)', updateBlocked);

  let deleteBlocked = false;
  try {
    sql(`delete from public.provider_usage where id = '${aliceRow}'`);
  } catch {
    deleteBlocked = true;
  }
  check('even service_role cannot delete a row', deleteBlocked);

  /* ------------------------------------------------------ 4. constraints */

  section('4. The constraints refuse nonsense');

  const refuses = (label, statement) => {
    let blocked = false;
    try {
      sql(statement);
    } catch {
      blocked = true;
    }
    check(label, blocked);
  };

  const base = (extra) =>
    `insert into public.provider_usage (user_id, provider, model, operation, status, latency_ms, attempts${extra.cols})
     values ('${alice.id}', ${extra.vals})`;

  refuses('an unknown provider is refused',
    base({ cols: '', vals: `'anthropic', 'm', 'resume_extraction', 'succeeded', 1, 1` }));
  refuses('an unknown operation is refused',
    base({ cols: '', vals: `'openrouter', 'm', 'job_scoring', 'succeeded', 1, 1` }));
  refuses('an unknown status is refused',
    base({ cols: '', vals: `'openrouter', 'm', 'resume_extraction', 'maybe', 1, 1` }));
  refuses('negative latency is refused',
    base({ cols: '', vals: `'openrouter', 'm', 'resume_extraction', 'succeeded', -1, 1` }));
  refuses('a negative cost is refused',
    base({ cols: ', cost_usd', vals: `'openrouter', 'm', 'resume_extraction', 'succeeded', 1, 1, -0.5` }));
  refuses('a failure without a class is refused',
    base({ cols: '', vals: `'openrouter', 'm', 'resume_extraction', 'failed', 1, 1` }));
  refuses('a success carrying a failure class is refused',
    base({ cols: ', failure_class', vals: `'openrouter', 'm', 'resume_extraction', 'succeeded', 1, 1, 'timeout'` }));
  refuses('an unattempted call that reports tokens is refused',
    base({ cols: ', total_tokens', vals: `'openrouter', 'm', 'resume_extraction', 'not_attempted', 1, 0, 500` }));
  refuses('an unattempted call with attempts > 0 is refused',
    base({ cols: '', vals: `'openrouter', 'm', 'resume_extraction', 'not_attempted', 1, 3` }));

  // And the shapes that must be accepted.
  const failedRow = sql(
    `insert into public.provider_usage
       (user_id, provider, model, operation, status, failure_class, failure_code, latency_ms, attempts)
     values ('${alice.id}', 'openrouter', 'google/gemini-2.5-flash', 'resume_extraction',
             'failed', 'timeout', 'timeout', 90000, 2)
     returning id`
  );
  check('a classified failure is accepted', /^[0-9a-f-]{36}$/.test(failedRow));

  const refusedRow = sql(
    `insert into public.provider_usage
       (user_id, provider, model, operation, status, failure_class, failure_code, latency_ms, attempts)
     values (null, 'openrouter', 'unknown', 'resume_extraction',
             'not_attempted', 'model_error', 'not_configured', 0, 0)
     returning id`
  );
  check('a not_attempted call with no user is accepted', /^[0-9a-f-]{36}$/.test(refusedRow),
    'accounting outlives the account');

  /* ------------------------------------------- 5. deleting an account */

  section('5. Deleting an account keeps the accounting');

  const before = sql(`select count(*) from public.provider_usage where user_id = '${bob.id}'`);
  const admin = svcClient();
  await admin.auth.admin.deleteUser(bob.id);
  created.splice(created.indexOf(bob.id), 1);
  const orphaned = sql(
    `select count(*) from public.provider_usage where user_id is null and provider_request_id is not null`
  );
  check('the row survives the user', before === '1' && Number(orphaned) >= 1,
    `before ${before}, orphaned ${orphaned}`);
}

async function cleanup() {
  const admin = svcClient();
  for (const id of created) {
    try {
      await admin.auth.admin.deleteUser(id);
    } catch {
      /* best effort */
    }
  }
  // Usage rows are append-only by design, so the throwaway rows are left in
  // place with a null user. They carry no candidate data.
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
  console.log(`ALL ${passed} PROVIDER-USAGE CHECKS PASSED`);
  process.exit(0);
}
console.log(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
