/**
 * The agent control plane, offline.
 *
 *   npm run test:agent
 *
 * Pure. No network, no database, no browser, no provider, no worker. Every
 * dependency is either a plain value or an injected fake, so this runs
 * identically on a developer machine and on a CI runner.
 *
 * WHAT IT IS FOR
 *
 * The control plane decides whether a machine fills in a form and presses
 * submit on a real person's behalf. Nothing in this milestone executes any of
 * that — the point is to fix and prove the boundaries BEFORE anything can act
 * on them, because a rule discovered after the fact is discovered by an
 * application that has already been sent.
 *
 * Four properties get the most attention below, in rough order of how much
 * damage getting them wrong would do:
 *
 *   1. a stale worker cannot submit (fencing);
 *   2. no safety rule fails open;
 *   3. a private-network URL is never accepted;
 *   4. a usage row cannot carry candidate content.
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

const C = await import('../lib/agent/contracts.ts');
const SM = await import('../lib/agent/state-machine.ts');
const SAFETY = await import('../lib/agent/safety.ts');
const URLS = await import('../lib/agent/job-url.ts');
const WRITER = await import('../lib/ai/usage-writer.ts');

const uuid = (n = 1) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const iso = (offsetMs = 0) => new Date(1_800_000_000_000 + offsetMs).toISOString();
const key = 'idem_0123456789abcdef';

/* ============================================================ CONTRACTS */

section('1. Contracts accept valid data and reject malformed');

const VALID = {
  CandidateSnapshot: {
    candidate_id: uuid(1), captured_at: iso(), mode: 'openrouter_only',
    profile_complete: true, has_resume: true,
    work_authorization: 'yes', requires_visa_sponsorship: 'no', willing_to_relocate: 'unknown',
    compensation_configured: true,
    facts: [{ key: 'work_authorization', value: 'citizen', verified: true, source: 'candidate_entered' }],
  },
  JobUrlInput: {
    candidate_id: uuid(1), url: 'https://boards.greenhouse.io/acme/jobs/1',
    idempotency_key: key, submitted_at: iso(),
  },
  JobEnvelope: {
    job_id: uuid(2), candidate_id: uuid(1),
    canonical_url: 'https://boards.greenhouse.io/acme/jobs/1',
    host: 'boards.greenhouse.io', source: 'candidate_url',
    idempotency_key: key, correlation_id: uuid(3), received_at: iso(),
  },
  JobSnapshot: {
    snapshot_id: uuid(4), job_id: uuid(2), fetched_at: iso(), http_status: 200,
    content_hash: 'a'.repeat(64), byte_size: 4096, storage_path: 'snapshots/x.html',
  },
  NormalizedJob: {
    job_id: uuid(2), snapshot_id: uuid(4), title: 'Engineer', company: 'ACME',
    location: 'Singapore', remote: 'unknown', employment_type: 'full_time', ats: 'greenhouse',
    salary_min: null, salary_max: null, salary_currency: null, posted_at: null,
    unreadable_sections: [],
  },
  EligibilityDecision: {
    job_id: uuid(2), candidate_id: uuid(1), decided_at: iso(),
    outcome: 'eligible', reasons: [], evaluator: 'deterministic_rules',
  },
  ScoreResult: {
    job_id: uuid(2), candidate_id: uuid(1), scored_at: iso(), score: 82, confidence: 0.7,
    explanation: 'Matches stack and seniority.', model: 'google/gemini-2.5-flash',
    provider: 'openrouter', correlation_id: uuid(3),
  },
  SafetyDecision: {
    decided_at: iso(), action: 'stop', reasons: ['captcha'], requires_human: true,
  },
  AutomationTask: {
    task_id: uuid(5), job_id: uuid(2), candidate_id: uuid(1), mode: 'openrouter_only',
    idempotency_key: key, correlation_id: uuid(3), created_at: iso(),
    steps: [{ action: 'open_job_url', field: null, fact_key: null }],
    attempt: 0, max_attempts: 3,
  },
  AutomationTaskResult: {
    task_id: uuid(5), finished_at: iso(), outcome: 'submitted', safety: null,
    failure_kind: null, failure_code: null, confirmation_reference: 'GH-12345', steps_completed: 6,
  },
  SlotLease: {
    lease_id: uuid(6), task_id: uuid(5), slot_id: uuid(7), supervisor_id: uuid(10),
    candidate_id: uuid(1), acquired_at: iso(), expires_at: iso(60_000), fence_token: 1,
  },
  SupervisorRegistration: {
    supervisor_id: uuid(10), candidate_id: uuid(1), registered_at: iso(),
    platform: 'windows', agent_version: '0.1.0', declared_slots: 3,
  },
  SlotRegistration: {
    slot_id: uuid(7), supervisor_id: uuid(10), candidate_id: uuid(1), slot_index: 1,
    capabilities: ['form_fill'], browser_context_id: 'ctx-1', registered_at: iso(),
  },
  ApplicationAttempt: {
    attempt_id: uuid(8), job_id: uuid(2), candidate_id: uuid(1), task_id: uuid(5),
    started_at: iso(), finished_at: iso(1000), outcome: 'submitted',
    mode: 'openrouter_only', idempotency_key: key, correlation_id: uuid(3),
  },
  AutomationEvent: {
    event_id: uuid(9), candidate_id: uuid(1), job_id: uuid(2), task_id: uuid(5),
    correlation_id: uuid(3), occurred_at: iso(), kind: 'task_queued',
    detail: { attempt: 1, queued: true, note: 'first' },
  },
};

