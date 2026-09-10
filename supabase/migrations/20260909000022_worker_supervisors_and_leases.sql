-- Local worker: supervisors, slots, automation tasks, leases and events.
--
-- The minimum schema for ONE candidate-owned supervisor running ONE active
-- slot, shaped so that ten slots need no migration later. Nothing here starts
-- a process; this is where a worker's claims are checked.
--
-- Five user-owned tables, following migration 12/13 exactly: user_id on every
-- table keyed straight to auth.users, RLS enabled AND forced, revoke-then-grant,
-- and the same one-line ownership predicate rather than a join.
--
-- WHY THE HARD RULES ARE HERE AND NOT ONLY IN TYPESCRIPT
--
-- RLS lets a signed-in client PATCH these tables straight through PostgREST
-- without touching lib/agent. A TypeScript-only rule would therefore be
-- advisory, and the rules below are not advisory — they are what stops two
-- slots submitting one application, or a laptop that woke from sleep finishing
-- a task somebody else has already finished:
--
--   * one active lease per task          (partial unique index)
--   * one active lease per slot          (partial unique index)
--   * a fence token that only increases  (trigger)
--   * a lease that expires after it starts, and never past a hard ceiling
--   * a revoked supervisor's slots cannot hold a lease
--   * task status transitions from a fixed table that MIRRORS
--     lib/agent/state-machine.ts, checked for parity by an offline test
--
-- NOTHING HERE STORES A CREDENTIAL. Not an OpenRouter key, not a Claude
-- session, not a worker token, not a browser cookie. A supervisor authenticates
-- with the candidate's own Supabase session; browser_context_id is an opaque
-- local label, deliberately not a path or a profile reference.

-- ---------------------------------------------------------------------------
-- worker_supervisors — one local process, on the candidate's own machine
-- ---------------------------------------------------------------------------
create table public.worker_supervisors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- A coarse bucket, not a fingerprint.
  platform text not null
    constraint worker_supervisors_platform_allowed
    check (platform in ('windows', 'macos', 'linux')),

  -- The build, so an old protocol can be refused.
  agent_version text not null
    constraint worker_supervisors_version_shape
    check (agent_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),

  -- The ceiling this install intends to run. Ten is the design maximum; the
  -- runtime in this milestone uses exactly one.
  declared_slots integer not null default 1
    constraint worker_supervisors_declared_slots_range
    check (declared_slots between 1 and 10),

  -- Process lifecycle. Mirrors SUPERVISOR_LIFECYCLE_STATES.
  lifecycle text not null default 'offline'
    constraint worker_supervisors_lifecycle_allowed
    check (lifecycle in ('offline', 'starting', 'running', 'stopping')),

  -- Registration revocation. A candidate can disown a machine — a lost laptop,
  -- a rebuilt one — and a revoked supervisor may never lease anything again.
  -- Kept rather than deleted so its audit trail survives.
  revoked_at timestamptz,
  revoked_reason text
    constraint worker_supervisors_revoked_reason_allowed
    check (revoked_reason is null or revoked_reason in (
      'candidate_requested', 'kill_switch', 'superseded', 'suspected_compromise'
    )),

  last_heartbeat_at timestamptz,
  heartbeat_sequence bigint not null default 0
    constraint worker_supervisors_sequence_non_negative check (heartbeat_sequence >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A revoked supervisor names why; an active one does not.
  constraint worker_supervisors_revocation_complete
    check ((revoked_at is null) = (revoked_reason is null)),
  -- A revoked supervisor is not running.
  constraint worker_supervisors_revoked_is_not_running
    check (revoked_at is null or lifecycle in ('offline', 'stopping')),
  -- An offline supervisor has not just sent a heartbeat claiming otherwise.
  constraint worker_supervisors_version_length check (length(agent_version) <= 40)
);

