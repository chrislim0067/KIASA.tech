/**
 * The hosted-project shape: a platform event-trigger helper in `public`.
 *
 *   node scripts/test-hosted-definer-shape.mjs
 *
 * WHAT THIS IS FOR
 *
 * `db push` against the real project aborted inside migration 27:
 *
 *   ERROR: unexpected SECURITY DEFINER function(s): rls_auto_enable
 *
 * A hosted Supabase project carries `public.rls_auto_enable()` — an event
 * trigger that enables row level security on every table created in `public`.
 * It is owned by `postgres`, belongs to no extension, and is SECURITY DEFINER.
 * The local stack does not have it, so CI applied all thirty migrations from
 * empty and never noticed. Migrations 27, 28 and 29 all carried the same
 * unscoped predicate, so the push would have failed three times.
 *
 * This suite reproduces that shape against real Postgres and proves the
 * corrected predicate:
 *
 *   1. with a platform-shaped event-trigger definer present, each migration's
 *      own verification block passes;
 *   2. a rogue CALLABLE definer is still rejected — the guard is not weakened;
 *   3. an event-trigger function genuinely cannot be invoked directly, which is
 *      the property the exclusion rests on;
 *   4. no migration in this repository creates a definer returning
 *      `event_trigger`, so the exclusion is provably empty for our own code.
 *
 * Local stack only. It creates and drops its own functions and touches no
 * application data. Nothing here contacts a hosted service.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { statusEnvRaw } from './lib/supabase-cli.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_kiasa';

/* Refuse to run anywhere but the local stack. */
{
  const raw = statusEnvRaw();
  const url = (raw.match(/^API_URL="?([^"\r\n]*)"?/m) ?? [])[1] ?? '';
  if (!/127\.0\.0\.1|localhost/.test(url)) {
    throw new Error('Local Supabase is not running, or the API URL is not local.');
  }
}

const psql = (sql, opts = {}) =>
  execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qtAc', sql],
    { encoding: 'utf8', ...opts }
  ).trim();

/** Run SQL and report whether the database refused it, without throwing. */
function refused(sql) {
  try {
    psql(sql, { stdio: 'pipe' });
    return null;
  } catch (error) {
    const text = String(error.stderr ?? error.stdout ?? error.message ?? '');
    return text.replace(/\s+/g, ' ').trim();
  }
}