for (const [name, value] of Object.entries(VALID)) {
  const schema = C[name];
  check(`${name} accepts a valid example`, schema.safeParse(value).success,
    schema.safeParse(value).success ? '' : JSON.stringify(schema.safeParse(value).error.issues[0]?.path));
}

section('2. Unknown fields are rejected, not silently dropped');

for (const [name, value] of Object.entries(VALID)) {
  const withExtra = { ...value, prompt: 'the full résumé text of a real person' };
  check(`${name} rejects an unknown key`, C[name].safeParse(withExtra).success === false);
}

section('3. Malformed data is rejected');

const MALFORMED = [
  ['CandidateSnapshot', { ...VALID.CandidateSnapshot, work_authorization: true }, 'a boolean where a tri-state belongs'],
  ['CandidateSnapshot', { ...VALID.CandidateSnapshot, candidate_id: 'not-a-uuid' }, 'a bad uuid'],
  ['JobEnvelope', { ...VALID.JobEnvelope, canonical_url: 'javascript:alert(1)' }, 'a javascript: url'],
  ['JobEnvelope', { ...VALID.JobEnvelope, idempotency_key: 'short' }, 'a too-short idempotency key'],
  ['JobEnvelope', { ...VALID.JobEnvelope, idempotency_key: 'has spaces and ; semicolons' }, 'an unsafe idempotency key'],
  ['JobSnapshot', { ...VALID.JobSnapshot, content_hash: 'nothex' }, 'a non-sha256 hash'],
  ['JobSnapshot', { ...VALID.JobSnapshot, http_status: 99 }, 'an impossible status'],
  ['NormalizedJob', { ...VALID.NormalizedJob, ats: 'my_custom_ats' }, 'an unknown ATS'],
  ['NormalizedJob', { ...VALID.NormalizedJob, salary_currency: 'dollars' }, 'a non-ISO currency'],
  ['EligibilityDecision', { ...VALID.EligibilityDecision, evaluator: 'llm' }, 'a model as the eligibility evaluator'],
  ['EligibilityDecision', { ...VALID.EligibilityDecision, reasons: ['because_i_said_so'] }, 'a free-text reason'],
  ['ScoreResult', { ...VALID.ScoreResult, score: 101 }, 'a score out of range'],
  ['ScoreResult', { ...VALID.ScoreResult, confidence: 1.5 }, 'a confidence out of range'],
  ['ScoreResult', { ...VALID.ScoreResult, provider: 'anthropic' }, 'a provider that is not OpenRouter'],
  ['AutomationTask', { ...VALID.AutomationTask, steps: [] }, 'a task with no steps'],
  ['AutomationTask', { ...VALID.AutomationTask, attempt: 9, max_attempts: 3 }, 'attempts beyond the maximum'],
  ['AutomationTask', { ...VALID.AutomationTask, mode: 'claude_max_backend' }, 'an unsupported mode'],
  ['SlotRegistration', { ...VALID.SlotRegistration, slot_index: 11 }, 'a slot index beyond ten'],
  ['SlotRegistration', { ...VALID.SlotRegistration, capabilities: ['run_shell'] }, 'an invented capability'],
  ['SupervisorRegistration', { ...VALID.SupervisorRegistration, declared_slots: 11 }, 'more than ten declared slots'],
  ['SlotLease', { ...VALID.SlotLease, fence_token: 0 }, 'a fence token below one'],
  ['AutomationEvent', { ...VALID.AutomationEvent, detail: { body: { nested: 'object' } } }, 'a nested detail payload'],
  ['AutomationEvent', { ...VALID.AutomationEvent, kind: 'anything_goes' }, 'an unknown event kind'],
];
for (const [name, value, why] of MALFORMED) {
  check(`${name} rejects ${why}`, C[name].safeParse(value).success === false);
}

