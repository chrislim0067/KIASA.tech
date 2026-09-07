-- The administrator user directory: one queryable, paginable, searchable row
-- per account, assembled from auth.users and the public tables that describe
-- them.
--
-- WHY A VIEW AND NOT THE AUTH ADMIN API
--
-- `auth.admin.listUsers()` returns pages of accounts and nothing else. It
-- cannot search by name, cannot filter by role or activity, cannot sort by
-- anything but its own order, and knows nothing about profiles or applications.
-- Building the administrator user list on it would mean fetching a page,
-- issuing a query per user to enrich it, and filtering in JavaScript — which is
-- the N+1 pattern the requirement explicitly rules out, and which produces
-- wrong pagination the moment a search is applied (you would be searching
-- within a page rather than across the table).
--
-- One view lets the list be a single indexed, offset-paginated query with
-- WHERE and ORDER BY pushed into PostgreSQL.
--
-- THE PRIVILEGE TRADE-OFF, STATED PLAINLY
--
-- `service_role` cannot SELECT auth.users — verified on a live stack, not
-- assumed:
--     has_table_privilege('service_role','auth.users','SELECT') = false
--
-- So this view CANNOT be security_invoker; it runs with the privileges of its
-- owner (postgres), which is the same mechanism as a SECURITY DEFINER function.
-- Migration 13 forbids definer *functions*, and that rule is kept — no function
-- here is definer. This view is the one deliberate exception to the spirit of
-- it, and it is contained three ways:
--
--   1. NARROW PROJECTION. The view cannot leak what it does not select.
--      encrypted_password, confirmation_token, recovery_token,
--      reauthentication_token, email_change_token_new/current and phone_change_token
--      are all excluded. Even if the grant below were widened by mistake, no
--      password hash and no authentication token is reachable through it.
--   2. ONE GRANTEE. service_role only. anon, authenticated and PUBLIC are
--      revoked, and the self-verification block fails the migration if that
--      ever stops being true.
--   3. NO POLICY SURFACE. It is never exposed through PostgREST to a browser
--      role, so reaching it requires the secret key, which requires having
--      already passed requireAdmin() in a server route handler.
--
-- The alternative — `grant select on auth.users to service_role` — was
-- rejected: it would expose every column including the password hash, and
-- grants on the auth schema are Supabase-managed and may be reset by a platform
-- upgrade.

create view public.admin_user_directory as
select
  u.id                                             as user_id,
  u.email,
  u.created_at                                     as registered_at,
  u.last_sign_in_at,
  u.email_confirmed_at,
  u.invited_at,
  u.banned_until,
  u.deleted_at,
  u.is_anonymous,

  -- Display name, preferring what the candidate profile states over the
  -- signup metadata. Both are user-supplied; neither is authoritative, and the
  -- profile is the one the person actually maintains.
  coalesce(
    nullif(trim(concat_ws(' ', p.legal_first_name, p.legal_last_name)), ''),
    nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(p.preferred_name), '')
  )                                                as display_name,
  p.preferred_name,
  p.contact_email,
  p.city,
  p.country_code,
  p.onboarding_completed_at,

  -- Absence of a user_roles row means the ordinary role; the directory states
  -- the effective role rather than making every caller repeat the coalesce.
  coalesce(r.role, 'user')                         as role,
  r.granted_at                                     as role_granted_at,

  a.is_automation_enabled,

  -- Derived account status. A single value the administrator list can filter
  -- on, rather than four nullable timestamps the caller has to interpret.
  case
    when u.deleted_at is not null                        then 'deleted'
    when u.banned_until is not null
         and u.banned_until > now()                      then 'banned'
    when u.email_confirmed_at is null
         and u.invited_at is not null                    then 'invited'
    when u.email_confirmed_at is null                    then 'pending_confirmation'
    else 'active'
  end                                              as account_status,

  -- Job intake counters. Real today: these are the only activity numbers the
  -- platform can currently produce, and they describe jobs taken in, not
  -- applications made. Named accordingly so they can never be mistaken for
  -- application metrics on a dashboard.
  coalesce(j.jobs_total, 0)                        as jobs_total,
  j.last_job_at,

  -- Application counters. Zero until an application engine writes to the
  -- tables from migration 15 — which is the honest answer, not a placeholder.
  coalesce(s.applications_total, 0)                as applications_total,
  coalesce(s.applications_succeeded, 0)            as applications_succeeded,
  coalesce(s.applications_failed, 0)               as applications_failed,
  coalesce(s.applications_pending, 0)              as applications_pending,
  coalesce(s.manual_total, 0)                      as manual_total,
  coalesce(s.automation_total, 0)                  as automation_total,
  coalesce(s.bid_bot_total, 0)                     as bid_bot_total,
  coalesce(s.bid_bot_succeeded, 0)                 as bid_bot_succeeded,
  coalesce(s.bid_bot_attempts, 0)                  as bid_bot_attempts,
  s.last_application_at,

  -- "Last meaningful activity", computed rather than stored so it cannot go
  -- stale. greatest() ignores NULLs, so an account that has only ever signed in
  -- still reports its sign-in.
  greatest(
    u.last_sign_in_at,
    j.last_job_at,
    s.last_application_at
  )                                                as last_activity_at
