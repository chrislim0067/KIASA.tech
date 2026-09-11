/**
 * Public surface of the job-intake layer.
 *
 * Same contract as lib/profile: pass an authenticated Supabase client and the
 * userId from `supabase.auth.getUser()`, receive a `Result`. A UI route handler
 * and an agent runtime call these identically; the only difference is the
 * `Actor` they declare.
 *
 *   const supabase = await createClient();
 *   const { data: { user } } = await supabase.auth.getUser();
 *   if (!user) return;
 *   const actor = { type: 'human', id: user.id } as const;
 *
 *   const submitted = await submitJob(supabase, user.id, { url }, actor);
 *   if (submitted.ok) {
 *     const fetched = await fetchJob(supabase, user.id, submitted.data.job.id,
 *                                    createSafeFetcher(), actor);
 *     if (fetched.ok && fetched.data.attempt.outcome === 'ok') {
 *       await extractJob(supabase, user.id, fetched.data.job.id,
 *                        fetched.data.snapshot.id, actor);
 *     }
 *   }
 */
export {
  submitJob, getJob, listJobs, listSnapshots, getFacts, listEvents,
  transitionJob, fetchJob, extractJob, archiveJob,
} from './operations';
export type {
  Actor, JobsClient, JobRow, JobSnapshotRow, JobFactsRow, JobEventRow,
  SubmitJobInput, SubmitJobResult, FetchJobResult, ExtractJobResult, ListJobsOptions,
} from './operations';

export { canonicaliseUrl } from './url';
export type { CanonicalUrl, CanonicalResult, UrlRejection } from './url';

export {
  JOB_STATUSES, LEGAL_TRANSITIONS, JOB_EVENT_TYPES, ACTOR_TYPES,
  IN_PROGRESS_STATUSES, PARKED_STATUSES, TERMINAL_STATUSES, ACTIONABLE_STATUSES,
  canTransition, nextStatuses, classifyStatus, isJobStatus,
} from './state';
export type { JobStatus, JobEventType, ActorType } from './state';

export {
  createSafeFetcher, checkHost, isBlockedAddress, isAllowedByRobots,
  outcomeForStatus, FETCH_DEFAULTS,
} from './fetcher';
export type { JobFetcher, FetchAttempt, FetchOutcome, FetchOptions, HostVerdict } from './fetcher';

export { extractJobFacts } from './extract';
export { vendorApiEndpoint, greenhouseFacts, isVendorApiUrl } from './vendor-api';
export type { VendorEndpoint, EndpointRefusal } from './vendor-api';
export type { ExtractedFacts, ExtractionResult, ExtractionMethod, ExtractionReason } from './extract';
