-- Administrator approval of new accounts.
--
-- Confirming an email proves someone controls that mailbox. It does not mean
-- KIASA wants them on the platform. This migration adds the gate the workflow
-- always described: a signup lands in `pending` and reaches nothing until an
-- administrator approves it.
--
-- SHAPE, AND WHY IT IS ITS OWN TABLE
--
-- Access is orthogonal to role. A person can be approved and ordinary, approved
-- and an administrator, or pending and nothing at all. Folding a status column
-- into `user_roles` would mean the row that grants privilege is also the row
-- that grants entry, so revoking one would silently touch the other — and
-- `user_roles` deliberately has NO row for an ordinary user, which would leave
-- exactly the population this gate is about with nowhere to record a decision.
--
-- ABSENCE MEANS `pending`
--
-- The same "absence is the default" rule `user_roles` uses, pointed the other
-- way: there, absence means the LEAST privilege; here, absence means the LEAST
-- access. A brand-new signup has no row and is therefore pending without
-- anything having to write one at signup time — no trigger on auth.users, no
-- application bootstrap that could fail and quietly admit someone.
--
-- The existing accounts are backfilled as approved at the bottom of this file.
-- Locking out people who were already using the platform would be a regression
-- dressed up as a security improvement.

create table public.user_access (
  user_id uuid primary key references auth.users (id) on delete cascade,

  status text not null default 'pending'
    constraint user_access_status_allowed check (status in ('pending', 'approved', 'rejected')),

  -- Who decided, and when. NULL for a row that is still pending, and NULL for
  -- the backfill below, which no administrator personally decided.
  decided_by uuid,
  decided_at timestamptz,

  -- Shown to the administrator, never to the applicant: a rejection reason is
  -- an internal note, and echoing it to the rejected person invites argument
  -- with a decision that has already been made.
  reason text
    constraint user_access_reason_length check (reason is null or length(reason) <= 500),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A decided row must say who and when; a pending row must not pretend to.
  constraint user_access_decision_complete
    check ((status = 'pending') = (decided_at is null)),

  -- Only a rejection carries a reason.
  constraint user_access_reason_only_on_rejection
    check (reason is null or status = 'rejected')
);

comment on table public.user_access is
  'Administrator approval gate for accounts. Absence of a row means pending: a '
  'new signup reaches nothing until an administrator approves it.';

comment on column public.user_access.decided_by is
  'The administrator who decided. Not a foreign key, for the same reason '
  'admin_audit_log carries none: the decision outlives the deciding account.';

create index user_access_status_idx on public.user_access (status);
create index user_access_decided_idx on public.user_access (decided_at desc);

-- ---------------------------------------------------------------------------
-- RLS, grants and policies
-- ---------------------------------------------------------------------------
do $$
begin
  alter table public.user_access enable row level security;
  alter table public.user_access force row level security;

  revoke all on public.user_access from anon;
  revoke all on public.user_access from public;
  revoke all on public.user_access from authenticated;
  revoke all on public.user_access from service_role;

  -- A user may read their OWN status, and nothing else. That is what lets the
  -- "waiting for approval" screen tell them where they stand without an
  -- elevated credential — the same trick the admin check uses for roles.
  grant select on public.user_access to authenticated;

  create policy user_access_select_own on public.user_access
    for select to authenticated
    using ((select auth.uid()) = user_id);

  -- No INSERT, UPDATE or DELETE for `authenticated`. A user approving
  -- themselves is the entire threat this table exists to prevent, and the
  -- privilege to attempt it simply does not exist.

  -- Administrative decisions are made by a server route handler holding the
  -- secret key, after requireAdmin() has already passed.
  grant select, insert, update, delete on public.user_access to service_role;
end;
$$;

create trigger user_access_set_row_timestamps
  before insert or update on public.user_access
  for each row execute function public.set_row_timestamps();

-- The subject of a decision may never be reassigned, mirroring
-- guard_user_role_subject() on user_roles.
create or replace function public.guard_user_access_subject()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'user_access.user_id is immutable; delete and re-decide instead'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

comment on function public.guard_user_access_subject() is
  'BEFORE UPDATE on user_access: refuses to move a decision between accounts.';

