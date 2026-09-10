-- Candidate profile drafting: a second task kind, and a bounded home for the
-- draft it produces.
--
-- WHY THE TASK TABLE IS EXTENDED RATHER THAN DUPLICATED
--
-- `task_leases.task_id` references `automation_tasks`, so a separate task table
-- would need its own leases, its own fence tokens and its own expiry — a second
-- copy of the most security-sensitive machinery in this system. The task stays
-- where the leases are. Only the PAYLOAD moves, into `profile_drafts`, because
-- a résumé-shaped blob has no business widening a table that currently holds
-- nothing but scalars.
--
-- See docs/PROFILE-DRAFTING-DESIGN.md for the options considered.
--
-- WHAT DOES NOT CHANGE
--
-- `kind` defaults to `job_application`, so every existing row and every
-- existing insert keeps its exact meaning. The transition table in migration 22
-- is NOT re-declared here: it remains the single authority, and
-- scripts/test-agent-state-parity.mjs still checks it against
-- lib/agent/state-machine.ts. The new rule is a separate trigger, additive and
-- independently auditable.

-- ---------------------------------------------------------------------------
-- 1. The task kind, and a job_id that is required exactly when it means
--    something.
-- ---------------------------------------------------------------------------
alter table public.automation_tasks
  add column kind text not null default 'job_application'
    constraint automation_tasks_kind_allowed
    check (kind in ('job_application', 'candidate_profile_drafting'));

alter table public.automation_tasks
  alter column job_id drop not null;

/*
 * THE INVARIANT IS TIGHTER THAN IT WAS, NOT LOOSER.
 *
 * Before this migration a task could point at a job it had no use for, and
 * nothing said so. Now a job application cannot exist without a job AND a
 * profile draft cannot carry one — the two directions of one biconditional.
 */
alter table public.automation_tasks
  add constraint automation_tasks_job_iff_job_application
  check ((kind = 'job_application') = (job_id is not null));

/*
 * A PROFILE DRAFT CAN NEVER REACH A SUBMISSION STATE.
 *
 * Layer one: a CHECK, so it holds for every writer including a superuser and
 * including a migration written by someone who has forgotten why.
 */
alter table public.automation_tasks
  add constraint automation_tasks_profile_never_submits
  check (
    kind <> 'candidate_profile_drafting'
    or status not in ('ready_to_submit', 'submitted')
  );

/*
 * Layer two: a trigger, so the refusal NAMES the reason. A constraint
 * violation says a row is invalid; this says which rule was broken and why,
 * which is what a reader of the logs needs at three in the morning.
 *
 * It also freezes `kind`. A task that could change kind after creation could
 * be laundered from a profile draft into a job application, and the CHECK
 * above would then permit exactly what it exists to forbid.
 */
create or replace function public.guard_automation_task_kind()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  if tg_op = 'UPDATE' and new.kind is distinct from old.kind then
    raise exception 'a task kind is fixed at creation (% -> %)', old.kind, new.kind
      using errcode = 'check_violation';
  end if;

  if new.kind = 'candidate_profile_drafting'
     and new.status in ('ready_to_submit', 'submitted')
  then
    raise exception
      'a candidate_profile_drafting task may not reach %; drafting stops at manual_review',
      new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

revoke all on function public.guard_automation_task_kind()
  from public, anon, authenticated, service_role;

create trigger automation_tasks_kind_guard
  before insert or update on public.automation_tasks
  for each row execute function public.guard_automation_task_kind();

