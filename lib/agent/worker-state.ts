import {
  WORKER_PAUSE_REASONS,
  type SafetyStopReason,
  type SessionState,
  type SlotReadiness,
  type SlotState,
  type SupervisorLifecycle,
  type WorkerPauseReason,
} from '@/lib/agent/contracts';
import { isLeaseValid, type LeaseCheck, type LeaseVerdict, type AgentState } from '@/lib/agent/state-machine';

/**
 * The supervisor/slot rules, as pure functions.
 *
 * No network, no database, no clock of its own — every function that needs the
 * time is given it. Same reasoning as `lib/agent/safety.ts`: these decide
 * whether a machine presses submit on a real person's behalf, and the only
 * grounds for trusting them is that they can be tested exhaustively.
 *
 * `lib/agent/contracts.ts` says what the shapes are. This says what may
 * happen. The split is deliberate — a schema can tell you a heartbeat is
 * well-formed, but not whether the slot that sent it is allowed to act.
 */

/* ------------------------------------------------------- registration keys */

/**
 * Registration is IDEMPOTENT, and these are why.
 *
 * A supervisor is identified by the id generated once on the candidate's
 * machine; a slot by its supervisor and its index. Re-registering is an upsert
 * of the same row.
 *
 * This matters more than it looks. A laptop that opens and closes forty times
 * a day would otherwise create forty supervisors and four hundred slots, each
 * potentially holding a lease nobody will ever release, and each task would
 * then sit un-leasable until its expiry. Timestamps are deliberately NOT part
 * of the key, so a reconnect is the same identity rather than a new one.
 */
export const supervisorKey = (r: { supervisor_id: string }): string =>
  `supervisor:${r.supervisor_id}`;

export const slotKey = (r: { supervisor_id: string; slot_index: number }): string =>
  `slot:${r.supervisor_id}:${r.slot_index}`;

/**
 * Is this heartbeat newer than what we already hold?
 *
 * Heartbeats arrive out of order — a retry after a timeout can overtake the
 * message it was retrying. Applying a stale one would resurrect an old state:
 * a slot that has just crashed would be shown as `working`, and the control
 * plane would leave its task leased.
 *
 * Equal sequence numbers are REJECTED rather than accepted. A duplicate
 * delivery carries no new information, and treating it as fresh would restart
 * the liveness clock for a slot that may already be gone.
 */
export function isHeartbeatFresh(
  known: { sequence: number } | null,
  incoming: { sequence: number }
): boolean {
  if (!known) return true;
  return incoming.sequence > known.sequence;
}

/* ------------------------------------------------- observations to decisions */

/**
 * What the control plane does about each thing a slot can report.
 *
 * TOTAL BY CONSTRUCTION. `Record<WorkerPauseReason, ...>` means a new pause
 * reason cannot be added without deciding here what it means — which is the
 * whole point of separating observation from judgement. The worker says "I saw
 * a challenge"; this says "that is a `captcha` stop".
 *
 * `control_plane_paused` maps to `null` because it is not an observation about
 * a page at all: the control plane paused the task itself, already knows why,
 * and does not need to be told by the slot. Every other reason maps to a real
 * `SafetyStopReason`, and a test asserts that null appears exactly once.
 */
export const PAUSE_REASON_TO_SAFETY: Readonly<
  Record<WorkerPauseReason, SafetyStopReason | null>
> = {
  employer_authentication_required: 'employer_authentication_required',
  claude_authentication_required: 'claude_authentication_required',
  captcha_detected: 'captcha',
  anti_bot_challenge_detected: 'anti_bot_warning',
  mfa_required: 'mfa_required',
  sensitive_information_requested: 'sensitive_information_requested',
  unknown_page: 'unknown_page',
  /* A question we hold no verified answer for is exactly `unknown_candidate_fact`. */
  unknown_question: 'unknown_candidate_fact',
  unsupported_site: 'unsupported_site',
  control_plane_paused: null,
};

/** Every pause reason, for exhaustiveness tests. */
export const ALL_PAUSE_REASONS: readonly WorkerPauseReason[] = WORKER_PAUSE_REASONS;