-- ---------------------------------------------------------------------------
-- worker_slots — one isolated browser context; the unit that does the work
-- ---------------------------------------------------------------------------
create table public.worker_slots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  supervisor_id uuid not null
    references public.worker_supervisors (id) on delete cascade,

  -- 1..10, unique within a supervisor. THIS is the uniqueness that stops slot
  -- 3 and slot 7 being the same row after a reconnect.
  slot_index integer not null
    constraint worker_slots_index_range check (slot_index between 1 and 10),

  -- Declared per slot, because a browser context is what determines whether a
  -- file upload works. An empty array would be a slot that can do nothing.
  capabilities text[] not null default array['form_fill']::text[]
    constraint worker_slots_capabilities_known
    check (
      array_length(capabilities, 1) between 1 and 3
      and capabilities <@ array['form_fill', 'file_upload', 'confirmation_capture']::text[]
    ),

  -- An opaque local label. NOT a path, NOT a profile directory, NOT a
  -- reference to stored browser credentials.
  browser_context_id text not null
    constraint worker_slots_context_shape check (browser_context_id ~ '^[A-Za-z0-9_-]{1,64}$'),

  -- Mirrors SLOT_READINESS_STATES.
  readiness text not null default 'initializing'
    constraint worker_slots_readiness_allowed
    check (readiness in (
      'initializing', 'ready', 'working', 'paused', 'stopping', 'stopped', 'crashed'
    )),

  -- Mirrors WORKER_PAUSE_REASONS. Present exactly when paused.
  pause_reason text
    constraint worker_slots_pause_reason_allowed
    check (pause_reason is null or pause_reason in (
      'employer_authentication_required', 'claude_authentication_required',
      'captcha_detected', 'anti_bot_challenge_detected', 'mfa_required',
      'sensitive_information_requested', 'unknown_page', 'unknown_question',
      'unsupported_site', 'control_plane_paused'
    )),

  -- Mirrors WORKER_STOP_REASONS. Present exactly when stopping or stopped.
  stop_reason text
    constraint worker_slots_stop_reason_allowed
    check (stop_reason is null or stop_reason in (
      'candidate_requested', 'kill_switch', 'supervisor_shutdown', 'slot_crashed',
      'lease_lost', 'protocol_violation', 'update_required'
    )),

  -- Session states the slot depends on. Four values, because `not_applicable`
  -- is a real answer: openrouter_only has no Claude session to report on.
  employer_session text not null default 'unknown'
    constraint worker_slots_employer_session_allowed
    check (employer_session in ('authenticated', 'not_authenticated', 'unknown')),
  claude_session text not null default 'not_applicable'
    constraint worker_slots_claude_session_allowed
    check (claude_session in (
      'authenticated', 'not_authenticated', 'unknown', 'not_applicable'
    )),

  last_heartbeat_at timestamptz,
  heartbeat_sequence bigint not null default 0
    constraint worker_slots_sequence_non_negative check (heartbeat_sequence >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One slot number per supervisor. Re-registering slot 1 updates this row
  -- rather than creating a second one, which is what makes registration
  -- idempotent for a laptop that reconnects forty times a day.
  constraint worker_slots_one_index_per_supervisor unique (supervisor_id, slot_index),

  -- A paused slot names its reason; nothing else carries one.
  constraint worker_slots_pause_reason_iff_paused
    check ((readiness = 'paused') = (pause_reason is not null)),
  -- A stopping or stopped slot names its reason. A crashed one does not: it
  -- was not asked to stop, which is precisely the distinction.
  constraint worker_slots_stop_reason_iff_stopping
    check ((readiness in ('stopping', 'stopped')) = (stop_reason is not null))
);

