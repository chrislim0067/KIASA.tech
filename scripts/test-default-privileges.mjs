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

const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_kiasa';
const sql = (statement) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', statement], {
    encoding: 'utf8',
  }).trim();

const TABLES = [
  'profiles', 'job_preferences', 'automation_settings', 'work_authorizations',
  'work_experiences', 'education_entries', 'skills', 'certifications',
  'projects', 'languages', 'verified_answers',
];
const CHECK_HELPER_SIGNATURES = {
  text_array_matches: 'public.text_array_matches(text[], text)',
  text_array_no_blanks: 'public.text_array_no_blanks(text[])',
};
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

section('3. The 3 helper functions');
for (const role of ['anon', 'service_role']) {
  const n = sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and has_function_privilege('${role}',p.oid,'EXECUTE')`);
  check(`${role} cannot execute any public function`, n === '0', `${n} executable`);
}
{
  const pub = sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and has_function_privilege('public',p.oid,'EXECUTE')`);
  check('PUBLIC cannot execute any public function', pub === '0', `${pub} executable`);

  const trig = sql(`select has_function_privilege('authenticated','public.set_updated_at()','EXECUTE')`);
  check('authenticated cannot execute set_updated_at()', trig === 'f', trig);

  // has_function_privilege needs a full signature, not a bare name.
  for (const [fn, signature] of Object.entries(CHECK_HELPER_SIGNATURES)) {
    const can = sql(`select has_function_privilege('authenticated','${signature}', 'EXECUTE')`);
    check(`authenticated can execute ${fn} (required by CHECK)`, can === 't', can);
  }

  const unsafe = sql(`select coalesce(string_agg(p.proname,','),'none') from pg_proc p
                      join pg_namespace n on n.oid=p.pronamespace
                      where n.nspname='public'
                        and (p.prosecdef or p.proconfig is null
                             or not (p.proconfig && array['search_path=""','search_path=']))`);
  check('all functions are SECURITY INVOKER with empty search_path', unsafe === 'none', unsafe);
}

console.log(`\n${'='.repeat(56)}`);
console.log(failed === 0 ? 'DEFAULT PRIVILEGES AND GRANTS VERIFIED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
