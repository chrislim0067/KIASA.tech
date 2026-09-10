/**
 * The worker protocol, offline.
 *
 *   npm run test:worker
 *
 * Pure. No network, no database, no browser, no supervisor, no slot, no
 * provider. Every input is a plain value. Nothing here starts anything.
 *
 * WHAT THIS IS FOR
 *
 * Milestone 2A decided three things, and this is where they are held to:
 *
 *   1. Two AI modes, and only two. OpenRouter is the backend provider; Claude
 *      Max is the CANDIDATE's own session and is reached by preparing a prompt
 *      and accepting a pasted answer — never by the backend calling anything.
 *
 *   2. One supervisor, up to ten INDEPENDENT slots. The earlier draft modelled
 *      one worker with one `current_task_id`, which cannot describe ten slots
 *      doing ten different things. The supervisor heartbeat now carries no
 *      task id at all, and this proves it.
 *
 *   3. Readiness, authentication and stop states are separate vocabularies. A
 *      login wall, a challenge, an MFA prompt or an unrecognised page is a
 *      STOP — never a form to type into, and never something to work around.
 *
 * The properties that would do the most damage if wrong, in order: a stale
 * slot completing a task; a duplicate completion becoming a second real
 * application; a stop state being treated as ready; a credential reaching a
 * heartbeat.
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
const W = await import('../lib/agent/worker-state.ts');
const MODE = await import('../lib/agent/ai-mode.ts');
const SAFETY = await import('../lib/agent/safety.ts');

const uuid = (n = 1) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const iso = (offsetMs = 0) => new Date(1_800_000_000_000 + offsetMs).toISOString();
const key = (n) => `idem_0123456789abcde${n}`;

const SUPERVISOR = uuid(100);
const CANDIDATE = uuid(1);

/* ==================================================== 1-3. THE TWO AI MODES */

section('1. openrouter_only routes backend reasoning to OpenRouter');

{
  const table = MODE.routingTable('openrouter_only');
  const modelCapabilities = MODE.AI_CAPABILITIES.filter((c) => c !== 'eligibility_evaluation');

  for (const capability of modelCapabilities) {
    check(`${capability} routes to openrouter`, table[capability].destination === 'openrouter');
  }
  check('the credential is held in the server environment',
    modelCapabilities.every((c) => table[c].credential_holder === 'server_environment'),
    'never in a row, a browser, a heartbeat or a worker');
  check('the mode uses a server-held credential',
    MODE.usesServerHeldCredential('openrouter_only') === true);
  check('no capability routes to a Claude paste console in this mode',
    Object.values(table).every((r) => r.destination !== 'candidate_claude_max_paste'));
}

section('2. claude_max_assisted routes model work to the candidate paste console');

{
  const table = MODE.routingTable('claude_max_assisted');
  const modelCapabilities = MODE.AI_CAPABILITIES.filter((c) => c !== 'eligibility_evaluation');

  for (const capability of modelCapabilities) {
    check(`${capability} routes to the candidate paste console`,
      table[capability].destination === 'candidate_claude_max_paste');
  }
  check('the candidate holds their own session; the backend holds nothing',
    modelCapabilities.every((r) => table[r].credential_holder === 'candidate_own_session'));
  check('the mode uses NO server-held credential',
    MODE.usesServerHeldCredential('claude_max_assisted') === false,
    'the backend never holds a Claude credential');
  check('nothing in this mode reaches a backend provider at all',
    Object.values(table).every((r) => r.destination !== 'openrouter'),
    'openrouter is the only backend provider destination, and this mode uses none of it');
}

section('3. Eligibility is never decided by a model, in either mode');

for (const mode of ['openrouter_only', 'claude_max_assisted']) {
  const routing = MODE.routeCapability(mode, 'eligibility_evaluation');
  check(`${mode}: eligibility routes to deterministic_rules`,
    routing.destination === 'deterministic_rules');
  check(`  ${mode}: it holds no credential`, routing.credential_holder === 'none');
}
check('the contract cannot express a model having decided eligibility',
  C.EligibilityDecision.safeParse({
    job_id: uuid(2), candidate_id: CANDIDATE, decided_at: iso(),
    outcome: 'eligible', reasons: [], evaluator: 'openrouter',
  }).success === false,
  'evaluator is a literal, not an enum');

section('4. Only the assisted mode can require a Claude session');

check('openrouter_only does not require a Claude session',
  MODE.requiresClaudeSession('openrouter_only') === false);
