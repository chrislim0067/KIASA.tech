/**
 * Machine-readable mirror of the database's shape and constraints.
 *
 * Every value here was extracted from the frozen migrations (1-11) and verified
 * against a live local database, not assumed. It exists so validation, the
 * completeness report and the tests all read the same numbers, and so a drift
 * between this file and the schema shows up as a test failure rather than as a
 * runtime surprise.
 *
 * The database remains the authority. Nothing here relaxes a constraint; these
 * values only let the application refuse obviously-invalid input before a round
 * trip, and let an agent understand the shape of what it is filling in.
 */

/* -------------------------------------------------------------- cardinality */

/**
 * Tables whose primary key IS `user_id` — exactly one row per user, upserted.
 * Evidence: `user_id uuid primary key references auth.users (id)` in migrations
 * 2 and 3.
 */
export const SINGLETON_TABLES = ['profiles', 'job_preferences', 'automation_settings'] as const;

/**
 * Tables with a surrogate `id uuid primary key` — many rows per user.
 *
 * Note that `work_authorizations` belongs here, not with the singletons: it is
 * unique on `(user_id, country_code)`, so authorization is recorded per country.
 * A user may be authorized in one country and not another, and having a row for
 * one country says nothing about any other.
 */
export const COLLECTION_TABLES = [
  'work_authorizations',
  'work_experiences',
  'education_entries',
  'skills',
  'certifications',
  'projects',
  'languages',
  'verified_answers',
] as const;

export const ALL_TABLES = [...SINGLETON_TABLES, ...COLLECTION_TABLES] as const;

/**
 * Natural-key uniqueness beyond the primary key, so callers can anticipate a
 * `conflict` result instead of discovering it.
 *
 * `skills` is unique on `(user_id, lower(name))` — case-insensitive, so "Go"
 * and "go" collide.
 */
export const NATURAL_KEYS = {
  work_authorizations: ['country_code'],
  languages: ['language_code'],
  verified_answers: ['question_key'],
  skills: ['name (case-insensitive)'],
} as const;

/* --------------------------------------------------- database-managed columns */

/**
 * Columns the database owns. The layer's input types omit these, so a caller
 * cannot supply them; this list is the runtime backstop and the thing the tests
 * assert against.
 *
 * - `user_id` is supplied by the layer from the authenticated identity, never
 *   by the caller, so row donation is impossible by construction.
 * - `created_at` / `updated_at` are stamped by the migration-9
 *   `set_row_timestamps` trigger, which overwrites whatever a client sends.
 * - `requires_human_approval` is `GENERATED ALWAYS ... STORED`; writing it
 *   raises 428C9.
 * - `verified_at` is derived from `is_verified` by the migration-9 provenance
 *   guard, never taken from the client.
 */
export const MANAGED_COLUMNS = ['user_id', 'created_at', 'updated_at'] as const;
export const GENERATED_COLUMNS = ['requires_human_approval'] as const;
export const TRIGGER_DERIVED_COLUMNS = ['verified_at'] as const;

/**
 * `source` values the migration-9 guard reserves for non-API roles. An
 * `authenticated` client that sends one gets 42501. The only value this layer
 * may write is `user_entered`, because that is the only thing an API client can
 * truthfully assert.
 */
export const CLIENT_WRITABLE_SOURCE = 'user_entered' as const;
export const RESERVED_SOURCES = ['imported_from_resume', 'agent_drafted_user_approved'] as const;

/* ---------------------------------------------------------------- vocabularies */

export const WORK_MODES = ['remote', 'hybrid', 'onsite'] as const;
export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'internship', 'temporary'] as const;
/** work_experiences additionally allows 'freelance'; job_preferences does not. */
export const EXPERIENCE_EMPLOYMENT_TYPES = [...EMPLOYMENT_TYPES, 'freelance'] as const;
export const SALARY_PERIODS = ['hourly', 'daily', 'monthly', 'annual'] as const;
export const TRAVEL_WILLINGNESS = ['none', 'occasional', 'frequent', 'extensive'] as const;
export const EXPERIENCE_LEVELS = [
  'internship', 'entry', 'associate', 'mid', 'senior', 'lead', 'principal', 'executive',
] as const;
export const SKILL_PROFICIENCIES = ['beginner', 'intermediate', 'advanced', 'expert'] as const;
export const LANGUAGE_PROFICIENCIES = [
  'elementary', 'limited_working', 'professional_working', 'full_professional', 'native_bilingual',
] as const;
export const ANSWER_TYPES = ['text', 'boolean', 'number', 'date', 'single_choice', 'multi_choice'] as const;

/**
 * The eight sensitivity values. This same list is the vocabulary for
 * `automation_settings.always_require_approval_categories`.
 *
 * Everything except `normal` forces `requires_human_approval` to true through
 * the generated column, which is the mechanism behind the product rule that the
 * system stops and asks a human.
 */
