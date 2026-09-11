import 'server-only';

/**
 * Job-intake data-access layer.
 *
 * Mirrors lib/profile exactly: an injected authenticated client plus the userId
 * from getUser(), a Result discriminated union rather than thrown errors, and
 * the same error categories. No service-role key, no RLS bypass.
 *
 * Two behaviours carried over from the profile layer because they were learned
 * the hard way there:
 *   - `user_id` is always stamped from the authenticated identity, never taken
 *     from caller input, so row donation is impossible by construction;
 *   - every mutation requests the affected rows back and maps zero rows to
 *     `not_found`, because an UPDATE filtered out by RLS returns success with
 *     zero rows rather than an error.
 */
import { fail, mapPostgrestError, ok, type Result } from '@/lib/profile/errors';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { canonicaliseUrl } from './url';
import { canTransition, type ActorType, type JobEventType, type JobStatus } from './state';
import { extractJobFacts } from './extract';
import { vendorApiEndpoint, greenhouseFacts, isVendorApiUrl } from './vendor-api';
import type { FetchAttempt, JobFetcher } from './fetcher';

export type JobsClient = SupabaseClient<Database>;

type Tables = Database['public']['Tables'];
export type JobRow = Tables['jobs']['Row'];
export type JobSnapshotRow = Tables['job_snapshots']['Row'];
export type JobFactsRow = Tables['job_facts']['Row'];
export type JobEventRow = Tables['job_events']['Row'];

/** Who is acting. Every mutation records one, so events are attributable. */
export interface Actor {
  readonly type: ActorType;
  /** Required for 'human' (the auth.users id); optional for agent/system. */
  readonly id?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUserId(userId: string | null | undefined): Result<string> {
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    return fail('unauthenticated', 'missing_user_id',
      'No authenticated user. Establish identity with getUser() before calling the jobs layer.');
  }
  return ok(userId);
}

/**
 * A human actor must be identified, and must be the authenticated user — an
 * event claiming a different human would be a forged audit entry.
 */
function requireActor(actor: Actor, userId: string): Result<Actor> {
  if (actor.type === 'human') {
    if (!actor.id || !UUID.test(actor.id)) {
      return fail('invalid_input', 'actor_id_required',
        'A human actor must be identified.', { field: 'actor.id' });
    }
    if (actor.id !== userId) {
      return fail('forbidden', 'actor_mismatch',
        'A human actor must be the authenticated user.', { field: 'actor.id' });
    }
  }
  return ok(actor);
}

/* --------------------------------------------------------------- events */

/**
 * Appends one event. Called by every mutation, so the log records what actually
 * happened rather than what a caller chose to report.
 */
