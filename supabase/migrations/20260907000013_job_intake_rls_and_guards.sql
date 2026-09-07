-- Row Level Security, grants and integrity guards for the four job-intake
-- tables, following the template established by migration 7.
--
-- Same loop, same predicates, same revokes. The only departures are deliberate
-- and justified below: job_snapshots and job_events do not get an UPDATE
-- policy, because they are evidence rather than editable records.

-- ---------------------------------------------------------------------------
-- RLS, grants and policies
-- ---------------------------------------------------------------------------
do $$
declare
  target_table text;
  -- Tables the owner may fully manage.
  mutable_tables text[] := array['jobs', 'job_facts'];
  -- Append-only evidence: SELECT, INSERT and DELETE, but never UPDATE.
  append_only_tables text[] := array['job_snapshots'];
  -- Audit history: SELECT and INSERT only. No UPDATE, no DELETE.
  audit_tables text[] := array['job_events'];
  all_tables text[] := array['jobs', 'job_facts', 'job_snapshots', 'job_events'];
begin
  foreach target_table in array all_tables loop
    execute format('alter table public.%I enable row level security', target_table);
    execute format('alter table public.%I force row level security', target_table);

    -- Revoke first. Supabase's defaults hand `authenticated` ALL on new public
    -- tables, which includes TRUNCATE — and TRUNCATE is not subject to row
    -- security, so a signed-in user could otherwise empty a table for everyone.
    execute format('revoke all on public.%I from anon', target_table);
    execute format('revoke all on public.%I from public', target_table);
    execute format('revoke all on public.%I from authenticated', target_table);
    execute format('revoke all on public.%I from service_role', target_table);

    -- SELECT and INSERT are common to all four.
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
  end loop;

  -- UPDATE and DELETE for the tables that are genuinely editable.
  foreach target_table in array mutable_tables loop
    execute format('grant update, delete on public.%I to authenticated', target_table);
    execute format($p$
      create policy %I on public.%I
        for update to authenticated
        using ((select auth.uid()) = user_id)
        with check ((select auth.uid()) = user_id)
    $p$, target_table || '_update_own', target_table);
    execute format($p$
      create policy %I on public.%I
        for delete to authenticated
        using ((select auth.uid()) = user_id)
    $p$, target_table || '_delete_own', target_table);
  end loop;

  -- Snapshots: deletable (a user may erase stored page bodies) but never
  -- editable, so the evidence a fact was extracted from cannot be rewritten
  -- after the fact.
  foreach target_table in array append_only_tables loop
    execute format('grant delete on public.%I to authenticated', target_table);
    execute format($p$
      create policy %I on public.%I
        for delete to authenticated
        using ((select auth.uid()) = user_id)
    $p$, target_table || '_delete_own', target_table);
  end loop;

  -- Events: no UPDATE and no DELETE.
  --
  -- Decision, stated because the requirement asked for one: owners may NOT
  -- delete individual events. An audit trail a user can selectively prune is
  -- not an audit trail, and the later resolver-agent work depends on this log
  -- being a faithful record of who decided what. Erasure is still possible at
  -- the only granularity that is honest — deleting the account, or the job,
  -- removes the whole history by cascade, and a cascade is not subject to RLS.
  -- So the user retains a real right to erasure without gaining the ability to
  -- rewrite history.
  foreach target_table in array audit_tables loop
    null; -- SELECT and INSERT already granted above; nothing further.
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Timestamps
-- ---------------------------------------------------------------------------
-- Reuse the existing trigger rather than inventing a second convention. It
-- stamps created_at/updated_at server-side and preserves created_at on UPDATE,
-- so a client cannot backdate a row. job_events has no updated_at and is
-- never updated, so it is excluded.
do $$
declare
  target_table text;
begin
  foreach target_table in array array['jobs', 'job_snapshots', 'job_facts'] loop
    execute format(
      'create trigger %I before insert or update on public.%I for each row execute function public.set_row_timestamps()',
      target_table || '_set_row_timestamps', target_table);
  end loop;
end;
$$;

-- job_events only has created_at, so it gets a minimal stamp of its own.
create or replace function public.set_event_created_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.created_at := now();
  -- occurred_at may be supplied by the caller (a client recording when
  -- something actually happened), but it can never be in the future, and it
  -- defaults to now() when omitted.
  if new.occurred_at is null or new.occurred_at > now() then
    new.occurred_at := now();
  end if;
  return new;
end;
$$;

comment on function public.set_event_created_at() is
  'BEFORE INSERT on job_events: stamps created_at server-side and clamps a '
  'future occurred_at to now.';

create trigger job_events_set_created_at
  before insert on public.job_events
  for each row execute function public.set_event_created_at();

revoke all on function public.set_event_created_at() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------
-- Snapshots and events are evidence. Withholding the UPDATE grant and policy
-- already stops the API roles, which is the threat that matters for user
-- isolation — but it stops ONLY those roles. `postgres` and `service_role`
-- carry BYPASSRLS, so a policy is not a boundary against them.
--
-- A trigger is therefore the primary mechanism here rather than the secondary
-- one: it refuses the UPDATE for every role, including the owner, which is the
-- only thing that makes "immutable" true rather than merely "immutable to
-- clients". The missing grant and policy remain as the outer layer.
create or replace function public.refuse_row_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'public.% rows are immutable and cannot be updated', tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

