-- Application tracking: the authoritative record of applying to a job.
--
-- WHY THIS EXISTS
--
-- The job pipeline in migrations 12-13 ends at `extracted`: KIASA fetches a
-- posting and extracts its facts, and stops. Nothing in the schema records that
-- an application was ever *made*, by what mechanism, or whether it succeeded.
-- Every administrator metric the product needs — how many jobs a user applied
-- to, how many succeeded, how many were automated, how many were the Bid Bot —
-- is therefore unanswerable today, and inferring those numbers from job intake
-- state would be fabrication: `extracted` means "we read the posting", not
-- "we applied".
--
-- These two tables are that missing record. Until an application engine writes
-- to them the administrator dashboard will honestly report zero, which is the
-- correct answer, rather than a number derived from unrelated data.
--
-- THE TWO-TABLE SHAPE
--
--   applications         one row per (user, job). The logical application and
--                        its CURRENT state. Mutable, transition-guarded.
--   application_attempts one row per execution attempt. Append-only evidence.
--
-- A logical application can be attempted repeatedly — a transient failure is
-- retried, a needs_intervention is resumed after the user answers — so attempts
-- are modelled separately rather than overwriting a single row. The ledger is
-- the authoritative history; `applications` is a projection of it that exists
-- so the common queries ("what is this application doing now") do not have to
-- reduce the ledger every time. scripts/test-application-reconciliation.mjs
-- asserts the projection agrees with the ledger.
--
-- WHAT IS DELIBERATELY *NOT* HERE
--
-- `discovered` and `matched` are not application states. A job is discovered
-- and qualified by the intake pipeline, which already has its own state machine
-- and its own event log; duplicating those as application states would create
-- two sources of truth for one fact. An application begins at `queued`, the
-- moment the job has been selected and handed to an executor.
--
-- jobs.status is NOT extended by this migration. The intake state machine and
-- its guard trigger are left exactly as migration 13 wrote them.

-- ---------------------------------------------------------------------------
-- applications
-- ---------------------------------------------------------------------------
create table public.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null references public.jobs (id) on delete cascade,

  -- THE attribution column. Structured, constrained, and never derived by
  -- searching logs for a string.
  --
  --   manual     the user applied themselves through KIASA
  --   automated  unattended execution that is not the Bid Bot
  --   bid_bot    the Bid Bot specifically
  --   external   recorded as applied outside KIASA (imported or user-declared)
  --
  -- 'bid_bot' is its own value rather than a flag on 'automated' because the
  -- administrator question is "how many did the Bid Bot do", and a metric whose
  -- correctness depends on remembering to also filter a boolean is a metric
  -- that will eventually be reported wrong.
  method text not null
    constraint applications_method_allowed
    check (method in ('manual', 'automated', 'bid_bot', 'external')),

  -- Lifecycle. Transitions are enforced by a trigger below; this CHECK only
  -- constrains the vocabulary, exactly as jobs.status does.
  status text not null default 'queued'
    constraint applications_status_allowed
    check (status in (
      'queued',              -- selected, waiting for an executor
      'preparing',           -- an executor has claimed it and is building it
      'submitting',          -- submission in flight
      'submitted',           -- KIASA sent it
      'confirmed',           -- the destination acknowledged it
      'failed',              -- resolved unsuccessfully
      'skipped',             -- deliberately not applied to
      'cancelled',           -- withdrawn before submission
      'duplicate',           -- already applied to this job
      'needs_intervention'   -- blocked awaiting a human or resolver agent
    )),

  -- Machine-readable reason for the current status. Split into a class and a
  -- code so a scheduler can branch on the class without knowing every code:
  -- transient work is retried, structural work needs a fix, terminal work is
  -- abandoned. This is the same shape the fetcher's status_reason uses.
  status_class text
    constraint applications_status_class_allowed
    check (status_class is null or status_class in ('transient', 'structural', 'terminal', 'question')),
  status_code text
    constraint applications_status_code_length check (status_code is null or length(status_code) <= 100),

  -- Who last executed it. Reuses the job_events actor vocabulary rather than
  -- inventing a second one.
  executor_type text
    constraint applications_executor_type_allowed
    check (executor_type is null or executor_type in ('human', 'agent', 'system')),
  executor_id uuid,
  -- The worker instance, e.g. 'bid-bot-03'. Identifies WHICH bot executed it,
  -- where `method` identifies what KIND of mechanism it was.
  worker_id text
    constraint applications_worker_id_length check (worker_id is null or length(worker_id) <= 100),

  attempt_count integer not null default 0
    constraint applications_attempt_count_nonneg check (attempt_count >= 0),

  -- Milestone timestamps. NULL means "has not happened", never "unknown".
  queued_at       timestamptz not null default now(),
  first_started_at timestamptz,
  submitted_at    timestamptz,
  confirmed_at    timestamptz,
  last_attempt_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One logical application per job per user. This is the duplicate control:
  -- a second attempt to apply to the same posting collides here rather than
  -- silently creating a second application and double-counting the metric.
  constraint applications_one_per_job unique (user_id, job_id),

  -- A submitted application must say when. Enforcing the pair means the
  -- "successfully applied" metric can be computed from either column and agree.
  constraint applications_submitted_has_timestamp
    check ((status in ('submitted', 'confirmed')) <= (submitted_at is not null)),
  constraint applications_confirmed_has_timestamp
    check ((status = 'confirmed') <= (confirmed_at is not null))
);

