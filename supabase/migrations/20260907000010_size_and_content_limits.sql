-- Fixes review findings M2, M3, L1 and L2.
--
--   M2  no length or cardinality limits: a 2,000,000-character description and a
--       5,000-element array were both accepted.
--   M3  other_links accepted "javascript:alert(1)" while the four first-class
--       URL columns correctly required http(s).
--   L1  blank-element protection was applied inconsistently — notably missing on
--       allowed_titles, an automation ALLOWLIST, where a blank entry could be
--       read by future matching logic as "match everything" (fail-open).
--   L2  always_require_approval_categories accepted any string, so a typo would
--       silently disable a required approval.
--
-- Limits are chosen to fit real résumés and application answers comfortably.
-- A long free-text answer runs to a few thousand characters; 10,000 is generous.
--
-- SCOPE: this bounds the size of individual rows. It does NOT prevent storage
-- abuse in general, because a user may still create many rows. Per-account
-- quotas and rate limiting belong to the application layer and are a later step.

-- ---------------------------------------------------------------------------
-- Validation helpers
-- ---------------------------------------------------------------------------
-- IMMUTABLE so they are legal inside CHECK constraints. Empty search_path, and
-- EXECUTE granted only to authenticated, which needs it because CHECK
-- constraints are evaluated in the inserting user's context.

-- Supersedes text_array_no_blanks by also bounding cardinality and element size.
create or replace function public.text_array_ok(arr text[], max_items integer, max_len integer)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select arr is null
     or (
       coalesce(array_length(arr, 1), 0) <= max_items
       and not exists (
         select 1 from unnest(arr) as element
         where element is null or btrim(element) = '' or length(element) > max_len
       )
     );
$$;

comment on function public.text_array_ok(text[], integer, integer) is
  'True when the array has at most max_items entries and every entry is '
  'non-blank and at most max_len characters.';

-- other_links: [{ "label": "...", "url": "https://..." }, ...]
create or replace function public.jsonb_links_ok(links jsonb, max_items integer, max_url integer, max_label integer)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select links is null
     or (
       jsonb_typeof(links) = 'array'
       and jsonb_array_length(links) <= max_items
       and not exists (
         select 1
         from jsonb_array_elements(links) as element
         where jsonb_typeof(element) <> 'object'
            -- Scheme allowlist. Anchored, so "javascript:", "data:", "file:",
            -- "vbscript:" and any other scheme cannot pass, including when
            -- preceded by whitespace or a newline.
            or coalesce(element ->> 'url', '') !~* '^https?://'
            or length(element ->> 'url') > max_url
            or coalesce(btrim(element ->> 'label'), '') = ''
            or length(element ->> 'label') > max_label
       )
     );
$$;

comment on function public.jsonb_links_ok(jsonb, integer, integer, integer) is
  'True when every element is an object with a non-blank label and an http(s) '
  'URL, within the given counts and lengths.';

