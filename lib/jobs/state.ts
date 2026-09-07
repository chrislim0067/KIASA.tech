/**
 * The job pipeline state machine.
 *
 * The AUTHORITY is the `guard_job_status_transition()` trigger in migration 13.
 * That is deliberate: RLS lets a client PATCH `jobs.status` straight through
 * PostgREST without touching this code, so a TypeScript-only rule would be
 * advisory at best — and this pipeline is meant to be driven by agents.
 *
 * This module mirrors the trigger so callers get an answer without a round
 * trip, and `scripts/test-job-state-parity.mjs` parses the migration and
 * asserts the two sets are identical in both directions. If they ever diverge,
 * that test fails rather than the two quietly disagreeing.
 */

export const JOB_STATUSES = [
  'received',
  'fetching',
  'fetched',
  'fetch_failed',
  'extracting',
  'extracted',
  'extraction_incomplete',
  'archived',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Legal transitions, in the same `from>to` form the SQL trigger uses so the two
 * can be compared literally.
 */
export const LEGAL_TRANSITIONS: readonly string[] = Object.freeze([
  'received>fetching', 'received>archived',
  'fetching>fetched', 'fetching>fetch_failed',
  'fetched>extracting', 'fetched>fetching', 'fetched>archived',
  'fetch_failed>fetching', 'fetch_failed>archived',
  'extracting>extracted', 'extracting>extraction_incomplete',
  'extracted>extracting', 'extracted>fetching', 'extracted>archived',
  'extraction_incomplete>extracting', 'extraction_incomplete>fetching',
  'extraction_incomplete>archived',
]);

const LEGAL: ReadonlySet<string> = new Set(LEGAL_TRANSITIONS);

/**
 * Work is in flight. A scheduler should leave these alone until they resolve or
 * are judged stale.
 */
export const IN_PROGRESS_STATUSES: readonly JobStatus[] = Object.freeze(['fetching', 'extracting']);

/** Resolved unsuccessfully but retryable — the states that need attention. */
export const PARKED_STATUSES: readonly JobStatus[] = Object.freeze(['fetch_failed', 'extraction_incomplete']);

/** No further automatic work. `archived` accepts no outgoing transition. */
export const TERMINAL_STATUSES: readonly JobStatus[] = Object.freeze(['archived']);

/** Ready for the next stage to pick up. */
export const ACTIONABLE_STATUSES: readonly JobStatus[] = Object.freeze([
  'received', 'fetched', 'extracted',
]);

/**
 * The status alone tells a scheduler what to do, with no heuristics and no
 * inspection of other columns.
 */
export function classifyStatus(status: JobStatus): 'actionable' | 'in_progress' | 'parked' | 'terminal' {
  if (TERMINAL_STATUSES.includes(status)) return 'terminal';
  if (IN_PROGRESS_STATUSES.includes(status)) return 'in_progress';
  if (PARKED_STATUSES.includes(status)) return 'parked';
  return 'actionable';
}

export const isJobStatus = (value: unknown): value is JobStatus =>
  typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);

/**
 * True when `from -> to` is legal.
 *
 * A no-op (`from === to`) is legal and is not a transition: the trigger returns
 * early on it, and re-running a stage that is already in its own state must be
 * safe for the pipeline to be resumable.
 */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return true;
  return LEGAL.has(`${from}>${to}`);
}

/** The states reachable from `from`, excluding the no-op. */
export function nextStatuses(from: JobStatus): JobStatus[] {
  return JOB_STATUSES.filter((to) => to !== from && LEGAL.has(`${from}>${to}`));
}

/** Event types recorded in `job_events`. Mirrors the CHECK in migration 12. */
export const JOB_EVENT_TYPES = [
  'submitted', 'deduplicated', 'status_changed',
  'fetch_started', 'fetch_succeeded', 'fetch_failed', 'fetch_refused',
  'extraction_started', 'extraction_succeeded', 'extraction_incomplete',
  'archived',
] as const;
export type JobEventType = (typeof JOB_EVENT_TYPES)[number];

/**
 * Who caused an event.
 *
 * `agent` is present but unused in this step. The owner decision on record is
 * that escalations will later be routed to a resolver agent with the human as
 * fallback, and retrofitting actor identity onto an audit log after the fact is
 * not possible — so the distinction is established now.
 */
export const ACTOR_TYPES = ['human', 'agent', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