export const SENSITIVITIES = [
  'normal', 'sensitive', 'legal_attestation', 'demographic_eeo',
  'disability', 'veteran_status', 'criminal_history', 'requires_approval',
] as const;

export type WorkMode = (typeof WORK_MODES)[number];
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];
export type Sensitivity = (typeof SENSITIVITIES)[number];
export type AnswerType = (typeof ANSWER_TYPES)[number];

/* --------------------------------------------------------------- text limits */

/** Maximum `length()` per column, from the `*_text_lengths` CHECK constraints. */
export const TEXT_LIMITS = {
  profiles: {
    legal_first_name: 100, legal_middle_name: 100, legal_last_name: 100,
    legal_suffix: 20, preferred_name: 100,
    contact_email: 320, address_line_1: 200, address_line_2: 200,
    city: 100, state_region: 100, postal_code: 20, timezone: 64,
    linkedin_url: 2048, github_url: 2048, portfolio_url: 2048, website_url: 2048,
  },
  work_experiences: { company_name: 200, job_title: 200, description: 10000, location_city: 100 },
  education_entries: {
    institution_name: 200, degree: 200, field_of_study: 200,
    grade: 100, description: 10000, location_city: 100,
  },
  skills: { name: 120, category: 100 },
  certifications: { name: 200, issuing_organization: 200, credential_id: 200, credential_url: 2048 },
  projects: { name: 200, role: 200, description: 10000, url: 2048, repository_url: 2048 },
  languages: { language_name: 100 },
  work_authorizations: { basis: 500 },
  verified_answers: { answer_text: 10000, question_text: 2000, question_category: 100 },
} as const;

/**
 * Array bounds from the 14 `text_array_ok(column, maxItems, maxLen)` checks.
 * Every one of these also inherits the invisible-value rule.
 */
export const ARRAY_LIMITS = {
  job_preferences: {
    desired_titles: { maxItems: 100, maxLen: 200 },
    desired_locations: { maxItems: 100, maxLen: 200 },
    preferred_industries: { maxItems: 100, maxLen: 200 },
  },
  automation_settings: {
    allowed_titles: { maxItems: 200, maxLen: 200 },
    excluded_titles: { maxItems: 200, maxLen: 200 },
    excluded_companies: { maxItems: 500, maxLen: 200 },
    excluded_industries: { maxItems: 200, maxLen: 200 },
    excluded_locations: { maxItems: 200, maxLen: 200 },
    allowed_country_codes: { maxItems: 250, maxLen: 2 },
    always_require_approval_categories: { maxItems: 8, maxLen: 50 },
  },
  work_experiences: { achievements: { maxItems: 50, maxLen: 2000 } },
  education_entries: { achievements: { maxItems: 50, maxLen: 2000 } },
  projects: { achievements: { maxItems: 50, maxLen: 2000 }, technologies: { maxItems: 100, maxLen: 100 } },
} as const;

/** `profiles.other_links` — `jsonb_links_ok(other_links, 20, 2048, 200)`. */
export const OTHER_LINKS_LIMITS = { maxItems: 20, maxUrlLen: 2048, maxLabelLen: 200 } as const;

/** Sizes measured by `pg_column_size`, not string length. */
export const JSONB_SIZE_LIMITS = {
  'automation_settings.extra_stop_conditions': 8192,
  'verified_answers.answer_structured': 16384,
} as const;

/* ------------------------------------------------------------------ patterns */

/**
 * Format rules copied from the CHECK constraints. Written with explicit
 * character classes (`[0-9]`, never `\d`) to match the SQL exactly.
 */
export const PATTERNS = {
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  phoneE164: /^\+[1-9][0-9]{6,14}$/,
  countryCode: /^[A-Z]{2}$/,
  currency: /^[A-Z]{3}$/,
  timezone: /^([A-Za-z_+-]+\/[A-Za-z_0-9+/-]+|UTC)$/,
  httpUrl: /^https?:\/\//,
  languageCode: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/,
  questionKey: /^[a-z0-9_]{1,120}$/,
} as const;

/** Numeric bounds. */
export const NUMERIC_LIMITS = {
  min_match_score: { min: 0, max: 100 },
  max_applications_per_day: { min: 0, max: 1000 },
} as const;

/**
 * Deterministic ordering per collection table, using columns that actually
 * exist. Six of the eight carry `sort_order integer not null default 0`; the
 * two that do not are ordered by their natural key. `id` is always the final
 * tiebreaker so a page of results is stable across calls.
 */
export const COLLECTION_ORDER = {
  work_authorizations: ['country_code', 'id'],
  work_experiences: ['sort_order', 'start_date', 'id'],
  education_entries: ['sort_order', 'start_date', 'id'],
  skills: ['sort_order', 'name', 'id'],
  certifications: ['sort_order', 'issue_date', 'id'],
  projects: ['sort_order', 'start_date', 'id'],
  languages: ['sort_order', 'language_code', 'id'],
  verified_answers: ['question_key', 'id'],
} as const;