check('claude_max_assisted does', MODE.requiresClaudeSession('claude_max_assisted') === true);

{
  const base = { mode: 'openrouter_only', employer_session: 'authenticated' };
  check('openrouter_only never raises claude_authentication_required',
    W.requiredPauseReasons({ ...base, claude_max_session: 'not_applicable' }).length === 0);
  check('  not even when the Claude session is reported unauthenticated',
    W.requiredPauseReasons({ ...base, claude_max_session: 'not_authenticated' }).length === 0,
    'asking a candidate to fix something irrelevant to the work is not a safety stop');

  const assisted = { mode: 'claude_max_assisted', employer_session: 'authenticated' };
  check('claude_max_assisted raises it when not signed in',
    W.requiredPauseReasons({ ...assisted, claude_max_session: 'not_authenticated' })
      .includes('claude_authentication_required'));
  check('  and when the session state is unknown (fails closed)',
    W.requiredPauseReasons({ ...assisted, claude_max_session: 'unknown' })
      .includes('claude_authentication_required'));
  check('  and not when it is authenticated',
    W.requiredPauseReasons({ ...assisted, claude_max_session: 'authenticated' }).length === 0);
}

{
  const valid = {
    slot_id: uuid(7), candidate_id: CANDIDATE, checked_at: iso(),
    mode: 'openrouter_only', employer_session: 'authenticated',
    employer_host: 'boards.greenhouse.io', claude_max_session: 'not_applicable',
  };
  check('SlotAuthenticationState accepts a valid openrouter_only report',
    C.SlotAuthenticationState.safeParse(valid).success);
  check('  openrouter_only reporting a real Claude session is rejected',
    C.SlotAuthenticationState.safeParse({ ...valid, claude_max_session: 'authenticated' })
      .success === false,
    'there is no Claude session in that mode to report on');
  check('  claude_max_assisted reporting not_applicable is rejected',
    C.SlotAuthenticationState.safeParse({
      ...valid, mode: 'claude_max_assisted', claude_max_session: 'not_applicable',
    }).success === false);
  check('  claude_max_assisted reporting a real state is accepted',
    C.SlotAuthenticationState.safeParse({
      ...valid, mode: 'claude_max_assisted', claude_max_session: 'unknown',
    }).success);
}

/* ============================================ 5-9. STOPS, NEVER WORKAROUNDS */

section('5. Employer authentication required is a stop, not a form');

{
  const S = SAFETY.evaluateSafety;
  check('a signed-out employer session stops',
    S({ ...SAFETY.SAFE_BASELINE, employer_authenticated: 'no' })
      .reasons.includes('employer_authentication_required'));
  check('  an UNKNOWN session also stops (never fails open)',
    S({ ...SAFETY.SAFE_BASELINE, employer_authenticated: 'unknown' })
      .reasons.includes('employer_authentication_required'),
    'a login page renders inputs and a submit button, exactly like a form');
  check('  a confirmed session proceeds',
    S({ ...SAFETY.SAFE_BASELINE, employer_authenticated: 'yes' }).action === 'proceed');
}

section('6-9. Challenges, MFA, sensitive data, unknown pages and unsupported sites');

{
  const S = SAFETY.evaluateSafety;
  const CASES = [
    ['captcha_present', 'captcha', 'a CAPTCHA'],
    ['anti_bot_warning_present', 'anti_bot_warning', 'an anti-bot warning'],
    ['mfa_required', 'mfa_required', 'an MFA prompt'],
    ['sensitive_information_requested', 'sensitive_information_requested', 'a request for sensitive data'],
  ];
  for (const [field, reason, what] of CASES) {
    check(`${what} stops`, S({ ...SAFETY.SAFE_BASELINE, [field]: 'yes' }).reasons.includes(reason));
    check(`  ${what} unestablished ALSO stops`,
      S({ ...SAFETY.SAFE_BASELINE, [field]: 'unknown' }).reasons.includes(reason));
  }

  const CAPABILITY_CASES = [
    ['page_recognised', 'unknown_page', 'an unrecognised page'],
    ['site_supported', 'unsupported_site', 'an unsupported site'],
  ];
  for (const [field, reason, what] of CAPABILITY_CASES) {
    check(`${what} stops`, S({ ...SAFETY.SAFE_BASELINE, [field]: 'no' }).reasons.includes(reason));
    check(`  ${what} unestablished ALSO stops`,
      S({ ...SAFETY.SAFE_BASELINE, [field]: 'unknown' }).reasons.includes(reason));
  }

  check('every stop requires a human',
    S({ ...SAFETY.SAFE_BASELINE, captcha_present: 'yes' }).requires_human === true,
    'a stop is the system working, not a failure to retry');
}