section('4. Malformed JSON is a parse failure, never a partial object');

for (const text of ['{ not json', '[]', 'null', '"a string"', '42']) {
  let parsed;
  let threw = false;
  try {
    parsed = JSON.parse(text);
  } catch {
    threw = true;
  }
  const rejected = threw || C.AutomationTask.safeParse(parsed).success === false;
  check(`rejects ${JSON.stringify(text).slice(0, 20)}`, rejected);
}

section('5. The four distinctions the design rests on');

check('unknown is not false: a tri-state refuses a boolean',
  C.Tristate.safeParse(false).success === false && C.Tristate.safeParse('unknown').success);
check('rejected is distinct from not-yet-evaluated',
  C.EligibilityDecision.safeParse({ ...VALID.EligibilityDecision, outcome: 'undetermined' }).success &&
  C.EligibilityDecision.safeParse({ ...VALID.EligibilityDecision, outcome: 'ineligible' }).success);
check('manual review is not a failure',
  C.AutomationTaskResult.safeParse({
    ...VALID.AutomationTaskResult, outcome: 'manual_review',
    safety: VALID.SafetyDecision, confirmation_reference: null,
  }).success);
check('a failure must say whether it is retryable',
  C.AutomationTaskResult.safeParse({
    ...VALID.AutomationTaskResult, outcome: 'failed', failure_kind: null,
    confirmation_reference: null,
  }).success === false);
check('  and a retryable failure is accepted',
  C.AutomationTaskResult.safeParse({
    ...VALID.AutomationTaskResult, outcome: 'failed', failure_kind: 'retryable',
    failure_code: 'network', confirmation_reference: null, safety: null,
  }).success);
check('paused is distinct from cancelled',
  C.AutomationTaskResult.safeParse({ ...VALID.AutomationTaskResult, outcome: 'paused', confirmation_reference: null }).success &&
  C.AutomationTaskResult.safeParse({ ...VALID.AutomationTaskResult, outcome: 'cancelled', confirmation_reference: null }).success);
check('submitted requires a confirmation reference',
  C.AutomationTaskResult.safeParse({ ...VALID.AutomationTaskResult, confirmation_reference: null }).success === false,
  'otherwise it is submission_unknown');
check('submission_unknown is its own outcome',
  C.AutomationTaskResult.safeParse({
    ...VALID.AutomationTaskResult, outcome: 'submission_unknown', confirmation_reference: null,
  }).success);

section('6. The action vocabulary is closed');

for (const action of ['eval', 'execute_javascript', 'run_shell', 'navigate', 'download_file', 'screenshot']) {
  check(`"${action}" is not an automation action`,
    C.AutomationAction.safeParse(action).success === false);
}
check('the permitted actions are exactly the nine defined', C.AUTOMATION_ACTIONS.length === 9);
check('a step may not carry free-text values',
  C.AutomationTask.safeParse({
    ...VALID.AutomationTask,
    steps: [{ action: 'fill_known_field', field: 'first_name', fact_key: null, value: 'Robert; DROP TABLE' }],
  }).success === false);

section('7. SafetyDecision is internally consistent');

check('a stop must name a reason',
  C.SafetyDecision.safeParse({ ...VALID.SafetyDecision, reasons: [] }).success === false);
check('proceeding must name none',
  C.SafetyDecision.safeParse({ decided_at: iso(), action: 'proceed', reasons: ['captcha'], requires_human: false }).success === false);
check('proceeding cannot require a human',
  C.SafetyDecision.safeParse({ decided_at: iso(), action: 'proceed', reasons: [], requires_human: true }).success === false);
check('a clean proceed validates',
  C.SafetyDecision.safeParse({ decided_at: iso(), action: 'proceed', reasons: [], requires_human: false }).success);

/* ======================================================= STATE MACHINE */

section('8. Every state and transition');

check('all fifteen states are defined', SM.AGENT_STATES.length === 15, SM.AGENT_STATES.length);
for (const s of ['received','validated','snapshot_stored','normalized','scored','rejected','queued','leased','processing','manual_review','ready_to_submit','submitted','failed','duplicate','cancelled']) {
  check(`  ${s} exists`, SM.isAgentState(s));
}