-- ---------------------------------------------------------------------------
-- automation_tasks — one unit of work against one job
-- ---------------------------------------------------------------------------
create table public.automation_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null references public.jobs (id) on delete cascade,

  -- Mirrors AGENT_STATES in lib/agent/state-machine.ts. The legal transitions
  -- are enforced by guard_automation_task_transition() below, and
  -- scripts/check-migrations-offline.mjs asserts the two tables are identical
  -- in both directions — so this is the SAME state machine expressed twice,
  -- not a second one.
  status text not null default 'received'
    constraint automation_tasks_status_allowed
    check (status in (
      'received', 'validated', 'snapshot_stored', 'normalized', 'scored',
      'rejected', 'queued', 'leased', 'processing', 'manual_review',
      'ready_to_submit', 'submitted', 'failed', 'duplicate', 'cancelled'
    )),

  mode text not null
    constraint automation_tasks_mode_allowed
    check (mode in ('openrouter_only', 'claude_max_assisted')),

  -- The only thing standing between a retry and a second real application.
  idempotency_key text not null
    constraint automation_tasks_idempotency_shape
    check (idempotency_key ~ '^[A-Za-z0-9_.:-]{16,200}$'),
  correlation_id uuid not null,

  -- Counted, never reset. A retry increments it.
  attempt integer not null default 0
    constraint automation_tasks_attempt_non_negative check (attempt >= 0),
  max_attempts integer not null default 3
    constraint automation_tasks_max_attempts_range check (max_attempts between 1 and 10),

  -- THE FENCE. Increases on every lease of this task; a completion is accepted
  -- only from the current value. Enforced monotonic by trigger, because a
  -- fence that can go backwards is not a fence.
  fence_token bigint not null default 0
    constraint automation_tasks_fence_non_negative check (fence_token >= 0),

  -- Whether a person had to act. Set when any capability routed to the paste
  -- console, so a completion rate cannot silently count hand-done work as
  -- unattended automation.
  candidate_assisted boolean not null default false,

  finished_at timestamptz,
  outcome text
    constraint automation_tasks_outcome_allowed
    check (outcome is null or outcome in (
      'submitted', 'submission_unknown', 'manual_review',
      'failed', 'paused', 'cancelled', 'duplicate'
    )),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint automation_tasks_attempt_within_max check (attempt <= max_attempts),
  -- A task has an outcome exactly when it has finished.
  constraint automation_tasks_outcome_iff_finished
    check ((finished_at is null) = (outcome is null)),
  -- One task per idempotency key per candidate. A redelivered queue message
  -- collides here rather than becoming a second application.
  constraint automation_tasks_one_per_idempotency_key unique (user_id, idempotency_key)
);

-- ---------------------------------------------------------------------------
-- task_leases — the right for ONE slot to work ONE task until ONE instant
-- ---------------------------------------------------------------------------
create table public.task_leases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid not null references public.automation_tasks (id) on delete cascade,

  -- The lease belongs to the SLOT, not the supervisor. A supervisor-scoped
  -- lease would let slot 3 complete the task slot 7 holds.
  slot_id uuid not null references public.worker_slots (id) on delete cascade,

  -- The value of automation_tasks.fence_token at the moment of leasing.
  fence_token bigint not null
    constraint task_leases_fence_positive check (fence_token >= 1),

  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Set when the lease ends for any reason. NULL means "currently held", and
  -- the partial unique indexes below key off exactly that.
  released_at timestamptz,
  release_reason text
    constraint task_leases_release_reason_allowed
    check (release_reason is null or release_reason in (
      'completed', 'failed', 'paused', 'expired', 'revoked', 'superseded', 'released'
    )),

  created_at timestamptz not null default now(),

  constraint task_leases_expires_after_acquired check (expires_at > acquired_at),
  -- A lease cannot be held forever by renewing. One hour from acquisition,
  -- matching MAX_TOTAL_LEASE_SECONDS in lib/agent/worker-state.ts.
  constraint task_leases_bounded_life
    check (expires_at <= acquired_at + interval '1 hour'),
  constraint task_leases_release_complete
    check ((released_at is null) = (release_reason is null)),
  constraint task_leases_released_after_acquired
    check (released_at is null or released_at >= acquired_at)
);

-- ONE ACTIVE LEASE PER TASK. The single most important index in this file: it
-- is what makes "two slots working the same application" impossible rather
-- than merely unlikely.
create unique index task_leases_one_active_per_task
  on public.task_leases (task_id) where released_at is null;

-- ONE ACTIVE TASK PER SLOT. A slot with two leases would be running two
-- applications through one browser context.
create unique index task_leases_one_active_per_slot
  on public.task_leases (slot_id) where released_at is null;

create index task_leases_by_user_active
  on public.task_leases (user_id, expires_at) where released_at is null;
create index worker_slots_by_supervisor on public.worker_slots (supervisor_id);
create index automation_tasks_by_user_status on public.automation_tasks (user_id, status);
create index automation_tasks_by_job on public.automation_tasks (job_id);