section('10. Every observation maps to a control-plane decision');

{
  const map = W.PAUSE_REASON_TO_SAFETY;
  check('the mapping is total over the pause reasons',
    C.WORKER_PAUSE_REASONS.every((r) => r in map),
    `${C.WORKER_PAUSE_REASONS.length} reasons`);
  const nulls = C.WORKER_PAUSE_REASONS.filter((r) => map[r] === null);
  check('exactly one reason is not a page observation', nulls.length === 1, nulls.join(','));
  check('  and it is control_plane_paused', nulls[0] === 'control_plane_paused');
  check('every other reason maps to a real SafetyStopReason',
    C.WORKER_PAUSE_REASONS.filter((r) => map[r] !== null)
      .every((r) => C.SAFETY_STOP_REASONS.includes(map[r])));
  check('no pause reason means "retry" or "work around it"',
    C.WORKER_PAUSE_REASONS.every((r) => !/bypass|solve|evade|retry|ignore/i.test(r)));
}

section('11. Every state the milestone requires is represented');

{
  const vocabularies = {
    supervisor_lifecycle: C.SUPERVISOR_LIFECYCLE_STATES,
    slot_readiness: C.SLOT_READINESS_STATES,
    pause_reason: C.WORKER_PAUSE_REASONS,
    task_event: C.TASK_EVENT_KINDS,
  };
  const coverage = Object.entries(C.REQUIRED_STATE_COVERAGE);
  check('fifteen required states are claimed', coverage.length === 15, `${coverage.length}`);
  for (const [required, { vocabulary, member }] of coverage) {
    check(`${required} -> ${vocabulary}.${member}`,
      Array.isArray(vocabularies[vocabulary]) && vocabularies[vocabulary].includes(member));
  }
  check('stop reasons are their own vocabulary, separate from pauses',
    C.WORKER_STOP_REASONS.length > 0 &&
      C.WORKER_STOP_REASONS.every((r) => !C.WORKER_PAUSE_REASONS.includes(r)),
    'shutting a slot down is not the same as pausing a task');
}

/* ================================================ 12-15. SUPERVISOR AND SLOTS */

section('12. One supervisor, ten independent slots');

const slotState = (state, extra = {}) => ({ state, since: iso(), ...extra });

const tenSlots = Array.from({ length: 10 }, (_, i) => ({
  slot_id: uuid(200 + i),
  slot_index: i + 1,
  readiness: 'working',
  task_id: uuid(300 + i),
}));

{
  for (let i = 0; i < 10; i++) {
    const reg = {
      slot_id: uuid(200 + i), supervisor_id: SUPERVISOR, candidate_id: CANDIDATE,
      slot_index: i + 1, capabilities: ['form_fill', 'file_upload'],
      browser_context_id: `ctx-${i + 1}`, registered_at: iso(),
    };
    check(`slot ${i + 1} registers independently`, C.SlotRegistration.safeParse(reg).success);
  }
  check('an eleventh slot is refused',
    C.SlotRegistration.safeParse({
      slot_id: uuid(211), supervisor_id: SUPERVISOR, candidate_id: CANDIDATE,
      slot_index: 11, capabilities: ['form_fill'],
      browser_context_id: 'ctx-11', registered_at: iso(),
    }).success === false,
    'ten is the design ceiling, and none of them run yet');

  const summary = {
    supervisor_id: SUPERVISOR, candidate_id: CANDIDATE, sent_at: iso(), sequence: 4,
    lifecycle: 'running', slots: tenSlots, ...W.summariseSlots(tenSlots),
  };
  check('a supervisor summary with ten working slots is valid',
    C.SupervisorHeartbeat.safeParse(summary).success,
    JSON.stringify(C.SupervisorHeartbeat.safeParse(summary).error?.issues?.[0]?.message ?? ''));
  check('  it reports ten working slots', summary.slots_working === 10);
  check('  ten distinct task ids, not one',
    new Set(summary.slots.map((s) => s.task_id)).size === 10);
}

section('13. The supervisor heartbeat cannot name a single current task');