comment on table public.applications is
  'One row per (user, job): the logical application and its current state. '
  'Authoritative history lives in application_attempts.';

comment on column public.applications.method is
  'How the application was made. bid_bot is a first-class value so Bid Bot '
  'metrics are a column comparison, never a log search.';

create index applications_user_id_idx on public.applications (user_id);
create index applications_user_status_idx on public.applications (user_id, status);
create index applications_user_method_idx on public.applications (user_id, method);
create index applications_user_created_idx on public.applications (user_id, created_at desc);
create index applications_job_idx on public.applications (job_id);
-- Platform-wide administrator aggregates scan by status and method across all
-- users, so these two are not redundant with the per-user composites above.
create index applications_status_idx on public.applications (status);
create index applications_method_idx on public.applications (method);
create index applications_submitted_at_idx on public.applications (submitted_at desc)
  where submitted_at is not null;

-- ---------------------------------------------------------------------------
-- application_attempts  (append-only ledger)
-- ---------------------------------------------------------------------------
create table public.application_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  application_id uuid not null references public.applications (id) on delete cascade,
  -- Denormalised so per-job attempt queries need no join, matching how the
  -- job tables carry user_id rather than reaching it through a parent.
  job_id uuid not null references public.jobs (id) on delete cascade,

  attempt_number integer not null
    constraint application_attempts_number_positive check (attempt_number >= 1),

  -- Carried per attempt, not read from the parent. A retry may legitimately use
  -- a different mechanism (Bid Bot fails, a human finishes it manually), and if
  -- the attempt did not record its own method that history would be lost the
  -- moment the parent row was updated.
  method text not null
    constraint application_attempts_method_allowed
    check (method in ('manual', 'automated', 'bid_bot', 'external')),

  executor_type text not null
    constraint application_attempts_executor_type_allowed
    check (executor_type in ('human', 'agent', 'system')),
  executor_id uuid,
  worker_id text
    constraint application_attempts_worker_id_length check (worker_id is null or length(worker_id) <= 100),

  started_at timestamptz not null default now(),
  ended_at timestamptz,

  -- NULL while the attempt is still running. A row with no outcome is an
  -- attempt in flight; the scheduler treats a stale one as abandoned.
  outcome text
    constraint application_attempts_outcome_allowed
    check (outcome is null or outcome in (
      'submitted', 'failed', 'skipped', 'cancelled', 'duplicate', 'needs_intervention'
    )),

  failure_class text
    constraint application_attempts_failure_class_allowed
    check (failure_class is null or failure_class in ('transient', 'structural', 'terminal', 'question')),
  failure_code text
    constraint application_attempts_failure_code_length
    check (failure_code is null or length(failure_code) <= 100),

  detail jsonb not null default '{}'::jsonb
    constraint application_attempts_detail_is_object check (jsonb_typeof(detail) = 'object')
    constraint application_attempts_detail_size check (pg_column_size(detail) <= 8192),

  created_at timestamptz not null default now(),

  -- A human executor must be identified, mirroring job_events.
  constraint application_attempts_human_has_actor
    check (executor_type <> 'human' or executor_id is not null),
  -- A finished attempt states its outcome; an unfinished one does not.
  constraint application_attempts_ended_has_outcome
    check ((ended_at is not null) = (outcome is not null)),
  -- Attempt numbering is dense and unique per application.
  constraint application_attempts_unique_number unique (application_id, attempt_number)
);