/**
 * Which pauses the current session state forces.
 *
 * FAILS CLOSED, in the same shape as the safety evaluator: a session counts as
 * established only when it says `authenticated`. `unknown` pauses, because a
 * check that could not be performed is not a check that passed — and the page
 * behind a login wall is the one most easily mistaken for a form.
 *
 * The Claude session is consulted ONLY in assisted mode. In `openrouter_only`
 * it is `not_applicable`, and raising `claude_authentication_required` there
 * would ask the candidate to fix something with no bearing on the work.
 */
export function requiredPauseReasons(auth: {
  mode: 'openrouter_only' | 'claude_max_assisted';
  employer_session: SessionState;
  claude_max_session: SessionState;
}): WorkerPauseReason[] {
  const reasons: WorkerPauseReason[] = [];
  if (auth.employer_session !== 'authenticated') {
    reasons.push('employer_authentication_required');
  }
  if (auth.mode === 'claude_max_assisted' && auth.claude_max_session !== 'authenticated') {
    reasons.push('claude_authentication_required');
  }
  return reasons;
}

/* ------------------------------------------------------------- readiness */

/** The readiness a slot state reports. The discriminant IS the readiness. */
export const readinessOf = (state: SlotState): SlotReadiness => state.state;

/**
 * May this slot be given a new task?
 *
 * Both conditions, and they are genuinely different:
 *
 *   RUNNING is about the supervisor process. `starting` is not running — a
 *   supervisor still opening its browser contexts will drop a task handed to
 *   it — and `stopping` is not either, because work accepted during shutdown
 *   is work abandoned mid-form.
 *
 *   READY is about the slot. A `working` slot already has a task, and giving
 *   it a second is precisely the one-slot-one-task rule being broken.
 */
export function canAcceptTask(
  lifecycle: SupervisorLifecycle,
  state: SlotState
): { allowed: true } | { allowed: false; reason: 'supervisor_not_running' | 'slot_not_ready' } {
  if (lifecycle !== 'running') return { allowed: false, reason: 'supervisor_not_running' };
  if (state.state !== 'ready') return { allowed: false, reason: 'slot_not_ready' };
  return { allowed: true };
}

/** Every reason a submission can be refused, from all four checks. */
export type SlotSubmitRefusal =
  | 'supervisor_not_running'
  | 'slot_not_working'
  | Extract<LeaseVerdict, { valid: false }>['reason']
  | 'not_ready';

export type SlotSubmitVerdict =
  | { allowed: true }
  | { allowed: false; reason: SlotSubmitRefusal };

/**
 * May this slot submit? The complete gate.
 *
 * ORDER MATTERS, and it is: supervisor, slot, lease, task state.
 *
 * The lease check alone is not enough, which is the correction this milestone
 * makes. A slot can hold a perfectly valid, current, unexpired lease and still
 * have no business submitting — it may have paused on a CAPTCHA, be shutting
 * down, or have crashed and been restarted into a fresh context that never saw
 * the form. `canSubmit()` in the state machine answers "is this lease good for
 * this task"; only this function answers "and is the thing holding it in a fit
 * state to act".
 *
 * Every branch refuses. There is no path here that returns `allowed: true`
 * without all four passing.
 */
export function canSlotSubmit(input: {
  lifecycle: SupervisorLifecycle;
  slotState: SlotState;
  agentState: AgentState;
  lease: LeaseCheck;
}): SlotSubmitVerdict {
  if (input.lifecycle !== 'running') {
    return { allowed: false, reason: 'supervisor_not_running' };
  }
  // A paused, stopping, stopped, crashed, initializing or merely ready slot is
  // not mid-task, so there is nothing for it to legitimately submit.
  if (input.slotState.state !== 'working') {
    return { allowed: false, reason: 'slot_not_working' };
  }
  const verdict = isLeaseValid(input.lease);
  if (!verdict.valid) return { allowed: false, reason: verdict.reason };
  if (input.agentState !== 'ready_to_submit') {
    return { allowed: false, reason: 'not_ready' };
  }
  return { allowed: true };
}

/* ---------------------------------------------------------------- leases */

/** A lease can be extended, but not indefinitely. One hour, total. */
export const MAX_TOTAL_LEASE_SECONDS = 3600;

