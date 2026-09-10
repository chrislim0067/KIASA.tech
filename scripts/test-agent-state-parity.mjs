/**
 * The task state machine exists TWICE. This proves it is the same one.
 *
 *   npm run test:state-parity
 *
 * Offline: it parses the migration SQL as text and compares it with the
 * TypeScript table. No database, no Supabase, no Docker.
 *
 * WHY
 *
 * `guard_automation_task_transition()` in migration 22 is the AUTHORITY —
 * RLS lets a client PATCH `automation_tasks.status` straight through
 * PostgREST without touching any TypeScript, so a rule that lived only in
 * `lib/agent/state-machine.ts` would be advisory. But callers need an answer
 * without a round trip, so the table is mirrored in TypeScript.
 *
 * Two copies of a rule is a drift waiting to happen, and a drifted transition
 * table is the worst kind: the database would refuse a move the code believes
 * is legal, mid-application, on a real submission. So they are compared here in
 * BOTH directions, and this file is the reason Milestone 2B did not add a
 * second competing state machine — it added a second EXPRESSION of one, with a
 * test welding them together.
 *
 * The same pattern as scripts/test-job-state-parity.mjs, for the same reason.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIGRATION = path.join(
  ROOT, 'supabase', 'migrations', '20260909000022_worker_supervisors_and_leases.sql'
);

let passed = 0;
let failed = 0;
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

const SM = await import('../lib/agent/state-machine.ts');
const TR = await import('../lib/agent/state-translation.ts');

const sql = readFileSync(MIGRATION, 'utf8');

/**
 * Pull the CASE arms out of guard_automation_task_transition().
 *
 * Parsed rather than executed, deliberately: running it would need a database,
 * and the whole value of this check is that it runs on every push in the
 * static job, before anything reaches Postgres.
 */
function parseSqlTransitions(source) {
  const fn = source.slice(
    source.indexOf('guard_automation_task_transition()'),
    source.indexOf('automation_tasks_status_transition')
  );
  const table = {};
  const arm = /when\s+'([a-z_]+)'\s*then\s+array\[([^\]]*)\]/g;
  let m;
  while ((m = arm.exec(fn)) !== null) {
    const targets = m[2]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter((s) => s.length > 0);
    table[m[1]] = targets;
  }
  return table;
}

const fromSql = parseSqlTransitions(sql);
const fromTs = SM.TRANSITIONS;

section('1. Both tables describe the same states');

const sqlStates = Object.keys(fromSql).sort();
const tsStates = [...SM.AGENT_STATES].sort();

check('the migration declares every state the TypeScript does',
  tsStates.every((s) => sqlStates.includes(s)),
  tsStates.filter((s) => !sqlStates.includes(s)).join(', ') || 'none missing');
check('the migration declares no state the TypeScript does not',
  sqlStates.every((s) => tsStates.includes(s)),
  sqlStates.filter((s) => !tsStates.includes(s)).join(', ') || 'none extra');
check('both list exactly the same number', sqlStates.length === tsStates.length,
  `sql=${sqlStates.length} ts=${tsStates.length}`);

check('the CHECK constraint vocabulary matches too', (() => {
  const m = sql.match(/automation_tasks_status_allowed\s*\n?\s*check \(status in \(([\s\S]*?)\)\)/);
  if (!m) return false;
  const listed = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  return listed.join(',') === tsStates.join(',');
})(), 'a state the trigger allows but the CHECK rejects is unreachable');

section('2. Every transition agrees, in both directions');

for (const state of tsStates) {
  const ts = [...(fromTs[state] ?? [])].sort();
  const db = [...(fromSql[state] ?? [])].sort();
  check(`${state}: ${ts.length === 0 ? '(terminal)' : ts.join(' ')}`,
    ts.join(',') === db.join(','),
    ts.join(',') === db.join(',') ? '' : `ts=[${ts}] sql=[${db}]`);
}

section('3. Terminal states are terminal in both');

for (const state of SM.TERMINAL_STATES) {
  check(`${state} has no outgoing edge in TypeScript`, (fromTs[state] ?? []).length === 0);
  check(`  nor in the migration`, (fromSql[state] ?? []).length === 0);
}
check('failed cannot reach submitted in either',
  !(fromTs.failed ?? []).includes('submitted') && !(fromSql.failed ?? []).includes('submitted'),
  'a retry must never re-send an application');

section('4. The migration mirrors, rather than inventing');

check('it says so in a comment',
  /MIRRORS lib\/agent\/state-machine\.ts/i.test(sql) || /mirrors lib\/agent\/state-machine/i.test(sql));
check('the fence token is enforced monotonic in the database',
  /fence_token may not decrease/.test(sql),
  'a fence that can go backwards is not a fence');
check('attempts are enforced non-decreasing',
  /attempt may not decrease/.test(sql));
check('one active lease per task is a unique index',
  /task_leases_one_active_per_task[\s\S]{0,160}where released_at is null/.test(sql));
check('one active lease per slot is a unique index',
  /task_leases_one_active_per_slot[\s\S]{0,160}where released_at is null/.test(sql));
check('an expired lease cannot be renewed, in the database',
  /an expired lease may not be renewed/.test(sql));
check('a revoked supervisor cannot hold a lease',
  /a revoked supervisor may not hold a lease/.test(sql));

section('5. Task, job and application states have stated translations');

{
  const all = TR.STATE_TRANSLATION;
  check('the translation is total over every agent state',
    SM.AGENT_STATES.every((s) => s in all), `${Object.keys(all).length} states`);
  check('  and never yields undefined',
    Object.values(all).every((v) => v.application !== undefined && v.job !== undefined));

  const EXPECTED = {
    received: null, validated: null, snapshot_stored: null, normalized: null, scored: null,
    rejected: 'skipped', queued: 'queued', leased: 'preparing', processing: 'preparing',
    manual_review: 'needs_intervention', ready_to_submit: 'submitting',
    submitted: 'submitted', failed: 'failed', duplicate: 'duplicate', cancelled: 'cancelled',
  };
  for (const [state, expected] of Object.entries(EXPECTED)) {
    check(`${state} -> application ${expected ?? '(none yet)'}`,
      all[state].application === expected, String(all[state].application));
  }

  check('nothing maps to confirmed',
    Object.values(all).every((v) => v.application !== 'confirmed'),
    'an employer confirms an application; the system does not confirm its own work');
  check('a stop maps to needs_intervention, never failed',
    all.manual_review.application === 'needs_intervention');
  check('a rejection maps to skipped, never failed',
    all.rejected.application === 'skipped', 'nothing malfunctioned');
  check('execution states write nothing back to the job',
    ['processing', 'failed', 'submitted', 'manual_review'].every((s) => all[s].job === null),
    'a crashed browser has not un-fetched the posting');
  check('only a human clears manual_review',
    TR.taskStateNeedsHuman('manual_review') === true &&
      SM.AGENT_STATES.filter((s) => TR.taskStateNeedsHuman(s)).length === 1);
}

console.log('\n========================================================');
if (failed === 0) {
  console.log(`ALL ${passed} STATE-PARITY CHECKS PASSED`);
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