const VALID_EDGES = [
  ['received','validated'], ['received','rejected'], ['received','duplicate'],
  ['validated','snapshot_stored'], ['snapshot_stored','normalized'],
  ['normalized','scored'], ['normalized','rejected'],
  ['scored','queued'], ['scored','rejected'],
  ['queued','leased'], ['leased','processing'], ['leased','queued'],
  ['processing','manual_review'], ['processing','ready_to_submit'], ['processing','failed'],
  ['manual_review','ready_to_submit'], ['ready_to_submit','submitted'],
  ['failed','queued'], ['failed','manual_review'],
];
for (const [a, b] of VALID_EDGES) {
  check(`  ${a} -> ${b} is allowed`, SM.canTransition(a, b));
}

section('9. Invalid transitions fail closed');

const INVALID_EDGES = [
  ['received','submitted'], ['queued','submitted'], ['processing','submitted'],
  ['failed','submitted'], ['manual_review','submitted'],
  ['submitted','processing'], ['submitted','queued'], ['submitted','failed'],
  ['cancelled','queued'], ['cancelled','processing'], ['duplicate','queued'],
  ['rejected','queued'], ['rejected','scored'],
  ['scored','submitted'], ['validated','normalized'], ['received','processing'],
];
for (const [a, b] of INVALID_EDGES) {
  check(`  ${a} -> ${b} is refused`, SM.canTransition(a, b) === false);
}

check('an unknown source state is refused', SM.canTransition('made_up', 'queued') === false);
check('an unknown target state is refused', SM.canTransition('queued', 'made_up') === false);
check('a null state is refused', SM.canTransition(null, 'queued') === false);
check('terminal states have no exits',
  SM.TERMINAL_STATES.every((s) => SM.TRANSITIONS[s].length === 0),
  SM.TERMINAL_STATES.join(', '));
check('transition() explains a refusal', SM.transition('submitted', 'queued').reason === 'terminal');
check('  and an unknown state', SM.transition('nope', 'queued').reason === 'unknown_state');
check('  and a disallowed edge', SM.transition('queued', 'submitted').reason === 'not_allowed');
check('a permitted transition returns the new state', SM.transition('queued', 'leased').state === 'leased');

section('10. Retries are bounded, idempotent and honest about permanence');

check('a retryable failure with attempts left may retry',
  SM.isRetryAllowed({ state: 'failed', attempt: 1, max_attempts: 3, failure_kind: 'retryable' }).retry);
check('a permanent failure never retries',
  SM.isRetryAllowed({ state: 'failed', attempt: 0, max_attempts: 3, failure_kind: 'permanent' }).reason === 'permanent');
check('exhausted attempts stop',
  SM.isRetryAllowed({ state: 'failed', attempt: 3, max_attempts: 3, failure_kind: 'retryable' }).reason === 'attempts_exhausted');
check('a submitted task never retries',
  SM.isRetryAllowed({ state: 'submitted', attempt: 0, max_attempts: 3, failure_kind: 'retryable' }).reason === 'terminal');
check('a cancelled task never retries',
  SM.isRetryAllowed({ state: 'cancelled', attempt: 0, max_attempts: 3, failure_kind: 'retryable' }).reason === 'terminal');
check('a task that has not failed is not retried',
  SM.isRetryAllowed({ state: 'processing', attempt: 0, max_attempts: 3, failure_kind: null }).reason === 'not_failed');
check('a retry reuses the idempotency key, so replay is a no-op',
  C.AutomationTask.safeParse({ ...VALID.AutomationTask, attempt: 1 }).success &&
  VALID.AutomationTask.idempotency_key === key);

section('11. A stale slot cannot submit');

const now = new Date(1_800_000_060_000);
const live = { slot_id: uuid(7), expires_at: new Date(now.getTime() + 30_000).toISOString(), fence_token: 5 };
const base = { current_fence_token: 5, slot_id: uuid(7), now };

check('a live, current lease is valid', SM.isLeaseValid({ ...base, lease: live }).valid);
check('an expired lease is refused',
  SM.isLeaseValid({ ...base, lease: { ...live, expires_at: new Date(now.getTime() - 1).toISOString() } }).reason === 'expired');
check('a lease expiring exactly now is refused',
  SM.isLeaseValid({ ...base, lease: { ...live, expires_at: now.toISOString() } }).reason === 'expired');
check('a stale fence token is refused even while unexpired',
  SM.isLeaseValid({ ...base, lease: { ...live, fence_token: 4 } }).reason === 'stale_fence',
  'the slot cannot notice its own expiry, so the control plane decides');
check('another slot holding the lease is refused',
  SM.isLeaseValid({ ...base, lease: { ...live, slot_id: uuid(99) } }).reason === 'wrong_slot',
  'a sibling slot under the same supervisor is still the wrong slot');