-- ---------------------------------------------------------------------------
-- worker_events — append-only audit
-- ---------------------------------------------------------------------------
create table public.worker_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- Every reference is ON DELETE SET NULL: the audit trail must outlive the
  -- rows it describes, or "what happened to that application" becomes
  -- unanswerable the moment a job is removed.
  supervisor_id uuid references public.worker_supervisors (id) on delete set null,
  slot_id uuid references public.worker_slots (id) on delete set null,
  task_id uuid references public.automation_tasks (id) on delete set null,

  kind text not null
    constraint worker_events_kind_allowed
    check (kind in (
      'supervisor_registered', 'supervisor_revoked', 'supervisor_heartbeat',
      'slot_registered', 'slot_heartbeat', 'slot_paused', 'slot_stopped', 'slot_crashed',
      'lease_acquired', 'lease_renewed', 'lease_expired', 'lease_released', 'lease_refused',
      'task_started', 'task_paused', 'task_completed', 'task_failed',
      'local_claude_used', 'local_claude_unavailable', 'manual_fallback_used'
    )),

  -- Short scalars only. Deliberately not jsonb-of-anything: an unconstrained
  -- payload is where a job description, a prompt or page content eventually
  -- lands, and this table is read by support.
  detail jsonb not null default '{}'::jsonb
    constraint worker_events_detail_is_object check (jsonb_typeof(detail) = 'object')
    constraint worker_events_detail_bounded check (length(detail::text) <= 2000),

  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index worker_events_by_user_time on public.worker_events (user_id, occurred_at desc);
create index worker_events_by_task on public.worker_events (task_id) where task_id is not null;

-- ---------------------------------------------------------------------------
-- RLS, grants and policies — the migration 7 / 13 template
-- ---------------------------------------------------------------------------
do $$
declare
  target_table text;
  mutable_tables text[] := array['worker_supervisors', 'worker_slots', 'automation_tasks'];
  append_only_tables text[] := array['task_leases'];
  -- worker_events is deliberately absent from every list below the first:
  -- it takes SELECT and INSERT and nothing else. See the note at the end.
  all_tables text[] := array[
    'worker_supervisors', 'worker_slots', 'automation_tasks', 'task_leases', 'worker_events'
  ];
begin
  foreach target_table in array all_tables loop
    execute format('alter table public.%I enable row level security', target_table);
    execute format('alter table public.%I force row level security', target_table);

    -- Revoke first: Supabase hands `authenticated` ALL on new public tables,
    -- and that includes TRUNCATE, which row security does not restrain.
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
  end loop;

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

  -- Leases: UPDATE is granted (renewal and release both write here) but DELETE
  -- is not. A lease is evidence that a slot held a task at a time, and a
  -- candidate who could delete one could erase the record of an application
  -- having been attempted.
  foreach target_table in array append_only_tables loop
    execute format('grant update on public.%I to authenticated', target_table);
    execute format($p$
      create policy %I on public.%I
        for update to authenticated
        using ((select auth.uid()) = user_id)
        with check ((select auth.uid()) = user_id)
    $p$, target_table || '_update_own', target_table);
  end loop;

  -- worker_events gets SELECT and INSERT from the common loop above, and
  -- nothing more.
  --
  -- There is deliberately no loop for it. An audit row that its own subject
  -- can edit or delete is not an audit row, so the ABSENCE of an UPDATE and
  -- DELETE grant is the control. The self-verification below asserts both stay
  -- absent, and refuse_worker_event_update() refuses them as a second layer.
end $$;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- The fence only ever goes up.
--
-- A fence token that can be lowered is not a fence: a stale slot holding token
-- 4 becomes current again the moment someone writes 4 back. This is the rule
-- the whole stale-worker defence rests on.
create or replace function public.guard_fence_token_monotonic()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.fence_token < old.fence_token then
    raise exception 'fence_token may not decrease (% -> %)', old.fence_token, new.fence_token
      using errcode = 'check_violation';
  end if;
  -- Attempts are counted, never reset.
  if new.attempt < old.attempt then
    raise exception 'attempt may not decrease (% -> %)', old.attempt, new.attempt
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_fence_token_monotonic() from public, anon, authenticated, service_role;

create trigger automation_tasks_fence_monotonic
  before update on public.automation_tasks
  for each row execute function public.guard_fence_token_monotonic();

-- A revoked supervisor's slots may not acquire a lease.
--
-- Checked in the database because revocation is the control a candidate
-- reaches for when a machine is lost or compromised, and a control that a
-- compromised machine could ignore by not asking is not a control.
create or replace function public.guard_lease_supervisor_active()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  revoked timestamptz;
  slot_owner uuid;