-- ---------------------------------------------------------------------------
-- 2. The draft itself.
--
-- WHAT THIS TABLE MUST NEVER HOLD: a raw prompt, a raw model response, an API
-- key, a cookie, or unbounded résumé text. `input` carries validated facts that
-- already live in `resume_imports.extracted` plus a snapshot of the profile
-- fields a draft may touch. `result` carries the validated draft. Both are
-- bounded by a CHECK rather than by a convention.
-- ---------------------------------------------------------------------------
create table public.profile_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid not null references public.automation_tasks (id) on delete cascade,

  -- Which facts it was drafted from. ON DELETE SET NULL so a deleted import
  -- does not erase the record that a draft happened.
  resume_import_id uuid references public.resume_imports (id) on delete set null,

  /*
   * OPTIMISTIC CONCURRENCY. `profiles.updated_at` as it was when the task was
   * created. Confirmation re-reads it and refuses if the candidate has edited
   * their profile in the meantime, so a draft written against an old profile
   * cannot silently overwrite newer work.
   */
  profile_version timestamptz not null,

  status text not null default 'pending'
    constraint profile_drafts_status_allowed
    check (status in ('pending', 'drafted', 'confirmed', 'rejected', 'expired')),

  input jsonb not null
    constraint profile_drafts_input_is_object check (jsonb_typeof(input) = 'object')
    constraint profile_drafts_input_bounded check (length(input::text) <= 16000),

  result jsonb
    constraint profile_drafts_result_is_object
    check (result is null or jsonb_typeof(result) = 'object')
    constraint profile_drafts_result_bounded
    check (result is null or length(result::text) <= 16000),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  expires_at timestamptz not null default now() + interval '7 days',

  -- A drafted or confirmed row HAS a draft; a pending one does not.
  constraint profile_drafts_result_iff_drafted
    check ((status in ('drafted', 'confirmed')) = (result is not null)),
  -- A reviewed row says when.
  constraint profile_drafts_reviewed_complete
    check ((status in ('confirmed', 'rejected')) = (reviewed_at is not null)),
  constraint profile_drafts_expires_after_creation check (expires_at > created_at)
);

-- One live draft per task. A second would mean two answers to one question.
create unique index profile_drafts_one_live_per_task
  on public.profile_drafts (task_id)
  where status in ('pending', 'drafted');