{
  check('current_task_id is not a field on the supervisor heartbeat',
    C.SupervisorHeartbeat.safeParse({
      supervisor_id: SUPERVISOR, candidate_id: CANDIDATE, sent_at: iso(), sequence: 1,
      lifecycle: 'running', slots: [], slots_ready: 0, slots_working: 0, slots_paused: 0,
      current_task_id: uuid(5),
    }).success === false,
    'one task id would be false in nine ways at once');
  check('  nor lease_id', C.SupervisorHeartbeat.safeParse({
    supervisor_id: SUPERVISOR, candidate_id: CANDIDATE, sent_at: iso(), sequence: 1,
    lifecycle: 'running', slots: [], slots_ready: 0, slots_working: 0, slots_paused: 0,
    lease_id: uuid(6),
  }).success === false);
  check('  nor fence_token', C.SupervisorHeartbeat.safeParse({
    supervisor_id: SUPERVISOR, candidate_id: CANDIDATE, sent_at: iso(), sequence: 1,
    lifecycle: 'running', slots: [], slots_ready: 0, slots_working: 0, slots_paused: 0,
    fence_token: 3,
  }).success === false, 'authoritative lease state is per slot only');

  check('a summary that miscounts its own slots is rejected',
    C.SupervisorHeartbeat.safeParse({
      supervisor_id: SUPERVISOR, candidate_id: CANDIDATE, sent_at: iso(), sequence: 1,
      lifecycle: 'running', slots: [], slots_ready: 3, slots_working: 0, slots_paused: 0,
    }).success === false);
  check('two slots sharing an index are rejected',
    C.SupervisorHeartbeat.safeParse({
      supervisor_id: SUPERVISOR, candidate_id: CANDIDATE, sent_at: iso(), sequence: 1,
      lifecycle: 'running',
      slots: [
        { slot_id: uuid(201), slot_index: 1, readiness: 'ready', task_id: null },
        { slot_id: uuid(202), slot_index: 1, readiness: 'ready', task_id: null },
      ],
      slots_ready: 2, slots_working: 0, slots_paused: 0,
    }).success === false);
  check('an offline supervisor listing slots is rejected',
    C.SupervisorHeartbeat.safeParse({
      supervisor_id: SUPERVISOR, candidate_id: CANDIDATE, sent_at: iso(), sequence: 1,
      lifecycle: 'offline',
      slots: [{ slot_id: uuid(201), slot_index: 1, readiness: 'ready', task_id: null }],
      slots_ready: 1, slots_working: 0, slots_paused: 0,
    }).success === false);
}

section('14. A slot owns at most one task, and says so honestly');

{
  const working = {
    slot_id: uuid(201), supervisor_id: SUPERVISOR, candidate_id: CANDIDATE, slot_index: 1,
    sent_at: iso(), sequence: 7,
    state: slotState('working', { task_id: uuid(300), lease_id: uuid(400) }),
    lease: { lease_id: uuid(400), task_id: uuid(300), fence_token: 3, expires_at: iso(60_000) },
  };
  check('a working slot with a matching lease is valid', C.SlotHeartbeat.safeParse(working).success,
    JSON.stringify(C.SlotHeartbeat.safeParse(working).error?.issues?.[0]?.message ?? ''));
  check('  a working slot with no lease is rejected',
    C.SlotHeartbeat.safeParse({ ...working, lease: null }).success === false);
  check('  a working slot holding a lease for a DIFFERENT task is rejected',
    C.SlotHeartbeat.safeParse({
      ...working,
      lease: { ...working.lease, task_id: uuid(999) },
    }).success === false,
    'the one place a slot could quietly finish a task it was not given');
  check('  a ready slot still holding a lease is rejected',
    C.SlotHeartbeat.safeParse({ ...working, state: slotState('ready') }).success === false);
  check('a ready slot with no lease is valid',
    C.SlotHeartbeat.safeParse({ ...working, state: slotState('ready'), lease: null }).success);
  check('a paused slot must name its reason',
    C.SlotHeartbeat.safeParse({
      ...working, lease: null,
      state: slotState('paused', { task_id: uuid(300), lease_id: null, requires_candidate_action: true }),
    }).success === false,
    'an optional pause_reason would permit a pause that never says why');
  check('  a paused slot naming a reason is valid',
    C.SlotHeartbeat.safeParse({
      ...working, lease: null,
      state: slotState('paused', {
        task_id: uuid(300), lease_id: null,
        pause_reason: 'captcha_detected', requires_candidate_action: true,
      }),
    }).success);
  check('an invented slot state is rejected',
    C.SlotHeartbeat.safeParse({ ...working, lease: null, state: slotState('almost_ready') })
      .success === false);
}

section('15. A crashed slot does not disturb its siblings');