begin
  select s.revoked_at, w.user_id into revoked, slot_owner
  from public.worker_slots w
  join public.worker_supervisors s on s.id = w.supervisor_id
  where w.id = new.slot_id;

  if not found then
    raise exception 'lease references an unknown slot' using errcode = 'foreign_key_violation';
  end if;
  if revoked is not null then
    raise exception 'a revoked supervisor may not hold a lease' using errcode = 'check_violation';
  end if;
  -- Ownership is checked here as well as by RLS: a lease that crossed
  -- candidates would be one person's worker touching another's application.
  if slot_owner <> new.user_id then
    raise exception 'lease and slot belong to different candidates' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_lease_supervisor_active() from public, anon, authenticated, service_role;

create trigger task_leases_supervisor_active
  before insert on public.task_leases
  for each row execute function public.guard_lease_supervisor_active();

-- A released lease stays released.
--
-- Un-releasing a lease would revive a slot's authority to finish a task that
-- has already been handed to someone else.
create or replace function public.guard_lease_release_final()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.released_at is not null and new.released_at is null then
    raise exception 'a released lease may not be reopened' using errcode = 'check_violation';
  end if;
  if old.fence_token <> new.fence_token then
    raise exception 'a lease fence token is fixed at acquisition' using errcode = 'check_violation';
  end if;
  if old.task_id <> new.task_id or old.slot_id <> new.slot_id then
    raise exception 'a lease may not be reassigned' using errcode = 'check_violation';
  end if;
  -- Renewal extends; it never revives. An expired lease has already returned
  -- to the queue and been re-leased under a higher token.
  if old.released_at is null and old.expires_at <= now() and new.expires_at > old.expires_at then
    raise exception 'an expired lease may not be renewed' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_lease_release_final() from public, anon, authenticated, service_role;

create trigger task_leases_release_final
  before update on public.task_leases
  for each row execute function public.guard_lease_release_final();

-- Task status transitions.
--
-- THIS TABLE MIRRORS lib/agent/state-machine.ts. It is not a second state
-- machine: scripts/check-migrations-offline.mjs parses the array below and
-- asserts it matches TRANSITIONS exactly in both directions, so the two cannot
-- drift without a failing test.
create or replace function public.guard_automation_task_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  allowed text[];
begin
  if new.status = old.status then
    return new;
  end if;

  allowed := case old.status
    when 'received'        then array['validated', 'rejected', 'duplicate', 'cancelled']
    when 'validated'       then array['snapshot_stored', 'failed', 'cancelled']
    when 'snapshot_stored' then array['normalized', 'failed', 'cancelled']
    when 'normalized'      then array['scored', 'rejected', 'failed', 'cancelled']
    when 'scored'          then array['queued', 'rejected', 'cancelled']
    when 'rejected'        then array[]::text[]
    when 'queued'          then array['leased', 'cancelled', 'duplicate']
    when 'leased'          then array['processing', 'queued', 'failed', 'cancelled']
    when 'processing'      then array['manual_review', 'ready_to_submit', 'failed', 'queued', 'cancelled']
    when 'manual_review'   then array['ready_to_submit', 'cancelled', 'failed']
    when 'ready_to_submit' then array['submitted', 'manual_review', 'failed', 'cancelled']
    when 'submitted'       then array[]::text[]
    when 'failed'          then array['queued', 'manual_review', 'cancelled']
    when 'duplicate'       then array[]::text[]
    when 'cancelled'       then array[]::text[]
    else array[]::text[]
  end;

  if not (new.status = any(allowed)) then
    raise exception 'illegal task transition % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_automation_task_transition() from public, anon, authenticated, service_role;

create trigger automation_tasks_status_transition
  before update on public.automation_tasks
  for each row execute function public.guard_automation_task_transition();