create index profile_drafts_by_user on public.profile_drafts (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. RLS and grants — the migration 7/13/22 template, with column-level UPDATE.
--
-- A candidate may read their drafts, create one, and REVIEW one. Reviewing
-- means setting `status` and `reviewed_at` and nothing else: the draft itself
-- is written by the worker boundary, and a browser that could edit `result`
-- could put words in the model's mouth.
-- ---------------------------------------------------------------------------
alter table public.profile_drafts enable row level security;
alter table public.profile_drafts force row level security;

revoke all on public.profile_drafts from anon, public, authenticated, service_role;

grant select on public.profile_drafts to authenticated;
grant insert on public.profile_drafts to authenticated;
grant update (status, reviewed_at) on public.profile_drafts to authenticated;

create policy profile_drafts_select_own on public.profile_drafts
  for select to authenticated using ((select auth.uid()) = user_id);
create policy profile_drafts_insert_own on public.profile_drafts
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy profile_drafts_update_own on public.profile_drafts
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create trigger profile_drafts_touch
  before update on public.profile_drafts
  for each row execute function public.set_row_timestamps();

-- ---------------------------------------------------------------------------
-- 4. The claim now says WHAT it handed over.
--
-- The arguments do not change. The RETURN gains `claimed_kind`, because a
-- worker that cannot tell which kind of task it claimed cannot act on it — and
-- the alternative, a kind ARGUMENT, would let the caller choose, which is
-- exactly what this boundary refuses everywhere else.
--
-- Dropped and recreated because PostgreSQL cannot change a function's return
-- type in place.
-- ---------------------------------------------------------------------------
drop function if exists public.worker_claim_task(uuid, text);

create or replace function public.worker_claim_task(
  p_credential_id uuid,
  p_token_hash text
)
returns table (
  ok boolean,
  reason text,
  claimed_task_id uuid,
  claimed_lease_id uuid,
  claimed_fence bigint,
  claimed_lease_expires_at timestamptz,
  claimed_kind text,
  /*
   * THE WORK ITSELF, FOR THE KINDS THAT HAVE ANY.
   *
   * Null for a job application. For a profile draft it is
   * `profile_drafts.input` — validated résumé facts and a snapshot of the
   * twelve fields a draft may touch — which the table bounds to 16 000
   * characters, so the claim response stays bounded too.
   *
   * Returned here rather than through a second endpoint because the
   * alternative was a ninth definer function and another round trip to read a
   * row this transaction has already located.
   */
  claimed_input jsonb
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_cred record;
  v_stale public.task_leases%rowtype;
  v_task public.automation_tasks%rowtype;
  v_fence bigint;
  v_lease uuid;
  v_expires timestamptz;
  v_input jsonb;
  v_now timestamptz := now();
begin
  select * into v_cred from public.worker_resolve_credential(p_credential_id, p_token_hash);
  if not v_cred.ok then
    return query select false, v_cred.reason, null::uuid, null::uuid, null::bigint,
      null::timestamptz, null::text, null::jsonb;
    return;
  end if;
  if v_cred.cred_slot_id is null then
    return query select false, 'no_slot'::text, null::uuid, null::uuid, null::bigint,
      null::timestamptz, null::text, null::jsonb;
    return;
  end if;

  -- The slot lock is what makes this atomic: the losers of a race read the
  -- winner's committed lease and leave with `slot_busy`, having written
  -- nothing.
  perform 1 from public.worker_slots
   where id = v_cred.cred_slot_id and user_id = v_cred.cred_user_id
     for update;

  -- Reclaim a dead lease first: both uniqueness indexes are on unreleased
  -- rows, so an expired one still occupies the slot and its task.
  update public.task_leases
     set released_at = v_now, release_reason = 'expired'
   where slot_id = v_cred.cred_slot_id
     and released_at is null
     and expires_at <= v_now
  returning * into v_stale;

  if found then
    insert into public.worker_events (user_id, supervisor_id, slot_id, task_id, kind, detail)
    values (v_cred.cred_user_id, v_cred.cred_supervisor_id, v_cred.cred_slot_id,
            v_stale.task_id, 'lease_expired', '{}'::jsonb);

    update public.automation_tasks
       set status = 'queued'
     where id = v_stale.task_id
       and user_id = v_cred.cred_user_id
       and status in ('leased', 'processing');
  end if;

  if exists (
    select 1 from public.task_leases
    where slot_id = v_cred.cred_slot_id and released_at is null
  ) then
    return query select false, 'slot_busy'::text, null::uuid, null::uuid, null::bigint,
      null::timestamptz, null::text, null::jsonb;
    return;
  end if;

  select * into v_task
  from public.automation_tasks
  where user_id = v_cred.cred_user_id and status = 'queued'
  order by created_at
  limit 1
  for update skip locked;

  if not found then
    return query select false, 'no_task_available'::text, null::uuid, null::uuid, null::bigint,
      null::timestamptz, null::text, null::jsonb;
    return;
  end if;

  if v_task.attempt >= v_task.max_attempts then
    return query select false, 'attempts_exhausted'::text, null::uuid, null::uuid, null::bigint,
      null::timestamptz, null::text, null::jsonb;
    return;
  end if;

  update public.automation_tasks
     set status = 'leased',
         fence_token = fence_token + 1,
         attempt = attempt + 1
   where id = v_task.id
  returning fence_token into v_fence;

  update public.automation_tasks set status = 'processing' where id = v_task.id;

  v_expires := v_now + interval '2 minutes';
  insert into public.task_leases (user_id, task_id, slot_id, fence_token, expires_at)
  values (v_cred.cred_user_id, v_task.id, v_cred.cred_slot_id, v_fence, v_expires)
  returning id into v_lease;

  insert into public.worker_events (user_id, supervisor_id, slot_id, task_id, kind, detail)
  values (v_cred.cred_user_id, v_cred.cred_supervisor_id, v_cred.cred_slot_id, v_task.id,
          'lease_acquired', jsonb_build_object('fence', v_fence));
  insert into public.worker_events (user_id, supervisor_id, slot_id, task_id, kind, detail)
  values (v_cred.cred_user_id, v_cred.cred_supervisor_id, v_cred.cred_slot_id, v_task.id,
          'task_started', jsonb_build_object('fence', v_fence, 'kind', v_task.kind));

  -- The draft input, for the kind that has one. A job application has none.
  if v_task.kind = 'candidate_profile_drafting' then
    select d.input into v_input
    from public.profile_drafts d
    where d.task_id = v_task.id and d.user_id = v_cred.cred_user_id and d.status = 'pending';
  end if;

  return query select true, 'claimed'::text, v_task.id, v_lease, v_fence, v_expires,
    v_task.kind, v_input;
end;
$fn$;

revoke all on function public.worker_claim_task(uuid, text) from public, anon, authenticated;
grant execute on function public.worker_claim_task(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Storing the draft.
--
-- One narrow operation, in one transaction: validate the credential, take the
-- lease's lock, check the fence by equality, require the task to BE a profile
-- draft, bound the payload, store it, move the task to `manual_review`,
-- release the lease, and record what happened.
--
-- It cannot write a submission status — `manual_review` is a literal here, and
-- the trigger above would refuse anything else for this kind anyway. It cannot
-- choose a candidate: the owner comes from the credential. It cannot set
-- provenance or verification: it writes `profile_drafts.result` and nothing in
-- any profile table.
-- ---------------------------------------------------------------------------
create or replace function public.worker_submit_profile_draft(
  p_credential_id uuid,
  p_token_hash text,
  p_fence_token bigint,
  p_draft jsonb
)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_cred record;
  v_lease public.task_leases%rowtype;
  v_task public.automation_tasks%rowtype;
  v_draft public.profile_drafts%rowtype;
  v_now timestamptz := now();
begin
  if p_fence_token is null or p_fence_token < 1
     or p_draft is null or jsonb_typeof(p_draft) <> 'object'
     or length(p_draft::text) > 16000
  then
    return query select false, 'malformed_request'::text;
    return;
  end if;

  select * into v_cred from public.worker_resolve_credential(p_credential_id, p_token_hash);
  if not v_cred.ok then
    return query select false, v_cred.reason;
    return;
  end if;
  if v_cred.cred_slot_id is null then
    return query select false, 'no_slot'::text;
    return;
  end if;

  select * into v_lease
  from public.task_leases
  where slot_id = v_cred.cred_slot_id and released_at is null
    for update;

  if not found then
    return query select false, 'no_active_lease'::text;
    return;
  end if;
  if v_lease.fence_token <> p_fence_token then
    return query select false, 'stale_fence'::text;
    return;
  end if;
  if v_lease.expires_at <= v_now then
    return query select false, 'lease_expired'::text;
    return;
  end if;

  select * into v_task
  from public.automation_tasks
  where id = v_lease.task_id and user_id = v_cred.cred_user_id
    for update;

  if not found or v_task.status not in ('leased', 'processing') then
    return query select false, 'task_not_active'::text;
    return;
  end if;
  -- A job application has no draft to submit, and this is the only thing that
  -- writes `profile_drafts`.
  if v_task.kind <> 'candidate_profile_drafting' then
    return query select false, 'wrong_task_kind'::text;
    return;
  end if;

  select * into v_draft
  from public.profile_drafts
  where task_id = v_task.id and user_id = v_cred.cred_user_id and status = 'pending'
    for update;

  if not found then
    return query select false, 'no_pending_draft'::text;
    return;
  end if;

  update public.profile_drafts
     set result = p_draft, status = 'drafted'
   where id = v_draft.id;

  -- `manual_review` is where a worker stops. A person continues from there.
  update public.automation_tasks set status = 'manual_review' where id = v_task.id;

  update public.task_leases
     set released_at = v_now, release_reason = 'completed'
   where id = v_lease.id;

  insert into public.worker_events (user_id, supervisor_id, slot_id, task_id, kind, detail)
  values (v_cred.cred_user_id, v_cred.cred_supervisor_id, v_cred.cred_slot_id, v_task.id,
          'lease_released',
          jsonb_build_object('fence', v_lease.fence_token, 'disposition', 'completed'));
  insert into public.worker_events (user_id, supervisor_id, slot_id, task_id, kind, detail)
  values (v_cred.cred_user_id, v_cred.cred_supervisor_id, v_cred.cred_slot_id, v_task.id,
          'task_completed', jsonb_build_object('fence', v_lease.fence_token));

  return query select true, 'drafted'::text;
end;
$fn$;

revoke all on function public.worker_submit_profile_draft(uuid, text, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.worker_submit_profile_draft(uuid, text, bigint, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Self-verification.
-- ---------------------------------------------------------------------------
do $$
declare
  all_definers text[] := array[
    'worker_claim_task', 'worker_record_heartbeat', 'worker_redeem_pairing',
    'worker_renew_lease', 'worker_report_task', 'worker_resolve_credential',
    'worker_revoke_supervisor', 'worker_submit_profile_draft'
  ];
  service_callable text[] := array[
    'worker_claim_task', 'worker_record_heartbeat', 'worker_redeem_pairing',
    'worker_renew_lease', 'worker_report_task', 'worker_submit_profile_draft'
  ];
  browser_callable text[] := array['worker_revoke_supervisor'];
  target text;
  p pg_proc%rowtype;
  offending text;
  worker_tables text[] := array[
    'worker_supervisors', 'worker_slots', 'automation_tasks', 'task_leases',
    'worker_events', 'worker_pairings', 'worker_credentials', 'profile_drafts'
  ];
begin
  foreach target in array all_definers loop
    select pr.* into p
    from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
    where n.nspname = 'public' and pr.proname = target;

    if not found then
      raise exception '% is missing', target;
    end if;
    if not p.prosecdef then
      raise exception '% is not security definer', target;
    end if;
    if p.proconfig is null or not exists (
      select 1 from unnest(p.proconfig) entry
      where entry = 'search_path=' or entry = 'search_path=""'
        or entry = 'search_path='''''
    ) then
      raise exception '% does not pin search_path', target;
    end if;
    if p.prosrc ~* '\mexecute\M' then
      raise exception '% contains dynamic SQL', target;
    end if;
    if p.proacl is null then
      raise exception '% still holds default privileges', target;
    end if;
    if exists (select 1 from unnest(p.proacl) item where item::text like '=%') then
      raise exception '% is executable by PUBLIC', target;
    end if;
    if has_function_privilege('anon', p.oid, 'EXECUTE') then
      raise exception '% is executable by anon', target;
    end if;
    if has_function_privilege('service_role', p.oid, 'EXECUTE')
       <> (target = any(service_callable)) then
      raise exception '% has the wrong service_role EXECUTE grant', target;
    end if;
    if has_function_privilege('authenticated', p.oid, 'EXECUTE')
       <> (target = any(browser_callable)) then
      raise exception '% has the wrong authenticated EXECUTE grant', target;
    end if;
  end loop;

  select string_agg(pr.proname, ', ') into offending
  from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
  where n.nspname = 'public' and pr.prosecdef and not (pr.proname = any(all_definers));
  if offending is not null then
    raise exception 'unexpected SECURITY DEFINER function(s): %', offending;
  end if;

  -- NO NEW TABLE GRANT FOR service_role, including on the new table.
  select string_agg(distinct table_name || ':' || privilege_type, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('worker_supervisors', 'worker_slots', 'automation_tasks',
                       'task_leases', 'worker_events', 'profile_drafts')
    and grantee = 'service_role';
  if offending is not null then
    raise exception 'service_role gained a table grant: %', offending;
  end if;

  /*
   * TWO VIEWS, BECAUSE THERE ARE TWO KINDS OF GRANT.
   *
   * `role_table_grants` lists TABLE-level privileges. A column-level
   * `grant update (status, reviewed_at)` does not appear there at all — which
   * is what the first version of this assertion got wrong, and why this
   * migration refused to apply until someone read the error.
   *
   * At table level the browser holds SELECT and INSERT and no UPDATE: it may
   * not rewrite a draft wholesale. The UPDATE it does hold is column-level and
   * reaches exactly the two review columns.
   */
  select string_agg(privilege_type, ', ') into offending
  from (
    select distinct privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'profile_drafts'
      and grantee = 'authenticated'
    order by privilege_type
  ) s;
  if offending is distinct from 'INSERT, SELECT' then
    raise exception 'profile_drafts table grants to authenticated are wrong: %', offending;
  end if;

  select string_agg(column_name, ', ') into offending
  from (
    select distinct column_name
    from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'profile_drafts'
      and grantee = 'authenticated' and privilege_type = 'UPDATE'
    order by column_name
  ) s;
  if offending is distinct from 'reviewed_at, status' then
    raise exception 'the profile_drafts review columns are wrong: %',
      coalesce(offending, 'none');
  end if;

  foreach target in array worker_tables loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = target
        and c.relrowsecurity and c.relforcerowsecurity
    ) then
      raise exception '% lost RLS', target;
    end if;
  end loop;

  -- The two constraints that carry this milestone's safety property.
  foreach target in array array[
    'automation_tasks_job_iff_job_application',
    'automation_tasks_profile_never_submits',
    'automation_tasks_kind_allowed'
  ] loop
    if not exists (select 1 from pg_constraint where conname = target) then
      raise exception 'missing constraint %', target;
    end if;
  end loop;

  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'automation_tasks'
      and t.tgname = 'automation_tasks_kind_guard'
  ) then
    raise exception 'the task-kind guard is not attached';
  end if;

  /*
   * NO WORKER PATH TO SUBMISSION. Comments stripped first: they discuss those
   * statuses at length, and a scan that flagged its own explanation would have
   * to be deleted.
   */
  select string_agg(pr.proname, ', ') into offending
  from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
  where n.nspname = 'public' and pr.proname = any(service_callable)
    and regexp_replace(
          regexp_replace(pr.prosrc, '/\*.*?\*/', '', 'gs'),
          '--[^' || chr(10) || ']*', '', 'g'
        ) ~ '(ready_to_submit|''submitted'')';
  if offending is not null then
    raise exception 'a worker-callable function can write a submission status: %', offending;
  end if;
end $$;