comment on function public.refuse_row_update() is
  'BEFORE UPDATE guard for append-only evidence tables. Raises for every role, '
  'including roles that bypass RLS.';

create trigger job_snapshots_immutable
  before update on public.job_snapshots
  for each row execute function public.refuse_row_update();

create trigger job_events_immutable
  before update on public.job_events
  for each row execute function public.refuse_row_update();

revoke all on function public.refuse_row_update() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Status transitions
-- ---------------------------------------------------------------------------
-- The legal-transition table lives here, in the database, because RLS lets a
-- client PATCH jobs.status directly through PostgREST without going near the
-- application. Enforcing transitions only in TypeScript would leave that door
-- open, which matters more than usual for a system that will be driven by
-- agents.
--
-- lib/jobs/state.ts mirrors this table for fast feedback, and
-- scripts/test-job-state-parity.mjs asserts the two are identical in both
-- directions — the same pattern already used for the invisible-character set.
create or replace function public.guard_job_status_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  legal constant text[] := array[
    -- from received
    'received>fetching', 'received>archived',
    -- fetching resolves one way or the other
    'fetching>fetched', 'fetching>fetch_failed',
    -- a fetched page can be extracted, re-fetched, or put aside
    'fetched>extracting', 'fetched>fetching', 'fetched>archived',
    -- a failed fetch may be retried or abandoned
    'fetch_failed>fetching', 'fetch_failed>archived',
    -- extraction resolves one way or the other
    'extracting>extracted', 'extracting>extraction_incomplete',
    -- extracted work can be redone against a fresh snapshot
    'extracted>extracting', 'extracted>fetching', 'extracted>archived',
    -- an incomplete extraction can be retried, re-fetched, or abandoned
    'extraction_incomplete>extracting', 'extraction_incomplete>fetching',
    'extraction_incomplete>archived'
  ];
begin
  if new.status = old.status then
    return new;  -- not a transition; nothing to validate
  end if;
  if not ((old.status || '>' || new.status) = any(legal)) then
    raise exception 'illegal job status transition: % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function public.guard_job_status_transition() is
  'BEFORE UPDATE on jobs: rejects status transitions outside the legal set. '
  'Mirrored by lib/jobs/state.ts, with a parity test asserting equality.';

-- Runs after the timestamp trigger (alphabetical within the same timing:
-- jobs_set_row_timestamps < jobs_zz_status_transition).
create trigger jobs_zz_status_transition
  before update on public.jobs
  for each row execute function public.guard_job_status_transition();

revoke all on function public.guard_job_status_transition() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Self-verification
-- ---------------------------------------------------------------------------
do $$
declare
  all_tables text[] := array['jobs', 'job_facts', 'job_snapshots', 'job_events'];
  target text;
  offending text;
  n integer;
begin
  -- RLS enabled AND forced on all four.
  select string_agg(t, ', ') into offending
  from unnest(all_tables) t
  where not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t and c.relrowsecurity and c.relforcerowsecurity
  );
  if offending is not null then
    raise exception 'RLS not enabled and forced on: %', offending;
  end if;

  -- Nothing for anon, PUBLIC or service_role.
  select string_agg(distinct grantee || ' on ' || table_name, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = any(all_tables)
    and grantee in ('anon', 'PUBLIC', 'service_role');
  if offending is not null then
    raise exception 'unexpected grants: %', offending;
  end if;

  -- authenticated must hold no privilege beyond DML.
  select string_agg(distinct privilege_type, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = any(all_tables)
    and grantee = 'authenticated'
    and privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE');
  if offending is not null then
    raise exception 'authenticated holds more than DML: %', offending;
  end if;

  -- Evidence tables must have no UPDATE grant at all.
  foreach target in array array['job_snapshots', 'job_events'] loop
    if exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = target
        and grantee = 'authenticated' and privilege_type = 'UPDATE'
    ) then
      raise exception '% must not grant UPDATE', target;
    end if;
  end loop;

  -- job_events must have no DELETE grant either.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'job_events'
      and grantee = 'authenticated' and privilege_type = 'DELETE'
  ) then
    raise exception 'job_events must not grant DELETE';
  end if;

  -- Every UPDATE policy carries WITH CHECK.
  select count(*) into n from pg_policies
  where schemaname = 'public' and tablename = any(all_tables)
    and cmd = 'UPDATE' and with_check is null;
  if n > 0 then
    raise exception '% UPDATE policies lack WITH CHECK', n;
  end if;

  -- Expected policy count: 2 mutable tables x 4, 1 append-only x 3, 1 audit x 2.
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = any(all_tables);
  if n <> 13 then
    raise exception 'expected 13 policies on the job tables, found %', n;
  end if;

  -- The guard triggers must actually be attached.
  foreach target in array array['job_snapshots_immutable', 'job_events_immutable', 'jobs_zz_status_transition'] loop
    if not exists (select 1 from pg_trigger where tgname = target and not tgisinternal) then
      raise exception 'trigger % is missing', target;
    end if;
  end loop;

  -- No function THIS MIGRATION SET owns may be SECURITY DEFINER or carry an
  -- unpinned search_path. Scoped by name: a hosted Supabase project also carries
  -- platform-installed helpers (`rls_auto_enable` among them) which are not ours
  -- to audit or revoke. See migration 7 for the full reasoning.
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

  raise notice 'Job intake RLS, grants and guards verified.';
end;
$$;