-- Events are append-only — with ONE exception, and it is not optional.
--
-- THE BUG THIS AVOIDS, WHICH HAS BEEN SHIPPED HERE ONCE BEFORE
--
-- The three references above are ON DELETE SET NULL, so the audit trail
-- outlives the rows it describes. A referential action is ordinary SQL and
-- FIRES TRIGGERS: deleting a supervisor issues `update worker_events set
-- supervisor_id = null`. A blanket refusal therefore does not merely protect
-- the audit trail — it makes deleting a supervisor impossible, and because
-- worker_supervisors cascades from auth.users, IT BREAKS ACCOUNT DELETION
-- ENTIRELY. `provider_usage` shipped exactly this defect in an earlier
-- milestone and CI caught it there too.
--
-- So the FK detach is permitted, and precisely nothing else: every other
-- column must be byte-identical, and a reference may only go to null, never
-- from one value to another.
--
-- DELETE is not refused here at all. worker_events holds no DELETE grant, so
-- no client can issue one; the cascade from auth.users must still work, and a
-- trigger that blocked it would leave rows no one could remove.
create or replace function public.refuse_worker_event_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'supervisor_id' - 'slot_id' - 'task_id')
     = (to_jsonb(old) - 'supervisor_id' - 'slot_id' - 'task_id')
     and (new.supervisor_id is null or new.supervisor_id = old.supervisor_id)
     and (new.slot_id is null or new.slot_id = old.slot_id)
     and (new.task_id is null or new.task_id = old.task_id)
  then
    return new;
  end if;
  raise exception 'worker_events is append-only' using errcode = 'check_violation';
end;
$$;
revoke all on function public.refuse_worker_event_update() from public, anon, authenticated, service_role;

create trigger worker_events_append_only
  before update on public.worker_events
  for each row execute function public.refuse_worker_event_update();

-- ---------------------------------------------------------------------------
-- Self-verification. This migration ABORTS rather than leaving the schema
-- half-secured, following migrations 7 and 13.
-- ---------------------------------------------------------------------------
do $$
declare
  all_tables text[] := array[
    'worker_supervisors', 'worker_slots', 'automation_tasks', 'task_leases', 'worker_events'
  ];
  target text;
  offending text;
  n integer;
begin
  -- RLS enabled AND forced everywhere.
  foreach target in array all_tables loop
    if not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relname = target
        and c.relrowsecurity and c.relforcerowsecurity
    ) then
      raise exception '% does not have RLS enabled and forced', target;
    end if;
  end loop;

  -- No grants to anon, PUBLIC or service_role.
  select string_agg(distinct grantee, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = any(all_tables)
    and grantee in ('anon', 'PUBLIC', 'service_role');
  if offending is not null then
    raise exception 'unexpected grants: %', offending;
  end if;

  -- authenticated holds nothing beyond DML.
  select string_agg(distinct privilege_type, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = any(all_tables)
    and grantee = 'authenticated'
    and privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE');
  if offending is not null then
    raise exception 'authenticated holds more than DML: %', offending;
  end if;

  -- The audit table takes no UPDATE and no DELETE grant.
  foreach target in array array['worker_events'] loop
    if exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = target
        and grantee = 'authenticated' and privilege_type in ('UPDATE', 'DELETE')
    ) then
      raise exception '% must not grant UPDATE or DELETE', target;
    end if;
  end loop;

  -- Leases are never deletable.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'task_leases'
      and grantee = 'authenticated' and privilege_type = 'DELETE'
  ) then
    raise exception 'task_leases must not grant DELETE';
  end if;

  -- Every UPDATE policy carries WITH CHECK.
  select count(*) into n from pg_policies
  where schemaname = 'public' and tablename = any(all_tables)
    and cmd = 'UPDATE' and with_check is null;
  if n > 0 then
    raise exception '% UPDATE policies lack WITH CHECK', n;
  end if;

  -- 3 mutable x 4 + 1 lease table x 3 + 1 audit x 2 = 17.
  select count(*) into n from pg_policies
  where schemaname = 'public' and tablename = any(all_tables);
  if n <> 17 then
    raise exception 'expected 17 policies, found %', n;
  end if;

  -- The two partial unique indexes that make double-work impossible.
  foreach target in array array[
    'task_leases_one_active_per_task', 'task_leases_one_active_per_slot'
  ] loop
    if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = target) then
      raise exception 'missing index %', target;
    end if;
  end loop;

  -- The slot uniqueness constraint.
  if not exists (
    select 1 from pg_constraint
    where conname = 'worker_slots_one_index_per_supervisor'
  ) then
    raise exception 'missing worker_slots_one_index_per_supervisor';
  end if;
end $$;