comment on table public.application_attempts is
  'Append-only ledger: one row per execution attempt. Authoritative source for '
  'attempted-versus-succeeded metrics. Immutable once written.';

create index application_attempts_user_id_idx on public.application_attempts (user_id);
create index application_attempts_application_idx
  on public.application_attempts (application_id, attempt_number);
create index application_attempts_job_idx on public.application_attempts (job_id);
create index application_attempts_user_started_idx
  on public.application_attempts (user_id, started_at desc);
create index application_attempts_method_idx on public.application_attempts (method);

-- ---------------------------------------------------------------------------
-- RLS, grants and policies
-- ---------------------------------------------------------------------------
do $$
declare
  target_table text;
  all_tables text[] := array['applications', 'application_attempts'];
begin
  foreach target_table in array all_tables loop
    execute format('alter table public.%I enable row level security', target_table);
    execute format('alter table public.%I force row level security', target_table);

    execute format('revoke all on public.%I from anon', target_table);
    execute format('revoke all on public.%I from public', target_table);
    execute format('revoke all on public.%I from authenticated', target_table);
    execute format('revoke all on public.%I from service_role', target_table);

    execute format('grant select, insert on public.%I to authenticated', target_table);

    execute format($p$
      create policy %I on public.%I
        for select to authenticated
        using ((select auth.uid()) = user_id)
    $p$, target_table || '_select_own', target_table);

    execute format($p$
      create policy %I on public.%I
        for insert to authenticated
        with check ((select auth.uid()) = user_id)
    $p$, target_table || '_insert_own', target_table);

    -- Administrators read every user's rows, and they do it through a server
    -- route handler holding service_role — never through an admin-shaped RLS
    -- policy on these tables. SELECT only: the administrator surface reports on
    -- applications, it does not author them.
    execute format('grant select on public.%I to service_role', target_table);
  end loop;

  -- applications is mutable by its owner: an application advances through its
  -- lifecycle, and a user may cancel one. There is deliberately NO DELETE.
  -- Deleting an application would silently rewrite the user's own history and
  -- every metric computed from it. Erasure remains available at the only
  -- honest granularity — remove the job, or the account, and the cascade takes
  -- the applications with it. This is the same decision migration 13 recorded
  -- for job_events, applied for the same reason.
  grant update on public.applications to authenticated;
  create policy applications_update_own on public.applications
    for update to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

  -- application_attempts gets no UPDATE and no DELETE at all. It is evidence.
end;
$$;

-- ---------------------------------------------------------------------------
-- Timestamps and immutability
-- ---------------------------------------------------------------------------
create trigger applications_set_row_timestamps
  before insert or update on public.applications
  for each row execute function public.set_row_timestamps();

create trigger application_attempts_immutable
  before update on public.application_attempts
  for each row execute function public.refuse_row_update();

create or replace function public.set_attempt_created_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.created_at := now();
  if new.started_at is null or new.started_at > now() then
    new.started_at := now();
  end if;
  return new;
end;
$$;

comment on function public.set_attempt_created_at() is
  'BEFORE INSERT on application_attempts: stamps created_at server-side and '
  'clamps a future started_at to now.';

create trigger application_attempts_set_created_at
  before insert on public.application_attempts
  for each row execute function public.set_attempt_created_at();

