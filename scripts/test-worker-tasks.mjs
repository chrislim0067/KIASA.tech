/**
 * The one-slot task lifecycle, offline.
 *
 *   npm run test:tasks
 *
 * WHAT THIS PROVES AND WHAT IT CANNOT
 *
 * The protocol above the database: schemas, transitions, replay, fencing,
 * pause semantics, the closed refusal vocabulary, and the shape of what comes
 * back. It runs against the shared in-memory model in
 * scripts/lib/worker-task-memory.mjs, which cannot prove a row lock, a partial
 * unique index or a trigger — scripts/test-worker-db-boundary.mjs does that
 * against real Postgres in CI.
 *
 * It also reads migration 27 as TEXT, which is the only way to assert some of
 * the properties that matter most: that no worker-callable function can write
 * a submission status, that ownership is never a parameter, and that the fence
 * is compared by equality.
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

const E = await import('../lib/worker/endpoints.ts');
const P = await import('../lib/worker/pairing.ts');
const HTTP = await import('../lib/worker/http.ts');
const C = await import('../lib/agent/contracts.ts');
const { createTaskMemory, PAUSE_REASONS, STOP_REASONS } = await import(
  './lib/worker-task-memory.mjs'
);

const MIGRATION = readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '20260910000027_worker_task_lifecycle.sql'),
  'utf8'
);

/** The migration with its prose removed, so a comment cannot satisfy a check. */
const CODE = MIGRATION.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');

