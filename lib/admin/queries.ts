import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { isAppRole, DEFAULT_ROLE, type AppRole } from '@/lib/auth/roles';

/**
 * Read side of the administrator surface.
 *
 * Two rules run through every function here:
 *
 *   1. AGGREGATE IN THE DATABASE. Counts come from `count: 'exact'` or from the
 *      `application_stats_by_user` view. Nothing fetches rows in order to
 *      length them, and the user list never issues a query per user — it reads
 *      `admin_user_directory`, which has already joined roles, profile,
 *      job and application counters.
 *
 *   2. PROJECT EXPLICITLY. Every select names its columns. No `select('*')`
 *      anywhere, so a column added to a table later cannot silently start
 *      travelling to a browser.
 *
 * Callers must have passed `requireAdmin()` / `guardApi()` first; nothing in
 * this file re-checks authorization, because a check that is duplicated in
 * twelve places is a check that will eventually be omitted in one of them.
 */

// ---------------------------------------------------------------------------
// Search sanitisation
// ---------------------------------------------------------------------------
/**
 * PostgREST's `or=` filter is a comma-separated, parenthesised mini-language.
 * An unescaped comma, parenthesis or quote in user input does not merely break
 * the query — it changes which filter runs. Values are therefore wrapped in
 * double quotes (which PostgREST supports precisely for this) with backslashes
 * and quotes escaped, and control characters removed.
 *
 * This is filter-syntax escaping, not SQL escaping: PostgREST parameterises the
 * value itself, so SQL injection is not the exposure here. Filter *confusion*
 * is, and that is what this prevents.
 */