create trigger user_access_zz_subject_immutable
  before update on public.user_access
  for each row execute function public.guard_user_access_subject();

revoke all on function public.guard_user_access_subject() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
-- Everyone who already had an account keeps their access. `decided_by` is NULL
-- and the note records why, so this is never mistaken for a decision somebody
-- actually made.
insert into public.user_access (user_id, status, decided_at, decided_by)
select id, 'approved', now(), null
from auth.users
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- Administrator views
-- ---------------------------------------------------------------------------
-- Both views are replaced rather than altered: `admin_user_directory` gains an
-- access_status column, and the platform stats gain the pending counter the
-- dashboard needs to show a queue length.
--
-- Drop order matters and is the reverse of create order: admin_platform_stats
-- selects from admin_user_directory, so PostgreSQL refuses to drop the
-- directory while the stats view still references it.
drop view if exists public.admin_platform_stats;
drop view if exists public.admin_user_directory;

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

  coalesce(r.role, 'user')                         as role,
  r.granted_at                                     as role_granted_at,

  -- The approval gate. Absence means pending, exactly as the table's own
  -- default does, so a signup that has never been looked at reads correctly
  -- here without a row having to exist.
  coalesce(acc.status, 'pending')                  as access_status,
  acc.decided_at                                   as access_decided_at,
  acc.decided_by                                   as access_decided_by,
  acc.reason                                       as access_reason,

  a.is_automation_enabled,

  case
    when u.deleted_at is not null                        then 'deleted'
    when u.banned_until is not null
         and u.banned_until > now()                      then 'banned'
    when u.email_confirmed_at is null
         and u.invited_at is not null                    then 'invited'
    when u.email_confirmed_at is null                    then 'pending_confirmation'
    else 'active'
  end                                              as account_status,

  coalesce(j.jobs_total, 0)                        as jobs_total,
  j.last_job_at,

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

  greatest(u.last_sign_in_at, j.last_job_at, s.last_application_at) as last_activity_at
from auth.users u
left join public.profiles p            on p.user_id = u.id
left join public.user_roles r          on r.user_id = u.id
left join public.user_access acc       on acc.user_id = u.id
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

create view public.admin_platform_stats as
select
  (select count(*) from auth.users)::bigint                                  as users_total,
  (select count(*) from auth.users where created_at >= now() - interval '7 days')::bigint
                                                                             as users_new_7d,
  (select count(*) from auth.users where created_at >= now() - interval '30 days')::bigint
                                                                             as users_new_30d,
  (select count(*) from auth.users where email_confirmed_at is null and deleted_at is null)::bigint
                                                                             as users_pending_confirmation,
  (select count(*) from public.user_roles where role = 'admin')::bigint      as users_admin,
  (select count(*) from public.admin_user_directory
    where last_activity_at >= now() - interval '30 days')::bigint            as users_active_30d,

  -- The approval queue. `users_pending_approval` is the number an administrator
  -- is expected to act on; it is distinct from users_pending_confirmation,
  -- which is the mail-provider's problem, not theirs.
  (select count(*) from public.admin_user_directory where access_status = 'pending')::bigint
                                                                             as users_pending_approval,
  (select count(*) from public.user_access where status = 'approved')::bigint as users_approved,
  (select count(*) from public.user_access where status = 'rejected')::bigint as users_rejected,

  (select count(*) from public.jobs)::bigint                                 as jobs_total,
  (select count(*) from public.jobs where created_at >= now() - interval '7 days')::bigint
                                                                             as jobs_new_7d,
  (select count(*) from public.jobs where status = 'extracted')::bigint      as jobs_extracted,
  (select count(*) from public.jobs where status in ('fetch_failed', 'extraction_incomplete'))::bigint
                                                                             as jobs_parked,

  (select count(*) from public.applications)::bigint                         as applications_total,
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
-- Audit vocabulary
-- ---------------------------------------------------------------------------
-- The action list is a CHECK, so approving and rejecting have to be added to it
-- before the audit writer can record them.
alter table public.admin_audit_log
  drop constraint admin_audit_log_action_allowed;