const ALICE = '00000000-0000-4000-8000-00000000a11c';
const BOB = '00000000-0000-4000-8000-00000000b0b0';

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function makeWorld(nowMs = Date.UTC(2026, 8, 10, 12, 0, 0)) {
  const credentials = new Map();
  let clock = nowMs;
  const memory = createTaskMemory({
    credentials,
    uuid,
    now: () => new Date(clock),
  });

  const pair = (userId) => {
    const id = uuid();
    const secret = 'x'.repeat(43);
    credentials.set(id, {
      id,
      user_id: userId,
      supervisor_id: uuid(),
      slot_id: uuid(),
      token_hash: P.hashSecret(secret),
      audience: 'kiasa-worker',
      scope: 'slot:heartbeat',
      expires_at: new Date(clock + 30 * 86_400_000).toISOString(),
      revoked_at: null,
    });
    return { credentialId: id, tokenHash: P.hashSecret(secret) };
  };

  return {
    memory,
    credentials,
    pair,
    advance: (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
}

/* ===================================================== 1. THE SCHEMAS */

section('1. Request schemas are strict, bounded and identity-free');

{
  const beat = (extra) => E.HeartbeatRequest.safeParse({
    sequence: 1, lifecycle: 'running', slot_readiness: 'ready', ...extra,
  });

  check('a plain ready heartbeat parses', beat({}).success);
  check('an unknown key is rejected', !beat({ user_id: ALICE }).success,
    'identity in a body is identity the caller chose');
  check('so is a supervisor id', !beat({ supervisor_id: ALICE }).success);
  check('so is a task id', !beat({ task_id: ALICE }).success);

  check('paused without a reason is refused',
    !beat({ slot_readiness: 'paused' }).success);
  check('  and the refusal names the missing reason',
    beat({ slot_readiness: 'paused' }).error?.issues.some(
      (i) => i.message === 'pause_reason_required'));
  check('paused WITH an allowed reason parses',
    beat({ slot_readiness: 'paused', reason: 'captcha_detected' }).success);
  check('  but not with a stop reason',
    !beat({ slot_readiness: 'paused', reason: 'kill_switch' }).success,
    'the two vocabularies are not interchangeable');
  check('  and not with free text',
    !beat({ slot_readiness: 'paused', reason: 'the site looked odd' }).success,
    'a worker describes its situation from a list or not at all');

  check('stopped without a reason is refused', !beat({ slot_readiness: 'stopped' }).success);
  check('stopping without a reason is refused', !beat({ slot_readiness: 'stopping' }).success);
  check('stopped WITH a stop reason parses',
    beat({ slot_readiness: 'stopped', reason: 'supervisor_shutdown' }).success);
  check('ready WITH a reason is refused',
    !beat({ reason: 'captcha_detected' }).success,
    'the constraint binds in both directions');
  check('crashed needs no reason', beat({ slot_readiness: 'crashed' }).success);

  const renew = (b) => E.RenewRequest.safeParse(b);
  check('renew takes exactly one field', renew({ fence_token: 3 }).success);
  check('  a zero fence is refused', !renew({ fence_token: 0 }).success);
  check('  a fractional fence is refused', !renew({ fence_token: 1.5 }).success);
  check('  and nothing else may ride along',
    !renew({ fence_token: 3, task_id: ALICE }).success);

  const report = (b) => E.ReportRequest.safeParse(b);
  check('report accepts the three dispositions',
    ['completed', 'failed', 'released'].every((d) =>
      report({ fence_token: 1, disposition: d, ...(d === 'failed' ? { reason: 'unknown_page' } : {}) })
        .success));
  check('THERE IS NO SUBMIT DISPOSITION',
    !report({ fence_token: 1, disposition: 'submitted' }).success &&
      !report({ fence_token: 1, disposition: 'ready_to_submit' }).success,
    'a worker cannot say an application was sent, because it cannot send one');
  check('a failure must name a cause',
    !report({ fence_token: 1, disposition: 'failed' }).success);
  check('  from the allowed list only',
    !report({ fence_token: 1, disposition: 'failed', reason: 'it broke' }).success);
  check('a success carries no reason',
    !report({ fence_token: 1, disposition: 'completed', reason: 'unknown_page' }).success);
}

/* ================================================ 2. THE HAPPY PATH */

section('2. Claim, renew, report — the whole cycle');

{
  const w = makeWorld();
  const alice = w.pair(ALICE);
  const taskId = w.memory.seedTask(ALICE);

  const claim = await E.claimTask(w.memory, alice);
  check('a queued task is claimed', claim.ok === true, claim.ok ? '' : claim.reason);
  check('  the task it names is the one that was queued', claim.ok && claim.taskId === taskId);
  check('  the fence starts at one', claim.ok && claim.fenceToken === 1);
  check('  and the task is now being worked on',
    w.memory.tasks.get(taskId).status === 'processing',
    w.memory.tasks.get(taskId).status);
  check('  the attempt was counted', w.memory.tasks.get(taskId).attempt === 1);

  /*
   * NOTHING ABOUT THE JOB COMES BACK. Not a URL, not an employer, not a title.
   * This milestone's worker has no use for any of them, and a field that
   * exists is a field that leaks.
   */
  const claimText = JSON.stringify(claim);
  check('the claim response carries ids and times only',
    Object.keys(claim).sort().join(',') === 'fenceToken,leaseExpiresAt,leaseId,ok,taskId',
    Object.keys(claim).sort().join(','));
  check('  and no hash of anything', !/[0-9a-f]{64}/.test(claimText));

  /*
   * RENEWING WITH NO TIME ELAPSED EXTENDS NOTHING, and says so. The target is
   * `min(now + 2 minutes, acquired + 1 hour)`, which at the instant of the
   * claim is exactly the expiry it already has. Accepted, applied to nothing,
   * and no event written — the same shape as a replayed heartbeat.
   */
  const immediate = await E.renewLease(w.memory, alice, { fence_token: 1 });
  check('renewing immediately is accepted and extends nothing',
    immediate.ok === true && immediate.expiresAt === claim.leaseExpiresAt,
    immediate.reason);

  w.advance(30 * 1000);
  const renewed = await E.renewLease(w.memory, alice, { fence_token: 1 });
  check('the lease renews at the right fence', renewed.ok === true,
    renewed.ok ? '' : renewed.reason);
  check('  and the expiry actually moved',
    Date.parse(renewed.expiresAt) > Date.parse(claim.leaseExpiresAt));

  const done = await E.reportTask(w.memory, alice, {
    fence_token: 1, disposition: 'completed',
  });
  check('the task is reported complete', done.ok === true, done.ok ? '' : done.reason);
  check('  IT LANDS IN manual_review, NOT ready_to_submit',
    w.memory.tasks.get(taskId).status === 'manual_review',
    w.memory.tasks.get(taskId).status);
  check('  the lease was released', [...w.memory.leases.values()][0].released_at !== null);
  check('  with the matching reason',
    [...w.memory.leases.values()][0].release_reason === 'completed');
}

section('3. Replay, staleness and the fence');

{
  const w = makeWorld();
  const alice = w.pair(ALICE);
  w.memory.seedTask(ALICE);
  const claim = await E.claimTask(w.memory, alice);

  const replayClaim = await E.claimTask(w.memory, alice);
  check('a second claim while holding one is refused',
    replayClaim.ok === false && replayClaim.reason === 'slot_busy',
    replayClaim.ok ? 'CLAIMED TWICE' : replayClaim.reason);

  const stale = await E.renewLease(w.memory, alice, { fence_token: claim.fenceToken + 1 });
  check('a fence from the future is refused',
    stale.ok === false && stale.reason === 'stale_fence', stale.reason);
  const older = await E.renewLease(w.memory, alice, { fence_token: 1 });
  check('  and the right fence still works', older.ok === true);

  const wrongFenceReport = await E.reportTask(w.memory, alice, {
    fence_token: 99, disposition: 'released',
  });
  check('a report at the wrong fence is refused',
    wrongFenceReport.ok === false && wrongFenceReport.reason === 'stale_fence');

  const first = await E.reportTask(w.memory, alice, { fence_token: 1, disposition: 'released' });
  check('the first report succeeds', first.ok === true);
  const replay = await E.reportTask(w.memory, alice, { fence_token: 1, disposition: 'released' });
  check('REPLAYING IT IS REFUSED, NOT REPEATED',
    replay.ok === false && replay.reason === 'no_active_lease', replay.reason);

  // The task went back to the queue, so it can be claimed again — at a HIGHER
  // fence. The fence only ever rises.
  const second = await E.claimTask(w.memory, alice);
  check('re-claiming raises the fence', second.ok && second.fenceToken === 2,
    String(second.fenceToken));
}

section('4. A dead lease is reclaimed, and a stale worker cannot mutate');

{
  const w = makeWorld();
  const alice = w.pair(ALICE);
  const taskId = w.memory.seedTask(ALICE);
  const claim = await E.claimTask(w.memory, alice);

  w.advance(3 * 60 * 1000); // past the two-minute lease

  const late = await E.renewLease(w.memory, alice, { fence_token: claim.fenceToken });
  check('an expired lease cannot be renewed',
    late.ok === false && late.reason === 'lease_expired', late.reason);
  const lateReport = await E.reportTask(w.memory, alice, {
    fence_token: claim.fenceToken, disposition: 'completed',
  });
  check('  and cannot report a completion',
    lateReport.ok === false && lateReport.reason === 'lease_expired', lateReport.reason);
  check('  the task was NOT moved', w.memory.tasks.get(taskId).status === 'processing',
    w.memory.tasks.get(taskId).status);

  const reclaimed = await E.claimTask(w.memory, alice);
  check('a new claim reclaims the dead lease and takes the task',
    reclaimed.ok === true, reclaimed.ok ? '' : reclaimed.reason);
  check('  at a higher fence', reclaimed.fenceToken === 2, String(reclaimed.fenceToken));
  check('  and the dead one was released as expired',
    [...w.memory.leases.values()].some((l) => l.release_reason === 'expired'));
  check('  which was recorded',
    w.memory.events.some((e) => e.kind === 'lease_expired'));
}

section('5. Attempts are finite');

{
  const w = makeWorld();
  const alice = w.pair(ALICE);
  const taskId = w.memory.seedTask(ALICE);
  for (let i = 0; i < 3; i++) {
    const c = await E.claimTask(w.memory, alice);
    await E.reportTask(w.memory, alice, { fence_token: c.fenceToken, disposition: 'released' });
  }
  check('three attempts were counted', w.memory.tasks.get(taskId).attempt === 3);
  const fourth = await E.claimTask(w.memory, alice);
  check('the fourth claim is refused rather than raising',
    fourth.ok === false && fourth.reason === 'attempts_exhausted', fourth.reason);
}

/* ============================================ 6. CROSS-CANDIDATE */

section('6. One candidate’s worker cannot reach another’s task');

{
  const w = makeWorld();
  const alice = w.pair(ALICE);
  const bob = w.pair(BOB);
  const aliceTask = w.memory.seedTask(ALICE);

  const bobClaim = await E.claimTask(w.memory, bob);
  check("Bob's worker finds nothing to claim",
    bobClaim.ok === false && bobClaim.reason === 'no_task_available',
    bobClaim.ok ? 'CLAIMED ALICE’S TASK' : bobClaim.reason);
  check("  and Alice's task is untouched",
    w.memory.tasks.get(aliceTask).status === 'queued');

  const aliceClaim = await E.claimTask(w.memory, alice);
  const bobRenew = await E.renewLease(w.memory, bob, { fence_token: aliceClaim.fenceToken });
  check("Bob cannot renew Alice's lease",
    bobRenew.ok === false && bobRenew.reason === 'no_active_lease', bobRenew.reason);
  const bobReport = await E.reportTask(w.memory, bob, {
    fence_token: aliceClaim.fenceToken, disposition: 'failed', reason: 'unknown_page',
  });
  check("  nor report on it",
    bobReport.ok === false && bobReport.reason === 'no_active_lease', bobReport.reason);
  check("  and Alice's task is still hers and still active",
    w.memory.tasks.get(aliceTask).status === 'processing');

  check('every event belongs to exactly one candidate',
    w.memory.events.every((e) => e.user_id === ALICE || e.user_id === BOB));
  check("  and none of Alice's events name Bob",
    w.memory.events.filter((e) => e.user_id === ALICE).every(
      (e) => !JSON.stringify(e).includes(BOB)));
}

/* ============================================== 7. DEAD CREDENTIALS */

section('7. A revoked or expired credential does nothing at all');

{
  const w = makeWorld();
  const alice = w.pair(ALICE);
  w.memory.seedTask(ALICE);
  w.credentials.get(alice.credentialId).revoked_at = new Date().toISOString();

  for (const [label, call] of [
    ['claim', () => E.claimTask(w.memory, alice)],
    ['renew', () => E.renewLease(w.memory, alice, { fence_token: 1 })],
    ['report', () => E.reportTask(w.memory, alice, { fence_token: 1, disposition: 'released' })],
  ]) {
    const r = await call();
    check(`a revoked credential cannot ${label}`,
      r.ok === false && r.reason === 'revoked', r.ok ? 'ALLOWED' : r.reason);
  }
  check('and nothing was recorded for it', w.memory.events.length === 0,
    `${w.memory.events.length} event(s)`);

  const w2 = makeWorld();
  const stale = w2.pair(ALICE);
  w2.memory.seedTask(ALICE);
  w2.advance(31 * 86_400_000);
  const expired = await E.claimTask(w2.memory, stale);
  check('an expired credential cannot claim',
    expired.ok === false && expired.reason === 'expired', expired.reason);
}

/* ================================================== 8. THE EVENTS */

section('8. Events are allow-listed, bounded and free of content');

{
  const w = makeWorld();
  const alice = w.pair(ALICE);
  w.memory.seedTask(ALICE);
  const claim = await E.claimTask(w.memory, alice);
  w.advance(30 * 1000); // or the renewal caps, extends nothing and records nothing
  await E.renewLease(w.memory, alice, { fence_token: claim.fenceToken });
  await E.reportTask(w.memory, alice, {
    fence_token: claim.fenceToken, disposition: 'failed', reason: 'captcha_detected',
  });

  const kinds = w.memory.events.map((e) => e.kind);
  const allowed = new Set([
    'supervisor_registered', 'supervisor_revoked', 'supervisor_heartbeat',
    'slot_registered', 'slot_heartbeat', 'slot_paused', 'slot_stopped', 'slot_crashed',
    'lease_acquired', 'lease_renewed', 'lease_expired', 'lease_released', 'lease_refused',
    'task_started', 'task_paused', 'task_completed', 'task_failed',
    'local_claude_used', 'local_claude_unavailable', 'manual_fallback_used',
  ]);
  check('every event kind is one the table allows', kinds.every((k) => allowed.has(k)),
    kinds.join(','));
  check('the cycle recorded what it did',
    ['lease_acquired', 'task_started', 'lease_renewed', 'lease_released', 'task_failed']
      .every((k) => kinds.includes(k)),
    kinds.join(','));

  for (const e of w.memory.events) {
    const detail = JSON.stringify(e.detail);
    check(`  ${e.kind} carries at most a fence, a disposition and a reason`,
      Object.keys(e.detail).every((k) => ['fence', 'disposition', 'reason'].includes(k)),
      detail);
    check(`  ${e.kind} detail stays far inside the 2000-character bound`,
      detail.length <= 200, `${detail.length} chars`);
  }
  const everything = JSON.stringify(w.memory.events);
  check('no event carries a hash', !/[0-9a-f]{64}/.test(everything));
  check('no event carries a URL', !/https?:\/\//.test(everything));
  check('no event carries a token', !/\.[A-Za-z0-9_-]{43}/.test(everything));
}

section('9. Heartbeat events are written on transition only');

{
  const w = makeWorld();
  const alice = w.pair(ALICE);
  const slot = { readiness: 'initializing', pause_reason: null, stop_reason: null };
  const cred = w.credentials.get(alice.credentialId);

  const beat = (readiness, reason = null) => {
    const previous = slot.readiness;
    const refusal = w.memory.applyReadiness(slot, readiness, reason);
    if (refusal) return refusal;
    w.memory.recordSlotTransition(cred, slot, previous, readiness, reason);
    return null;
  };

  check('the first ready is a transition', beat('ready') === null && w.memory.events.length === 1);
  check('  five more ready beats write nothing',
    [0, 1, 2, 3, 4].every(() => beat('ready') === null) && w.memory.events.length === 1,
    `${w.memory.events.length} event(s)`);
  check('pausing is a transition', beat('paused', 'mfa_required') === null &&
    w.memory.events.length === 2);
  check('  recorded as slot_paused with its reason',
    w.memory.events[1].kind === 'slot_paused' &&
      w.memory.events[1].detail.reason === 'mfa_required');
  check('  and the slot carries the reason', slot.pause_reason === 'mfa_required');
  check('resuming clears it', beat('ready') === null && slot.pause_reason === null);
  check('  and leaves no stop reason either', slot.stop_reason === null);
  check('stopping needs a stop reason', beat('stopped') === 'stop_reason_required');
  check('  with one, it is recorded',
    beat('stopped', 'supervisor_shutdown') === null &&
      slot.stop_reason === 'supervisor_shutdown');
  check('  and returning to ready clears that too',
    beat('ready') === null && slot.stop_reason === null && slot.pause_reason === null);
}

/* ====================================== 10. THE MIGRATION, AS TEXT */

section('10. Migration 27 cannot be used to submit an application');

{
  const callable = [
    'worker_claim_task', 'worker_renew_lease', 'worker_report_task',
    'worker_record_heartbeat',
  ];
  const bodyOf = (name) => {
    const start = CODE.indexOf(`create or replace function public.${name}(`);
    if (start < 0) return '';
    const end = CODE.indexOf('$fn$;', start);
    return CODE.slice(start, end);
  };

  for (const fn of callable) {
    const body = bodyOf(fn);
    check(`${fn} exists`, body.length > 0);
    check(`  ${fn} never writes ready_to_submit`, !body.includes('ready_to_submit'));
    check(`  ${fn} never writes 'submitted'`, !body.includes("'submitted'"));
    check(`  ${fn} takes no candidate, task, slot or lease id`,
      !/p_(user|candidate|task|slot|lease|supervisor)_id/.test(body),
      'ownership is read from the row the credential matches');
    check(`  ${fn} pins an empty search_path`, /set search_path = ''/.test(
      CODE.slice(CODE.indexOf(`create or replace function public.${fn}(`),
        CODE.indexOf('$fn$', CODE.indexOf(`create or replace function public.${fn}(`)))));
  }

  /*
   * THREE CHECKS THAT HAD TO BE TIGHTENED.
   *
   * The first versions read `/for update/` and `/status = 'queued'/` against
   * the whole function, and a mutation run proved both vacuous: the task
   * SELECT carries its own `for update skip locked`, and the reclaim block
   * contains `set status = 'queued'`. Each matched something other than the
   * thing it was meant to guard, so deleting the guard changed nothing.
   *
   * They now name the exact clause. Removing the slot lock, dropping the
   * candidate filter, or widening the status gate each fails one of them.
   */
  check('the claim serialises on the SLOT row before deciding',
    /perform 1 from public\.worker_slots[\s\S]{0,200}?for update;/.test(
      bodyOf('worker_claim_task')),
    'without it two claims both read "no active lease" and both insert one');
  check('  it selects only THIS candidate’s queued tasks',
    /from public\.automation_tasks\s+where user_id = v_cred\.cred_user_id and status = 'queued'/
      .test(bodyOf('worker_claim_task')),
    'the candidate filter and the approval gate, in one clause');
  check('  and refuses when the slot already holds a lease',
    /slot_busy/.test(bodyOf('worker_claim_task')));
  check('  and reclaims an expired lease rather than wedging the slot',
    /release_reason = 'expired'/.test(bodyOf('worker_claim_task')));

  check('the fence is compared by EQUALITY, not by ordering',
    /fence_token <> p_fence_token/.test(bodyOf('worker_renew_lease')) &&
      /fence_token <> p_fence_token/.test(bodyOf('worker_report_task')),
    'a worker guessing forward is refused as firmly as one left behind');
  check('  and it only ever rises',
    /fence_token = fence_token \+ 1/.test(bodyOf('worker_claim_task')));

  check('the report maps completion to manual_review',
    /status = 'manual_review'/.test(bodyOf('worker_report_task')),
    'a person continues from there');

  check('every EXECUTE grant goes to service_role and nobody else',
    (CODE.match(/grant execute on function/g) ?? []).length ===
      (CODE.match(/to service_role;/g) ?? []).length,
    `${(CODE.match(/grant execute on function/g) ?? []).length} grant(s)`);
  check('  and every function is revoked from the browser roles first',
    (CODE.match(/revoke all on function/g) ?? []).length >= 5);
  check('the credential resolver is granted to NOBODY',
    /revoke all on function public\.worker_resolve_credential\(uuid, text\)\s*\n\s*from public, anon, authenticated, service_role;/.test(CODE),
    'reachable only from inside another definer function');

  check('no new table grant appears anywhere in the migration',
    !/^grant (select|insert|update|delete)/m.test(CODE),
    'the boundary is functions, not privileges');
  check('the migration asserts the zero-grant invariant itself',
    /service_role gained a table grant/.test(MIGRATION));
  check('  and that no unexpected definer function exists',
    /unexpected SECURITY DEFINER function/.test(MIGRATION));
  check('  and that no worker-callable function can write a submission status',
    /a worker-callable function can write a submission status/.test(MIGRATION));
}

section('11. Refusals are a closed list, and statuses are stable');

{
  check('the operation failure list is closed',
    Array.isArray(E.WORKER_OPERATION_FAILURES) && E.WORKER_OPERATION_FAILURES.includes('refused'));
  check('  every member maps to a 4xx status',
    E.WORKER_OPERATION_FAILURES.every((r) => {
      const s = HTTP.operationStatus(r);
      return s >= 400 && s < 500;
    }),
    'a refusal is never a 500, and a 500 never carries a reason');

  const mapped = {
    pause_reason_required: 400, stop_reason_required: 400, failure_reason_required: 400,
    unexpected_reason: 400, malformed_request: 400,
    revoked: 403, expired: 403, out_of_scope: 403,
    not_found: 404, no_slot: 404, no_task_available: 404, no_active_lease: 404,
    slot_busy: 409, stale_fence: 409, lease_expired: 409, task_not_active: 409,
    attempts_exhausted: 409, refused: 409,
  };
  for (const [reason, status] of Object.entries(mapped)) {
    check(`  ${reason} → ${status}`, HTTP.operationStatus(reason) === status,
      String(HTTP.operationStatus(reason)));
  }
  check('every failure in the list has a mapping written down',
    E.WORKER_OPERATION_FAILURES.every((r) => r in mapped),
    'an unmapped reason would silently become 409');
}

section('12. Nothing here can authorise a submission or reach a browser');

{
  const sources = [
    'lib/worker/endpoints.ts', 'lib/worker/store.ts', 'lib/worker/http.ts',
    'worker/kiasa-worker.mjs', 'scripts/lib/worker-task-memory.mjs',
    'app/api/worker/task/claim/route.ts', 'app/api/worker/task/renew/route.ts',
    'app/api/worker/task/report/route.ts',
  ];
  for (const file of sources) {
    const text = readFileSync(path.join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    check(`${file} opens no browser`, !/puppeteer|playwright|chromium|webdriver/i.test(text));
    check(`  ${file} submits nothing`, !/\bsubmitApplication\b|ready_to_submit/.test(text));
    /*
     * CALLS, NOT MENTIONS. The first version of this flagged
     * worker/kiasa-worker.mjs for a log line that says it holds no OpenRouter
     * key — a check that fails on a statement of the property it is checking
     * is a check that gets deleted. Hosts, imports and SDK names only.
     */
    check(`  ${file} reaches no model provider`,
      !/openrouter\.ai|api\.anthropic\.com|@anthropic-ai\/|from ['"][^'"]*openrouter/i.test(text),
      'a mention is not a call');
  }

  check('the pause vocabulary still refuses to describe evasion',
    C.WORKER_PAUSE_REASONS.every((r) => !/bypass|solve|evade|ignore|retry/i.test(r)),
    'a reason to stop must not read as a way around');
  check('the pause and stop vocabularies remain disjoint',
    STOP_REASONS.every((r) => !PAUSE_REASONS.includes(r)));
  check('the shared model mirrors the contract vocabularies exactly',
    PAUSE_REASONS.join(',') === C.WORKER_PAUSE_REASONS.join(',') &&
      STOP_REASONS.join(',') === C.WORKER_STOP_REASONS.join(','),
    'a test fixture that drifts from the contract proves nothing');
}

console.log(`\n${'='.repeat(56)}`);
if (failed === 0) {
  console.log(`ALL ${passed} WORKER-TASK CHECKS PASSED`);
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
