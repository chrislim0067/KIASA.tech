/**
 * The job/task lifecycle, as an explicit graph.
 *
 * Written as data rather than as `if` statements scattered through handlers,
 * because the interesting question is never "can this one transition happen"
 * but "what is the complete set, and which are missing". A table can be read,
 * diffed and tested exhaustively. Conditionals spread across five files cannot.
 *
 * FAIL CLOSED. `canTransition` answers false for anything not explicitly
 * listed, including states it has never heard of. A transition nobody thought
 * about is refused, not permitted by omission.
 *
 * THE TWO RULES THAT PROTECT A REAL PERSON
 *
 *   * `submitted` and `cancelled` are TERMINAL. Nothing leaves them. An
 *     application that has been sent cannot be re-sent by a retry, a
 *     redelivered queue message, or a worker waking up confused.
 *
 *   * A retry does not move state. It re-enters `processing` from `leased`
 *     with the SAME idempotency key, so replaying it is a no-op rather than a
 *     second application. `isRetryAllowed` is where that is decided, and it
 *     consults the lease, not the worker's opinion of the lease.
 */

export const AGENT_STATES = [
  'received',
  'validated',
  'snapshot_stored',
  'normalized',
  'scored',
  'rejected',
  'queued',
  'leased',
  'processing',
  'manual_review',
  'ready_to_submit',
  'submitted',
  'failed',
  'duplicate',
  'cancelled',
] as const;

export type AgentState = (typeof AGENT_STATES)[number];

/**
 * States nothing may leave.
 *
 * `submitted` because an application has reached an employer and cannot be
 * unsent. `cancelled` because a candidate said stop, and "stop" that can be
 * undone by a stale message is not a stop. `duplicate` because the work was
 * already done under another task.
 */
export const TERMINAL_STATES: readonly AgentState[] = ['submitted', 'cancelled', 'duplicate'];

/**
 * The complete transition table.
 *
 * Read as: from → the states it may move to. Anything absent is refused.
 */
export const TRANSITIONS: Readonly<Record<AgentState, readonly AgentState[]>> = {
  // Intake. A URL arrives and is checked before anything touches the network.
  received: ['validated', 'rejected', 'duplicate', 'cancelled'],
  validated: ['snapshot_stored', 'failed', 'cancelled'],
  snapshot_stored: ['normalized', 'failed', 'cancelled'],
  normalized: ['scored', 'rejected', 'failed', 'cancelled'],

  // Assessment. `rejected` is a decision; `failed` is a malfunction.
  scored: ['queued', 'rejected', 'cancelled'],
  rejected: [],

  // Execution.
  queued: ['leased', 'cancelled', 'duplicate'],
  // A lease can expire without the worker noticing, which returns the task to
  // the queue. That is the ONLY way a lease ends other than the worker acting.
  leased: ['processing', 'queued', 'failed', 'cancelled'],
  processing: ['manual_review', 'ready_to_submit', 'failed', 'queued', 'cancelled'],

  // A human is required. Resumable, or abandoned — never automatically retried.
  manual_review: ['ready_to_submit', 'cancelled', 'failed'],

  // The last gate before a real application is sent.
  ready_to_submit: ['submitted', 'manual_review', 'failed', 'cancelled'],

  // Terminal.
  submitted: [],
  cancelled: [],
  duplicate: [],

  // A retryable failure returns to the queue; a permanent one is abandoned or
  // handed to a person. `failed` -> `submitted` is deliberately absent.
  failed: ['queued', 'manual_review', 'cancelled'],
};

export const isAgentState = (value: unknown): value is AgentState =>
  typeof value === 'string' && (AGENT_STATES as readonly string[]).includes(value);

export const isTerminal = (state: AgentState): boolean => TERMINAL_STATES.includes(state);

/** Fails closed: an unknown state, or an unlisted edge, is refused. */
export function canTransition(from: unknown, to: unknown): boolean {
  if (!isAgentState(from) || !isAgentState(to)) return false;
  return TRANSITIONS[from].includes(to);
}

export type TransitionResult =
  | { ok: true; state: AgentState }
  | { ok: false; reason: 'unknown_state' | 'terminal' | 'not_allowed'; detail: string };

