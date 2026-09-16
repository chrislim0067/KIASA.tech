import 'server-only';

import { createJobBoardClient } from '@/lib/jobboard/client';
import {
  JOB_DETAIL_COLUMNS,
  JOB_SUMMARY_COLUMNS,
  isJobStatus,
  type JobDetail,
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
 * Coerces whatever Postgres returned into the summary the UI is typed against.
 *
 * Written defensively because this schema belongs to another repository. A
 * `status` outside the CHECK constraint, a null `skills` array, a numeric that
 * arrived as a string — none of them should blank the whole page, so each is
 * given a safe reading rather than trusted.
 */
function toSummary(row: Record<string, unknown>, ownerEmail: string | null): JobSummary {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

  const workplace = str(row.workplace_type);

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
    workplace_type:
      workplace === 'remote' || workplace === 'hybrid' || workplace === 'onsite'
        ? (workplace as WorkplaceType)
        : null,
    employment_type: str(row.employment_type),
    salary_min: num(row.salary_min),
    salary_max: num(row.salary_max),
    salary_currency: str(row.salary_currency),
    salary_period: str(row.salary_period),
    experience_min_years: num(row.experience_min_years),
    experience_max_years: num(row.experience_max_years),
    skills: Array.isArray(row.skills)
      ? row.skills.filter((s): s is string => typeof s === 'string')
      : [],
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
    owner_email: ownerEmail,
  };
}

/**
 * Maps owner UUID to email, for the whole page in one call.
 *
 * An administrator looking at every candidate's postings needs to know whose
 * each one is, and `user_id` alone does not answer that. The job board project
 * does not expose `auth.users` to the Data API — no project does — so this goes
 * through the Auth admin API, which the secret key already permits.
 *
 * FAILS SOFT. If the lookup errors the board still renders, with owners shown
 * as unknown. A directory problem should not take down the list of jobs, which
 * is the thing the page is actually for.
 */
async function resolveOwners(): Promise<Map<string, string>> {
  const emails = new Map<string, string>();

  try {
    const client = createJobBoardClient();
    // One page of 1000 covers this board comfortably. Paginating would mean
    // several round trips on every render to resolve names for rows that are
    // mostly the same handful of people.
    const { data, error } = await client.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) return emails;

    for (const user of data?.users ?? []) {
      if (user.id && user.email) emails.set(user.id, user.email);
    }
  } catch {
    // Unconfigured or unreachable. The caller renders without owner names.
  }

  return emails;
}

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

  const truncated = rows.length > LIST_LIMIT;
  const owners = await resolveOwners();

  return {
    jobs: rows
      .slice(0, LIST_LIMIT)
      .map((row) => toSummary(row, owners.get(String(row.user_id)) ?? null)),
    error: null,
    truncated,
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
    const owners = await resolveOwners();
    const summary = toSummary(row, owners.get(String(row.user_id)) ?? null);

    const list = (v: unknown): readonly string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

    return {
      ...summary,
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
