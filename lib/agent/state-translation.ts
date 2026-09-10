import { AGENT_STATES, type AgentState } from '@/lib/agent/state-machine';
import type { ApplicationStatus } from '@/lib/applications/state';
import type { JobStatus } from '@/lib/jobs/state';

/**
 * How the three state machines in this repository relate.
 *
 * THERE ARE THREE, AND THAT IS DELIBERATE — but only because each answers a
 * different question about a different row. What was NOT deliberate was them
 * having no stated relationship, which is the gap this module closes.
 *
 *   lib/jobs/state.ts          a JOB: has the posting been fetched and read?
 *                              Authority: guard_job_status_transition (mig. 13)
 *
 *   lib/agent/state-machine.ts a TASK: how far has this unit of work got?
 *                              Authority: guard_automation_task_transition
 *                              (migration 22)
 *
 *   lib/applications/state.ts  an APPLICATION: what happened with the employer?
 *                              Authority: guard_application_status_transition
 *                              (migration 15)
 *
 * A job is fetched once and may have several tasks over time; a task that
 * reaches submission produces one application. So the mapping below is
 * MANY-TO-ONE and PARTIAL, and both properties matter: the early task states
 * have no application at all, and inventing a `queued` application for a job
 * that was merely normalised would show a candidate an application they never
 * made.
 *
 * Every function here is total over `AgentState` and returns `null` for "no
 * corresponding row yet", never a nearest guess.
 */

/**
 * The application status a task in this state implies.
 *
 * `null` before an application exists. That covers everything up to `scored`:
 * the system has read a posting and formed an opinion, and no employer has
 * heard from anyone.
 *
 * NOTE WHAT IS ABSENT: nothing maps to `confirmed`. A task cannot reach it,
 * because `confirmed` means an employer acknowledged the application — a fact
 * that arrives later, from outside, and is recorded against the application
 * row directly. A task reaching `submitted` yields `submitted` and stops
 * there. Mapping it to `confirmed` would be the system confirming its own
 * work, which is exactly the kind of self-report `submission_unknown` exists
 * to prevent.
 */
export function taskStateToApplicationStatus(state: AgentState): ApplicationStatus | null {
  switch (state) {
    case 'received':
    case 'validated':
    case 'snapshot_stored':
    case 'normalized':
    case 'scored':
      return null;

    // A decision not to apply. `skipped`, not `failed`: nothing malfunctioned.
    case 'rejected':
      return 'skipped';

    case 'queued':
      return 'queued';

    // Leased and processing are both "being worked on". The application row
    // does not care which slot holds it or how far through the form it is.
    case 'leased':
    case 'processing':
      return 'preparing';

    // A stop is not a failure. It is the system noticing a human is required,
    // and recording it as `failed` would make the failure rate meaningless.
    case 'manual_review':
      return 'needs_intervention';

    case 'ready_to_submit':
      return 'submitting';
    case 'submitted':
      return 'submitted';
    case 'failed':
      return 'failed';
    case 'duplicate':
      return 'duplicate';
    case 'cancelled':
      return 'cancelled';
  }
}

/**
 * The job status a task in this state implies — for the intake half only.
 *
 * `null` from `scored` onward, and that is the point: once a job has been read,
 * nothing a task does afterwards changes what the JOB is. A task that fails
 * while filling a form has not un-fetched the posting, and writing
 * `fetch_failed` back onto the job because a browser crashed would corrupt the
 * intake record with an execution problem.
 */
export function taskStateToJobStatus(state: AgentState): JobStatus | null {
  switch (state) {
    case 'received':
    case 'validated':
      return 'received';
    case 'snapshot_stored':
      return 'fetched';
    case 'normalized':
      return 'extracted';
    default:
      return null;
  }
}

/**
 * Does a task in this state require a person?
 *
 * Kept beside the translations because it is the question a UI actually asks,
 * and deriving it from the application status would lose `manual_review` —
 * which maps to `needs_intervention` but is reached from a different direction
 * and means something more specific.
 */
export function taskStateNeedsHuman(state: AgentState): boolean {
  return state === 'manual_review';
}

/**
 * Every mapping, as data.
 *
 * Exported so a test can assert totality over `AGENT_STATES` without calling
 * the functions state by state — which is how a newly added state slips
 * through with an accidental `undefined`.
 */
export const STATE_TRANSLATION: Readonly<
  Record<AgentState, { application: ApplicationStatus | null; job: JobStatus | null }>
> = Object.fromEntries(
  AGENT_STATES.map((state) => [
    state,
    { application: taskStateToApplicationStatus(state), job: taskStateToJobStatus(state) },
  ])
) as Readonly<Record<AgentState, { application: ApplicationStatus | null; job: JobStatus | null }>>;