alter table public.admin_audit_log
  add constraint admin_audit_log_action_allowed
  check (action in (
    'user.invited',
    'user.invite_resent',
    'user.deleted',
    'user.role_granted',
    'user.role_revoked',
    'user.approved',
    'user.rejected',
    'user.access_reset',
    'admin.bootstrapped'
  ));

-- ---------------------------------------------------------------------------
-- Self-verification
-- ---------------------------------------------------------------------------
do $$
declare
  offending text;
  n integer;
  migration_functions text[] := array[
    'set_updated_at', 'text_array_matches', 'text_array_no_blanks', 'text_array_ok',
    'jsonb_links_ok', 'is_blank_or_invisible', 'set_row_timestamps',
    'guard_verified_answer_provenance', 'set_event_created_at', 'refuse_row_update',
    'guard_job_status_transition', 'set_audit_created_at', 'guard_user_role_subject',
    'set_attempt_created_at', 'guard_application_status_transition',
    'guard_user_access_subject'
  ];
begin
  if not exists (
    select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname = 'user_access'
      and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'RLS not enabled and forced on user_access';
  end if;

  -- THE control: authenticated may only SELECT. A user who can write this table
  -- can approve themselves, which defeats the entire feature.
  select string_agg(privilege_type, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'user_access'
    and grantee = 'authenticated' and privilege_type <> 'SELECT';
  if offending is not null then
    raise exception 'authenticated can write user_access (%). Self-approval is possible.', offending;
  end if;

  select string_agg(distinct grantee, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'user_access'
    and grantee in ('anon', 'PUBLIC');
  if offending is not null then
    raise exception 'anon/PUBLIC hold grants on user_access: %', offending;
  end if;

  select count(*) into n from pg_policies
  where schemaname = 'public' and tablename = 'user_access';
  if n <> 1 then
    raise exception 'expected exactly 1 policy on user_access, found %', n;
  end if;

  -- Every pre-existing account must have been backfilled, or this migration
  -- would lock out the people already using the platform.
  select count(*) into n
  from auth.users u
  left join public.user_access acc on acc.user_id = u.id
  where acc.user_id is null;
  if n > 0 then
    raise exception '% existing account(s) were not backfilled', n;
  end if;

  -- The directory must expose the new column, and must still hide the secrets.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'admin_user_directory'
      and column_name = 'access_status'
  ) then
    raise exception 'admin_user_directory is missing access_status';
  end if;

  select string_agg(column_name, ', ') into offending
  from information_schema.columns
  where table_schema = 'public' and table_name = 'admin_user_directory'
    and column_name = any(array[
      'encrypted_password', 'confirmation_token', 'recovery_token',
      'reauthentication_token', 'email_change_token_new',
      'email_change_token_current', 'phone_change_token']);
  if offending is not null then
    raise exception 'admin_user_directory projects secret columns: %', offending;
  end if;

  -- Neither view may be reachable by a browser role.
  select string_agg(distinct table_name || '/' || grantee, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('admin_user_directory', 'admin_platform_stats', 'user_access')
    and grantee in ('anon', 'authenticated', 'PUBLIC')
    and not (table_name = 'user_access' and grantee = 'authenticated' and privilege_type = 'SELECT');
  if offending is not null then
    raise exception 'administrator relations reachable by browser roles: %', offending;
  end if;

  -- The stats view must execute and report the queue.
  perform 1 from public.admin_platform_stats;

  -- The audit vocabulary must accept the new actions.
  if not exists (
    select 1 from pg_constraint
    where conname = 'admin_audit_log_action_allowed'
      and pg_get_constraintdef(oid) like '%user.approved%'
      and pg_get_constraintdef(oid) like '%user.rejected%'
  ) then
    raise exception 'admin_audit_log does not accept the approval actions';
  end if;

  -- Project-wide rule, scoped to our own functions (see migration 7).
  select string_agg(p.proname, ', ') into offending
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.proname = any(migration_functions)
    and (p.prosecdef or p.proconfig is null
         or not (p.proconfig && array['search_path=""', 'search_path=']));
  if offending is not null then
    raise exception 'unsafe functions: %', offending;
  end if;

  raise notice 'Approval gate created; existing accounts backfilled as approved.';
end;
$$;