let passed = 0;
let failed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(label, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/**
 * The final `do $$ ... $$;` block of a migration — its self-verification.
 *
 * Re-running just that block is safe and is exactly what aborted the push: it
 * reads the catalogue and raises. The DDL above it is not replayed, because the
 * tables already exist; what is under test is the assertion, not the schema.
 */
function verificationBlock(file) {
  const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  const open = sql.lastIndexOf('do $$');
  if (open < 0) return null;
  const close = sql.indexOf('end $$;', open);
  if (close < 0) return null;
  return sql.slice(open, close + 'end $$;'.length);
}

/* A stand-in with the same SHAPE as the hosted helper: event trigger, SECURITY
   DEFINER, owned by the migration role, in public, belonging to no extension.
   Its body is inert — the shape is what the predicate sees. */
const PLATFORM_HELPER = `
create or replace function public.kiasa_test_platform_rls_helper()
returns event_trigger language plpgsql security definer
set search_path to 'pg_catalog'
as $fn$ begin return; end $fn$;`;

/* A rogue definer with a CALLABLE return type — what the guard exists to catch. */
const ROGUE_CALLABLE = `
create or replace function public.kiasa_test_rogue_definer()
returns text language plpgsql security definer
as $fn$ begin return 'i should be caught'; end $fn$;`;

const cleanup = () => {
  refused('drop function if exists public.kiasa_test_platform_rls_helper();');
  refused('drop function if exists public.kiasa_test_rogue_definer();');
};

cleanup();

/* ------------------------------------------------------------------------- */
section('1. An event-trigger function cannot be invoked, whatever its grants');

psql(PLATFORM_HELPER);

{
  const grants = psql(`select
      has_function_privilege('public',        'public.kiasa_test_platform_rls_helper()', 'EXECUTE')::text
      || ',' ||
      has_function_privilege('anon',          'public.kiasa_test_platform_rls_helper()', 'EXECUTE')::text
      || ',' ||
      has_function_privilege('authenticated', 'public.kiasa_test_platform_rls_helper()', 'EXECUTE')::text`);

  /*
   * Postgres grants EXECUTE to PUBLIC on every new function, so these are very
   * likely true — exactly as they are for the real hosted helper. The point of
   * this section is that it does not matter.
   */
  check('the default PUBLIC EXECUTE grant is present, as on the hosted helper',
    grants === 'true,true,true', grants);

  const error = refused(`select public.kiasa_test_platform_rls_helper();`);
  check('and yet it CANNOT be called directly', error !== null,
    error ? error.slice(0, 90) : 'IT WAS CALLABLE');
  check('  because the return type forbids it',
    error !== null && /event trigger|can only be called|trigger function/i.test(error),
    error ? error.slice(0, 90) : '');
}

/* ------------------------------------------------------------------------- */
section('2. Each migration verifies cleanly with the platform helper present');

for (const file of [
  '20260910000027_worker_task_lifecycle.sql',
  '20260910000028_worker_audit_events.sql',
  '20260910000029_profile_drafting_tasks.sql',
]) {
  const block = verificationBlock(file);
  check(`${file.slice(14, 34)}: its verification block was found`, block !== null);
  if (!block) continue;

  const error = refused(block);
  check(`  it passes with an event-trigger definer in public`, error === null,
    error ? error.slice(0, 140) : '');
}

/* ------------------------------------------------------------------------- */
section('3. A rogue CALLABLE definer is still rejected');

psql(ROGUE_CALLABLE);

{
  let caught = 0;
  for (const file of [
    '20260910000027_worker_task_lifecycle.sql',
    '20260910000028_worker_audit_events.sql',
    '20260910000029_profile_drafting_tasks.sql',
  ]) {
    const block = verificationBlock(file);
    if (!block) continue;
    const error = refused(block);
    const named = error !== null && /kiasa_test_rogue_definer/.test(error);
    check(`${file.slice(14, 34)}: refuses the rogue definer, and names it`, named,
      error ? error.slice(0, 110) : 'IT WAS ACCEPTED');
    if (named) caught++;
  }
  check('all three still catch it — the guard is not weakened', caught === 3, String(caught));
}

refused('drop function if exists public.kiasa_test_rogue_definer();');

/* ------------------------------------------------------------------------- */
section('4. The exclusion is provably empty for this repository');

{
  /*
   * If any migration here ever creates a SECURITY DEFINER function returning
   * `event_trigger`, the exclusion would start hiding one of ours. It does not
   * today, and this fails the moment that changes.
   */
  const offenders = [];
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8')
      // Comments discuss event triggers at length; scanning them would flag the
      // explanation rather than the code.
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*--[^\n]*$/gm, ' ');
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function[\s\S]{0,600}?\$/gi)) {
      const body = m[0];
      if (/returns\s+event_trigger/i.test(body) && /security\s+definer/i.test(body)) {
        offenders.push(file);
      }
    }
  }
  check('no migration creates a SECURITY DEFINER event-trigger function',
    offenders.length === 0, offenders.join(', '));

  const live = psql(`select coalesce(string_agg(p.proname, ','), 'none')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.prorettype = 'pg_catalog.event_trigger'::regtype
      and p.proname <> 'kiasa_test_platform_rls_helper'`);
  check('  and none exists in the database beyond this test’s own', live === 'none', live);
}

/* ------------------------------------------------------------------------- */
section('5. Our own definers keep every property');

{
  const wrong = psql(`select coalesce(string_agg(p.proname, ','), 'none')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'worker\\_%'
      and (
        not p.prosecdef
        or p.proconfig is null
        or not (p.proconfig && array['search_path=""', 'search_path='])
      )`);
  check('every worker_* function is a definer with a pinned empty search_path',
    wrong === 'none', wrong);

  const reachable = psql(`select coalesce(string_agg(p.proname, ','), 'none')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'worker\\_%'
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('public', p.oid, 'EXECUTE'))`);
  check('  and none is reachable by anon or PUBLIC', reachable === 'none', reachable);
}

cleanup();

console.log(`\n${'='.repeat(56)}`);
if (failed === 0) {
  console.log(`ALL ${passed} HOSTED-DEFINER-SHAPE CHECKS PASSED`);
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