{
  const before = tenSlots.map((s) => ({ ...s }));
  const after = W.applySlotCrash(before, before[4].slot_id);
  check('the crashed slot is marked crashed', after[4].readiness === 'crashed');
  check('  and releases its task id', after[4].task_id === null);
  check('nine slots are untouched, by identity',
    after.filter((s, i) => i !== 4).every((s, i) => s === before.filter((_, j) => j !== 4)[i]),
    'isolation asserted by reference, not by eyeballing a diff');
  check('  they keep their own tasks',
    after.filter((_, i) => i !== 4).every((s) => s.task_id !== null));
  const counts = W.summariseSlots(after);
  check('the summary reflects nine working slots', counts.slots_working === 9);
}

/* ======================================================= 16-18. LEASES */

const now = new Date(1_800_000_060_000);
const liveLease = {
  lease_id: uuid(400), task_id: uuid(300), slot_id: uuid(201),
  acquired_at: new Date(now.getTime() - 60_000).toISOString(),
  expires_at: new Date(now.getTime() + 30_000).toISOString(),
  fence_token: 5,
};

section('16. A stale slot is fenced out');

{
  const req = {
    lease_id: uuid(400), task_id: uuid(300), slot_id: uuid(201),
    fence_token: 5, extend_by_seconds: 120,
  };
  const ctx = { request: req, lease: liveLease, current_fence_token: 5, now };

  check('a live, current lease renews', W.evaluateRenewal(ctx).granted);
  check('  the new expiry is measured from now, not from the old expiry',
    W.evaluateRenewal(ctx).expires_at === new Date(now.getTime() + 120_000).toISOString(),
    'a slot that renews late does not bank the time it was unresponsive');
  check('a stale fence token is refused',
    W.evaluateRenewal({ ...ctx, current_fence_token: 6 }).reason === 'stale_fence');
  check('  a slot claiming an old token it does not hold is refused',
    W.evaluateRenewal({ ...ctx, request: { ...req, fence_token: 4 } }).reason === 'stale_fence');
  check('another slot renewing this lease is refused',
    W.evaluateRenewal({ ...ctx, request: { ...req, slot_id: uuid(202) } }).reason === 'wrong_slot',
    'a sibling under the same supervisor is still the wrong slot');
  check('a renewal for a different task is refused',
    W.evaluateRenewal({ ...ctx, request: { ...req, task_id: uuid(999) } }).reason === 'wrong_task');
}

section('17. A sleeping laptop cannot renew or submit an expired lease');

{
  const req = {
    lease_id: uuid(400), task_id: uuid(300), slot_id: uuid(201),
    fence_token: 5, extend_by_seconds: 120,
  };
  const expired = { ...liveLease, expires_at: new Date(now.getTime() - 1).toISOString() };
  check('an expired lease is NEVER renewed',
    W.evaluateRenewal({ request: req, lease: expired, current_fence_token: 5, now })
      .reason === 'expired',
    'it went back to the queue and was re-leased; reviving it would put two slots on one task');
  check('a lease expiring exactly now is expired',
    W.evaluateRenewal({
      request: req, lease: { ...liveLease, expires_at: now.toISOString() },
      current_fence_token: 5, now,
    }).reason === 'expired');
  check('no lease at all is refused',
    W.evaluateRenewal({ request: req, lease: null, current_fence_token: 5, now })
      .reason === 'no_lease');
  check('a lease cannot be held forever by renewing',
    W.evaluateRenewal({
      request: { ...req, extend_by_seconds: 900 },
      lease: { ...liveLease, acquired_at: new Date(now.getTime() - 3500_000).toISOString() },
      current_fence_token: 5, now,
    }).reason === 'max_lease_exceeded',
    `capped at ${W.MAX_TOTAL_LEASE_SECONDS}s from acquisition`);
}

section('18. Submission takes all four checks');