check('no lease at all is refused', SM.isLeaseValid({ ...base, lease: null }).reason === 'no_lease');
check('a malformed expiry is refused',
  SM.isLeaseValid({ ...base, lease: { ...live, expires_at: 'soon' } }).reason === 'expired');

check('submitting needs a valid lease AND ready_to_submit',
  SM.canSubmit({ ...base, lease: live, state: 'ready_to_submit' }).valid);
check('  a stale slot cannot submit',
  SM.canSubmit({ ...base, lease: { ...live, fence_token: 1 }, state: 'ready_to_submit' }).reason === 'stale_fence');
check('  an expired slot cannot submit',
  SM.canSubmit({ ...base, lease: { ...live, expires_at: new Date(now.getTime() - 1000).toISOString() }, state: 'ready_to_submit' }).reason === 'expired');
check('  a valid lease in the wrong state cannot submit',
  SM.canSubmit({ ...base, lease: live, state: 'processing' }).reason === 'not_ready');
check('  a valid lease on an already-submitted task cannot submit',
  SM.canSubmit({ ...base, lease: live, state: 'submitted' }).reason === 'not_ready');

/* ============================================================= SAFETY */

section('12. No safety rule fails open');

const S = SAFETY.evaluateSafety;
check('the safe baseline proceeds', S(SAFETY.SAFE_BASELINE).action === 'proceed',
  JSON.stringify(S(SAFETY.SAFE_BASELINE).reasons));

const HAZARDS = [
  ['captcha_present', 'captcha'],
  ['mfa_required', 'mfa_required'],
  ['legal_attestation_present', 'legal_attestation'],
  ['demographic_question_present', 'protected_demographic_question'],
  ['application_fee_present', 'application_fee'],
  ['external_contact_requested', 'external_contact_requested'],
  ['anti_bot_warning_present', 'anti_bot_warning'],
];
for (const [field, reason] of HAZARDS) {
  const yes = S({ ...SAFETY.SAFE_BASELINE, [field]: 'yes' });
  check(`${field}=yes stops with ${reason}`, yes.action === 'stop' && yes.reasons.includes(reason));
  const unknown = S({ ...SAFETY.SAFE_BASELINE, [field]: 'unknown' });
  check(`  ${field}=unknown ALSO stops (never fails open)`,
    unknown.action === 'stop' && unknown.reasons.includes(reason));
}

const CAPABILITIES = [
  ['all_controls_supported', 'unsupported_ats_control'],
  ['submission_state_confirmed', 'ambiguous_submission_state'],
];
for (const [field, reason] of CAPABILITIES) {
  check(`${field}=no stops with ${reason}`,
    S({ ...SAFETY.SAFE_BASELINE, [field]: 'no' }).reasons.includes(reason));
  check(`  ${field}=unknown ALSO stops`,
    S({ ...SAFETY.SAFE_BASELINE, [field]: 'unknown' }).reasons.includes(reason));
}

check('an unverified required fact stops',
  S({ ...SAFETY.SAFE_BASELINE, unverified_required_facts: ['visa_status'] }).reasons.includes('unknown_candidate_fact'));
check('a pay question without configuration stops',
  S({ ...SAFETY.SAFE_BASELINE, compensation_question_present: 'yes', compensation_configured: false })
    .reasons.includes('compensation_not_configured'));
check('  a pay question WITH configuration proceeds',
  S({ ...SAFETY.SAFE_BASELINE, compensation_question_present: 'yes', compensation_configured: true }).action === 'proceed');
check('  an UNKNOWN pay question without configuration still stops',
  S({ ...SAFETY.SAFE_BASELINE, compensation_question_present: 'unknown', compensation_configured: false })
    .reasons.includes('compensation_not_configured'));
check('a missing résumé stops', S({ ...SAFETY.SAFE_BASELINE, has_resume: false }).reasons.includes('missing_resume'));
check('an incomplete profile stops', S({ ...SAFETY.SAFE_BASELINE, profile_complete: false }).reasons.includes('profile_incomplete'));

section('13. Kill switch, quotas and budget');

check('the kill switch stops', S({ ...SAFETY.SAFE_BASELINE, kill_switch_engaged: true }).reasons.includes('kill_switch'));
check('the daily quota stops at the limit, not past it',
  S({ ...SAFETY.SAFE_BASELINE, applications_today: 50, daily_quota: 50 }).reasons.includes('daily_quota_exceeded'));
check('  one under the daily quota proceeds',
  S({ ...SAFETY.SAFE_BASELINE, applications_today: 49, daily_quota: 50 }).action === 'proceed');