revoke all on function public.set_attempt_created_at() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Status transitions
-- ---------------------------------------------------------------------------
-- Same reasoning as guard_job_status_transition(): RLS lets a client PATCH
-- applications.status straight through PostgREST, so a TypeScript-only rule
-- would be advisory. lib/applications/state.ts mirrors this table and
-- scripts/test-application-state-parity.mjs asserts they are identical.
create or replace function public.guard_application_status_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  legal constant text[] := array[
    -- queued: picked up, or resolved without ever running
    'queued>preparing', 'queued>cancelled', 'queued>skipped', 'queued>duplicate',
    -- preparing: the executor is building the application
    'preparing>submitting', 'preparing>failed', 'preparing>skipped',
    'preparing>needs_intervention', 'preparing>cancelled', 'preparing>duplicate',
    -- submitting: in flight, resolves one way or the other
    'submitting>submitted', 'submitting>failed', 'submitting>needs_intervention',
    -- submitted: the destination may later confirm, or the submission may be
    -- discovered to have failed
    'submitted>confirmed', 'submitted>failed',
    -- blocked work resumes, or is abandoned
    'needs_intervention>preparing', 'needs_intervention>submitting',
    'needs_intervention>cancelled', 'needs_intervention>skipped',
    'needs_intervention>failed',
    -- retry: a failed or skipped application may be requeued
    'failed>queued', 'skipped>queued'
    -- confirmed, cancelled and duplicate are terminal: no outgoing transition.
  ];
begin
  if new.status = old.status then
    return new;  -- not a transition
  end if;
  if not ((old.status || '>' || new.status) = any(legal)) then
    raise exception 'illegal application status transition: % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function public.guard_application_status_transition() is
  'BEFORE UPDATE on applications: rejects status transitions outside the legal '
  'set. Mirrored by lib/applications/state.ts with a parity test.';

create trigger applications_zz_status_transition
  before update on public.applications
  for each row execute function public.guard_application_status_transition();