{
  const leaseCheck = {
    lease: { slot_id: uuid(201), expires_at: liveLease.expires_at, fence_token: 5 },
    current_fence_token: 5, slot_id: uuid(201), now,
  };
  const ok = {
    lifecycle: 'running',
    slotState: slotState('working', { task_id: uuid(300), lease_id: uuid(400) }),
    agentState: 'ready_to_submit',
    lease: leaseCheck,
  };
  check('a running supervisor, a working slot, a current lease and a ready task submit',
    W.canSlotSubmit(ok).allowed);

  check('a slot that is merely ready cannot submit',
    W.canSlotSubmit({ ...ok, slotState: slotState('ready') }).reason === 'slot_not_working');
  for (const [state, extra] of [
    ['paused', { task_id: uuid(300), lease_id: uuid(400), pause_reason: 'captcha_detected', requires_candidate_action: true }],
    ['stopping', { stop_reason: 'candidate_requested' }],
    ['stopped', { stop_reason: 'kill_switch' }],
    ['crashed', { failure_code: 'context_lost' }],
    ['initializing', {}],
  ]) {
    check(`  a ${state} slot cannot submit`,
      W.canSlotSubmit({ ...ok, slotState: slotState(state, extra) }).reason === 'slot_not_working',
      state === 'paused' ? 'even holding a perfectly valid lease' : '');
  }

  for (const lifecycle of ['offline', 'starting', 'stopping']) {
    check(`  a ${lifecycle} supervisor cannot submit`,
      W.canSlotSubmit({ ...ok, lifecycle }).reason === 'supervisor_not_running');
  }

  check('  a stale fence cannot submit',
    W.canSlotSubmit({
      ...ok, lease: { ...leaseCheck, lease: { ...leaseCheck.lease, fence_token: 4 } },
    }).reason === 'stale_fence');
  check('  an expired lease cannot submit',
    W.canSlotSubmit({
      ...ok,
      lease: {
        ...leaseCheck,
        lease: { ...leaseCheck.lease, expires_at: new Date(now.getTime() - 1).toISOString() },
      },
    }).reason === 'expired');
  check('  a task that is not ready cannot submit',
    W.canSlotSubmit({ ...ok, agentState: 'processing' }).reason === 'not_ready');
  check('  an already-submitted task cannot be submitted again',
    W.canSlotSubmit({ ...ok, agentState: 'submitted' }).reason === 'not_ready');

  check('a task is only handed to a ready slot under a running supervisor',
    W.canAcceptTask('running', slotState('ready')).allowed);
  check('  not to a working slot', W.canAcceptTask('running', slotState('working', {
    task_id: uuid(300), lease_id: uuid(400),
  })).reason === 'slot_not_ready');
  check('  not while the supervisor is starting',
    W.canAcceptTask('starting', slotState('ready')).reason === 'supervisor_not_running',
    'running is not ready: a supervisor still opening contexts will drop the task');
}

/* ================================= 19-20. IDEMPOTENCY, VOCABULARY, SECRETS */

section('19. Registration and heartbeats are idempotent and ordered');

{
  const a = { supervisor_id: SUPERVISOR, candidate_id: CANDIDATE, registered_at: iso() };
  const b = { supervisor_id: SUPERVISOR, candidate_id: CANDIDATE, registered_at: iso(90_000) };
  check('re-registering a supervisor is the same identity',
    W.supervisorKey(a) === W.supervisorKey(b),
    'a laptop reconnecting forty times a day must not create forty supervisors');
  check('a different supervisor is a different identity',
    W.supervisorKey(a) !== W.supervisorKey({ ...a, supervisor_id: uuid(101) }));
  check('a slot is identified by supervisor and index',
    W.slotKey({ supervisor_id: SUPERVISOR, slot_index: 3 }) ===
      W.slotKey({ supervisor_id: SUPERVISOR, slot_index: 3 }));
  check('  two indices are two slots',
    W.slotKey({ supervisor_id: SUPERVISOR, slot_index: 3 }) !==
      W.slotKey({ supervisor_id: SUPERVISOR, slot_index: 4 }));

  check('a newer heartbeat is applied', W.isHeartbeatFresh({ sequence: 4 }, { sequence: 5 }));
  check('the first heartbeat is applied', W.isHeartbeatFresh(null, { sequence: 0 }));
  check('an older heartbeat is discarded',
    W.isHeartbeatFresh({ sequence: 9 }, { sequence: 8 }) === false,
    'a retry can overtake the message it was retrying');
  check('a repeated heartbeat is discarded',
    W.isHeartbeatFresh({ sequence: 9 }, { sequence: 9 }) === false,
    'a duplicate carries no news and must not restart the liveness clock');
}

section('20. Duplicate completions do not become duplicate applications');