check('the monthly quota stops at the limit',
  S({ ...SAFETY.SAFE_BASELINE, applications_this_month: 500, monthly_quota: 500 }).reasons.includes('monthly_quota_exceeded'));
check('the budget stops at the limit',
  S({ ...SAFETY.SAFE_BASELINE, spend_usd_this_month: 25, monthly_budget_usd: 25 }).reasons.includes('budget_exceeded'));
check('  one cent under the budget proceeds',
  S({ ...SAFETY.SAFE_BASELINE, spend_usd_this_month: 24.99, monthly_budget_usd: 25 }).action === 'proceed');

check('every reason is reachable',
  SAFETY.ALL_STOP_REASONS.every((r) => {
    const all = S({
      ...SAFETY.SAFE_BASELINE,
      captcha_present: 'yes', mfa_required: 'yes', legal_attestation_present: 'yes',
      demographic_question_present: 'yes', application_fee_present: 'yes',
      external_contact_requested: 'yes', anti_bot_warning_present: 'yes',
      sensitive_information_requested: 'yes', page_recognised: 'no', site_supported: 'no',
      employer_authenticated: 'no',
      mode: 'claude_max_assisted', claude_max_authenticated: 'no',
      all_controls_supported: 'no', submission_state_confirmed: 'no',
      compensation_question_present: 'yes', compensation_configured: false,
      unverified_required_facts: ['x'], has_resume: false, profile_complete: false,
      kill_switch_engaged: true, applications_today: 99, applications_this_month: 999,
      spend_usd_this_month: 999,
    });
    return all.reasons.includes(r);
  }),
  `${SAFETY.ALL_STOP_REASONS.length} reasons`);
check('every stop requires a human', S({ ...SAFETY.SAFE_BASELINE, captcha_present: 'yes' }).requires_human === true);
check('a proceed does not', S(SAFETY.SAFE_BASELINE).requires_human === false);
check('all reasons are collected, not just the first',
  S({ ...SAFETY.SAFE_BASELINE, captcha_present: 'yes', mfa_required: 'yes', has_resume: false }).reasons.length === 3);

/* ============================================================== URLS */

section('14. Candidate URLs: accepted');

for (const [input, expected] of [
  ['https://boards.greenhouse.io/acme/jobs/1', 'https://boards.greenhouse.io/acme/jobs/1'],
  ['https://JOBS.example.com/role', 'https://jobs.example.com/role'],
  ['https://jobs.example.com:443/role', 'https://jobs.example.com/role'],
  ['https://jobs.example.com/role#apply', 'https://jobs.example.com/role'],
  ['https://jobs.example.com/role?utm_source=x&id=7', 'https://jobs.example.com/role?id=7'],
  ['https://jobs.example.com/role?b=2&a=1', 'https://jobs.example.com/role?a=1&b=2'],
  // A bare origin keeps its root slash. This module used to strip it; the one
  // canonical normalizer in lib/jobs/url.ts does not, and it is the one the
  // database's uniqueness constraint is built on. See scripts/test-job-dedupe.mjs.
  ['https://jobs.example.com', 'https://jobs.example.com/'],
]) {
  const r = URLS.validateJobUrl(input);
  check(`canonicalises ${input.slice(0, 46)}`, r.ok && r.canonical === expected,
    r.ok ? r.canonical : r.reason);
}

section('15. Candidate URLs: refused');

const BAD_URLS = [
  ['http://jobs.example.com/role', 'scheme_not_https'],
  ['ftp://jobs.example.com/role', 'scheme_not_https'],
  ['javascript:alert(1)', 'scheme_not_https'],
  ['file:///etc/passwd', 'scheme_not_https'],
  ['https://user:pass@jobs.example.com/role', 'credentials_in_url'],
  ['https://127.0.0.1/x', 'loopback'],
  ['https://127.0.0.1:54322/x', 'port_not_allowed'],
  ['https://[::1]/x', 'loopback'],
  ['https://10.0.0.5/x', 'private_network'],
  ['https://172.16.4.4/x', 'private_network'],
  ['https://192.168.1.1/x', 'private_network'],
  ['https://169.254.169.254/latest/meta-data/', 'link_local'],
  ['https://100.64.1.1/x', 'private_network'],
  ['https://[fd00::1]/x', 'unique_local'],
  ['https://[fe80::1]/x', 'link_local'],
  ['https://[::ffff:127.0.0.1]/x', 'loopback'],
  ['https://8.8.8.8/x', 'ip_literal_not_allowed'],
  ['https://localhost/x', 'reserved_tld'],
  ['https://api.internal/x', 'reserved_tld'],
  ['https://thing.local/x', 'reserved_tld'],
  ['https://foo.test/x', 'reserved_tld'],
  ['https://intranet/x', 'hostname_not_public'],
  ['https://jobs.example.com:8080/x', 'port_not_allowed'],
  ['not a url', 'not_a_url'],
  ['', 'empty'],
  ['https://jobs.example.com/' + 'a'.repeat(3000), 'too_long'],
];
for (const [input, reason] of BAD_URLS) {
  const r = URLS.validateJobUrl(input);
  check(`refuses ${input.slice(0, 44) || '(empty)'}`, !r.ok && r.reason === reason,
    r.ok ? 'ACCEPTED' : r.reason);
}
check('a non-string is refused', URLS.validateJobUrl(null).ok === false);
check('an object is refused', URLS.validateJobUrl({ url: 'https://x.com' }).ok === false);