revoke all on function public.guard_application_status_transition() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Administrator aggregate
-- ---------------------------------------------------------------------------
-- One row per user with every counter the administrator surface needs, so the
-- user list is a single grouped query joined once — never one count per user,
-- and never "fetch all applications and count them in JavaScript".
--
-- security_invoker = true is essential. A view defaults to running with the
-- privileges of its OWNER, which here is postgres — a role with BYPASSRLS. Left
-- at the default, any role granted SELECT on this view would read every user's
-- aggregates regardless of policy. With security_invoker the view executes as
-- the caller, so RLS still applies, and only service_role (which is granted
-- below, and legitimately bypasses RLS for the administrator surface) sees
-- across users.
create view public.application_stats_by_user
with (security_invoker = true) as
with app_rollup as (
  select
    a.user_id,
    count(*)::bigint                                                          as applications_total,
    -- "Successfully applied" is submitted or confirmed, and nothing else. A
    -- bot beginning work is explicitly NOT success; that is what the separate
    -- attempted counters below are for.
    count(*) filter (where a.status in ('submitted', 'confirmed'))::bigint    as applications_succeeded,
    count(*) filter (where a.status = 'confirmed')::bigint                    as applications_confirmed,
    count(*) filter (where a.status = 'failed')::bigint                       as applications_failed,
    count(*) filter (where a.status in ('queued', 'preparing', 'submitting'))::bigint
                                                                              as applications_pending,
    count(*) filter (where a.status = 'skipped')::bigint                      as applications_skipped,
    count(*) filter (where a.status = 'cancelled')::bigint                    as applications_cancelled,
    count(*) filter (where a.status = 'duplicate')::bigint                    as applications_duplicate,
    count(*) filter (where a.status = 'needs_intervention')::bigint           as applications_needs_intervention,

    count(*) filter (where a.method = 'manual')::bigint                       as manual_total,
    count(*) filter (where a.method = 'automated')::bigint                    as automated_total,
    count(*) filter (where a.method = 'bid_bot')::bigint                      as bid_bot_total,
    count(*) filter (where a.method = 'external')::bigint                     as external_total,

    -- Bid Bot, stated honestly in both halves. "The Bid Bot handled 400
    -- applications" and "the Bid Bot successfully submitted 260" are different
    -- facts and the administrator sees both rather than one standing in for
    -- the other.
    count(*) filter (where a.method = 'bid_bot' and a.status in ('submitted', 'confirmed'))::bigint
                                                                              as bid_bot_succeeded,
    count(*) filter (where a.method = 'bid_bot' and a.status = 'failed')::bigint
                                                                              as bid_bot_failed,
    -- Everything unattended, Bid Bot included.
    count(*) filter (where a.method in ('automated', 'bid_bot'))::bigint      as automation_total,

    max(a.submitted_at)                                                       as last_submitted_at,
    max(a.created_at)                                                         as last_application_at
  from public.applications a
  group by a.user_id
),
attempt_rollup as (
  select
    t.user_id,
    count(*)::bigint                                                          as attempts_total,
    count(*) filter (where t.method = 'bid_bot')::bigint                      as bid_bot_attempts,
    count(*) filter (where t.method = 'bid_bot' and t.outcome = 'submitted')::bigint
                                                                              as bid_bot_attempts_submitted,
    count(*) filter (where t.outcome = 'failed')::bigint                      as attempts_failed,
    max(t.started_at)                                                         as last_attempt_at
  from public.application_attempts t
  group by t.user_id
)
select
  coalesce(ar.user_id, tr.user_id)                    as user_id,
  coalesce(ar.applications_total, 0)                  as applications_total,
  coalesce(ar.applications_succeeded, 0)              as applications_succeeded,
  coalesce(ar.applications_confirmed, 0)              as applications_confirmed,
  coalesce(ar.applications_failed, 0)                 as applications_failed,
  coalesce(ar.applications_pending, 0)                as applications_pending,
  coalesce(ar.applications_skipped, 0)                as applications_skipped,
  coalesce(ar.applications_cancelled, 0)              as applications_cancelled,
  coalesce(ar.applications_duplicate, 0)              as applications_duplicate,
  coalesce(ar.applications_needs_intervention, 0)     as applications_needs_intervention,
  coalesce(ar.manual_total, 0)                        as manual_total,
  coalesce(ar.automated_total, 0)                     as automated_total,
  coalesce(ar.bid_bot_total, 0)                       as bid_bot_total,
  coalesce(ar.external_total, 0)                      as external_total,
  coalesce(ar.bid_bot_succeeded, 0)                   as bid_bot_succeeded,
  coalesce(ar.bid_bot_failed, 0)                      as bid_bot_failed,
  coalesce(ar.automation_total, 0)                    as automation_total,
  coalesce(tr.attempts_total, 0)                      as attempts_total,
  coalesce(tr.bid_bot_attempts, 0)                    as bid_bot_attempts,
  coalesce(tr.bid_bot_attempts_submitted, 0)          as bid_bot_attempts_submitted,
  coalesce(tr.attempts_failed, 0)                     as attempts_failed,
  ar.last_submitted_at,
  ar.last_application_at,
  tr.last_attempt_at
from app_rollup ar
full outer join attempt_rollup tr on tr.user_id = ar.user_id;

comment on view public.application_stats_by_user is
  'Per-user application counters for the administrator surface. '
  'security_invoker so RLS still applies; granted to service_role only.';

revoke all on public.application_stats_by_user from anon, public, authenticated;
grant select on public.application_stats_by_user to service_role;

-- ---------------------------------------------------------------------------
-- Self-verification
-- ---------------------------------------------------------------------------
do $$
declare
  all_tables text[] := array['applications', 'application_attempts'];
  target text;
  offending text;
  n integer;