-- Migration 8 removed the automatic grants, so these must be explicit.
revoke all on function public.text_array_ok(text[], integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.jsonb_links_ok(jsonb, integer, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.text_array_ok(text[], integer, integer) to authenticated;
grant execute on function public.jsonb_links_ok(jsonb, integer, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
alter table public.profiles
  add constraint profiles_name_lengths check (
    coalesce(length(legal_first_name), 0)  <= 100 and
    coalesce(length(legal_middle_name), 0) <= 100 and
    coalesce(length(legal_last_name), 0)   <= 100 and
    coalesce(length(legal_suffix), 0)      <= 20  and
    coalesce(length(preferred_name), 0)    <= 100
  ),
  add constraint profiles_contact_lengths check (
    coalesce(length(contact_email), 0)  <= 320 and
    coalesce(length(address_line_1), 0) <= 200 and
    coalesce(length(address_line_2), 0) <= 200 and
    coalesce(length(city), 0)           <= 100 and
    coalesce(length(state_region), 0)   <= 100 and
    coalesce(length(postal_code), 0)    <= 20  and
    coalesce(length(timezone), 0)       <= 64
  ),
  add constraint profiles_url_lengths check (
    coalesce(length(linkedin_url), 0)  <= 2048 and
    coalesce(length(github_url), 0)    <= 2048 and
    coalesce(length(portfolio_url), 0) <= 2048 and
    coalesce(length(website_url), 0)   <= 2048
  ),
  -- M3: scheme allowlist + bounds, matching the first-class URL columns.
  add constraint profiles_other_links_valid
    check (public.jsonb_links_ok(other_links, 20, 2048, 200));

-- ---------------------------------------------------------------------------
-- job_preferences  (L1: uniform array bounds)
-- ---------------------------------------------------------------------------
alter table public.job_preferences
  drop constraint if exists job_preferences_desired_titles_no_blanks,
  add constraint job_preferences_desired_titles_bounds       check (public.text_array_ok(desired_titles, 100, 200)),
  add constraint job_preferences_desired_locations_bounds    check (public.text_array_ok(desired_locations, 100, 200)),
  add constraint job_preferences_preferred_industries_bounds check (public.text_array_ok(preferred_industries, 100, 200));

-- ---------------------------------------------------------------------------
-- automation_settings  (L1 + L2)
-- ---------------------------------------------------------------------------
alter table public.automation_settings
  drop constraint if exists automation_settings_excluded_titles_no_blanks,
  drop constraint if exists automation_settings_excluded_companies_no_blanks,
  drop constraint if exists automation_settings_excluded_industries_no_blanks,
  drop constraint if exists automation_settings_excluded_locations_no_blanks,
  -- allowed_titles is an ALLOWLIST: a blank entry here fails open, which is why
  -- it mattered that this was the column missing the guard.
  add constraint automation_settings_allowed_titles_bounds      check (public.text_array_ok(allowed_titles, 200, 200)),
  add constraint automation_settings_excluded_titles_bounds     check (public.text_array_ok(excluded_titles, 200, 200)),
  add constraint automation_settings_excluded_companies_bounds  check (public.text_array_ok(excluded_companies, 500, 200)),
  add constraint automation_settings_excluded_industries_bounds check (public.text_array_ok(excluded_industries, 200, 200)),
  add constraint automation_settings_excluded_locations_bounds  check (public.text_array_ok(excluded_locations, 200, 200)),
  add constraint automation_settings_allowed_countries_bounds   check (public.text_array_ok(allowed_country_codes, 250, 2)),
  -- L2: must match the verified_answers.sensitivity vocabulary exactly, so a
  -- typo fails loudly instead of quietly switching off an approval requirement.
  add constraint automation_settings_approval_categories_allowed check (
    always_require_approval_categories <@ array[
      'normal', 'sensitive', 'legal_attestation', 'demographic_eeo',
      'disability', 'veteran_status', 'criminal_history', 'requires_approval'
    ]::text[]
  ),
  add constraint automation_settings_approval_categories_bounds
    check (public.text_array_ok(always_require_approval_categories, 8, 50)),
  add constraint automation_settings_extra_stop_size
    check (pg_column_size(extra_stop_conditions) <= 8192);

-- ---------------------------------------------------------------------------
-- candidate history
-- ---------------------------------------------------------------------------
alter table public.work_experiences
  drop constraint if exists work_experiences_achievements_no_blanks,
  add constraint work_experiences_achievements_bounds check (public.text_array_ok(achievements, 50, 2000)),
  add constraint work_experiences_text_lengths check (
    length(company_name) <= 200 and length(job_title) <= 200 and
    coalesce(length(description), 0) <= 10000 and
    coalesce(length(location_city), 0) <= 100
  );

alter table public.education_entries
  drop constraint if exists education_entries_achievements_no_blanks,
  add constraint education_entries_achievements_bounds check (public.text_array_ok(achievements, 50, 2000)),
  add constraint education_entries_text_lengths check (
    length(institution_name) <= 200 and
    coalesce(length(degree), 0) <= 200 and
    coalesce(length(field_of_study), 0) <= 200 and
    coalesce(length(grade), 0) <= 100 and
    coalesce(length(description), 0) <= 10000 and
    coalesce(length(location_city), 0) <= 100
  );

alter table public.skills
  add constraint skills_text_lengths check (
    length(name) <= 120 and coalesce(length(category), 0) <= 100
  );

alter table public.certifications
  add constraint certifications_text_lengths check (
    length(name) <= 200 and
    coalesce(length(issuing_organization), 0) <= 200 and
    coalesce(length(credential_id), 0) <= 200 and
    coalesce(length(credential_url), 0) <= 2048
  );

alter table public.projects
  drop constraint if exists projects_achievements_no_blanks,
  drop constraint if exists projects_technologies_no_blanks,
  add constraint projects_achievements_bounds check (public.text_array_ok(achievements, 50, 2000)),
  add constraint projects_technologies_bounds check (public.text_array_ok(technologies, 100, 100)),
  add constraint projects_text_lengths check (
    length(name) <= 200 and
    coalesce(length(role), 0) <= 200 and
    coalesce(length(description), 0) <= 10000 and
    coalesce(length(url), 0) <= 2048 and
    coalesce(length(repository_url), 0) <= 2048
  );

alter table public.languages
  add constraint languages_name_length check (coalesce(length(language_name), 0) <= 100);

-- ---------------------------------------------------------------------------
-- verified_answers
-- ---------------------------------------------------------------------------
alter table public.verified_answers
  add constraint verified_answers_text_lengths check (
    coalesce(length(answer_text), 0) <= 10000 and
    coalesce(length(question_text), 0) <= 2000 and
    coalesce(length(question_category), 0) <= 100
  ),
  -- pg_column_size measures the stored (TOAST-compressed) size, which is the
  -- number that actually costs storage.
  add constraint verified_answers_structured_size
    check (answer_structured is null or pg_column_size(answer_structured) <= 16384);

-- ---------------------------------------------------------------------------
-- Self-verification
-- ---------------------------------------------------------------------------
do $$
declare
  offending text;
begin
  -- The new CHECK helpers must be executable by authenticated, or every write
  -- touching a constrained column would fail.
  select string_agg(sig, ', ') into offending
  from unnest(array[
    'public.text_array_ok(text[], integer, integer)',
    'public.jsonb_links_ok(jsonb, integer, integer, integer)'
  ]) as sig
  where not has_function_privilege('authenticated', sig, 'EXECUTE');
  if offending is not null then
    raise exception 'authenticated cannot execute required CHECK helper(s): %', offending;
  end if;

  -- ...and must remain closed to everyone else.
  --
  -- Scoped to the functions this migration set owns. A hosted Supabase project
  -- also carries platform-installed helpers (`rls_auto_enable` among them) that
  -- are EXECUTE-able by PUBLIC by design and are not ours to revoke; asserting
  -- over them fails the migration while proving nothing about our own posture.
  -- See migration 7 for the full reasoning.
  select string_agg(p.proname, ', ') into offending
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = any(array[
      'set_updated_at', 'text_array_matches', 'text_array_no_blanks', 'text_array_ok',
      'jsonb_links_ok', 'is_blank_or_invisible', 'set_row_timestamps',
      'guard_verified_answer_provenance', 'set_event_created_at', 'refuse_row_update',
      'guard_job_status_transition', 'set_audit_created_at', 'guard_user_role_subject',
      'set_attempt_created_at', 'guard_application_status_transition'])
    and (has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('public', p.oid, 'EXECUTE')
      or has_function_privilege('service_role', p.oid, 'EXECUTE'));
  if offending is not null then
    raise exception 'anon/PUBLIC/service_role can execute: %', offending;
  end if;

  raise notice 'Size, URL and vocabulary limits applied.';
end;
$$;