{
  const done = {
    kind: 'task_completed', task_id: uuid(300), idempotency_key: key(1),
    fence_token: 5, outcome: 'submitted',
  };
  const current = { [uuid(300)]: 5 };

  const once = W.dedupeTaskEvents([done], current);
  check('one completion is accepted once', once.accepted.length === 1 && once.duplicates === 0);

  const twice = W.dedupeTaskEvents([done, { ...done, event: 'resent' }], current);
  check('the same completion sent twice is accepted once',
    twice.accepted.length === 1 && twice.duplicates === 1,
    'a redelivered queue message is not a second application');

  const thrice = W.dedupeTaskEvents([done, done, done], current);
  check('  three deliveries are still one application',
    thrice.accepted.length === 1 && thrice.duplicates === 2);

  const conflicting = W.dedupeTaskEvents(
    [done, { ...done, kind: 'task_failed', outcome: 'failed' }], current);
  check('the same key making a DIFFERENT claim is a conflict, not a duplicate',
    conflicting.accepted.length === 1 && conflicting.conflicts.length === 1 &&
      conflicting.duplicates === 0,
    'submitted and failed cannot both be true; arrival order must not decide it');

  const stale = W.dedupeTaskEvents([{ ...done, fence_token: 4 }], current);
  check('a fenced completion is refused, not deduplicated',
    stale.fenced.length === 1 && stale.accepted.length === 0 && stale.duplicates === 0,
    'folding it into duplicates would hide a stale slot claiming a submission');

  const unknownTask = W.dedupeTaskEvents([{ ...done, task_id: uuid(998) }], current);
  check('a completion for a task with no current token is fenced',
    unknownTask.fenced.length === 1 && unknownTask.accepted.length === 0);

  check('two different tasks both complete',
    W.dedupeTaskEvents(
      [done, { ...done, task_id: uuid(301), idempotency_key: key(2) }],
      { ...current, [uuid(301)]: 5 }
    ).accepted.length === 2);

  check('completionKey is task plus idempotency key, not the event id',
    W.completionKey(done) === `${uuid(300)}:${key(1)}`);
}

section('21. The action vocabulary stays closed');

{
  const command = {
    command_id: uuid(500), task_id: uuid(300), slot_id: uuid(201), candidate_id: CANDIDATE,
    lease_id: uuid(400), fence_token: 5, issued_at: iso(), expires_at: iso(60_000),
    mode: 'openrouter_only',
    steps: [{ action: 'open_job_url', field: null, fact_key: null }],
  };
  check('a command from the closed vocabulary is valid', C.SlotCommand.safeParse(command).success,
    JSON.stringify(C.SlotCommand.safeParse(command).error?.issues?.[0]?.message ?? ''));
  for (const action of ['execute_javascript', 'navigate', 'run_shell', 'solve_captcha', 'eval']) {
    check(`  "${action}" is refused`,
      C.SlotCommand.safeParse({
        ...command, steps: [{ action, field: null, fact_key: null }],
      }).success === false);
  }
  check('a command with no steps is refused',
    C.SlotCommand.safeParse({ ...command, steps: [] }).success === false);
  check('a command expiring before it was issued is refused',
    C.SlotCommand.safeParse({ ...command, expires_at: iso(-1000) }).success === false);
  check('the vocabulary contains no escape hatch',
    C.AUTOMATION_ACTIONS.every((a) => !/script|eval|shell|exec|navigate_to|bypass/i.test(a)),
    C.AUTOMATION_ACTIONS.join(', '));
}

section('22. No credential can ride along in a payload');

