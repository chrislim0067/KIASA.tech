import 'server-only';

import { createJobBoardClient } from '@/lib/jobboard/client';
import {
  JOB_DETAIL_COLUMNS,
  JOB_OPPORTUNITY_COLUMNS,
  JOB_OPPORTUNITY_DETAIL_COLUMNS,
  JOB_SUMMARY_COLUMNS,
  isJobStatus,
  type JobDetail,
  type JobOpportunity,
  type JobOpportunityDetail,
  type JobSummary,
  type WorkplaceType,
} from '@/lib/jobboard/types';

/**
 * Reading the job board.
 *
 * THE PROJECTION BOUNDARY. Every row the administrator surface renders passes
 * through a function in this file, and each one builds its result field by
 * field rather than spreading the database row. A spread is how a column added
 * to `saved_jobs` next month — by a repository this one does not control —
 * silently reaches a browser. Naming the fields means a new column is invisible
 * here until someone decides it should not be.
 *
 * Everything is READ ONLY. KIASA does not own these rows; the browser extension
 * writes them and their owner controls them. There is deliberately no update or
 * delete in this module, and adding one would be a product decision about
 * acting on someone else's pipeline, not a refactor.
 */

/** How many rows the board will load in one pass. */
const LIST_LIMIT = 500;

/**
 * Coercion, shared by every projection in this file.
 *
 * Written defensively because this schema belongs to another repository. A
 * `status` outside the CHECK constraint, a null `skills` array, a numeric that
 * arrived as a string — none of them should blank the whole page, so each is
 * given a safe reading rather than trusted.
 *
 * Shared on purpose: two audiences see different FIELDS, but a numeric that
 * arrived as a string means the same thing to both, and two copies of these
 * rules would eventually disagree about it. What must not be shared is the
 * field list — see the note above the candidate projection at the bottom.
 */
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

const list = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

/** Only the three lowercase values the UI filters on; anything else is unknown. */
const workplaceOf = (v: unknown): WorkplaceType | null => {
  const w = str(v);
  return w === 'remote' || w === 'hybrid' || w === 'onsite' ? (w as WorkplaceType) : null;
};

/** Coerces a row into the summary the ADMINISTRATOR surface is typed against. */
function toSummary(row: Record<string, unknown>): JobSummary {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    fingerprint: String(row.fingerprint ?? ''),
    url: String(row.url ?? ''),
    domain: String(row.domain ?? ''),
    provider: str(row.provider),
    provider_job_id: str(row.provider_job_id),
    title: str(row.title),
    company: str(row.company),
    company_logo_url: str(row.company_logo_url),
    location: str(row.location),
    workplace_type: workplaceOf(row.workplace_type),
    employment_type: str(row.employment_type),
    salary_min: num(row.salary_min),
    salary_max: num(row.salary_max),
    salary_currency: str(row.salary_currency),
    salary_period: str(row.salary_period),
    experience_min_years: num(row.experience_min_years),
    experience_max_years: num(row.experience_max_years),
    skills: list(row.skills),
    sponsorship_available: bool(row.sponsorship_available),
    security_clearance_required: bool(row.security_clearance_required),
    extraction_confidence: num(row.extraction_confidence),
    // An unrecognised status renders as 'saved' rather than crashing the list.
    // This is a viewer for a schema it does not own; a value it has not been
    // taught about is a reason to degrade, not to fail.
    status: isJobStatus(row.status) ? row.status : 'saved',
    saved_at: String(row.saved_at ?? new Date(0).toISOString()),
    updated_at: String(row.updated_at ?? row.saved_at ?? new Date(0).toISOString()),
    // The note's EXISTENCE crosses to the client; its text does not.
    has_notes: typeof row.notes === 'string' && row.notes.trim().length > 0,
  };
}

/*
 * NO OWNER DIRECTORY LOOKUP LIVES HERE ANY MORE.
 *
 * There used to be a `resolveOwners()` that read the job board project’s
 * `auth.users` through the Auth admin API and attached an email to every row.
 * It is gone, along with the email itself — see the note at the bottom of
 * `lib/jobboard/types.ts` for why.
 *
 * Two things follow, and both are improvements. The page now makes ONE query
 * instead of two, dropping a round trip to a different service from every
 * render. And the only address that ever crossed this boundary no longer
 * crosses it at all, so there is nothing left to fail soft about.
 */

export interface JobListResult {
  readonly jobs: readonly JobSummary[];
  /** Set when the rows could not be read at all. The page shows this verbatim. */
  readonly error: string | null;
  /** True when more rows exist than {@link LIST_LIMIT} returned. */
  readonly truncated: boolean;
}

/**
 * Every saved job, newest first.
 *
 * Across all owners — that is the whole point of the administrator view, and
 * the reason it needs the secret key. Ordered by `saved_at` descending to match
 * the `saved_jobs_user_saved_at_idx` index and the order the source board uses.
 */
export async function listSavedJobs(): Promise<JobListResult> {
  let rows: Record<string, unknown>[];

  try {
    const client = createJobBoardClient();
    const { data, error } = await client
      .from('saved_jobs')
      .select(JOB_SUMMARY_COLUMNS)
      // One more than the limit, so "there are more" is known without a
      // second count query.
      .limit(LIST_LIMIT + 1)
      .order('saved_at', { ascending: false });

    if (error) return { jobs: [], error: error.message, truncated: false };
    rows = (data ?? []) as unknown as Record<string, unknown>[];
  } catch (error) {
    return {
      jobs: [],
      error: error instanceof Error ? error.message : 'The job board could not be reached.',
      truncated: false,
    };
  }

  return {
    jobs: rows.slice(0, LIST_LIMIT).map(toSummary),
    error: null,
    truncated: rows.length > LIST_LIMIT,
  };
}

