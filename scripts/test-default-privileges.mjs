/**
 * Default-privilege and grant audit for the local database.
 *
 *   supabase start && node scripts/test-default-privileges.mjs
 *
 * Migration 8 verifies this at apply time; this script re-checks a running
 * database at any point, so drift introduced by a later migration is caught
 * without a full reset.
 *
 * Two parts:
 *   1. Probe objects (table, function, sequence) are created in public,
 *      inspected, then dropped — proving a *future* object grants nothing.
 *   2. The 11 real tables and 3 real helper functions are asserted to hold
 *      exactly the intended privileges.
 *
 * Local only, via psql in the Supabase container. No service-role key, no
 * application credentials.
 */
import { execFileSync } from 'node:child_process';

import { statusEnvRaw } from './lib/supabase-cli.mjs';

const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_kiasa';

/**
 * Local-only guard, matching the sibling test scripts. (Review finding L3)
 *
 * This script creates and DROPs probe objects, so it must never be pointed at
 * anything but a throwaway local stack. Its siblings refused a non-loopback
 * API_URL; this one went straight to `docker exec psql` with no such check.
 */
function assertLocalStack() {
  const raw = statusEnvRaw();
  const apiUrl = (raw.match(/^API_URL="?([^"\r\n]*)"?/m) ?? [])[1];
  if (!apiUrl) throw new Error('Local Supabase is not running (supabase start).');
  let host;
  try {
    host = new URL(apiUrl).hostname;
  } catch {
    throw new Error(`Unrecognised API_URL: ${apiUrl}`);
  }
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error(`Refusing to run against a non-local API URL: ${apiUrl}`);
  }
  return apiUrl;
}

console.log(`local API: ${assertLocalStack()}`);

const sql = (statement) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', statement], {
    encoding: 'utf8',
  }).trim();

const TABLES = [
  'profiles', 'job_preferences', 'automation_settings', 'work_authorizations',
  'work_experiences', 'education_entries', 'skills', 'certifications',
  'projects', 'languages', 'verified_answers',
];
/**
 * The helpers a CHECK constraint evaluates in the inserting user's context, so
 * `authenticated` must hold EXECUTE on each. is_blank_or_invisible is included
 * because text_array_ok and jsonb_links_ok call it, and a nested call in a
 * SECURITY INVOKER function is still permission-checked against the original
 * caller. text_array_no_blanks was dropped in migration 11.
 */
const CHECK_HELPER_SIGNATURES = {
  text_array_matches: 'public.text_array_matches(text[], text)',
  text_array_ok: 'public.text_array_ok(text[], integer, integer)',
  jsonb_links_ok: 'public.jsonb_links_ok(jsonb, integer, integer, integer)',
  is_blank_or_invisible: 'public.is_blank_or_invisible(text)',
};
/** Functions that must no longer exist at all. */
const REMOVED_FUNCTIONS = ['text_array_no_blanks', 'set_updated_at'];
/**
 * THE WORKER AUTHORIZATION BOUNDARY, AND NOTHING ELSE.
 *
 * Two invariants below used to read zero: `service_role` executed no public
 * function, and no public function was SECURITY DEFINER. Both were the right
 * default and both still are — migration 26 makes exactly two exceptions, and
 * they exist to REMOVE privilege rather than add it.
 *
 * A worker redeeming a pairing secret has no session, so there is no candidate
 * context for RLS to evaluate and its writes cannot run under one. The
 * alternative to these two functions was granting `service_role` SELECT,
 * INSERT and UPDATE on `worker_supervisors` and `worker_slots` — every row of
 * every candidate's worker state, reachable from any bug in any server route.
 * Two named functions, each performing one operation and reading ownership out
 * of a row the caller has proved it holds, is by far the smaller surface.
 *
 * So the two checks become allow-lists rather than zeroes, which is stricter
 * in the way that matters: a THIRD definer function, or a third EXECUTE grant,
 * still fails here. Sorted by name, because string_agg is.
 */
