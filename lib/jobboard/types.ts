/**
 * The shape of a row in the job board project's `saved_jobs` table.
 *
 * Hand-written rather than generated. `lib/supabase/database.types.ts` is
 * produced by `npm run db:types` against KIASA'S OWN database, and the job
 * board lives in a different project with a different schema — running the
 * generator against it would overwrite the types this app depends on. These
 * mirror `supabase/migrations/0001_saved_jobs.sql` in the job board repo and
 * must be changed together with it.
 *
 * Every extracted field is nullable, without exception. A saved job is only
 * ever as complete as the page it came from, and a type that promised a salary
 * would be lying about most real postings.
 *
 * Column names stay snake_case because they map one-to-one onto Postgres.
 * Translating case at the boundary is a reliable source of silent field loss.
 */

/**
 * Where a saved job sits in its owner's pipeline.
 *
 * Ordered as the pipeline flows; the board renders its columns in this order.
 * Mirrors the CHECK constraint on `saved_jobs.status`.
 */
export const JOB_STATUSES = [
  'saved',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'archived',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_STATUS_LABELS: Readonly<Record<JobStatus, string>> = Object.freeze({
  saved: 'Saved',
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected',
  archived: 'Archived',
});

export const isJobStatus = (value: unknown): value is JobStatus =>
  typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);

export type WorkplaceType = 'remote' | 'hybrid' | 'onsite';

/** Everything the list, the board and the sidebar render. */
export interface JobSummary {
  readonly id: string;
  readonly user_id: string;
  readonly fingerprint: string;
  readonly url: string;
  readonly domain: string;
  readonly provider: string | null;
  readonly provider_job_id: string | null;
  readonly title: string | null;
  readonly company: string | null;
  readonly company_logo_url: string | null;
  readonly location: string | null;
  readonly workplace_type: WorkplaceType | null;
  readonly employment_type: string | null;
  readonly salary_min: number | null;
  readonly salary_max: number | null;
  readonly salary_currency: string | null;
  readonly salary_period: string | null;
  readonly experience_min_years: number | null;
  readonly experience_max_years: number | null;
  readonly skills: readonly string[];
  readonly sponsorship_available: boolean | null;
  readonly security_clearance_required: boolean | null;
  readonly extraction_confidence: number | null;
  readonly status: JobStatus;
  readonly saved_at: string;
  readonly updated_at: string;
  /**
   * Whether the owner wrote a private note, NOT the note itself.
   *
   * The text is deliberately withheld from the list. A note is the owner's own
   * working scratch about an employer, and an administrator scanning a hundred
   * rows has no reason to read a hundred of them in passing. Opening one job is
   * a deliberate act and shows it; the list only reports that it exists.
   */
  readonly has_notes: boolean;
  /**
   * Resolved from the job board project's `auth.users`, not stored on the row.
   *
   * An administrator looking at everyone's postings needs to know whose each
   * one is, and a bare UUID does not answer that. Null when the lookup could
   * not run or the account no longer exists.
   */
  readonly owner_email: string | null;
}

/**
 * The long-form content, which only the detail page reads.
 *
 * Split out for the reason named in the job board's own `lib/columns.ts`: a
 * description runs to several kilobytes, so selecting it for every row turned
 * a list of a few dozen jobs into megabytes of transfer to render text the
 * list never shows.
 *
 * `notes` lives here rather than on the summary on purpose — it is the owner's
 * private working note. The list shows only that a note EXISTS, via
 * `has_notes`; reading the text itself is a deliberate act on one job.
 */
export interface JobDetail extends JobSummary {
  readonly description: string | null;
  readonly responsibilities: readonly string[];
  readonly required_qualifications: readonly string[];
  readonly preferred_qualifications: readonly string[];
  readonly notes: string | null;
  readonly applied_at: string | null;
}

/** Columns the list query selects. Kept in step with {@link JobSummary}. */
export const JOB_SUMMARY_COLUMNS = [
  'id',
  'user_id',
  'fingerprint',
  'url',
  'domain',
  'provider',
  'provider_job_id',
  'title',
  'company',
  'company_logo_url',
  'location',
  'workplace_type',
  'employment_type',
  'salary_min',
  'salary_max',
  'salary_currency',
  'salary_period',
  'experience_min_years',
  'experience_max_years',
  'skills',
  'sponsorship_available',
  'security_clearance_required',
  'extraction_confidence',
  'status',
  'saved_at',
  'updated_at',
  // Selected so `has_notes` can be derived, then dropped before the rows reach
  // the client. Short, user-typed text — nothing like the kilobytes of
  // `description` this list is careful not to fetch.
  'notes',
].join(',');

/** The detail query adds the long-form columns to the summary set. */
export const JOB_DETAIL_COLUMNS = [
  JOB_SUMMARY_COLUMNS,
  'description',
  'responsibilities',
  'required_qualifications',
  'preferred_qualifications',
  'applied_at',
].join(',');