async function appendEvent(
  client: JobsClient,
  userId: string,
  jobId: string,
  event: {
    type: JobEventType;
    actor: Actor;
    fromStatus?: JobStatus | null;
    toStatus?: JobStatus | null;
    errorCategory?: string | null;
    errorCode?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<Result<JobEventRow>> {
  const { data, error } = await client
    .from('job_events')
    .insert({
      user_id: userId,
      job_id: jobId,
      event_type: event.type,
      from_status: event.fromStatus ?? null,
      to_status: event.toStatus ?? null,
      actor_type: event.actor.type,
      actor_id: event.actor.id ?? null,
      error_category: event.errorCategory ?? null,
      error_code: event.errorCode ?? null,
      detail: (event.detail ?? {}) as never,
    })
    .select()
    .single();
  if (error) return mapPostgrestError(error, { table: 'job_events', operation: 'insert' });
  return ok(data);
}

/* --------------------------------------------------------------- submit */

export interface SubmitJobInput {
  readonly url: string;
  readonly source?: 'user_link' | 'user_paste' | 'agent_discovered' | 'imported';
}

export interface SubmitJobResult {
  readonly job: JobRow;
  /** True when an existing job was returned instead of a new one being created. */
  readonly deduplicated: boolean;
}

/**
 * Submits a URL, idempotently.
 *
 * Submitting the same posting twice returns the EXISTING job rather than
 * failing or creating a second row: for a caller — especially an agent retrying
 * after a timeout — "this job is already here" is success, not an error.
 *
 * The canonical form decides identity; see lib/jobs/url.ts for exactly which
 * URL shapes collapse together.
 */
export async function submitJob(
  client: JobsClient, userId: string, input: SubmitJobInput, actor: Actor,
): Promise<Result<SubmitJobResult>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;
  const checkedActor = requireActor(actor, id.data);
  if (!checkedActor.ok) return checkedActor;

  const canonical = canonicaliseUrl(input.url);
  if (!canonical.ok) {
    return fail('invalid_input', `url_${canonical.reason}`,
      'That does not look like a usable job URL.', { field: 'url' });
  }

  const existing = await client
    .from('jobs').select('*')
    .eq('user_id', id.data).eq('canonical_url', canonical.value.canonical)
    .maybeSingle();
  if (existing.error) return mapPostgrestError(existing.error, { table: 'jobs', operation: 'select' });
  if (existing.data) {
    const event = await appendEvent(client, id.data, existing.data.id, {
      type: 'deduplicated', actor: checkedActor.data,
      detail: { submitted_url: input.url, canonical_url: canonical.value.canonical },
    });
    if (!event.ok) return event;
    return ok({ job: existing.data, deduplicated: true });
  }

  const created = await client
    .from('jobs')
    .insert({
      user_id: id.data,
      submitted_url: canonical.value.submitted,
      canonical_url: canonical.value.canonical,
      source: input.source ?? 'user_link',
      ats_vendor: canonical.value.atsVendor,
      external_job_id: canonical.value.externalJobId,
      status: 'received',
    })
    .select()
    .single();

  if (created.error) {
    // Lost a race with a concurrent submission of the same URL. The unique
    // constraint firing means the job exists, which is the caller's desired end
    // state, so re-read and report it as a deduplication.
    if (created.error.code === '23505') {
      const reread = await client
        .from('jobs').select('*')
        .eq('user_id', id.data).eq('canonical_url', canonical.value.canonical)
        .maybeSingle();
      if (reread.error) return mapPostgrestError(reread.error, { table: 'jobs', operation: 'select' });
      if (reread.data) return ok({ job: reread.data, deduplicated: true });
    }
    return mapPostgrestError(created.error, { table: 'jobs', operation: 'insert' });
  }

  const event = await appendEvent(client, id.data, created.data.id, {
    type: 'submitted', actor: checkedActor.data, toStatus: 'received',
    detail: { submitted_url: input.url, canonical_url: canonical.value.canonical },
  });
  if (!event.ok) return event;
  return ok({ job: created.data, deduplicated: false });
}

/* ---------------------------------------------------------------- reads */

export async function getJob(client: JobsClient, userId: string, jobId: string): Promise<Result<JobRow | null>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;
  if (!UUID.test(jobId)) {
    return fail('invalid_input', 'bad_row_id', 'The job id is not a valid identifier.', { field: 'jobId' });
  }
  const { data, error } = await client
    .from('jobs').select('*').eq('user_id', id.data).eq('id', jobId).maybeSingle();
  if (error) return mapPostgrestError(error, { table: 'jobs', operation: 'select' });
  return ok(data ?? null);
}

export interface ListJobsOptions {
  readonly status?: JobStatus | readonly JobStatus[];
  readonly limit?: number;
}

/** Lists jobs, newest first, with `id` as a tiebreaker so paging is stable. */
export async function listJobs(
  client: JobsClient, userId: string, options: ListJobsOptions = {},
): Promise<Result<JobRow[]>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;
  let query = client.from('jobs').select('*').eq('user_id', id.data);
  if (options.status !== undefined) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    query = query.in('status', statuses as string[]);
  }
  query = query.order('created_at', { ascending: false }).order('id', { ascending: true });
  if (options.limit !== undefined) query = query.limit(options.limit);
  const { data, error } = await query;
  if (error) return mapPostgrestError(error, { table: 'jobs', operation: 'select' });
  return ok(data ?? []);
}