/** Apply a transition, or explain precisely why not. Never throws. */
export function transition(from: unknown, to: unknown): TransitionResult {
  if (!isAgentState(from)) return { ok: false, reason: 'unknown_state', detail: `from=${String(from)}` };
  if (!isAgentState(to)) return { ok: false, reason: 'unknown_state', detail: `to=${String(to)}` };
  if (isTerminal(from)) {
    return { ok: false, reason: 'terminal', detail: `${from} is terminal` };
  }
  if (!TRANSITIONS[from].includes(to)) {
    return { ok: false, reason: 'not_allowed', detail: `${from} -> ${to}` };
  }
  return { ok: true, state: to };
}

/* ------------------------------------------------------------- retries */

export interface LeaseView {
  /** ISO instant the lease expires. */
  expires_at: string;
  /** Increases on every lease of the task. */
  fence_token: number;
}

export interface RetryQuery {
  state: AgentState;
  attempt: number;
  max_attempts: number;
  /** Whether the last failure could plausibly succeed next time. */
  failure_kind: 'retryable' | 'permanent' | null;
}

export type RetryDecision =
  | { retry: true }
  | { retry: false; reason: 'terminal' | 'not_failed' | 'permanent' | 'attempts_exhausted' };

/**
 * May this be retried?
 *
 * Attempts are counted, never reset, and a permanent failure is never retried
 * however many attempts remain — retrying a rejected file upload a further
 * four times only produces four more rejections and four more charges.
 */
export function isRetryAllowed(q: RetryQuery): RetryDecision {
  if (isTerminal(q.state)) return { retry: false, reason: 'terminal' };
  if (q.state !== 'failed') return { retry: false, reason: 'not_failed' };
  if (q.failure_kind !== 'retryable') return { retry: false, reason: 'permanent' };
  if (q.attempt >= q.max_attempts) return { retry: false, reason: 'attempts_exhausted' };
  return { retry: true };
}

/* ------------------------------------------------------- lease validity */

export type LeaseVerdict =
  | { valid: true }
  | { valid: false; reason: 'expired' | 'stale_fence' | 'no_lease' | 'wrong_worker' };

export interface LeaseCheck {
  lease: (LeaseView & { worker_id: string }) | null;
  /** The token the control plane currently considers authoritative. */
  current_fence_token: number;
  /** Who is asking. */
  worker_id: string;
  /** Injected so the tests are deterministic. */
  now: Date;
}

/**
 * May this worker still act on this task?
 *
 * THE FENCE TOKEN IS THE POINT. Expiry alone is not enough: a worker that
 * stalls — a long GC pause, a suspended laptop, a hung network call — cannot
 * notice its own lease expiring, because it is not running. It wakes up
 * believing it still holds the lease and tries to submit.
 *
 * So the control plane, not the worker, decides. Every lease of a task
 * increases the token, and a completion is accepted only from the current one.
 * A stale worker is holding an old number and is refused, whatever its own
 * clock says. This is checked BEFORE any submission, which is the single most
 * important ordering rule in the whole control plane.
 */
export function isLeaseValid(check: LeaseCheck): LeaseVerdict {
  const { lease, current_fence_token, worker_id, now } = check;
  if (!lease) return { valid: false, reason: 'no_lease' };
  if (lease.worker_id !== worker_id) return { valid: false, reason: 'wrong_worker' };
  // Checked before expiry: a worker with a stale token is stale even if its
  // own lease row has not lapsed yet.
  if (lease.fence_token !== current_fence_token) return { valid: false, reason: 'stale_fence' };
  const expires = Date.parse(lease.expires_at);
  if (!Number.isFinite(expires) || expires <= now.getTime()) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true };
}

/**
 * May this worker submit?
 *
 * Submission is the irreversible act, so it takes both checks and takes them
 * in this order: a valid, current lease AND a state that is genuinely ready.
 */
export function canSubmit(check: LeaseCheck & { state: AgentState }): LeaseVerdict | { valid: false; reason: 'not_ready' } {
  const lease = isLeaseValid(check);
  if (!lease.valid) return lease;
  if (check.state !== 'ready_to_submit') return { valid: false, reason: 'not_ready' };
  return { valid: true };
}
