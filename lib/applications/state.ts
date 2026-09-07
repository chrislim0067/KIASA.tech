/**
 * The application lifecycle state machine.
 *
 * The AUTHORITY is the `guard_application_status_transition()` trigger in
 * migration 15, for the same reason `lib/jobs/state.ts` defers to its trigger:
 * RLS lets a client PATCH `applications.status` straight through PostgREST
 * without touching this code, so a TypeScript-only rule would be advisory.
 *
 * This module mirrors the trigger so callers get an answer without a round
 * trip, and `scripts/test-application-state-parity.mjs` parses the migration
 * and asserts the two sets are identical in both directions.
 */

export const APPLICATION_STATUSES = [
  'queued',
  'preparing',
  'submitting',
  'submitted',
  'confirmed',
  'failed',
  'skipped',
  'cancelled',
  'duplicate',
  'needs_intervention',
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/**
 * How the application was made.
 *
 * `bid_bot` is a peer of `automated`, not a subtype of it. The administrator
 * question is "how many did the Bid Bot do", and a metric that depends on
 * remembering to also filter a flag is one that eventually gets reported wrong.
 * {@link AUTOMATION_METHODS} is the union when "all unattended work" is meant.
 */
export const APPLICATION_METHODS = ['manual', 'automated', 'bid_bot', 'external'] as const;
export type ApplicationMethod = (typeof APPLICATION_METHODS)[number];

/** Everything executed without a human driving it, Bid Bot included. */
export const AUTOMATION_METHODS: readonly ApplicationMethod[] = Object.freeze([
  'automated',
  'bid_bot',
]);

/**
 * Legal transitions, in the same `from>to` form the SQL trigger uses so the two
 * can be compared literally.
 */
export const LEGAL_TRANSITIONS: readonly string[] = Object.freeze([
  'queued>preparing', 'queued>cancelled', 'queued>skipped', 'queued>duplicate',
  'preparing>submitting', 'preparing>failed', 'preparing>skipped',
  'preparing>needs_intervention', 'preparing>cancelled', 'preparing>duplicate',
  'submitting>submitted', 'submitting>failed', 'submitting>needs_intervention',
  'submitted>confirmed', 'submitted>failed',
  'needs_intervention>preparing', 'needs_intervention>submitting',
  'needs_intervention>cancelled', 'needs_intervention>skipped',
  'needs_intervention>failed',
  'failed>queued', 'skipped>queued',
]);

const LEGAL: ReadonlySet<string> = new Set(LEGAL_TRANSITIONS);

/**
 * THE countability rule.
 *
 * An application counts as successfully applied when KIASA actually sent it —
 * `submitted` — or the destination acknowledged it — `confirmed`. Nothing else
 * counts. In particular a bot *beginning* work is not success: `preparing` and
 * `submitting` are in-flight, and reporting them as applied is exactly the
 * inaccuracy this model exists to prevent.
 *
 * Everything that reports "successfully applied" must derive it from here
 * rather than restating the list, so the definition cannot drift between the
 * dashboard, the user detail page and the SQL view.
 */
export const SUCCESS_STATUSES: readonly ApplicationStatus[] = Object.freeze([
  'submitted',
  'confirmed',
]);

/** Work is in flight. A scheduler leaves these alone until they resolve. */
export const IN_FLIGHT_STATUSES: readonly ApplicationStatus[] = Object.freeze([
  'queued',
  'preparing',
  'submitting',
]);

/** Resolved unsuccessfully but retryable. */
export const RETRYABLE_STATUSES: readonly ApplicationStatus[] = Object.freeze([
  'failed',
  'skipped',
]);

/** Blocked awaiting a human or a resolver agent. */
export const BLOCKED_STATUSES: readonly ApplicationStatus[] = Object.freeze(['needs_intervention']);

/** No further work. These accept no outgoing transition. */
export const TERMINAL_STATUSES: readonly ApplicationStatus[] = Object.freeze([
  'confirmed',
  'cancelled',
  'duplicate',
]);

export function isSuccess(status: ApplicationStatus): boolean {
  return SUCCESS_STATUSES.includes(status);
}

export function classifyStatus(
  status: ApplicationStatus
): 'in_flight' | 'succeeded' | 'blocked' | 'retryable' | 'terminal' {
  if (SUCCESS_STATUSES.includes(status)) return 'succeeded';
  if (IN_FLIGHT_STATUSES.includes(status)) return 'in_flight';
  if (BLOCKED_STATUSES.includes(status)) return 'blocked';
  if (RETRYABLE_STATUSES.includes(status)) return 'retryable';
  return 'terminal';
}

export const isApplicationStatus = (value: unknown): value is ApplicationStatus =>
  typeof value === 'string' && (APPLICATION_STATUSES as readonly string[]).includes(value);

export const isApplicationMethod = (value: unknown): value is ApplicationMethod =>
  typeof value === 'string' && (APPLICATION_METHODS as readonly string[]).includes(value);

/**
 * True when `from -> to` is legal. A no-op is legal and is not a transition:
 * re-running a stage that is already in its own state must be safe for the
 * pipeline to be resumable.
 */
export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  if (from === to) return true;
  return LEGAL.has(`${from}>${to}`);
}

/** The states reachable from `from`, excluding the no-op. */
export function nextStatuses(from: ApplicationStatus): ApplicationStatus[] {
  return APPLICATION_STATUSES.filter((to) => to !== from && LEGAL.has(`${from}>${to}`));
}

/**
 * Why an attempt did not succeed.
 *
 * `transient` retries on its own, `structural` needs a code or selector fix,
 * `terminal` is not worth retrying, and `question` means the executor needs an
 * answer rather than a repair. Routing a transient network failure to the same
 * handler as an unanswered screening question is the mistake this split exists
 * to prevent.
 */
export const FAILURE_CLASSES = ['transient', 'structural', 'terminal', 'question'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** Outcomes an individual attempt can end with. Mirrors the CHECK in migration 15. */
export const ATTEMPT_OUTCOMES = [
  'submitted',
  'failed',
  'skipped',
  'cancelled',
  'duplicate',
  'needs_intervention',
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** Who executed an attempt. Reuses the job_events vocabulary. */
export const EXECUTOR_TYPES = ['human', 'agent', 'system'] as const;
export type ExecutorType = (typeof EXECUTOR_TYPES)[number];