export async function listSnapshots(
  client: JobsClient, userId: string, jobId: string,
): Promise<Result<JobSnapshotRow[]>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;
  const { data, error } = await client
    .from('job_snapshots').select('*')
    .eq('user_id', id.data).eq('job_id', jobId)
    .order('fetched_at', { ascending: false }).order('id', { ascending: true });
  if (error) return mapPostgrestError(error, { table: 'job_snapshots', operation: 'select' });
  return ok(data ?? []);
}

export async function getFacts(
  client: JobsClient, userId: string, snapshotId: string,
): Promise<Result<JobFactsRow | null>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;
  const { data, error } = await client
    .from('job_facts').select('*')
    .eq('user_id', id.data).eq('snapshot_id', snapshotId).maybeSingle();
  if (error) return mapPostgrestError(error, { table: 'job_facts', operation: 'select' });
  return ok(data ?? null);
}

/** The audit log for one job, oldest first — the order it happened in. */
export async function listEvents(
  client: JobsClient, userId: string, jobId: string,
): Promise<Result<JobEventRow[]>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;
  const { data, error } = await client
    .from('job_events').select('*')
    .eq('user_id', id.data).eq('job_id', jobId)
    .order('occurred_at', { ascending: true }).order('id', { ascending: true });
  if (error) return mapPostgrestError(error, { table: 'job_events', operation: 'select' });
  return ok(data ?? []);
}

/* ---------------------------------------------------------- transitions */

/**
 * Moves a job to a new status and records exactly one event.
 *
 * Validated here for a fast, specific answer, and again by the migration-13
 * trigger which is the authority — a client can PATCH the column directly, so
 * the database must be the one that actually refuses.
 *
 * A no-op transition (already in the target state) succeeds without writing an
 * event: re-running a stage must be safe, and a resumed pipeline must not
 * inflate the audit log with entries for work that did not happen.
 */
export async function transitionJob(
  client: JobsClient,
  userId: string,
  jobId: string,
  to: JobStatus,
  actor: Actor,
  options: { reason?: string | null; errorCategory?: string | null; errorCode?: string | null; detail?: Record<string, unknown> } = {},
): Promise<Result<JobRow>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;
  const checkedActor = requireActor(actor, id.data);
  if (!checkedActor.ok) return checkedActor;

  const current = await getJob(client, id.data, jobId);
  if (!current.ok) return current;
  if (!current.data) return fail('not_found', 'row_not_found', 'That job does not exist.');

  const from = current.data.status as JobStatus;
  if (from === to) return ok(current.data);   // idempotent, no event

  if (!canTransition(from, to)) {
    return fail('constraint_violation', 'illegal_transition',
      `A job cannot move from ${from} to ${to}.`, { field: 'status', detail: `${from}>${to}` });
  }

  const { data, error } = await client
    .from('jobs')
    .update({ status: to, status_reason: options.reason ?? null })
    .eq('user_id', id.data).eq('id', jobId)
    .select();
  if (error) return mapPostgrestError(error, { table: 'jobs', operation: 'update' });
  const rows = data ?? [];
  if (rows.length === 0) {
    return fail('not_found', 'row_not_found', 'That job does not exist or is not yours to modify.');
  }

  const event = await appendEvent(client, id.data, jobId, {
    type: 'status_changed', actor: checkedActor.data,
    fromStatus: from, toStatus: to,
    errorCategory: options.errorCategory ?? null,
    errorCode: options.errorCode ?? null,
    detail: options.detail ?? {},
  });
  if (!event.ok) return event;
  return ok(rows[0]);
}

/* ----------------------------------------------------------- fetch stage */

export interface FetchJobResult {
  readonly job: JobRow;
  readonly snapshot: JobSnapshotRow;
  readonly attempt: FetchAttempt;
}

