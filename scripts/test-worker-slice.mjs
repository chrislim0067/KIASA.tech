/**
 * The one-slot vertical slice, and the schema that backs it.
 *
 *   npm run test:slice
 *
 * OFFLINE. The fixture is a file, the transport is a fake, the clock is a
 * parameter, and the migration is read as TEXT rather than applied — so this
 * runs identically on a developer machine that cannot start Postgres and on a
 * CI runner that can.
 *
 * The database assertions here are STRUCTURAL: they prove the constraints are
 * written. That they WORK is proven by the `database` CI job, which resets a
 * real Postgres from empty and applies every migration. Both matter, and
 * neither substitutes for the other.
 *
 * THE PROPERTY THIS FILE EXISTS FOR
 *
 * Five of the six fixture pages must stop with NOTHING TYPED. A login wall, a
 * challenge, an MFA prompt and a passport-number field all render inputs,
 * labels and a submit button; they are indistinguishable from an ordinary
 * application form by shape alone. Every "0 fields filled" assertion below is
 * the difference between that and a candidate's details in a login attempt.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

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

const FIX = await import('../lib/worker/fixture.ts');
const SLICE = await import('../lib/worker/slice.ts');
const T = await import('../lib/local-claude/transport.ts');
const W = await import('../lib/agent/worker-state.ts');

const html = readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'employer-form.html'), 'utf8');
const sql = readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '20260909000022_worker_supervisors_and_leases.sql'),
  'utf8'
);

const FACTS = {
  full_name: 'Alex Candidate', email: 'alex@example.com',
  years_experience: '6', resume: 'resume.pdf', primary_skill: 'TypeScript',
};
const ANSWER = JSON.stringify({
  answer: 'Six years with TypeScript.',
  used_fact_keys: ['years_experience', 'primary_skill'], uncertain: false,
});
const SUPPORTED = {
  status: 'supported', adapter: 'claude_code_cli', version: '2.1.267', model: 'sonnet',
};

const now = new Date('2026-09-09T12:00:00.000Z');
const iso = (ms = 0) => new Date(now.getTime() + ms).toISOString();

const baseInputs = (over = {}) => ({
  mode: 'claude_max_assisted',
  availability: SUPPORTED,
  verifiedFacts: FACTS,
  transport: T.createMockTransport({ availability: SUPPORTED, responses: [ANSWER] }),
  lifecycle: 'running',
  slotState: {
    state: 'working', since: iso(),
    task_id: '00000000-0000-4000-8000-00000000000a',
    lease_id: '00000000-0000-4000-8000-00000000000b',
  },
  agentState: 'ready_to_submit',
  lease: {
    lease: { slot_id: 'slot-1', expires_at: iso(300_000), fence_token: 3 },
    current_fence_token: 3, slot_id: 'slot-1', now,
  },
  ...over,
});

const run = (page, over = {}) =>
  SLICE.runSlice({ ...baseInputs(over), observation: FIX.readFixturePage(html, page) });

/* ==================================================== 1. THE ORDINARY PATH */

section('1. The ordinary form is filled from verified facts and drafted');

{
  const o = await run('ordinary');
  check('it proceeds', o.status === 'ready_for_review', o.status);
  check('  safety said proceed', o.safety.action === 'proceed', o.safety.reasons.join(','));
  check('  four routine fields are filled', o.filled.length === 4,
    o.filled.map((f) => f.name).join(', '));
  check('  every filled value came from a verified fact',
    o.filled.every((f) => FACTS[f.factKey] === f.value));
  check('  the free-text field was drafted', o.drafted?.status === 'ok');
  check('  the draft cites only supplied facts',
    o.drafted.output.used_fact_keys.every((k) => k in FACTS));
  check('  the submit gate was reached and allowed', o.submitGate?.allowed === true,
    'reported, never acted on — the fixture is a local file');
  check('  it is NOT candidate-assisted', o.candidateAssisted === false,
    'a working local adapter means no person had to act');
}

/* ================================================== 2. THE FIVE HAZARDS */

section('2. Every hazard page stops with nothing typed');

const HAZARDS = [
  ['login', 'employer_authentication_required', 'a login wall renders inputs exactly like a form'],
  ['captcha', 'captcha', 'a challenge exists to establish a person is present'],
  ['mfa', 'mfa_required', 'an MFA prompt is not an application question'],
  ['sensitive', 'sensitive_information_requested', 'a passport number is not application data'],
  ['unknown', 'unknown_page', 'an unrecognised page is a stop, not a guess'],
];