begin
  -- RLS enabled and forced.
  select string_agg(t, ', ') into offending
  from unnest(all_tables) t
  where not exists (
    select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname = t and c.relrowsecurity and c.relforcerowsecurity
  );
  if offending is not null then
    raise exception 'RLS not enabled and forced on: %', offending;
  end if;

  -- Ownership must be direct and indexed, and must cascade from auth.users so
  -- account deletion really removes it. Same three assertions migration 12 makes.
  foreach target in array all_tables loop
    if not exists (
      select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid
      join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relname = target
        and a.attname = 'user_id' and a.attnotnull and a.attnum > 0
    ) then
      raise exception '%.user_id is missing or nullable', target;
    end if;

    if not exists (
      select 1 from pg_constraint fk
      join pg_class c on c.oid = fk.conrelid
      join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relname = target and fk.contype = 'f'
        and fk.confdeltype = 'c'
        and fk.conkey = (select array_agg(a.attnum) from pg_attribute a
                         where a.attrelid = c.oid and a.attname = 'user_id')
    ) then
      raise exception '%.user_id does not cascade from auth.users', target;
    end if;
  end loop;

  -- anon and PUBLIC reach nothing.
  select string_agg(distinct grantee || ' on ' || table_name, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = any(all_tables)
    and grantee in ('anon', 'PUBLIC');
  if offending is not null then
    raise exception 'anon/PUBLIC hold grants: %', offending;
  end if;

  -- authenticated holds no privilege beyond DML, and specifically no DELETE on
  -- either table: history is not user-erasable except by cascade.
  select string_agg(distinct table_name || '.' || privilege_type, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = any(all_tables)
    and grantee = 'authenticated'
    and privilege_type not in ('SELECT', 'INSERT', 'UPDATE');
  if offending is not null then
    raise exception 'authenticated holds unexpected privileges: %', offending;
  end if;

  -- The ledger is append-only for the API roles.
  select string_agg(grantee || '.' || privilege_type, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'application_attempts'
    and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
    and privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE');
  if offending is not null then
    raise exception 'application_attempts is not append-only (%)', offending;
  end if;

  -- service_role reads but never writes these tables.
  select string_agg(table_name || '.' || privilege_type, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = any(all_tables)
    and grantee = 'service_role' and privilege_type <> 'SELECT';
  if offending is not null then
    raise exception 'service_role holds more than SELECT: %', offending;
  end if;

  -- Every UPDATE policy carries WITH CHECK, or a user could hand a row away.
  select count(*) into n from pg_policies
  where schemaname = 'public' and tablename = any(all_tables)
    and cmd = 'UPDATE' and with_check is null;
  if n > 0 then
    raise exception '% UPDATE policies lack WITH CHECK', n;
  end if;

  -- applications: select/insert/update = 3; attempts: select/insert = 2.
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = any(all_tables);
  if n <> 5 then
    raise exception 'expected 5 policies across the application tables, found %', n;
  end if;

  -- Guard triggers attached.
  select string_agg(t, ', ') into offending
  from unnest(array[
    'applications_set_row_timestamps', 'applications_zz_status_transition',
    'application_attempts_immutable', 'application_attempts_set_created_at'
  ]) t
  where not exists (select 1 from pg_trigger where tgname = t and not tgisinternal);
  if offending is not null then
    raise exception 'missing triggers: %', offending;
  end if;

  -- The aggregate view must be security_invoker. Without it the view runs as
  -- postgres (BYPASSRLS) and any grantee would read across all users.
  if not exists (
    select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname = 'application_stats_by_user'
      and c.reloptions @> array['security_invoker=true']
  ) then
    raise exception 'application_stats_by_user is not security_invoker';
  end if;

  -- and must not be readable by the browser roles.
  select string_agg(grantee, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'application_stats_by_user'
    and grantee in ('anon', 'authenticated', 'PUBLIC');
  if offending is not null then
    raise exception 'application_stats_by_user is reachable by: %', offending;
  end if;

  -- Project-wide rule: nothing in public may be SECURITY DEFINER or carry an
  -- unpinned search_path.
  select string_agg(p.proname, ', ') into offending
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and (p.prosecdef or p.proconfig is null
         or not (p.proconfig && array['search_path=""', 'search_path=']));
  if offending is not null then
    raise exception 'unsafe functions: %', offending;
  end if;

  raise notice 'Application tracking created: applications, application_attempts, stats view.';
end;
$$;