/*
 * Two lists, not one, because the resolver is deliberately in only one of
 * them. `worker_resolve_credential` is SECURITY DEFINER and granted to
 * NOBODY: inside another definer function the current user is the owner, which
 * holds EXECUTE implicitly, so the five operations can call it while PostgREST
 * cannot reach it at all. Collapsing these into one list would either hide a
 * definer function or grant it.
 *
 * Sorted by name, because string_agg is.
 */
const WORKER_DEFINER_FUNCTIONS = [
  'worker_claim_task',
  'worker_record_heartbeat',
  'worker_redeem_pairing',
  'worker_renew_lease',
  'worker_report_task',
  'worker_resolve_credential',
];
const WORKER_CALLABLE_FUNCTIONS = WORKER_DEFINER_FUNCTIONS.filter(
  (fn) => fn !== 'worker_resolve_credential'
);
const API_ROLES = ['anon', 'authenticated', 'service_role'];

let failed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/* ------------------------------------------------------- 1. probe objects */
section('1. A newly created object grants nothing');

// Cleanup first in case a previous run died midway.
sql(`drop function if exists public._privprobe_fn(); drop sequence if exists public._privprobe_seq; drop table if exists public._privprobe_table;`);

sql(`create table public._privprobe_table (id integer);
     create sequence public._privprobe_seq;
     create function public._privprobe_fn() returns integer language sql immutable set search_path = '' as 'select 1';`);

for (const role of API_ROLES) {
  const t = sql(`select bool_or(has_table_privilege('${role}','public._privprobe_table',p))
                 from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p`);
  check(`probe table: ${role} has no access`, t === 'f', t);
  const f = sql(`select has_function_privilege('${role}','public._privprobe_fn()','EXECUTE')`);
  check(`probe function: ${role} cannot execute`, f === 'f', f);
  const s = sql(`select bool_or(has_sequence_privilege('${role}','public._privprobe_seq',p))
                 from unnest(array['USAGE','SELECT','UPDATE']) p`);
  check(`probe sequence: ${role} has no access`, s === 'f', s);
}
{
  const pub = sql(`select has_function_privilege('public','public._privprobe_fn()','EXECUTE')`);
  check('probe function: PUBLIC cannot execute (built-in default suppressed)', pub === 'f', pub);
  const pubT = sql(`select has_table_privilege('public','public._privprobe_table','SELECT')`);
  check('probe table: PUBLIC has no SELECT', pubT === 'f', pubT);
}

sql(`drop function public._privprobe_fn(); drop sequence public._privprobe_seq; drop table public._privprobe_table;`);
{
  const left = sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
                    where n.nspname='public' and c.relname like '\\_privprobe%'`);
  check('all probe objects removed', left === '0', `${left} left`);
  const leftFn = sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                      where n.nspname='public' and p.proname like '\\_privprobe%'`);
  check('probe function removed', leftFn === '0', `${leftFn} left`);
}

/* --------------------------------------------------- 2. the real objects */
section('2. The 11 candidate tables');

