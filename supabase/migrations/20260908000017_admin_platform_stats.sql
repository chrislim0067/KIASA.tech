-- Platform-wide administrator counters, as a single one-row view.
--
-- The dashboard needs fifteen numbers. Fetching them as fifteen PostgREST
-- `count: 'exact'` requests would be fifteen HTTP round trips and fifteen
-- planner invocations for what PostgreSQL can answer in one pass — and the
-- requirement is explicit that aggregation belongs in the database. This view
-- is that one pass.
--
-- Every counter is computed at query time (now() is evaluated per SELECT), so
-- nothing here is a cached or precomputed value that could drift from the
-- tables. The underlying rows remain the source of truth; this view only
-- reduces them.
--
-- Same containment as admin_user_directory: it reads auth.users, so it must be
-- owner-executed, and it is granted to service_role alone. The projection is
-- counts only — no email, no identifier, nothing about an individual — so even
-- a widened grant would leak no personal data.

create view public.admin_platform_stats as
select
  -- ---- accounts -------------------------------------------------------
  (select count(*) from auth.users)::bigint                                  as users_total,
  (select count(*) from auth.users where created_at >= now() - interval '7 days')::bigint
                                                                             as users_new_7d,
  (select count(*) from auth.users where created_at >= now() - interval '30 days')::bigint
                                                                             as users_new_30d,
  (select count(*) from auth.users where email_confirmed_at is null and deleted_at is null)::bigint
                                                                             as users_pending_confirmation,
  (select count(*) from public.user_roles where role = 'admin')::bigint      as users_admin,

  -- "Active" means the account did something in the window — signed in, added
  -- a job, or had an application. It is NOT a count of live sessions, which
  -- Supabase does not expose; the column name says "activity" so the dashboard
  -- cannot imply a measurement the platform cannot make.
  (select count(*) from public.admin_user_directory
    where last_activity_at >= now() - interval '30 days')::bigint            as users_active_30d,

  -- ---- job intake (real today) ---------------------------------------
  (select count(*) from public.jobs)::bigint                                 as jobs_total,
  (select count(*) from public.jobs where created_at >= now() - interval '7 days')::bigint
                                                                             as jobs_new_7d,
  (select count(*) from public.jobs where status = 'extracted')::bigint      as jobs_extracted,
  (select count(*) from public.jobs where status in ('fetch_failed', 'extraction_incomplete'))::bigint
                                                                             as jobs_parked,

  -- ---- applications (zero until an engine writes them) ----------------
  (select count(*) from public.applications)::bigint                         as applications_total,
  -- Success is submitted or confirmed and nothing else. A bot merely starting
  -- work is not a successful application; see lib/applications/state.ts.
  (select count(*) from public.applications where status in ('submitted', 'confirmed'))::bigint
                                                                             as applications_succeeded,
  (select count(*) from public.applications where status = 'failed')::bigint as applications_failed,
  (select count(*) from public.applications where status in ('queued', 'preparing', 'submitting'))::bigint
                                                                             as applications_pending,
  (select count(*) from public.applications where status = 'needs_intervention')::bigint
                                                                             as applications_needs_intervention,
  (select count(*) from public.applications where method = 'manual')::bigint as applications_manual,
  (select count(*) from public.applications where method in ('automated', 'bid_bot'))::bigint
                                                                             as applications_automated,

  -- ---- Bid Bot, both halves ------------------------------------------
  -- "attempted" and "succeeded" are different facts. Exposing only one of them
  -- would let the dashboard imply the other.
  (select count(*) from public.applications where method = 'bid_bot')::bigint
                                                                             as bid_bot_total,
  (select count(*) from public.applications
    where method = 'bid_bot' and status in ('submitted', 'confirmed'))::bigint
                                                                             as bid_bot_succeeded,
  (select count(*) from public.applications where method = 'bid_bot' and status = 'failed')::bigint
                                                                             as bid_bot_failed,
  (select count(*) from public.application_attempts where method = 'bid_bot')::bigint
                                                                             as bid_bot_attempts,
  (select count(*) from public.application_attempts
    where method = 'bid_bot' and outcome = 'submitted')::bigint              as bid_bot_attempts_submitted,

  -- ---- recent administrative activity ---------------------------------
  (select count(*) from public.admin_audit_log
    where occurred_at >= now() - interval '7 days')::bigint                  as admin_actions_7d,
  (select count(*) from public.admin_audit_log
    where occurred_at >= now() - interval '7 days' and result = 'failed')::bigint
                                                                             as admin_actions_failed_7d;

comment on view public.admin_platform_stats is
  'One-row platform counters for the administrator dashboard. Computed per '
  'query, never cached. Counts only — no personal data. service_role only.';

revoke all on public.admin_platform_stats from anon, public, authenticated;
grant select on public.admin_platform_stats to service_role;

-- ---------------------------------------------------------------------------
-- Self-verification
-- ---------------------------------------------------------------------------
do $$
declare
  offending text;
  stats record;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'admin_platform_stats' and c.relkind = 'v'
  ) then
    raise exception 'admin_platform_stats was not created';
  end if;

  select string_agg(grantee, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'admin_platform_stats'
    and grantee in ('anon', 'authenticated', 'PUBLIC');
  if offending is not null then
    raise exception 'admin_platform_stats is reachable by: %', offending;
  end if;

  -- The view must project counts only. Any column that is not a bigint would
  -- mean personal data crept into a relation whose safety argument rests on it
  -- containing none.
  select string_agg(column_name || ' (' || data_type || ')', ', ') into offending
  from information_schema.columns
  where table_schema = 'public' and table_name = 'admin_platform_stats'
    and data_type <> 'bigint';
  if offending is not null then
    raise exception 'admin_platform_stats projects non-count columns: %', offending;
  end if;

  -- It must actually execute. A view referencing a mistyped column would only
  -- fail at first SELECT, which could be in production.
  select * into stats from public.admin_platform_stats;
  if stats.users_total is null then
    raise exception 'admin_platform_stats returned a null users_total';
  end if;

  raise notice 'admin_platform_stats created and executed (users_total=%).', stats.users_total;
end;
$$;