/**
 * Fetches a job's page and stores the attempt as an immutable snapshot.
 *
 * Resumable: a job already in `fetching` is re-driven rather than refused, and
 * a job in a state with no legal path to `fetching` is rejected with a specific
 * category instead of silently doing nothing.
 *
 * A snapshot row is written for a FAILED attempt too. A refusal or an error is
 * evidence, and storing it is what lets a later retry be justified.
 */
export async function fetchJob(
  client: JobsClient, userId: string, jobId: string, fetcher: JobFetcher, actor: Actor,
): Promise<Result<FetchJobResult>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;
  const checkedActor = requireActor(actor, id.data);
  if (!checkedActor.ok) return checkedActor;

  const current = await getJob(client, id.data, jobId);
  if (!current.ok) return current;
  if (!current.data) return fail('not_found', 'row_not_found', 'That job does not exist.');

  const startingStatus = current.data.status as JobStatus;
  if (startingStatus !== 'fetching') {
    const started = await transitionJob(client, id.data, jobId, 'fetching', checkedActor.data);
    if (!started.ok) return started;
  }
  /*
   * PREFER THE BOARD'S OWN PUBLIC JSON, WHEN ONE CAN BE DERIVED.
   *
   * A Greenhouse posting renders its description in the browser, so fetching
   * the page server-side returns a shell and the read comes back partial. The
   * same posting is published as JSON at a documented endpoint, and
   * `vendorApiEndpoint` derives that endpoint from the canonical URL alone —
   * fixed host, strictly matched board token and job id, nothing from a query
   * string or a payload.
   *
   * The derived URL goes through THIS SAME FETCHER. It gets the scheme policy,
   * the DNS and address checks, the redirect limit, robots, the timeout, the
   * size cap, the content-type allowlist and the rate limiter exactly as any
   * other URL would. Deriving a URL does not make it trusted.
   *
   * When no endpoint can be derived — an embedded posting carries the job id
   * but not the board token — this falls back to the page, which is the
   * existing behaviour and is explicitly not claimed to be complete.
   */
  const endpoint = vendorApiEndpoint(current.data.canonical_url);
  const target = endpoint.ok ? endpoint.url : current.data.canonical_url;

  const fetchStarted = await appendEvent(client, id.data, jobId, {
    type: 'fetch_started',
    actor: checkedActor.data,
    // Both, so the audit trail says what was asked for AND what was read.
    detail: { url: current.data.canonical_url, fetched: target },
  });
  if (!fetchStarted.ok) return fetchStarted;

  const attempt = await fetcher.fetch(target);

  const snapshot = await client
    .from('job_snapshots')
    .insert({
      user_id: id.data,
      job_id: jobId,
      http_status: attempt.httpStatus,
      final_url: attempt.finalUrl,
      content_type: attempt.contentType,
      byte_size: attempt.byteSize,
      content_hash: attempt.contentHash,
      body: attempt.body,
      outcome: attempt.outcome,
    })
    .select()
    .single();
  if (snapshot.error) return mapPostgrestError(snapshot.error, { table: 'job_snapshots', operation: 'insert' });

  const succeeded = attempt.outcome === 'ok';
  const settled = await transitionJob(
    client, id.data, jobId, succeeded ? 'fetched' : 'fetch_failed', checkedActor.data,
    succeeded ? {} : { reason: attempt.outcome, errorCategory: attempt.outcome, errorCode: attempt.reason },
  );
  if (!settled.ok) return settled;

  const outcomeEvent = await appendEvent(client, id.data, jobId, {
    type: succeeded ? 'fetch_succeeded' : (attempt.outcome === 'refused_by_policy' ? 'fetch_refused' : 'fetch_failed'),
    actor: checkedActor.data,
    errorCategory: succeeded ? null : attempt.outcome,
    errorCode: succeeded ? null : attempt.reason,
    detail: { snapshot_id: snapshot.data.id, http_status: attempt.httpStatus, byte_size: attempt.byteSize },
  });
  if (!outcomeEvent.ok) return outcomeEvent;

  return ok({ job: settled.data, snapshot: snapshot.data, attempt });
}