for (const [page, reason, why] of HAZARDS) {
  const o = await run(page);
  check(`${page}: stops`, o.status === 'stopped', o.status);
  check(`  naming ${reason}`, o.safety.reasons.includes(reason), o.safety.reasons.join(','));
  check(`  ZERO fields filled`, o.filled.length === 0, why);
  check(`  nothing was drafted`, o.drafted === null);
  check(`  the submit gate was never reached`, o.submitGate === null);
  check(`  a human is required`, o.safety.requires_human === true);
}

section('3. The sensitive page is the one that looks most ordinary');

{
  const observation = FIX.readFixturePage(html, 'sensitive');
  check('it IS recognised as an application form', observation.page_recognised === 'yes',
    'which is exactly why the field-level check has to catch it');
  check('  it has a fillable routine field', observation.fillable.length > 0);
  check('  and sensitive fields alongside it',
    observation.fields.filter((f) => f.sensitiveKind).length === 3);
  const o = await run('sensitive');
  check('  yet nothing is filled, including the routine field',
    o.filled.length === 0,
    'one sensitive field stops the whole page, not just that field');
}

/* ============================================ 4. READINESS AND STOP STATES */

section('4. A slot that is not ready cannot submit');

{
  const NOT_WORKING = [
    ['ready', {}], ['initializing', {}],
    ['paused', { pause_reason: 'captcha_detected', task_id: null, lease_id: null, requires_candidate_action: true }],
    ['stopping', { stop_reason: 'candidate_requested' }],
    ['stopped', { stop_reason: 'kill_switch' }],
    ['crashed', { failure_code: 'context_lost' }],
  ];
  for (const [state, extra] of NOT_WORKING) {
    const o = await run('ordinary', { slotState: { state, since: iso(), ...extra } });
    check(`a ${state} slot is refused at the gate`,
      o.submitGate?.allowed === false && o.submitGate.reason === 'slot_not_working',
      state === 'paused' ? 'even holding a valid lease' : '');
  }
}

section('5. An offline or starting supervisor cannot submit');

for (const lifecycle of ['offline', 'starting', 'stopping']) {
  const o = await run('ordinary', { lifecycle });
  check(`a ${lifecycle} supervisor is refused`,
    o.submitGate?.allowed === false && o.submitGate.reason === 'supervisor_not_running',
    lifecycle === 'starting' ? 'running is not ready' : '');
}
check('an offline supervisor accepts no new task',
  W.canAcceptTask('offline', { state: 'ready', since: iso() }).reason === 'supervisor_not_running');

section('6. A stale or expired lease is refused at the gate');

{
  const stale = await run('ordinary', {
    lease: { ...baseInputs().lease, lease: { slot_id: 'slot-1', expires_at: iso(300_000), fence_token: 2 } },
  });
  check('a stale fence token cannot submit', stale.submitGate?.reason === 'stale_fence');

  const expired = await run('ordinary', {
    lease: { ...baseInputs().lease, lease: { slot_id: 'slot-1', expires_at: iso(-1), fence_token: 3 } },
  });
  check('an expired lease cannot submit', expired.submitGate?.reason === 'expired',
    'a laptop that woke from sleep holds nothing');

  const other = await run('ordinary', {
    lease: { ...baseInputs().lease, lease: { slot_id: 'slot-2', expires_at: iso(300_000), fence_token: 3 } },
  });
  check('a sibling slot cannot submit', other.submitGate?.reason === 'wrong_slot');

  const notReady = await run('ordinary', { agentState: 'processing' });
  check('a task that is not ready_to_submit cannot submit',
    notReady.submitGate?.reason === 'not_ready');
}

/* ======================================== 7. DRAFTING FAILURES REACH A HUMAN */

section('7. A bad draft never becomes an answer');

{
  const BAD = [
    ['prose instead of JSON', 'Sure, here you go.'],
    ['an uncertain answer', JSON.stringify({ answer: 'not sure', used_fact_keys: [], uncertain: true })],
    ['an invented fact key', JSON.stringify({ answer: 'x', used_fact_keys: ['salary_history'], uncertain: false })],
  ];
  for (const [why, response] of BAD) {
    const o = await run('ordinary', {
      transport: T.createMockTransport({ availability: SUPPORTED, responses: [response] }),
    });
    check(`${why} -> drafting_failed`, o.status === 'drafting_failed', o.status);
    check(`  the submit gate is never reached`, o.submitGate === null);
  }
  check('an invented fact key is reported as such', (await run('ordinary', {
    transport: T.createMockTransport({
      availability: SUPPORTED,
      responses: [JSON.stringify({ answer: 'x', used_fact_keys: ['salary_history'], uncertain: false })],
    }),
  })).drafted.detail.includes('unsupplied'),
    'an answer citing a fact we never supplied did not come from the candidate');
}