export interface RenewalContext {
  request: {
    lease_id: string;
    task_id: string;
    slot_id: string;
    fence_token: number;
    extend_by_seconds: number;
  };
  lease: {
    lease_id: string;
    task_id: string;
    slot_id: string;
    acquired_at: string;
    expires_at: string;
    fence_token: number;
  } | null;
  current_fence_token: number;
  now: Date;
}

export type RenewalVerdict =
  | { granted: true; expires_at: string }
  | {
      granted: false;
      reason:
        | 'no_lease'
        | 'wrong_lease'
        | 'wrong_slot'
        | 'wrong_task'
        | 'stale_fence'
        | 'expired'
        | 'max_lease_exceeded';
    };

/**
 * Extend a living lease.
 *
 * TWO RULES, both of which exist because of the same failure.
 *
 * 1. AN EXPIRED LEASE IS NEVER RENEWED. Once it lapsed, the task went back to
 *    the queue and was re-leased under a higher fence token. Reviving the old
 *    one would put two slots on one task — the exact outcome fencing exists to
 *    prevent. A slot whose renewal is refused for `expired` must abandon the
 *    task, not retry: someone else has it.
 *
 * 2. A LEASE CANNOT BE HELD FOREVER BY RENEWING. A slot that hangs while still
 *    sending renewals looks alive and would keep a task hostage indefinitely.
 *    `MAX_TOTAL_LEASE_SECONDS` from acquisition is the ceiling; past it the
 *    task returns to the queue, where a healthy slot can take it.
 *
 * The new expiry is measured from NOW, not from the old expiry, so a slot that
 * renews late does not bank the time it was unresponsive.
 */
export function evaluateRenewal(ctx: RenewalContext): RenewalVerdict {
  const { request, lease, current_fence_token, now } = ctx;
  if (!lease) return { granted: false, reason: 'no_lease' };
  if (lease.lease_id !== request.lease_id) return { granted: false, reason: 'wrong_lease' };
  if (lease.slot_id !== request.slot_id) return { granted: false, reason: 'wrong_slot' };
  if (lease.task_id !== request.task_id) return { granted: false, reason: 'wrong_task' };

  // Before expiry, as everywhere else: a stale token is stale whatever the
  // clock says, and the slot holding it has already been superseded.
  if (lease.fence_token !== current_fence_token || request.fence_token !== current_fence_token) {
    return { granted: false, reason: 'stale_fence' };
  }

  const expires = Date.parse(lease.expires_at);
  if (!Number.isFinite(expires) || expires <= now.getTime()) {
    return { granted: false, reason: 'expired' };
  }

  const acquired = Date.parse(lease.acquired_at);
  if (!Number.isFinite(acquired)) return { granted: false, reason: 'expired' };

  const next = now.getTime() + request.extend_by_seconds * 1000;
  if (next - acquired > MAX_TOTAL_LEASE_SECONDS * 1000) {
    return { granted: false, reason: 'max_lease_exceeded' };
  }
  return { granted: true, expires_at: new Date(next).toISOString() };
}

/* ------------------------------------------------------ completion events */

export interface TaskEventLike {
  kind: 'task_started' | 'task_paused' | 'task_completed' | 'task_failed';
  task_id: string;
  idempotency_key: string;
  fence_token: number;
  outcome: string | null;
}

/** The identity of a report about a task. Not the event id — that is per send. */
export const completionKey = (e: { task_id: string; idempotency_key: string }): string =>
  `${e.task_id}:${e.idempotency_key}`;

export interface DedupeResult {
  /** One entry per distinct (task_id, idempotency_key). */
  accepted: TaskEventLike[];
  /** Byte-identical repeats, safely discarded. */
  duplicates: number;
  /** Same key, DIFFERENT claim. Never silently resolved. */
  conflicts: TaskEventLike[];
  /** Reports whose fence token is not the current one, per task. */
  fenced: TaskEventLike[];
}