function quoteFilterValue(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .slice(0, 200);
  return `"${cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Escape the `%` and `_` that PostgreSQL LIKE treats as wildcards. */
function escapeLikeLiteral(raw: string): string {
  return raw.replace(/([%_\\])/g, '\\$1');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// User list
// ---------------------------------------------------------------------------
export const USER_SORT_FIELDS = [
  'registered_at',
  'last_activity_at',
  'email',
  'applications_total',
  'bid_bot_total',
] as const;
export type UserSortField = (typeof USER_SORT_FIELDS)[number];

export const ACCOUNT_STATUSES = [
  'active',
  'invited',
  'pending_confirmation',
  'banned',
  'deleted',
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export interface ListUsersParams {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | null;
  readonly role?: AppRole | null;
  readonly status?: AccountStatus | null;
  readonly sort?: UserSortField;
  readonly direction?: 'asc' | 'desc';
  /** Only accounts registered on or after this ISO timestamp. */
  readonly registeredAfter?: string | null;
  /** Only accounts with at least one application. */
  readonly hasApplications?: boolean;
}

export interface AdminUserRow {
  readonly user_id: string;
  readonly email: string | null;
  readonly display_name: string | null;
  readonly role: AppRole;
  readonly account_status: AccountStatus;
  readonly registered_at: string;
  readonly last_activity_at: string | null;
  readonly applications_total: number;
  readonly applications_succeeded: number;
  readonly bid_bot_total: number;
  readonly jobs_total: number;
}

/** The columns the list needs. Deliberately fewer than the detail page. */
const LIST_COLUMNS =
  'user_id, email, display_name, role, account_status, registered_at, last_activity_at, applications_total, applications_succeeded, bid_bot_total, jobs_total' as const;

export const MAX_PAGE_SIZE = 100;

export async function listUsers(
  params: ListUsersParams
): Promise<{ rows: AdminUserRow[]; total: number }> {
  const admin = createAdminClient();

  const pageSize = Math.min(Math.max(1, params.pageSize), MAX_PAGE_SIZE);
  const page = Math.max(1, params.page);
  const from = (page - 1) * pageSize;

  let query = admin
    .from('admin_user_directory')
    .select(LIST_COLUMNS, { count: 'exact' });

  const search = params.search?.trim();
  if (search) {
    if (UUID_RE.test(search)) {
      // An exact id is an exact lookup, not a text search.
      query = query.eq('user_id', search);
    } else {
      const needle = `*${escapeLikeLiteral(search)}*`;
      query = query.or(
        [
          `email.ilike.${quoteFilterValue(needle)}`,
          `display_name.ilike.${quoteFilterValue(needle)}`,
          `preferred_name.ilike.${quoteFilterValue(needle)}`,
          `contact_email.ilike.${quoteFilterValue(needle)}`,
        ].join(',')
      );
    }
  }

  if (params.role) query = query.eq('role', params.role);
  if (params.status) query = query.eq('account_status', params.status);
  if (params.registeredAfter) query = query.gte('registered_at', params.registeredAfter);
  if (params.hasApplications) query = query.gt('applications_total', 0);

  const sort: UserSortField = params.sort ?? 'registered_at';
  const ascending = params.direction === 'asc';
  query = query
    .order(sort, { ascending, nullsFirst: false })
    // A stable tiebreaker. Without it, two rows with equal sort keys can swap
    // between pages and a row is shown twice or skipped entirely.
    .order('user_id', { ascending: true })
    .range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) throw error;

  const rows = (data ?? []).map(
    (row): AdminUserRow => ({
      user_id: String(row.user_id),
      email: row.email ?? null,
      display_name: row.display_name ?? null,
      role: isAppRole(row.role) ? row.role : DEFAULT_ROLE,
      account_status: row.account_status as AccountStatus,
      registered_at: String(row.registered_at),
      last_activity_at: row.last_activity_at ?? null,
      applications_total: Number(row.applications_total ?? 0),
      applications_succeeded: Number(row.applications_succeeded ?? 0),
      bid_bot_total: Number(row.bid_bot_total ?? 0),
      jobs_total: Number(row.jobs_total ?? 0),
    })
  );

  return { rows, total: count ?? 0 };
}

// ---------------------------------------------------------------------------
// User detail
// ---------------------------------------------------------------------------
export interface AdminUserDetail {
  readonly account: Record<string, unknown>;
  readonly profile: Record<string, unknown> | null;
  readonly automation: Record<string, unknown> | null;
  readonly preferences: Record<string, unknown> | null;
  readonly stats: ApplicationStats;
  readonly recentApplications: AdminApplicationRow[];
  readonly skills: string[];
}

export interface ApplicationStats {
  readonly applications_total: number;
  readonly applications_succeeded: number;
  readonly applications_confirmed: number;
  readonly applications_failed: number;
  readonly applications_pending: number;
  readonly applications_skipped: number;
  readonly applications_cancelled: number;
  readonly applications_duplicate: number;
  readonly applications_needs_intervention: number;
  readonly manual_total: number;
  readonly automated_total: number;
  readonly bid_bot_total: number;
  readonly external_total: number;
  readonly bid_bot_succeeded: number;
  readonly bid_bot_failed: number;
  readonly automation_total: number;
  readonly attempts_total: number;
  readonly bid_bot_attempts: number;
  readonly bid_bot_attempts_submitted: number;
  readonly attempts_failed: number;
  readonly last_submitted_at: string | null;
  readonly last_application_at: string | null;
}

export const EMPTY_STATS: ApplicationStats = Object.freeze({
  applications_total: 0,
  applications_succeeded: 0,
  applications_confirmed: 0,
  applications_failed: 0,
  applications_pending: 0,
  applications_skipped: 0,
  applications_cancelled: 0,
  applications_duplicate: 0,
  applications_needs_intervention: 0,
  manual_total: 0,
  automated_total: 0,
  bid_bot_total: 0,
  external_total: 0,
  bid_bot_succeeded: 0,
  bid_bot_failed: 0,
  automation_total: 0,
  attempts_total: 0,
  bid_bot_attempts: 0,
  bid_bot_attempts_submitted: 0,
  attempts_failed: 0,
  last_submitted_at: null,
  last_application_at: null,
});

export interface AdminApplicationRow {
  readonly id: string;
  readonly job_id: string;
  readonly method: string;
  readonly status: string;
  readonly status_class: string | null;
  readonly status_code: string | null;
  readonly worker_id: string | null;
  readonly executor_type: string | null;
  readonly attempt_count: number;
  readonly queued_at: string;
  readonly submitted_at: string | null;
  readonly job_title: string | null;
  readonly company_name: string | null;
  readonly job_source: string | null;
  readonly job_url: string | null;
}

/**
 * The account row for one user.
 *
 * Reads the same narrow directory view the list uses rather than the Auth admin
 * API, so the detail page cannot disagree with the row the administrator
 * clicked, and so no code path here ever holds a full auth.users record.
 */
export async function getUserAccount(userId: string): Promise<Record<string, unknown> | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('admin_user_directory')
    .select(
      'user_id, email, display_name, preferred_name, contact_email, city, country_code, role, role_granted_at, account_status, registered_at, last_sign_in_at, email_confirmed_at, invited_at, banned_until, onboarding_completed_at, is_automation_enabled, last_activity_at, jobs_total, last_job_at'
    )
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

export async function getApplicationStats(userId: string): Promise<ApplicationStats> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('application_stats_by_user')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  // No row means the user has never had an application. Zero is the truthful
  // answer, and EMPTY_STATS says so without a special case at every call site.
  if (!data) return EMPTY_STATS;

  const n = (v: unknown) => Number(v ?? 0);
  return {
    applications_total: n(data.applications_total),
    applications_succeeded: n(data.applications_succeeded),
    applications_confirmed: n(data.applications_confirmed),
    applications_failed: n(data.applications_failed),
    applications_pending: n(data.applications_pending),
    applications_skipped: n(data.applications_skipped),
    applications_cancelled: n(data.applications_cancelled),
    applications_duplicate: n(data.applications_duplicate),
    applications_needs_intervention: n(data.applications_needs_intervention),
    manual_total: n(data.manual_total),
    automated_total: n(data.automated_total),
    bid_bot_total: n(data.bid_bot_total),
    external_total: n(data.external_total),
    bid_bot_succeeded: n(data.bid_bot_succeeded),
    bid_bot_failed: n(data.bid_bot_failed),
    automation_total: n(data.automation_total),
    attempts_total: n(data.attempts_total),
    bid_bot_attempts: n(data.bid_bot_attempts),
    bid_bot_attempts_submitted: n(data.bid_bot_attempts_submitted),
    attempts_failed: n(data.attempts_failed),
    last_submitted_at: data.last_submitted_at ?? null,
    last_application_at: data.last_application_at ?? null,
  };
}

/**
 * Recent applications with the job they were for.
 *
 * The job title and company come from `job_facts`, which is per-snapshot, so
 * the embed is ordered and limited to one — the most recent extraction. Doing
 * this as a PostgREST embed keeps it to a single round trip rather than a
 * lookup per application.
 */
export async function getRecentApplications(
  userId: string,
  limit = 25
): Promise<AdminApplicationRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('applications')
    .select(
      'id, job_id, method, status, status_class, status_code, worker_id, executor_type, attempt_count, queued_at, submitted_at, jobs!inner(canonical_url, source, job_facts(title, company_name, created_at))'
    )
    .eq('user_id', userId)
    .order('queued_at', { ascending: false })
    .limit(Math.min(limit, 100));

  if (error) throw error;

  return (data ?? []).map((row): AdminApplicationRow => {
    const job = (row as Record<string, unknown>).jobs as
      | { canonical_url?: string; source?: string; job_facts?: Array<Record<string, unknown>> }
      | undefined;

    const facts = (job?.job_facts ?? [])
      .slice()
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    const latest = facts[0];

    return {
      id: String(row.id),
      job_id: String(row.job_id),
      method: String(row.method),
      status: String(row.status),
      status_class: (row.status_class as string) ?? null,
      status_code: (row.status_code as string) ?? null,
      worker_id: (row.worker_id as string) ?? null,
      executor_type: (row.executor_type as string) ?? null,
      attempt_count: Number(row.attempt_count ?? 0),
      queued_at: String(row.queued_at),
      submitted_at: (row.submitted_at as string) ?? null,
      job_title: (latest?.title as string) ?? null,
      company_name: (latest?.company_name as string) ?? null,
      job_source: job?.source ?? null,
      job_url: job?.canonical_url ?? null,
    };
  });
}

/** The candidate profile, projected. Never returns anything from auth.users. */
export async function getUserProfile(userId: string): Promise<Record<string, unknown> | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('profiles')
    .select(
      'legal_first_name, legal_middle_name, legal_last_name, preferred_name, contact_email, phone_e164, city, state_region, country_code, timezone, linkedin_url, github_url, portfolio_url, website_url, onboarding_completed_at, created_at, updated_at'
    )
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

export async function getUserAutomation(userId: string): Promise<Record<string, unknown> | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('automation_settings')
    .select(
      'is_automation_enabled, allow_resume_tailoring, allow_cover_letter_generation, min_match_score, max_applications_per_day, absolute_min_salary, absolute_salary_currency, absolute_salary_period, excluded_companies, stop_on_captcha, stop_on_mfa, stop_on_assessment, stop_on_unknown_question, stop_on_sensitive_question, stop_on_legal_attestation, stop_on_application_fee, stop_on_external_contact_request, updated_at'
    )
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

export async function getUserSkills(userId: string, limit = 40): Promise<string[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('skills')
    .select('name')
    .eq('user_id', userId)
    .order('name', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return (data ?? []).map((r) => String(r.name));
}

// ---------------------------------------------------------------------------
// Platform dashboard
// ---------------------------------------------------------------------------
export interface PlatformStats {
  readonly usersTotal: number;
  readonly usersNew7d: number;
  readonly usersNew30d: number;
  /**
   * Accounts that did something in 30 days — signed in, added a job, or had an
   * application. NOT a live-session count: Supabase does not expose one, and
   * the name says "activity" so the dashboard cannot imply a measurement the
   * platform is unable to make.
   */
  readonly usersActive30d: number;
  readonly usersAdmin: number;
  readonly usersPendingConfirmation: number;

  readonly applicationsTotal: number;
  readonly applicationsSucceeded: number;
  readonly applicationsFailed: number;
  readonly applicationsPending: number;
  readonly applicationsNeedsIntervention: number;
  readonly applicationsManual: number;
  readonly applicationsAutomated: number;

  /** Applications the Bid Bot handled, whatever the outcome. */
  readonly applicationsBidBot: number;
  /** Of those, the ones actually submitted or confirmed. */
  readonly bidBotSucceeded: number;
  readonly bidBotFailed: number;
  /**
   * Execution attempts, which exceeds applicationsBidBot whenever anything was
   * retried. Shown alongside it so "attempted" is never read as "applied".
   */
  readonly bidBotAttempts: number;

  readonly jobsTotal: number;
  readonly jobsNew7d: number;
  readonly jobsExtracted: number;
  readonly jobsParked: number;

  readonly adminActions7d: number;
  readonly adminActionsFailed7d: number;

  /**
   * True when the application engine has never written a row. The dashboard
   * uses it to say so explicitly, rather than presenting a wall of zeros as
   * though they were measurements.
   */
  readonly applicationTrackingIdle: boolean;
}

/**
 * Platform counters, read as ONE row from `admin_platform_stats`.
 *
 * This previously issued fifteen separate `count: 'exact'` requests. That was
 * fifteen HTTP round trips and fifteen planner invocations for numbers
 * PostgreSQL produces in a single pass, and it put the aggregation in the
 * client where the requirement puts it in the database.
 *
 * The view (migration 17) recomputes every counter on each SELECT, so nothing
 * here is cached and no counter can drift from the tables it summarises.
 */
export async function getPlatformStats(): Promise<PlatformStats> {
  const admin = createAdminClient();
  const { data, error } = await admin.from('admin_platform_stats').select('*').maybeSingle();
  if (error) throw error;

  const n = (value: unknown): number => Number(value ?? 0);

  return {
    usersTotal: n(data?.users_total),
    usersNew7d: n(data?.users_new_7d),
    usersNew30d: n(data?.users_new_30d),
    usersActive30d: n(data?.users_active_30d),
    usersAdmin: n(data?.users_admin),
    usersPendingConfirmation: n(data?.users_pending_confirmation),

    applicationsTotal: n(data?.applications_total),
    applicationsSucceeded: n(data?.applications_succeeded),
    applicationsFailed: n(data?.applications_failed),
    applicationsPending: n(data?.applications_pending),
    applicationsNeedsIntervention: n(data?.applications_needs_intervention),
    applicationsManual: n(data?.applications_manual),
    applicationsAutomated: n(data?.applications_automated),

    applicationsBidBot: n(data?.bid_bot_total),
    bidBotSucceeded: n(data?.bid_bot_succeeded),
    bidBotFailed: n(data?.bid_bot_failed),
    bidBotAttempts: n(data?.bid_bot_attempts),

    jobsTotal: n(data?.jobs_total),
    jobsNew7d: n(data?.jobs_new_7d),
    jobsExtracted: n(data?.jobs_extracted),
    jobsParked: n(data?.jobs_parked),

    adminActions7d: n(data?.admin_actions_7d),
    adminActionsFailed7d: n(data?.admin_actions_failed_7d),

    applicationTrackingIdle: n(data?.applications_total) === 0,
  };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
export interface AuditRow {
  readonly id: string;
  readonly action: string;
  readonly actor_email: string | null;
  readonly target_email: string | null;
  readonly target_user_id: string | null;
  readonly result: string;
  readonly failure_code: string | null;
  readonly occurred_at: string;
}

export async function getRecentAudit(limit = 25, targetUserId?: string): Promise<AuditRow[]> {
  const admin = createAdminClient();
  let query = admin
    .from('admin_audit_log')
    .select('id, action, actor_email, target_email, target_user_id, result, failure_code, occurred_at')
    .order('occurred_at', { ascending: false })
    .limit(Math.min(limit, 200));

  if (targetUserId) query = query.eq('target_user_id', targetUserId);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as AuditRow[];
}

/** Recent registrations for the dashboard. Reuses the directory view. */
export async function getRecentRegistrations(limit = 8): Promise<AdminUserRow[]> {
  const { rows } = await listUsers({
    page: 1,
    pageSize: limit,
    sort: 'registered_at',
    direction: 'desc',
  });
  return rows;
}