from auth.users u
left join public.profiles p            on p.user_id = u.id
left join public.user_roles r          on r.user_id = u.id
left join public.automation_settings a on a.user_id = u.id
left join public.application_stats_by_user s on s.user_id = u.id
left join (
  select user_id, count(*)::bigint as jobs_total, max(created_at) as last_job_at
  from public.jobs
  group by user_id
) j on j.user_id = u.id;

comment on view public.admin_user_directory is
  'Administrator user list. Owner-executed by necessity (service_role cannot '
  'read auth.users); contained by a narrow projection that excludes every '
  'password hash and authentication token, and by being granted to '
  'service_role alone.';

revoke all on public.admin_user_directory from anon, public, authenticated;
grant select on public.admin_user_directory to service_role;

-- ---------------------------------------------------------------------------
-- Indexes supporting the administrator list
-- ---------------------------------------------------------------------------
-- The list sorts by registration date by default and searches by email or
-- name. auth.users is not ours to index, and it already has an index on email;
-- what we can index is the profile side of the name search.
create index if not exists profiles_name_search_idx
  on public.profiles using gin (
    to_tsvector('simple',
      coalesce(legal_first_name, '') || ' ' ||
      coalesce(legal_last_name, '') || ' ' ||
      coalesce(preferred_name, '')
    )
  );

comment on index public.profiles_name_search_idx is
  'Supports administrator name search. Rebuilt automatically; no maintenance.';

-- ---------------------------------------------------------------------------
-- Self-verification
-- ---------------------------------------------------------------------------
do $$
declare
  offending text;
  leaked text;
  forbidden_columns text[] := array[
    'encrypted_password', 'confirmation_token', 'recovery_token',
    'reauthentication_token', 'email_change_token_new',
    'email_change_token_current', 'phone_change_token'
  ];
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'admin_user_directory' and c.relkind = 'v'
  ) then
    raise exception 'admin_user_directory was not created';
  end if;

  -- THE containment control: no secret column may be projected. Checked against
  -- the view's actual output columns, so adding one later fails this migration's
  -- descendant rather than shipping quietly.
  select string_agg(column_name, ', ') into leaked
  from information_schema.columns
  where table_schema = 'public' and table_name = 'admin_user_directory'
    and column_name = any(forbidden_columns);
  if leaked is not null then
    raise exception 'admin_user_directory projects secret columns: %', leaked;
  end if;

  -- Only service_role may read it.
  select string_agg(grantee, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'admin_user_directory'
    and grantee in ('anon', 'authenticated', 'PUBLIC');
  if offending is not null then
    raise exception 'admin_user_directory is reachable by: %', offending;
  end if;

  if not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'admin_user_directory'
      and grantee = 'service_role' and privilege_type = 'SELECT'
  ) then
    raise exception 'service_role cannot read admin_user_directory';
  end if;

  -- The project-wide function rule still holds: this migration adds a view, not
  -- a definer function. Scoped by name — a hosted Supabase project also carries
  -- platform helpers that are not ours to audit; see migration 7.
  select string_agg(p.proname, ', ') into offending
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = any(array[
      'set_updated_at', 'text_array_matches', 'text_array_no_blanks', 'text_array_ok',
      'jsonb_links_ok', 'is_blank_or_invisible', 'set_row_timestamps',
      'guard_verified_answer_provenance', 'set_event_created_at', 'refuse_row_update',
      'guard_job_status_transition', 'set_audit_created_at', 'guard_user_role_subject',
      'set_attempt_created_at', 'guard_application_status_transition'])
    and (p.prosecdef or p.proconfig is null
         or not (p.proconfig && array['search_path=""', 'search_path=']));
  if offending is not null then
    raise exception 'unsafe functions: %', offending;
  end if;

  raise notice 'admin_user_directory created; secret columns excluded, service_role only.';
end;
$$;
