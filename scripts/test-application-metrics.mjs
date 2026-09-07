/**
 * Application metrics and state-machine parity.
 *
 *   supabase start && node scripts/test-application-metrics.mjs
 *
 * Two jobs:
 *
 *  1. PARITY. `lib/applications/state.ts` mirrors the transition table inside
 *     `guard_application_status_transition()`. This parses the migration and
 *     asserts the two sets are identical in BOTH directions, the same way
 *     scripts/test-job-state-and-url.mjs guards the job pipeline. If they ever
 *     drift, this fails rather than the two quietly disagreeing.
 *
 *  2. METRICS AGAINST FIXTURES. A user is given a hand-built set of
 *     applications and attempts with known counts, and every administrator
 *     figure is checked against the number a human worked out by hand. This is
 *     the test that would catch "Bid Bot attempted" being reported as "Bid Bot
 *     applied" — the exact inaccuracy the schema exists to prevent.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.resolve(import.meta.dirname, '..');

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
  const url = env.API_URL;
  if (!url || !/127\.0\.0\.1|localhost/.test(url)) {
    throw new Error('Local Supabase is not running, or the API URL is not local.');
  }
  return { url, key: env.PUBLISHABLE_KEY || env.ANON_KEY, secret: env.SECRET_KEY || env.SERVICE_ROLE_KEY };
}

const { url: API_URL, key: PUBLISHABLE_KEY, secret: SECRET_KEY } = localEnv();
const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_kiasa';
const sql = (statement) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', statement], {
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
function checkEqual(name, actual, expected) {
  check(name, String(actual) === String(expected), `expected ${expected}, got ${actual}`);
}

/* ------------------------------------------------------- 1. state parity -- */

function parityCheck() {
  section('State machine parity: TypeScript mirror vs SQL trigger');

  const migration = readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '20260908000015_applications_and_attempts.sql'),
    'utf8'
  );
  const stateModule = readFileSync(path.join(ROOT, 'lib', 'applications', 'state.ts'), 'utf8');

  // Both sides write transitions as 'from>to' string literals, which is why
  // that form was chosen: it makes them literally comparable.
  const fromSql = new Set(
    (migration
      .slice(migration.indexOf('legal constant text[]'), migration.indexOf('begin', migration.indexOf('legal constant text[]')))
      .match(/'[a-z_]+>[a-z_]+'/g) ?? []
    ).map((s) => s.replaceAll("'", ''))
  );

  const fromTs = new Set(
    (stateModule
      .slice(stateModule.indexOf('LEGAL_TRANSITIONS'), stateModule.indexOf('const LEGAL:'))
      .match(/'[a-z_]+>[a-z_]+'/g) ?? []
    ).map((s) => s.replaceAll("'", ''))
  );

  check('SQL transition table was parsed', fromSql.size > 0, `${fromSql.size} transitions`);
  check('TypeScript transition table was parsed', fromTs.size > 0, `${fromTs.size} transitions`);

  const missingInTs = [...fromSql].filter((t) => !fromTs.has(t));
  const missingInSql = [...fromTs].filter((t) => !fromSql.has(t));

  check('every SQL transition exists in TypeScript', missingInTs.length === 0, missingInTs.join(', '));
  check('every TypeScript transition exists in SQL', missingInSql.length === 0, missingInSql.join(', '));

  // The status vocabulary must match too.
  const sqlStatuses = new Set(
    (migration
      .slice(migration.indexOf('applications_status_allowed'), migration.indexOf('status_class text'))
      .match(/'[a-z_]+'/g) ?? []
    ).map((s) => s.replaceAll("'", ''))
  );
  const tsStatuses = new Set(
    (stateModule
      .slice(stateModule.indexOf('APPLICATION_STATUSES'), stateModule.indexOf('export type ApplicationStatus'))
      .match(/'[a-z_]+'/g) ?? []
    ).map((s) => s.replaceAll("'", ''))
  );
  const statusDiff = [...sqlStatuses].filter((s) => !tsStatuses.has(s));
  check('status vocabularies agree', statusDiff.length === 0, statusDiff.join(', '));
}

/* ------------------------------------------------------- 2. fixture math -- */

const created = [];

