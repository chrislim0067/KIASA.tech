-- Two deliberately separate tables:
--
--   job_preferences     what the candidate WANTS. Soft. Used for ranking.
--   automation_settings what the agent MAY DO. Hard. Used for refusing.
--
-- They are not merged because they answer different questions and are edited by
-- different intents. Where both mention pay the names say so out loud:
-- desired_min_salary (aspiration) versus absolute_min_salary (never go below).

create table public.job_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,

  desired_titles    text[] not null default '{}'
    constraint job_preferences_desired_titles_no_blanks check (public.text_array_no_blanks(desired_titles)),
  desired_locations text[] not null default '{}',

  -- Controlled vocabularies as text + CHECK rather than enums: adding or
  -- retiring a value is a plain migration, where ALTER TYPE cannot run in a
  -- transaction and enum values can never be removed.
  work_modes text[] not null default '{}'
    constraint job_preferences_work_modes_allowed
    check (work_modes <@ array['remote', 'hybrid', 'onsite']::text[]),

  employment_types text[] not null default '{}'
    constraint job_preferences_employment_types_allowed
    check (employment_types <@ array['full_time', 'part_time', 'contract', 'internship', 'temporary']::text[]),

  desired_min_salary numeric(12, 2)
    constraint job_preferences_desired_min_salary_nonneg check (desired_min_salary is null or desired_min_salary >= 0),
  salary_currency varchar(3)
    constraint job_preferences_salary_currency_format check (salary_currency is null or salary_currency ~ '^[A-Z]{3}$'),
  salary_period text
    constraint job_preferences_salary_period_allowed check (salary_period is null or salary_period in ('hourly', 'daily', 'monthly', 'annual')),

  preferred_industries text[] not null default '{}',

  willing_to_relocate boolean,
  travel_willingness text
    constraint job_preferences_travel_allowed
    check (travel_willingness is null or travel_willingness in ('none', 'occasional', 'frequent', 'extensive')),

  desired_experience_level text
    constraint job_preferences_experience_level_allowed
    check (desired_experience_level is null or desired_experience_level in
      ('internship', 'entry', 'associate', 'mid', 'senior', 'lead', 'principal', 'executive')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.job_preferences is
  'Soft preferences used to rank opportunities. Not a safety boundary.';
comment on column public.job_preferences.desired_min_salary is
  'Aspiration. The hard floor is automation_settings.absolute_min_salary.';

create trigger job_preferences_set_updated_at
  before update on public.job_preferences
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------

create table public.automation_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,

  -- Everything permissive defaults to the safe value. A row created with all
  -- defaults grants the agent nothing.
  is_automation_enabled          boolean not null default false,
  allow_resume_tailoring         boolean not null default false,
  allow_cover_letter_generation  boolean not null default false,

  min_match_score int not null default 0
    constraint automation_settings_min_match_score_range check (min_match_score between 0 and 100),

  -- The user's requested ceiling only. Execution must still obey job-site
  -- terms, rate limits and safety policy, whichever is lower.
  max_applications_per_day int not null default 0
    constraint automation_settings_max_apps_range check (max_applications_per_day between 0 and 1000),

  -- Hard boundaries.
  absolute_min_salary numeric(12, 2)
    constraint automation_settings_absolute_min_salary_nonneg check (absolute_min_salary is null or absolute_min_salary >= 0),
  absolute_salary_currency varchar(3)
    constraint automation_settings_currency_format check (absolute_salary_currency is null or absolute_salary_currency ~ '^[A-Z]{3}$'),
  absolute_salary_period text
    constraint automation_settings_salary_period_allowed check (absolute_salary_period is null or absolute_salary_period in ('hourly', 'daily', 'monthly', 'annual')),

  allowed_titles       text[] not null default '{}',
  excluded_titles      text[] not null default '{}'
    constraint automation_settings_excluded_titles_no_blanks check (public.text_array_no_blanks(excluded_titles)),
  excluded_companies   text[] not null default '{}'
    constraint automation_settings_excluded_companies_no_blanks check (public.text_array_no_blanks(excluded_companies)),
  excluded_industries  text[] not null default '{}'
    constraint automation_settings_excluded_industries_no_blanks check (public.text_array_no_blanks(excluded_industries)),

  allowed_country_codes text[] not null default '{}'
    constraint automation_settings_allowed_countries_format
    check (public.text_array_matches(allowed_country_codes, '^[A-Z]{2}$')),
  excluded_locations text[] not null default '{}'
    constraint automation_settings_excluded_locations_no_blanks
    check (public.text_array_no_blanks(excluded_locations)),

  always_require_approval_categories text[] not null default '{}',

  -- Core stop conditions are first-class columns, not JSONB. They are safety
  -- rules: they must be queryable, constrainable and impossible to typo away.
  -- All default true — the agent halts unless told otherwise.
  stop_on_captcha                  boolean not null default true,
  stop_on_mfa                      boolean not null default true,
  stop_on_assessment               boolean not null default true,
  stop_on_unknown_question         boolean not null default true,
  stop_on_sensitive_question       boolean not null default true,
  stop_on_legal_attestation        boolean not null default true,
  stop_on_application_fee          boolean not null default true,
  stop_on_external_contact_request boolean not null default true,

  -- Room for future conditions without a migration. Never for the eight above.
  extra_stop_conditions jsonb not null default '{}'::jsonb
    constraint automation_settings_extra_stop_is_object check (jsonb_typeof(extra_stop_conditions) = 'object'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.automation_settings is
  'Hard boundaries for the agent. Permissive fields default to the safe value.';
comment on column public.automation_settings.max_applications_per_day is
  'User-requested ceiling only; execution also obeys site rules and rate limits.';

create trigger automation_settings_set_updated_at
  before update on public.automation_settings
  for each row execute function public.set_updated_at();