/**
 * Collapse repeated reports into one, and refuse the ones that are not repeats.
 *
 * DUPLICATES ARE NORMAL. A completion sent over a flaky connection is retried;
 * a queue redelivers. Handling that badly means two real applications to one
 * employer, from one candidate, minutes apart.
 *
 * THREE OUTCOMES, kept apart on purpose:
 *
 *   accepted    the first report for a key.
 *   duplicates  the same key making the same claim. Discarded, counted.
 *   conflicts   the same key making a DIFFERENT claim — one says submitted,
 *               the other failed. Never resolved by picking one: they cannot
 *               both be true, and a rule like "last write wins" would decide a
 *               question about a real application by arrival order. It goes to
 *               a human.
 *
 * Fenced reports are separated before any of that. A stale slot's completion
 * is not a duplicate — it is a claim from something that lost the right to
 * make claims, and folding it into `duplicates` would hide it.
 */
export function dedupeTaskEvents(
  events: readonly TaskEventLike[],
  currentFenceTokens: Readonly<Record<string, number>>
): DedupeResult {
  const accepted: TaskEventLike[] = [];
  const conflicts: TaskEventLike[] = [];
  const fenced: TaskEventLike[] = [];
  const seen = new Map<string, TaskEventLike>();
  let duplicates = 0;

  for (const e of events) {
    const current = currentFenceTokens[e.task_id];
    if (current === undefined || e.fence_token !== current) {
      fenced.push(e);
      continue;
    }
    const k = completionKey(e);
    const first = seen.get(k);
    if (!first) {
      seen.set(k, e);
      accepted.push(e);
      continue;
    }
    if (first.kind === e.kind && first.outcome === e.outcome) {
      duplicates++;
      continue;
    }
    conflicts.push(e);
  }
  return { accepted, duplicates, conflicts, fenced };
}

/* ------------------------------------------------------- crash isolation */

export interface SlotSummaryLike {
  slot_id: string;
  slot_index: number;
  readiness: SlotReadiness;
  task_id: string | null;
}

/**
 * One slot crashed. Everything else carries on.
 *
 * A crash is a property of ONE browser context, and this returns the other
 * entries by reference — untouched, identical objects — so the isolation is
 * something a test can assert by identity rather than by eyeballing a diff.
 *
 * The crashed slot loses its `task_id` here, and that is not the task being
 * abandoned: the task keeps its lease until it expires, and is then re-leased
 * under a higher fence token. If the crashed slot comes back mid-form and
 * tries to finish, it is fenced out. That is the whole point of the fence.
 */
export function applySlotCrash(
  slots: readonly SlotSummaryLike[],
  crashedSlotId: string
): SlotSummaryLike[] {
  return slots.map((s) =>
    s.slot_id === crashedSlotId ? { ...s, readiness: 'crashed' as const, task_id: null } : s
  );
}

/**
 * Build a supervisor summary from the slots themselves.
 *
 * The counts are DERIVED, never passed in. A supervisor that reported its own
 * totals could report three ready slots while listing none, and the contract's
 * refinements would then be checking one lie against another.
 */
export function summariseSlots(slots: readonly SlotSummaryLike[]): {
  slots_ready: number;
  slots_working: number;
  slots_paused: number;
} {
  return {
    slots_ready: slots.filter((s) => s.readiness === 'ready').length,
    slots_working: slots.filter((s) => s.readiness === 'working').length,
    slots_paused: slots.filter((s) => s.readiness === 'paused').length,
  };
}

/* --------------------------------------------------------- secret hygiene */

/**
 * Field names that would mean a credential had reached a payload.
 *
 * A heartbeat travels from the candidate's machine to the control plane and is
 * logged at both ends. Nothing that authenticates anything may ride along.
 *
 * The contracts are `.strict()` with fixed field lists, so this cannot happen
 * silently today — but "the schema would reject it" is an argument, and a test
 * that reads the key names is a control. Note that `fence_token` is not a
 * credential and deliberately does not match: it is a counter, useless to
 * anyone who does not already hold the lease.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /bearer/i,
  /authorization/i,
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /session[_-]?token/i,
  /cookie/i,
  /credential/i,
  /private[_-]?key/i,
  /service[_-]?role/i,
];

/** Any key that looks like it carries a credential. Empty is the only pass. */
export function findCredentialLikeKeys(payload: object): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) {
      if (CREDENTIAL_PATTERNS.some((re) => re.test(k))) found.push(k);
      walk(v);
    }
  };
  walk(payload);
  return found;
}