for (const role of ['anon', 'service_role']) {
  const n = sql(`select count(*) from information_schema.role_table_grants
                 where table_schema='public' and grantee='${role}'
                   and table_name in (${TABLES.map((t) => `'${t}'`).join(',')})`);
  check(`${role} holds no table grants`, n === '0', `${n} grant(s)`);
}
{
  const extra = sql(`select coalesce(string_agg(distinct privilege_type,','),'none')
                     from information_schema.role_table_grants
                     where table_schema='public' and grantee='authenticated'
                       and table_name in (${TABLES.map((t) => `'${t}'`).join(',')})
                       and privilege_type not in ('SELECT','INSERT','UPDATE','DELETE')`);
  check('authenticated holds no privilege beyond DML', extra === 'none', extra);
  const missing = sql(`select count(*) from unnest(array[${TABLES.map((t) => `'${t}'`).join(',')}]) t
                       where (select count(*) from information_schema.role_table_grants g
                              where g.table_schema='public' and g.grantee='authenticated'
                                and g.table_name=t and g.privilege_type in ('SELECT','INSERT','UPDATE','DELETE')) <> 4`);
  check('authenticated has all four DML verbs on all 11 tables', missing === '0', `${missing} table(s) short`);
  const rls = sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
                   where n.nspname='public' and c.relname in (${TABLES.map((t) => `'${t}'`).join(',')})
                     and c.relrowsecurity and c.relforcerowsecurity`);
  check('RLS enabled and forced on all 11', rls === '11', `${rls}/11`);
}

section('3. The helper functions');
for (const role of ['anon', 'service_role']) {
  const executable = sql(`select coalesce(string_agg(p.proname, ',' order by p.proname), 'none')
                          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                          where n.nspname='public'
                            and has_function_privilege('${role}',p.oid,'EXECUTE')`);
  const allowed = role === 'service_role' ? WORKER_CALLABLE_FUNCTIONS.join(',') : 'none';
  check(
    role === 'service_role'
      ? 'service_role executes the worker boundary and nothing else'
      : `${role} cannot execute any public function`,
    executable === allowed,
    executable
  );
}
{
  const pub = sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and has_function_privilege('public',p.oid,'EXECUTE')`);
  check('PUBLIC cannot execute any public function', pub === '0', `${pub} executable`);

  // Trigger functions need no EXECUTE grant and must not have one.
  for (const trigger of ['public.set_row_timestamps()', 'public.guard_verified_answer_provenance()']) {
    const can = sql(`select has_function_privilege('authenticated','${trigger}','EXECUTE')`);
    check(`authenticated cannot execute ${trigger}`, can === 'f', can);
  }
  // Superseded functions must be dropped, not merely left unreferenced: an
  // unused function is still an RPC surface and still invites future misuse.
  for (const fn of REMOVED_FUNCTIONS) {
    const retired = sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                         where n.nspname='public' and p.proname='${fn}'`);
    check(`the superseded ${fn}() is gone`, retired === '0', `${retired} found`);
  }

  // has_function_privilege needs a full signature, not a bare name.
  for (const [fn, signature] of Object.entries(CHECK_HELPER_SIGNATURES)) {
    const can = sql(`select has_function_privilege('authenticated','${signature}', 'EXECUTE')`);
    check(`authenticated can execute ${fn} (required by CHECK)`, can === 't', can);
  }

  // An empty search_path is required of EVERY function, definer or not. It is
  // what stops a shadowing object in another schema being reached by an
  // unqualified name.
  const unsafe = sql(`select coalesce(string_agg(p.proname,','),'none') from pg_proc p
                      join pg_namespace n on n.oid=p.pronamespace
                      where n.nspname='public'
                        and (p.proconfig is null
                             or not (p.proconfig && array['search_path=""','search_path=']))`);
  check('every public function pins an empty search_path', unsafe === 'none', unsafe);

  // And SECURITY DEFINER is confined to the two that need it.
  const definers = sql(`select coalesce(string_agg(p.proname, ',' order by p.proname), 'none')
                        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                        where n.nspname='public' and p.prosecdef`);
  check('SECURITY DEFINER is confined to the worker boundary',
    definers === WORKER_DEFINER_FUNCTIONS.join(','), definers);
  check('  and the credential resolver is executable by nobody at all',
    !sql(`select coalesce(string_agg(p.proname, ','), 'none')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public'
             and has_function_privilege('service_role', p.oid, 'EXECUTE')`)
      .includes('worker_resolve_credential'),
    'it runs only inside another definer function');
}

console.log(`\n${'='.repeat(56)}`);
console.log(failed === 0 ? 'DEFAULT PRIVILEGES AND GRANTS VERIFIED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