section('16. Redirects are re-validated, never trusted');

check('a safe cross-host redirect is allowed',
  URLS.validateRedirect('https://greenhouse.io/a', 'https://boards.greenhouse.io/b', 1).ok);
check('  and is reported as cross-host',
  URLS.validateRedirect('https://greenhouse.io/a', 'https://boards.greenhouse.io/b', 1).crossHost === true);
check('a redirect to loopback is refused',
  URLS.validateRedirect('https://jobs.example.com/a', 'https://127.0.0.1/x', 1).reason === 'loopback');
check('a redirect to metadata is refused',
  URLS.validateRedirect('https://jobs.example.com/a', 'https://169.254.169.254/', 1).reason === 'link_local');
check('a redirect to http is refused',
  URLS.validateRedirect('https://jobs.example.com/a', 'http://jobs.example.com/b', 1).reason === 'scheme_not_https');
check('too many hops is refused',
  URLS.validateRedirect('https://a.example.com/a', 'https://b.example.com/b', 6).reason === 'too_many_redirects');

/* ====================================================== USAGE WRITER */

section('17. The usage writer records metadata and nothing else');

const USAGE = {
  provider: 'openrouter', model: 'google/gemini-2.5-flash', operation: 'resume_extraction',
  status: 'succeeded', failure_class: null, failure_code: null, latency_ms: 1200, attempts: 1,
  prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200, cost_usd: 0.0003,
  provider_request_id: 'gen-1', correlation_id: uuid(3),
};

function fakeClient(behaviour) {
  const captured = [];
  return {
    captured,
    from() {
      return {
        insert(row) {
          captured.push(row);
          return {
            select() {
              return {
                maybeSingle: async () => behaviour ?? { data: { id: uuid(11) }, error: null },
              };
            },
          };
        },
      };
    },
  };
}

{
  const client = fakeClient();
  const r = await WRITER.recordProviderUsage(USAGE, uuid(1), client);
  check('a valid record writes', r.ok, r.ok ? r.id : `${r.reason}: ${r.detail}`);
  const row = client.captured[0];
  check('  exactly the expected columns are written',
    JSON.stringify(Object.keys(row).sort()) === JSON.stringify([...WRITER.USAGE_ROW_KEYS].sort()),
    Object.keys(row).join(', '));
  check('  the candidate is recorded', row.user_id === uuid(1));
  check('  created_at is left to the database', !('created_at' in row));
}

{
  // The rule that matters: content cannot ride along, even if a caller tries.
  const client = fakeClient();
  const hostile = {
    ...USAGE,
    prompt: 'Jane Doe, 12 Example Road, +65 8123 4567, employment history...',
    raw_response: '{"choices":[...]}',
    // Assembled, not written out: a literal OpenRouter-shaped key here is a
    // finding in the repository's own history scan. gitleaks caught exactly
    // that, which is the check working.
    api_key: 'sk-' + 'or-v1-' + 'f'.repeat(24),
  };
  const r = await WRITER.recordProviderUsage(hostile, uuid(1), client);
  check('a record carrying a prompt is refused', !r.ok && r.reason === 'invalid_record');
  check('  nothing was written', client.captured.length === 0);
  check('  the error names fields, not values',
    !r.ok && !r.detail.includes('Jane') && !r.detail.includes('sk-or'),
    r.ok ? '' : r.detail);
}

for (const [field] of [['prompt'], ['messages'], ['response'], ['resume_text'], ['headers'], ['authorization']]) {
  const client = fakeClient();
  const r = await WRITER.recordProviderUsage({ ...USAGE, [field]: 'secret content' }, uuid(1), client);
  check(`a "${field}" field is refused`, !r.ok && r.reason === 'invalid_record');
  check(`  and nothing reaches the database`, client.captured.length === 0);
}