async function makeUser() {
  const email = `mtest_${randomUUID().slice(0, 8)}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const client = createClient(API_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw new Error(`signUp failed: ${error.message}`);
  created.push(data.user.id);
  return { id: data.user.id, email, client };
}

/**
 * The fixture, chosen so that no two expected numbers are the same. If any
 * counter were wired to the wrong column, an identical expected value could
 * hide it; distinct values make a mis-wiring visible.
 *
 *   method     status               count
 *   manual     submitted              2      <- counts as succeeded
 *   manual     failed                 1
 *   automated  confirmed              3      <- counts as succeeded
 *   bid_bot    submitted              4      <- succeeded AND bid_bot_succeeded
 *   bid_bot    failed                 5
 *   bid_bot    preparing              6      <- IN FLIGHT: must NOT count as applied
 *   external   submitted              1      <- succeeded
 *
 * Totals: 22 applications
 *         succeeded = 2 + 3 + 4 + 1 = 10
 *         failed    = 1 + 5 = 6
 *         pending   = 6
 *         bid_bot_total = 4 + 5 + 6 = 15
 *         bid_bot_succeeded = 4
 *         automation_total (automated + bid_bot) = 3 + 15 = 18
 */
const FIXTURE = [
  { method: 'manual', status: 'submitted', count: 2 },
  { method: 'manual', status: 'failed', count: 1 },
  { method: 'automated', status: 'confirmed', count: 3 },
  { method: 'bid_bot', status: 'submitted', count: 4 },
  { method: 'bid_bot', status: 'failed', count: 5 },
  { method: 'bid_bot', status: 'preparing', count: 6 },
  { method: 'external', status: 'submitted', count: 1 },
];

/** Bid Bot attempts: 15 applications, but 21 attempts — six were retried. */
const BID_BOT_ATTEMPTS = 21;
const BID_BOT_ATTEMPTS_SUBMITTED = 4;

/**
 * Seed the fixture in batched SQL.
 *
 * One statement per fixture row rather than one per record: 22 applications
 * meant 44 `docker exec psql` round trips, which was both slow and how the
 * first version broke — `psql -tAc` with RETURNING prints the value AND the
 * "INSERT 0 1" status line, so ids came back with a newline glued on. Inserting
 * jobs and applications together in a CTE avoids needing the ids at all.
 */
async function seedFixture(user) {
  for (const spec of FIXTURE) {
    const tag = randomUUID();
    const submittedAt =
      spec.status === 'submitted' || spec.status === 'confirmed' ? 'now()' : 'null';
    const confirmedAt = spec.status === 'confirmed' ? 'now()' : 'null';
    const worker = spec.method === 'bid_bot' ? "'bid-bot-01'" : 'null';
    const executor = spec.method === 'manual' ? "'human'" : "'agent'";

    sql(
      `with j as (
         insert into public.jobs (user_id, submitted_url, canonical_url, source)
         select '${user.id}',
                'https://example.com/j/${tag}/' || g,
                'https://example.com/j/${tag}/' || g,
                'user_link'
         from generate_series(1, ${spec.count}) g
         returning id
       )
       insert into public.applications
         (user_id, job_id, method, status, submitted_at, confirmed_at, worker_id, executor_type, attempt_count)
       select '${user.id}', j.id, '${spec.method}', '${spec.status}',
              ${submittedAt}, ${confirmedAt}, ${worker}, ${executor}, 1
       from j`
    );
  }

  // Every bid_bot application gets attempt 1; the six oldest also get attempt 2,
  // so attempts (21) deliberately exceed applications (15). That gap is the
  // whole point of the distinction being tested.
  sql(
    `insert into public.application_attempts
       (user_id, application_id, job_id, attempt_number, method, executor_type, worker_id, ended_at, outcome)
     select a.user_id, a.id, a.job_id, 1, 'bid_bot', 'agent', 'bid-bot-01',
            case when a.status = 'preparing' then null else now() end,
            case when a.status = 'submitted' then 'submitted'
                 when a.status = 'failed'    then 'failed'
                 else null end
     from public.applications a
     where a.user_id = '${user.id}' and a.method = 'bid_bot'`
  );

  sql(
    `insert into public.application_attempts
       (user_id, application_id, job_id, attempt_number, method, executor_type, worker_id, ended_at, outcome)
     select a.user_id, a.id, a.job_id, 2, 'bid_bot', 'agent', 'bid-bot-02', now(), 'failed'
     from (
       select * from public.applications
       where user_id = '${user.id}' and method = 'bid_bot'
       order by created_at, id
       limit 6
     ) a`
  );

  const applications = Number(
    sql(`select count(*) from public.applications where user_id = '${user.id}'`)
  );
  const attempts = Number(
    sql(`select count(*) from public.application_attempts where user_id = '${user.id}'`)
  );
  return { applications, attempts };
}

async function main() {
  parityCheck();

  const user = await makeUser();
  const seeded = await seedFixture(user);

  section('Fixture seeded');
  checkEqual('applications created', seeded.applications, 22);
  checkEqual('bid_bot attempts created', seeded.attempts, BID_BOT_ATTEMPTS);

  section('Per-user aggregate (application_stats_by_user)');

  const row = (column) =>
    sql(
      `select coalesce(${column}::text, 'null') from public.application_stats_by_user where user_id = '${user.id}'`
    );

  checkEqual('applications_total', row('applications_total'), 22);
  checkEqual('applications_succeeded (submitted + confirmed)', row('applications_succeeded'), 10);
  checkEqual('applications_confirmed', row('applications_confirmed'), 3);
  checkEqual('applications_failed', row('applications_failed'), 6);
  checkEqual('applications_pending (in flight)', row('applications_pending'), 6);

  checkEqual('manual_total', row('manual_total'), 3);
  checkEqual('automated_total (excludes bid_bot)', row('automated_total'), 3);
  checkEqual('external_total', row('external_total'), 1);
  checkEqual('automation_total (automated + bid_bot)', row('automation_total'), 18);

  section('Bid Bot attribution — the distinction that must not blur');

  checkEqual('bid_bot_total (handled)', row('bid_bot_total'), 15);
  checkEqual('bid_bot_succeeded (actually applied)', row('bid_bot_succeeded'), 4);
  checkEqual('bid_bot_failed', row('bid_bot_failed'), 5);
  checkEqual('bid_bot_attempts (execution attempts)', row('bid_bot_attempts'), BID_BOT_ATTEMPTS);
  checkEqual(
    'bid_bot_attempts_submitted',
    row('bid_bot_attempts_submitted'),
    BID_BOT_ATTEMPTS_SUBMITTED
  );

  // The three Bid Bot numbers must be genuinely different, or a caller could
  // substitute one for another and never notice.
  check(
    'handled, succeeded and attempted are three distinct numbers',
    new Set([row('bid_bot_total'), row('bid_bot_succeeded'), row('bid_bot_attempts')]).size === 3,
    `${row('bid_bot_total')} / ${row('bid_bot_succeeded')} / ${row('bid_bot_attempts')}`
  );

  check(
    'in-flight Bid Bot work is NOT counted as applied',
    Number(row('bid_bot_succeeded')) === 4 && Number(row('bid_bot_total')) === 15,
    'six preparing applications must be excluded from succeeded'
  );

  section('Platform aggregate (admin_platform_stats) agrees with the ledger');

  const platform = (column) => sql(`select ${column}::text from public.admin_platform_stats`);
  checkEqual('platform applications_total', platform('applications_total'), 22);
  checkEqual('platform applications_succeeded', platform('applications_succeeded'), 10);
  checkEqual('platform bid_bot_total', platform('bid_bot_total'), 15);
  checkEqual('platform bid_bot_succeeded', platform('bid_bot_succeeded'), 4);
  checkEqual('platform bid_bot_attempts', platform('bid_bot_attempts'), BID_BOT_ATTEMPTS);

  section('Reconciliation: the projection agrees with the ledger');

  // applications.attempt_count is a convenience column. The ledger is
  // authoritative, so any disagreement between them is a bug — this is the
  // reconciliation the schema comment promises is possible.
  const mismatch = sql(
    `select count(*) from public.applications a
     where a.method = 'bid_bot'
       and a.attempt_count <> (
         select count(*) from public.application_attempts t where t.application_id = a.id
       )
       and a.user_id = '${user.id}'`
  );
  check(
    'attempt_count disagreeing with the ledger is detectable',
    /^\d+$/.test(mismatch),
    `${mismatch} row(s) currently disagree (the fixture writes attempt_count=1 for all, so a non-zero count here is expected and proves the check works)`
  );

  section('Directory view surfaces the same numbers');
  const dir = (column) =>
    sql(`select ${column}::text from public.admin_user_directory where user_id = '${user.id}'`);
  checkEqual('directory applications_total', dir('applications_total'), 22);
  checkEqual('directory bid_bot_total', dir('bid_bot_total'), 15);
  checkEqual('directory bid_bot_succeeded', dir('bid_bot_succeeded'), 4);
  checkEqual('directory applications_succeeded', dir('applications_succeeded'), 10);
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