section('8. Without a local capability, the task becomes candidate-assisted');

for (const availability of [
  { status: 'unsupported', reason: 'cli_not_installed' },
  { status: 'manual_required', reason: 'candidate_has_not_consented' },
]) {
  const o = await run('ordinary', {
    availability,
    transport: T.createMockTransport({ availability }),
  });
  check(`${availability.reason}: the task is marked candidate-assisted`,
    o.candidateAssisted === true,
    'work a person does by hand must never be counted as unattended automation');
  check(`  and the slice stops for the person rather than pretending`,
    o.status === 'stopped', o.status);
}

/* ================================================= 9. THE SCHEMA THAT BACKS IT */

section('9. The database enforces what TypeScript only asserts');

const HAS = (re, label, detail = '') => check(label, re.test(sql), detail);

HAS(/create unique index task_leases_one_active_per_task[\s\S]{0,120}where released_at is null/,
  'one active lease per task, as a partial unique index',
  'two slots working one application becomes impossible, not merely unlikely');
HAS(/create unique index task_leases_one_active_per_slot[\s\S]{0,120}where released_at is null/,
  'one active task per slot');
HAS(/constraint worker_slots_one_index_per_supervisor unique \(supervisor_id, slot_index\)/,
  'slot numbers are unique per supervisor');
HAS(/check \(slot_index between 1 and 10\)/, 'slot_index is bounded to ten');
HAS(/check \(declared_slots between 1 and 10\)/, 'declared_slots is bounded to ten');
HAS(/constraint automation_tasks_one_per_idempotency_key unique \(user_id, idempotency_key\)/,
  'one task per idempotency key per candidate',
  'a redelivered queue message collides here rather than applying twice');
HAS(/fence_token may not decrease/, 'the fence token cannot go backwards');
HAS(/attempt may not decrease/, 'attempts are never reset');
HAS(/check \(expires_at > acquired_at\)/, 'a lease expires after it is acquired');
HAS(/check \(expires_at <= acquired_at \+ interval '1 hour'\)/,
  'a lease cannot be renewed indefinitely');
HAS(/an expired lease may not be renewed/, 'an expired lease is never revived');
HAS(/a released lease may not be reopened/, 'a released lease stays released');
HAS(/a revoked supervisor may not hold a lease/, 'registration revocation is enforced');
HAS(/lease and slot belong to different candidates/, 'a lease cannot cross candidates');
HAS(/worker_events is append-only/, 'the audit trail cannot be edited or deleted');

check('every table forces row level security',
  (sql.match(/force row level security/g) ?? []).length >= 1 &&
    /all_tables text\[\] := array\[[\s\S]*?'worker_events'[\s\S]*?\]/.test(sql));
check('grants are revoked before anything is granted',
  sql.indexOf('revoke all on public.%I from authenticated') <
    sql.indexOf('grant select, insert on public.%I to authenticated'),
  'Supabase hands authenticated ALL by default, and that includes TRUNCATE');
check('the migration verifies itself and aborts',
  /raise exception 'expected 17 policies, found %'/.test(sql));

section('10. Nothing in the schema stores a credential');

{
  const CREDENTIAL_COLUMNS = /\b(api_key|apikey|secret|password|token|cookie|session_key|credential|bearer)\b\s+(text|uuid|jsonb|bytea)/i;
  check('no column is credential-shaped', !CREDENTIAL_COLUMNS.test(sql),
    'fence_token is a bigint counter and deliberately does not match');
  check('the migration says so explicitly', /NOTHING HERE STORES A CREDENTIAL/.test(sql));
  check('browser_context_id is an opaque label, not a path',
    /browser_context_id text not null[\s\S]{0,160}\^\[A-Za-z0-9_-\]\{1,64\}\$/.test(sql));
}

console.log('\n========================================================');
if (failed === 0) {
  console.log(`ALL ${passed} WORKER-SLICE CHECKS PASSED`);
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