{
  const client = fakeClient({ data: null, error: { code: '23514', message: 'violates check constraint on row (Jane Doe, ...)' } });
  const r = await WRITER.recordProviderUsage(USAGE, uuid(1), client);
  check('a database rejection is reported', !r.ok && r.reason === 'rejected_by_database');
  check('  by code only, never the message',
    !r.ok && r.detail === '23514' && !r.detail.includes('Jane'),
    r.ok ? '' : r.detail);
}

{
  const client = { from() { throw new TypeError('connection lost'); } };
  const r = await WRITER.recordProviderUsage(USAGE, uuid(1), client);
  check('an unexpected error is caught, never thrown', !r.ok && r.reason === 'unexpected');
}

{
  const client = fakeClient({ data: null, error: null });
  const r = await WRITER.recordProviderUsage(USAGE, uuid(1), client);
  check('an insert returning no id is a failure, not a silent success', !r.ok && r.reason === 'unexpected');
}

{
  const client = fakeClient();
  const r = await WRITER.recordProviderUsage({ ...USAGE, status: 'not_attempted', failure_class: null }, uuid(1), client);
  check('the succeeded/reason invariant is enforced before the database', !r.ok && r.reason === 'invalid_record');
}

{
  const client = fakeClient();
  const r = await WRITER.recordProviderUsage(
    { ...USAGE, status: 'not_attempted', failure_class: 'model_error', failure_code: 'not_configured',
      attempts: 0, prompt_tokens: null, completion_tokens: null, total_tokens: null,
      cost_usd: null, provider_request_id: null },
    null, client);
  check('a refused call records with a null candidate', r.ok);
  check('  user_id is null, and the accounting still exists', client.captured[0]?.user_id === null);
}

section('18. Cross-candidate boundaries are stated in the contracts');

check('a lease names its candidate', 'candidate_id' in VALID.SlotLease);
check('a supervisor registers against one candidate', 'candidate_id' in VALID.SupervisorRegistration);
check('a slot registers against one candidate', 'candidate_id' in VALID.SlotRegistration);
check('a task names its candidate', 'candidate_id' in VALID.AutomationTask);
check('an event names its candidate', 'candidate_id' in VALID.AutomationEvent);
check('a lease for another candidate is still schema-valid but is an authorization concern',
  C.SlotLease.safeParse({ ...VALID.SlotLease, candidate_id: uuid(42) }).success,
  'enforced by RLS at the database, documented in WORKER-PROTOCOL.md');

section('19. No forbidden capability is referenced anywhere in lib/agent');

{
  const files = [
    'contracts.ts',
    'state-machine.ts',
    'safety.ts',
    'job-url.ts',
    'worker-state.ts',
    'ai-mode.ts',
  ];
  /*
   * The patterns are assembled from pieces rather than written out, following
   * the convention scripts/test-secret-scan.mjs already uses.
   *
   * This file is itself scanned — by the repository's provider check and by
   * gitleaks over full history. Writing the vendor host out in full, even in a
   * comment, made the provider suite report THIS file as an offender, and CI
   * caught it. Building the needle at runtime keeps the haystack honest.
   */
  const ANTHROPIC_PKG = '@anthropic' + '-ai/sdk';
  const ANTHROPIC_ENV = 'ANTHROPIC' + '_API_KEY';
  const ANTHROPIC_HOST = 'api.' + 'anthropic' + '.com';

  const forbidden = [
    [new RegExp(ANTHROPIC_PKG.replace('/', '\\/')), ANTHROPIC_PKG],
    [new RegExp(ANTHROPIC_ENV), ANTHROPIC_ENV],
    [new RegExp(ANTHROPIC_HOST.replace(/\./g, '\\.')), ANTHROPIC_HOST],
    [/\bfetch\s*\(/, 'a network call'],
    [/child_process/, 'a shell'],
    [/\beval\s*\(/, 'eval'],
    [/localStorage|document\.cookie/, 'browser storage'],
    [/puppeteer|playwright/, 'a browser driver'],
  ];
  for (const f of files) {
    const src = readFileSync(path.join(ROOT, 'lib', 'agent', f), 'utf8');
    for (const [re, what] of forbidden) {
      check(`lib/agent/${f} contains no ${what}`, !re.test(src));
    }
  }
}

/* ---------------------------------------------------------------- report */

console.log('\n========================================================');
if (failed === 0) {
  console.log(`ALL ${passed} AGENT CONTROL-PLANE CHECKS PASSED`);
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
