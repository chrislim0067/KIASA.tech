-- Fixes review finding M1: system timestamps and provenance were client-forgeable.
--
-- Before this migration an ordinary authenticated user could INSERT a row with
-- created_at = '2000-01-01' (proven: the value was stored verbatim), and could
-- claim source = 'agent_drafted_user_approved' with a back-dated verified_at.
-- That made the audit trail of the agent's "verified memory" self-asserted,
-- which is precisely what it must not be.
--
-- Two triggers close it. Both are SECURITY INVOKER with an empty search_path,
-- so neither can be used to escalate privilege.

-- ---------------------------------------------------------------------------
-- 1. System timestamps
-- ---------------------------------------------------------------------------
-- Replaces set_updated_at(), which only fired BEFORE UPDATE and therefore left
-- INSERT wide open. Handles both operations so the columns are never taken from
-- the client on any path.
create or replace function public.set_row_timestamps()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
  else
    -- created_at is immutable once written; whatever the client sent is discarded.
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

comment on function public.set_row_timestamps() is
  'BEFORE INSERT OR UPDATE: stamps created_at/updated_at from the server clock. '
  'Client-supplied values are always discarded.';

-- Swap every table over, then retire the update-only function.
do $$
declare
  target_table text;
  candidate_tables text[] := array[
    'profiles', 'job_preferences', 'automation_settings', 'work_authorizations',
    'work_experiences', 'education_entries', 'skills', 'certifications',
    'projects', 'languages', 'verified_answers'
  ];
begin
  foreach target_table in array candidate_tables loop
    execute format('drop trigger if exists %I on public.%I', target_table || '_set_updated_at', target_table);
    execute format(
      'create trigger %I before insert or update on public.%I for each row execute function public.set_row_timestamps()',
      target_table || '_set_row_timestamps', target_table);
  end loop;
end;
$$;

drop function if exists public.set_updated_at();

-- Trigger functions need no EXECUTE grant: the privilege is checked when the
-- trigger is created (as the owner), not when it fires. Established by testing
-- in Step 2C. Default privileges from migration 8 already grant nothing, but be
-- explicit so a future default change cannot silently open it.
revoke all on function public.set_row_timestamps() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Trusted provenance on verified_answers
-- ---------------------------------------------------------------------------
-- `source` records HOW an answer came to exist. Two of its values assert that a
-- server-side workflow ran:
--
--   user_entered                 the person typed it            <- client may set
--   imported_from_resume         an import pipeline produced it <- trusted only
--   agent_drafted_user_approved  the agent drafted, user approved <- trusted only
--
-- "Trusted" here means: not the browser. PostgREST executes as the `authenticated`
-- role, so the guard is simply that `authenticated` (and `anon`) may only write
-- user_entered. Any other role — the database owner running a migration, or a
-- future server-only worker connecting as a dedicated role — may write the
-- trusted values.
--
-- This introduces no new credential and nothing new is exposed to the browser.
-- It closes the door now; whatever server-side identity later walks through it
-- is a separate, explicit decision.
--
-- is_verified stays client-writable on purpose: the user approving their own
-- answer is the whole point of the feature. What they cannot do is choose WHEN
-- that approval happened — verified_at is stamped here, so a back-dated
-- verification is impossible.
create or replace function public.guard_verified_answer_provenance()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  api_roles constant text[] := array['anon', 'authenticated'];
  trusted_sources constant text[] := array['imported_from_resume', 'agent_drafted_user_approved'];
begin
  if current_user = any(api_roles) then
    if new.source = any(trusted_sources) then
      raise exception
        'source "%" is reserved for server-side workflows and cannot be set by an API client', new.source
        using errcode = 'insufficient_privilege';
    end if;

    -- Preserve provenance already recorded by a trusted writer: an API client
    -- must not be able to overwrite an agent-sourced row and relabel it.
    if tg_op = 'UPDATE' and old.source = any(trusted_sources) and new.source <> old.source then
      raise exception 'source of a server-recorded answer cannot be changed by an API client'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- verified_at is derived from is_verified, never taken from the client.
  if new.is_verified then
    if tg_op = 'INSERT' or not old.is_verified then
      new.verified_at := now();          -- moment of approval
    else
      new.verified_at := old.verified_at; -- already approved; keep the original
    end if;
  else
    new.verified_at := null;
  end if;

  return new;
end;
$$;

comment on function public.guard_verified_answer_provenance() is
  'BEFORE INSERT OR UPDATE on verified_answers: reserves trusted source values '
  'for non-API roles and stamps verified_at server-side.';

-- Runs after the timestamp trigger (alphabetical order within the same timing:
-- verified_answers_set_row_timestamps < verified_answers_zz_provenance).
create trigger verified_answers_zz_provenance
  before insert or update on public.verified_answers
  for each row execute function public.guard_verified_answer_provenance();

revoke all on function public.guard_verified_answer_provenance() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Self-verification
-- ---------------------------------------------------------------------------
do $$
declare
  missing text;
begin
  select string_agg(t, ', ') into missing
  from unnest(array[
    'profiles', 'job_preferences', 'automation_settings', 'work_authorizations',
    'work_experiences', 'education_entries', 'skills', 'certifications',
    'projects', 'languages', 'verified_answers'
  ]) as t
  where not exists (
    select 1 from pg_trigger g
    join pg_class c on c.oid = g.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t
      and g.tgname = t || '_set_row_timestamps' and not g.tgisinternal
  );
  if missing is not null then
    raise exception 'Timestamp trigger missing on: %', missing;
  end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'set_updated_at') then
    raise exception 'The update-only timestamp function should have been dropped';
  end if;

  raise notice 'Timestamp and provenance guards installed on 11 tables.';
end;
$$;