/**
 * One saved job, with its long-form content.
 *
 * Returns null when the id does not exist, which the page turns into a 404. The
 * id is passed to `.eq()` as a bound parameter — PostgREST does not interpolate
 * it into SQL — so an id taken from the URL cannot alter the query.
 */
export async function getSavedJob(id: string): Promise<JobDetail | null> {
  try {
    const client = createJobBoardClient();
    const { data, error } = await client
      .from('saved_jobs')
      .select(JOB_DETAIL_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (error || !data) return null;

    const row = data as unknown as Record<string, unknown>;

    return {
      ...toSummary(row),
      description: typeof row.description === 'string' ? row.description : null,
      responsibilities: list(row.responsibilities),
      required_qualifications: list(row.required_qualifications),
      preferred_qualifications: list(row.preferred_qualifications),
      // The one place a note's text is read, and only for a single job the
      // administrator deliberately opened.
      notes: typeof row.notes === 'string' && row.notes.trim().length > 0 ? row.notes : null,
      applied_at: typeof row.applied_at === 'string' ? row.applied_at : null,
    };
  } catch {
    return null;
  }
}

/* ==========================================================================
 * The CANDIDATE projection.
 *
 * Same table, different audience, and therefore a different function, a
 * different column list and a different type. Nothing below reuses `toSummary`
 * or `JOB_SUMMARY_COLUMNS`: a field added there for an administrator must not
 * reach a page shown to every permitted candidate merely because the two shared
 * a helper.
 *
 * `notes` is not selected at all here — not fetched and then dropped, simply
 * never asked for. The same goes for `user_id` and `status`. What cannot be
 * read cannot be leaked by a later mistake in a component.
 * ======================================================================== */

/** Coerces a row into the shape the candidate board is typed against. */
function toOpportunity(row: Record<string, unknown>): JobOpportunity {
  return {
    id: String(row.id),
    url: String(row.url ?? ''),
    domain: String(row.domain ?? ''),
    provider: str(row.provider),
    title: str(row.title),
    company: str(row.company),
    company_logo_url: str(row.company_logo_url),
    location: str(row.location),
    workplace_type: workplaceOf(row.workplace_type),
    employment_type: str(row.employment_type),
    salary_min: num(row.salary_min),
    salary_max: num(row.salary_max),
    salary_currency: str(row.salary_currency),
    salary_period: str(row.salary_period),
    experience_min_years: num(row.experience_min_years),
    experience_max_years: num(row.experience_max_years),
    skills: list(row.skills),
    sponsorship_available: bool(row.sponsorship_available),
    security_clearance_required: bool(row.security_clearance_required),
    extraction_confidence: num(row.extraction_confidence),
    saved_at: String(row.saved_at ?? new Date(0).toISOString()),
  };
}

export interface OpportunityListResult {
  readonly jobs: readonly JobOpportunity[];
  readonly error: string | null;
  readonly truncated: boolean;
}

/**
 * Every posting on the board, as opportunities.
 *
 * No owner filter, because there is no owner to filter on — the board is a
 * shared pool here. THE CALLER MUST HAVE CHECKED `resolveJobBoardAccess()`
 * FIRST; this function knows nothing about who is asking, exactly as
 * `listSavedJobs()` knows nothing about administrators. Authorization is the
 * page's job and the guard's job, and keeping it out of here is what stops a
 * second call site from inventing its own idea of who may read this.
 *
 * No owner directory lookup either, which makes this strictly cheaper than the
 * administrator list: one query, no Auth admin round trip.
 */
export async function listJobOpportunities(): Promise<OpportunityListResult> {
  let rows: Record<string, unknown>[];

  try {
    const client = createJobBoardClient();
    const { data, error } = await client
      .from('saved_jobs')
      .select(JOB_OPPORTUNITY_COLUMNS)
      .limit(LIST_LIMIT + 1)
      .order('saved_at', { ascending: false });

    if (error) return { jobs: [], error: error.message, truncated: false };
    rows = (data ?? []) as unknown as Record<string, unknown>[];
  } catch (error) {
    return {
      jobs: [],
      error: error instanceof Error ? error.message : 'The job board could not be reached.',
      truncated: false,
    };
  }

  return {
    jobs: rows.slice(0, LIST_LIMIT).map(toOpportunity),
    error: null,
    truncated: rows.length > LIST_LIMIT,
  };
}

/**
 * One opportunity, with its long-form content.
 *
 * The candidate counterpart of `getSavedJob()`, and it returns a strictly
 * smaller thing: no note, no pipeline status, no applied date, no owner. Null
 * when the id does not exist, which the page turns into a 404.
 */
export async function getJobOpportunity(id: string): Promise<JobOpportunityDetail | null> {
  try {
    const client = createJobBoardClient();
    const { data, error } = await client
      .from('saved_jobs')
      .select(JOB_OPPORTUNITY_DETAIL_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (error || !data) return null;

    const row = data as unknown as Record<string, unknown>;

    return {
      ...toOpportunity(row),
      description: typeof row.description === 'string' ? row.description : null,
      responsibilities: list(row.responsibilities),
      required_qualifications: list(row.required_qualifications),
      preferred_qualifications: list(row.preferred_qualifications),
    };
  } catch {
    return null;
  }
}