{
  const heartbeat = {
    slot_id: uuid(201), supervisor_id: SUPERVISOR, candidate_id: CANDIDATE, slot_index: 1,
    sent_at: iso(), sequence: 7,
    state: slotState('working', { task_id: uuid(300), lease_id: uuid(400) }),
    lease: { lease_id: uuid(400), task_id: uuid(300), fence_token: 3, expires_at: iso(60_000) },
  };
  check('a valid slot heartbeat carries no credential-shaped key',
    W.findCredentialLikeKeys(heartbeat).length === 0,
    'fence_token is a counter, not a credential, and deliberately does not match');

  const supervisorBeat = {
    supervisor_id: SUPERVISOR, candidate_id: CANDIDATE, sent_at: iso(), sequence: 1,
    lifecycle: 'running', slots: tenSlots, ...W.summariseSlots(tenSlots),
  };
  check('  nor does a supervisor summary', W.findCredentialLikeKeys(supervisorBeat).length === 0);

  // A positive control. An allow-list that never reports anything is not a
  // control, so this proves the detector actually fires.
  for (const planted of ['api_key', 'session_token', 'authorization', 'cookie', 'service_role_key']) {
    check(`  a planted "${planted}" IS detected`,
      W.findCredentialLikeKeys({ ...heartbeat, [planted]: 'x' }).includes(planted));
  }
  check('  and one nested inside the lease is detected too',
    W.findCredentialLikeKeys({
      ...heartbeat, lease: { ...heartbeat.lease, bearer: 'x' },
    }).includes('bearer'));

  check('the heartbeat schema rejects the extra key outright',
    C.SlotHeartbeat.safeParse({ ...heartbeat, api_key: 'x' }).success === false,
    'strict() first, the key scan as the control that proves it');

  const modeConfig = {
    candidate_id: CANDIDATE, mode: 'openrouter_only', updated_at: iso(),
    openrouter_model: 'openai/gpt-4o-mini', paste_console_enabled: false,
  };
  check('AiModeConfig accepts a valid openrouter_only config',
    C.AiModeConfig.safeParse(modeConfig).success);
  check('  it holds no credential-shaped key',
    W.findCredentialLikeKeys(modeConfig).length === 0,
    'the OpenRouter key lives in the server environment, never per candidate');
  check('  a per-candidate api key is refused',
    C.AiModeConfig.safeParse({ ...modeConfig, openrouter_api_key: 'sk-x' }).success === false);
  check('  openrouter_only cannot enable the paste console',
    C.AiModeConfig.safeParse({ ...modeConfig, paste_console_enabled: true }).success === false);
  check('  claude_max_assisted must enable it',
    C.AiModeConfig.safeParse({
      ...modeConfig, mode: 'claude_max_assisted', paste_console_enabled: false,
    }).success === false);
  check('  claude_max_assisted with the console on is valid',
    C.AiModeConfig.safeParse({
      ...modeConfig, mode: 'claude_max_assisted', paste_console_enabled: true,
    }).success);
}

section('23. No backend Anthropic path, and the extension point stays closed');

{
  /*
   * The needles are assembled at runtime rather than written out, following
   * scripts/test-secret-scan.mjs. This file is itself scanned by the
   * repository's provider check and by gitleaks over full history, and writing
   * the vendor host out in full would make this file the offender it is
   * looking for. CI caught exactly that in Milestone 1.
   */
  const PKG = '@anthropic' + '-ai/sdk';
  const ENV = 'ANTHROPIC' + '_API_KEY';
  const HOST = 'api.' + 'anthropic' + '.com';

  const forbidden = [
    [new RegExp(PKG.replace('/', '\\/')), PKG],
    [new RegExp(ENV), ENV],
    [new RegExp(HOST.replace(/\./g, '\\.')), HOST],
    [/\bfetch\s*\(/, 'a network call'],
    [/child_process/, 'a shell'],
    [/localStorage|document\.cookie/, 'browser storage'],
    [/puppeteer|playwright/, 'a browser driver'],
  ];
  for (const f of ['worker-state.ts', 'ai-mode.ts', 'contracts.ts']) {
    const src = readFileSync(path.join(ROOT, 'lib', 'agent', f), 'utf8');
    for (const [re, what] of forbidden) {
      check(`lib/agent/${f} contains no ${what}`, !re.test(src));
    }
  }

  check('there are exactly two automation modes',
    C.AutomationMode.options.length === 2, C.AutomationMode.options.join(', '));
  check('  a third mode cannot be parsed',
    C.AutomationMode.safeParse('claude_max_local').success === false,
    'the extension point cannot become real by accident');
  check('the local Claude capability is marked not implemented',
    MODE.CLAUDE_MAX_LOCAL_CAPABILITY.status === 'not_implemented');
  check('  it is blocked on an account-terms review',
    MODE.CLAUDE_MAX_LOCAL_CAPABILITY.blocked_on.includes('account_terms_review'),
    'the blocking question is not a technical one');
  check('  session extraction is permanently out of scope',
    MODE.CLAUDE_MAX_LOCAL_CAPABILITY.permanently_out_of_scope
      .includes('session_token_extraction'));
  check('  so is disguising automated traffic',
    MODE.CLAUDE_MAX_LOCAL_CAPABILITY.permanently_out_of_scope.includes('automation_disguise'));

  check('no destination lets the backend call Claude directly',
    ['openrouter_only', 'claude_max_assisted'].every((m) =>
      Object.values(MODE.routingTable(m)).every((r) =>
        ['openrouter', 'candidate_claude_max_paste', 'deterministic_rules'].includes(r.destination)
      )));
}

/* ---------------------------------------------------------------- report */

console.log('\n========================================================');
if (failed === 0) {
  console.log(`ALL ${passed} WORKER PROTOCOL CHECKS PASSED`);
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