/* -------------------------------------------------------- extract stage */

export interface ExtractJobResult {
  readonly job: JobRow;
  readonly facts: JobFactsRow;
}

/**
 * Runs deterministic extraction over a stored snapshot.
 *
 * Idempotent: the facts row is keyed on (user_id, snapshot_id) and upserted, so
 * re-extracting the same snapshot overwrites with identical content rather than
 * accumulating rows. Extraction itself is a pure function of the snapshot body,
 * so repeat runs produce byte-identical output.
 */
export async function extractJob(
  client: JobsClient, userId: string, jobId: string, snapshotId: string, actor: Actor,
): Promise<Result<ExtractJobResult>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;
  const checkedActor = requireActor(actor, id.data);
  if (!checkedActor.ok) return checkedActor;

  const snapshot = await client
    .from('job_snapshots').select('*')
    .eq('user_id', id.data).eq('id', snapshotId).eq('job_id', jobId).maybeSingle();
  if (snapshot.error) return mapPostgrestError(snapshot.error, { table: 'job_snapshots', operation: 'select' });
  if (!snapshot.data) return fail('not_found', 'row_not_found', 'That snapshot does not exist.');

  const started = await transitionJob(client, id.data, jobId, 'extracting', checkedActor.data);
  if (!started.ok) return started;
  const startEvent = await appendEvent(client, id.data, jobId, {
    type: 'extraction_started', actor: checkedActor.data, detail: { snapshot_id: snapshotId },
  });
  if (!startEvent.ok) return startEvent;

  /*
   * The parser follows the source. A snapshot taken from a vendor API is JSON
   * in that vendor's shape, not a web page with structured data embedded in it,
   * and running the HTML extractor over it would find nothing.
   */
  const result =
    isVendorApiUrl(snapshot.data.final_url) === 'greenhouse'
      ? greenhouseFacts(snapshot.data.body ?? '')
      : extractJobFacts(snapshot.data.body);

  const stored = await client
    .from('job_facts')
    .upsert({
      user_id: id.data,
      job_id: jobId,
      snapshot_id: snapshotId,
      ...result.facts,
      field_provenance: result.provenance as never,
      extraction_status: result.status,
      extraction_reason: result.reason,
    }, { onConflict: 'user_id,snapshot_id' })
    .select()
    .single();
  if (stored.error) return mapPostgrestError(stored.error, { table: 'job_facts', operation: 'upsert' });

  const complete = result.status === 'extracted';
  const settled = await transitionJob(
    client, id.data, jobId, complete ? 'extracted' : 'extraction_incomplete', checkedActor.data,
    complete ? {} : { reason: result.reason },
  );
  if (!settled.ok) return settled;

  const outcomeEvent = await appendEvent(client, id.data, jobId, {
    type: complete ? 'extraction_succeeded' : 'extraction_incomplete',
    actor: checkedActor.data,
    errorCategory: complete ? null : 'extraction',
    errorCode: complete ? null : result.reason,
    detail: { snapshot_id: snapshotId, fields: Object.keys(result.provenance).length },
  });
  if (!outcomeEvent.ok) return outcomeEvent;

  return ok({ job: settled.data, facts: stored.data });
}

/** Archives a job. Terminal: no transition leaves `archived`. */
export async function archiveJob(
  client: JobsClient, userId: string, jobId: string, actor: Actor,
): Promise<Result<JobRow>> {
  const result = await transitionJob(client, userId, jobId, 'archived', actor, { reason: 'archived_by_user' });
  if (!result.ok) return result;
  const id = requireUserId(userId);
  if (!id.ok) return id;
  const event = await appendEvent(client, id.data, jobId, { type: 'archived', actor, toStatus: 'archived' });
  if (!event.ok) return event;
  return ok(result.data);
}
