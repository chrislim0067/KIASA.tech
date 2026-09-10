-- The one-slot worker task lifecycle: claim, renew, report — and the pause
-- semantics migration 26 could not express.
--
-- WHAT THIS ADDS, AND WHAT IT DELIBERATELY CANNOT DO
--
-- Migration 26 gave a paired worker exactly two capabilities: redeem an
-- invitation, and report a heartbeat. It could not touch a task, because
-- `service_role` holds nothing on `automation_tasks`, `task_leases` or
-- `worker_events` and migration 22 asserts that absence. That invariant is not
-- relaxed here. Three more `security definer` functions are added, each doing
-- one protocol operation, each executable by `service_role` and nobody else.
--
-- THE ONE RULE EVERYTHING ELSE SERVES: a worker cannot cause an application to
-- be submitted. `automation_tasks` has `ready_to_submit` and `submitted`, and
-- NO function below writes either. The furthest a worker can move a task is
-- `manual_review`, which means a person must look at it. See
-- docs/WORKER-TASK-PROTOCOL.md.
--
-- OWNERSHIP IS STILL NEVER A PARAMETER. No function takes a candidate,
-- supervisor, slot, task or lease id. A worker presents its credential id, the
-- hash of the token minted for it, and — where staleness matters — the fence
-- number it was given. Everything else is read from the row that pair matches.
--
-- WHY THERE IS NO GENERIC EVENT WRITER. A worker cannot ask for an event to be
-- recorded; it performs an operation and the operation records what happened,
-- in the same transaction, with the kind as a literal in the function body and
-- `detail` built from bounded scalars. An "insert this event" RPC would be a
-- free-text channel into a table support staff read.

-- ---------------------------------------------------------------------------
-- 0. Credential resolution, shared by every operation below.
--
-- SECURITY DEFINER but granted to NOBODY. Inside another definer function the
-- current user is the owner, which holds EXECUTE implicitly, so these can call
-- it; PostgREST cannot, because `service_role` has no grant on it. That is the
-- whole reason it is safe to factor this out: one place to audit, and no new
-- reachable surface.
-- ---------------------------------------------------------------------------
create or replace function public.worker_resolve_credential(
  p_credential_id uuid,
  p_token_hash text
)
returns table (
  ok boolean,
  reason text,
  cred_user_id uuid,
  cred_supervisor_id uuid,
  cred_slot_id uuid
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_cred public.worker_credentials%rowtype;
  v_supervisor public.worker_supervisors%rowtype;
  v_now timestamptz := now();
begin
  if p_credential_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return query select false, 'malformed_request'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- The id names a row; the hash proves the caller holds the token that row
  -- was minted for. Both must match.
  select * into v_cred
  from public.worker_credentials
  where id = p_credential_id and token_hash = p_token_hash;

  if not found then
    return query select false, 'not_found'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if v_cred.revoked_at is not null then
    return query select false, 'revoked'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if v_cred.expires_at <= v_now then
    return query select false, 'expired'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if v_cred.audience <> 'kiasa-worker' or v_cred.scope <> 'slot:heartbeat' then
    return query select false, 'out_of_scope'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  select * into v_supervisor
  from public.worker_supervisors
  where id = v_cred.supervisor_id and user_id = v_cred.user_id;

  if not found then
    return query select false, 'not_found'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- A disowned machine may do nothing at all, however live its credential.
  if v_supervisor.revoked_at is not null then
    return query select false, 'revoked'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  return query select true, 'ok'::text, v_cred.user_id, v_cred.supervisor_id, v_cred.slot_id;
end;
$fn$;

revoke all on function public.worker_resolve_credential(uuid, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Heartbeat, replacing migration 26's — now carrying the reason.
--
-- Migration 26 refused `paused` outright and INVENTED `supervisor_shutdown`
-- for `stopped`, because the heartbeat had no reason field. A fiction in an
-- audit trail is worse than a refusal, so the reason now travels with the
-- state and the two "iff" constraints in migration 22 become explicit rules
-- rather than a contradiction.
--
-- The old five-argument form is DROPPED rather than left as an overload: two
-- functions of the same name, one of which quietly invents reasons, is exactly
-- the sort of thing that survives a review.
-- ---------------------------------------------------------------------------
drop function if exists public.worker_record_heartbeat(uuid, text, bigint, text, text);

create or replace function public.worker_record_heartbeat(
  p_credential_id uuid,
  p_token_hash text,
  p_sequence bigint,
  p_lifecycle text,
  p_readiness text,
  p_reason text
)
returns table (ok boolean, reason text, applied boolean)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_cred record;
  v_supervisor public.worker_supervisors%rowtype;
  v_slot public.worker_slots%rowtype;
  v_now timestamptz := now();
  v_pause text;
  v_stop text;
  v_kind text;
begin
  if p_sequence is null or p_sequence < 0
     or p_lifecycle is null or p_lifecycle not in ('offline', 'starting', 'running', 'stopping')
     or p_readiness is null or p_readiness not in (
       'initializing', 'ready', 'working', 'paused', 'stopping', 'stopped', 'crashed'
     )
  then
    return query select false, 'malformed_request'::text, false;
    return;
  end if;

  /*
   * THE PAUSE AND STOP RULES, STATED ONCE.
   *
   * `worker_slots_pause_reason_iff_paused` and
   * `worker_slots_stop_reason_iff_stopping` require reason and state to move
   * together in BOTH directions: a paused slot must name a reason, and a slot
   * that is not paused must not carry one. So a heartbeat that reports `ready`
   * clears whatever was there, atomically with the state — there is no window
   * in which a stale reason survives a resume.
   *
   * The vocabularies are migration 22's own CHECK lists, mirrored by
   * WORKER_PAUSE_REASONS and WORKER_STOP_REASONS in lib/agent/contracts.ts.
   * No free text is accepted from a worker, here or anywhere.
   */
  /*
   * AN ABSENT REASON ARRIVES AS THE EMPTY STRING.
   *
   * `supabase gen types` cannot see that a text parameter is nullable — the
   * catalogue does not record it — so the generated Args type says
   * `p_reason: string` and a null would not typecheck at the call site. The
   * alternatives were an unsafe cast, which hides a real question, or a
   * DEFAULT, which changes the generated signature again for a property the
   * database does not enforce either way.
   *
   * So the store sends '' for "no reason", and both spellings are treated
   * identically here. '' is not a member of either vocabulary, so it can never
   * be mistaken for a real reason: every branch below still refuses it.
   */
  if p_readiness = 'paused' then
    if coalesce(p_reason, '') = '' or p_reason not in (
      'employer_authentication_required', 'claude_authentication_required',
      'captcha_detected', 'anti_bot_challenge_detected', 'mfa_required',
      'sensitive_information_requested', 'unknown_page', 'unknown_question',
      'unsupported_site', 'control_plane_paused'
    ) then
      return query select false, 'pause_reason_required'::text, false;
      return;
    end if;
    v_pause := p_reason;
    v_stop := null;
  elsif p_readiness in ('stopping', 'stopped') then
    if coalesce(p_reason, '') = '' or p_reason not in (
      'candidate_requested', 'kill_switch', 'supervisor_shutdown', 'slot_crashed',
      'lease_lost', 'protocol_violation', 'update_required'
    ) then
      return query select false, 'stop_reason_required'::text, false;
      return;
    end if;
    v_pause := null;
    v_stop := p_reason;
  else
    -- initializing, ready, working, crashed: neither column may be set, and a
    -- reason sent anyway is a protocol error rather than something to ignore.
    if coalesce(p_reason, '') <> '' then
      return query select false, 'unexpected_reason'::text, false;
      return;
    end if;
    v_pause := null;
    v_stop := null;
  end if;

  select * into v_cred from public.worker_resolve_credential(p_credential_id, p_token_hash);
  if not v_cred.ok then
    return query select false, v_cred.reason, false;
    return;
  end if;

  select * into v_supervisor
  from public.worker_supervisors where id = v_cred.cred_supervisor_id;

  /*
   * MONOTONIC BY SEQUENCE. A duplicate delivery, or a retry that overtakes
   * what it was retrying, must not move a worker's state backwards — a crashed
   * slot showing as `working` would leave its task leased. Accepted, applied
   * to nothing, and no event written: this is the bounded-rate rule that keeps
   * a worker beating every thirty seconds from filling the audit table.
   */
  if p_sequence <= v_supervisor.heartbeat_sequence then
    return query select true, 'stale_sequence'::text, false;
    return;
  end if;

  update public.worker_supervisors
     set heartbeat_sequence = p_sequence,
         last_heartbeat_at = v_now,
         lifecycle = p_lifecycle
   where id = v_supervisor.id;

  if v_cred.cred_slot_id is not null then
    select * into v_slot from public.worker_slots
     where id = v_cred.cred_slot_id and user_id = v_cred.cred_user_id
       for update;

    if found then
      update public.worker_slots
         set heartbeat_sequence = p_sequence,
             last_heartbeat_at = v_now,
             readiness = p_readiness,
             pause_reason = v_pause,
             stop_reason = v_stop
       where id = v_slot.id;

      /*
       * AN EVENT ON TRANSITION ONLY. A slot that beats every thirty seconds
       * for a day is 2,880 heartbeats and zero event rows unless something
       * actually changed.
       */
      if v_slot.readiness is distinct from p_readiness then
        v_kind := case p_readiness
          when 'paused' then 'slot_paused'
          when 'stopping' then 'slot_stopped'
          when 'stopped' then 'slot_stopped'
          when 'crashed' then 'slot_crashed'
          else 'slot_heartbeat'
        end;
        insert into public.worker_events
          (user_id, supervisor_id, slot_id, kind, detail)
        values (
          v_cred.cred_user_id, v_supervisor.id, v_slot.id, v_kind,
          case when coalesce(p_reason, '') = '' then '{}'::jsonb
               else jsonb_build_object('reason', p_reason)
          end
        );
      end if;
    end if;
  end if;

  return query select true, 'applied'::text, true;
end;
$fn$;

revoke all on function public.worker_record_heartbeat(uuid, text, bigint, text, text, text)
  from public, anon, authenticated;
grant execute on function public.worker_record_heartbeat(uuid, text, bigint, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. Claim one approved task.
--
-- The worker names no task. It asks for work, and the function hands it the
-- oldest task the CREDENTIAL'S OWN candidate has approved — `queued` is the
-- approval gate, reached by the intake pipeline and the candidate, never by a
-- worker. A worker that could name a task id could probe for other people's.
-- ---------------------------------------------------------------------------
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
  claimed_lease_expires_at timestamptz
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
  v_now timestamptz := now();
begin
  select * into v_cred from public.worker_resolve_credential(p_credential_id, p_token_hash);
  if not v_cred.ok then
    return query select false, v_cred.reason, null::uuid, null::uuid, null::bigint, null::timestamptz;
    return;
  end if;
  if v_cred.cred_slot_id is null then
    return query select false, 'no_slot'::text, null::uuid, null::uuid, null::bigint, null::timestamptz;
    return;
  end if;

  /*
   * THE SLOT LOCK IS WHAT MAKES THIS ATOMIC.
   *
   * `task_leases_one_active_per_slot` would refuse a second lease anyway — but
   * as a constraint violation, which aborts the transaction and returns a 500
   * after the task has already been moved. Serialising on the slot row instead
   * means the losers of a race READ the winner's committed lease and leave
   * with a clean `slot_busy`, having written nothing.
   */
  perform 1 from public.worker_slots
   where id = v_cred.cred_slot_id and user_id = v_cred.cred_user_id
     for update;

  /*
   * RECLAIM A DEAD LEASE FIRST.
   *
   * Both uniqueness indexes are `where released_at is null`, so an expired but
   * unreleased lease still occupies the slot and the task. Without this a
   * crashed worker would wedge its own slot until a human intervened.
   */
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
    return query select false, 'slot_busy'::text, null::uuid, null::uuid, null::bigint, null::timestamptz;
    return;
  end if;

  /*
   * ONLY `queued`, and only this candidate's. `skip locked` keeps two claims
   * from queueing behind one another for a task the first will take anyway.
   */
  select * into v_task
  from public.automation_tasks
  where user_id = v_cred.cred_user_id and status = 'queued'
  order by created_at
  limit 1
  for update skip locked;

  if not found then
    return query select false, 'no_task_available'::text, null::uuid, null::uuid, null::bigint, null::timestamptz;
    return;
  end if;

  -- `automation_tasks_attempt_within_max` would raise; refusing cleanly keeps
  -- an exhausted task from turning every claim into a 500.
  if v_task.attempt >= v_task.max_attempts then
    return query select false, 'attempts_exhausted'::text, null::uuid, null::uuid, null::bigint, null::timestamptz;
    return;
  end if;

  -- The fence only ever rises; `guard_fence_token_monotonic` enforces it.
  update public.automation_tasks
     set status = 'leased',
         fence_token = fence_token + 1,
         attempt = attempt + 1
   where id = v_task.id
  returning fence_token into v_fence;

  /*
   * `leased` exists for a scheduler that hands work out before a slot picks it
   * up. One slot has no scheduler: the claim IS the start, so both transitions
   * happen under the same lock and the task is never observably leased with
   * nobody working it.
   */
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
          'task_started', jsonb_build_object('fence', v_fence));

  return query select true, 'claimed'::text, v_task.id, v_lease, v_fence, v_expires;
end;
$fn$;

revoke all on function public.worker_claim_task(uuid, text) from public, anon, authenticated;
grant execute on function public.worker_claim_task(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Renew the lease.
--
-- The fence is the only thing the worker sends that is not derived from its
-- credential, and it is checked by EQUALITY: a worker holding fence 4 after
-- the task was re-leased at 5 is stale, and guessing 6 is refused as loudly as
-- presenting 4.
-- ---------------------------------------------------------------------------
create or replace function public.worker_renew_lease(
  p_credential_id uuid,
  p_token_hash text,
  p_fence_token bigint
)
returns table (ok boolean, reason text, renewed_expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_cred record;
  v_lease public.task_leases%rowtype;
  v_now timestamptz := now();
  v_target timestamptz;
begin
  if p_fence_token is null or p_fence_token < 1 then
    return query select false, 'malformed_request'::text, null::timestamptz;
    return;
  end if;

  select * into v_cred from public.worker_resolve_credential(p_credential_id, p_token_hash);
  if not v_cred.ok then
    return query select false, v_cred.reason, null::timestamptz;
    return;
  end if;
  if v_cred.cred_slot_id is null then
    return query select false, 'no_slot'::text, null::timestamptz;
    return;
  end if;

  select * into v_lease
  from public.task_leases
  where slot_id = v_cred.cred_slot_id and released_at is null
    for update;

  if not found then
    return query select false, 'no_active_lease'::text, null::timestamptz;
    return;
  end if;
  if v_lease.fence_token <> p_fence_token then
    return query select false, 'stale_fence'::text, null::timestamptz;
    return;
  end if;
  -- `guard_lease_release_final` refuses to extend an expired lease. Refusing
  -- here first turns that into a status rather than a 500.
  if v_lease.expires_at <= v_now then
    return query select false, 'lease_expired'::text, null::timestamptz;
    return;
  end if;

  /*
   * `task_leases_bounded_life` caps expiry at one hour from ACQUISITION, so a
   * lease can be renewed but never carried past that. A task needing longer
   * must be released and re-claimed — an hour of silence is not a worker that
   * is still working.
   */
  v_target := least(v_now + interval '2 minutes', v_lease.acquired_at + interval '1 hour');

  if v_target <= v_lease.expires_at then
    return query select true, 'lease_capped'::text, v_lease.expires_at;
    return;
  end if;

  update public.task_leases set expires_at = v_target where id = v_lease.id;

  insert into public.worker_events (user_id, supervisor_id, slot_id, task_id, kind, detail)
  values (v_cred.cred_user_id, v_cred.cred_supervisor_id, v_cred.cred_slot_id, v_lease.task_id,
          'lease_renewed', jsonb_build_object('fence', v_lease.fence_token));

  return query select true, 'renewed'::text, v_target;
end;
$fn$;

revoke all on function public.worker_renew_lease(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.worker_renew_lease(uuid, text, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Report how the task went, and release the lease.
--
-- Three dispositions, and NEITHER submission status is among them:
--
--   completed → the task moves to `manual_review`. A person continues from
--               there. This is as far as a worker can take an application.
--   failed    → the task moves to `failed`, with a reason drawn from
--               migration 22's own pause-reason vocabulary.
--   released  → the task returns to `queued` for another attempt.
-- ---------------------------------------------------------------------------
create or replace function public.worker_report_task(
  p_credential_id uuid,
  p_token_hash text,
  p_fence_token bigint,
  p_disposition text,
  p_reason text
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
  v_now timestamptz := now();
  v_release text;
begin
  if p_fence_token is null or p_fence_token < 1
     or p_disposition is null or p_disposition not in ('completed', 'failed', 'released')
  then
    return query select false, 'malformed_request'::text;
    return;
  end if;

  /*
   * A FAILURE NAMES A CAUSE, AND ONLY FROM THE ALLOWED LIST. The vocabulary is
   * migration 22's `worker_slots_pause_reason_allowed` — the situations that
   * actually stop automation. A success or a release carries no reason, and
   * sending one is a protocol error rather than something to ignore.
   */
  if p_disposition = 'failed' then
    if coalesce(p_reason, '') = '' or p_reason not in (
      'employer_authentication_required', 'claude_authentication_required',
      'captcha_detected', 'anti_bot_challenge_detected', 'mfa_required',
      'sensitive_information_requested', 'unknown_page', 'unknown_question',
      'unsupported_site', 'control_plane_paused'
    ) then
      return query select false, 'failure_reason_required'::text;
      return;
    end if;
  elsif coalesce(p_reason, '') <> '' then
    return query select false, 'unexpected_reason'::text;
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

  -- A replayed report finds no active lease, because the first one released
  -- it. Refused, not repeated: the two are different facts.
  if not found then
    return query select false, 'no_active_lease'::text;
    return;
  end if;
  if v_lease.fence_token <> p_fence_token then
    return query select false, 'stale_fence'::text;
    return;
  end if;
  -- A stale worker may not mutate the task it has already lost.
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

  if p_disposition = 'completed' then
    -- `manual_review`, NOT `ready_to_submit`. Deciding that an application is
    -- ready to send is a candidate's judgement, and no worker or model makes
    -- it. There is no code path from here to `submitted`.
    update public.automation_tasks set status = 'manual_review' where id = v_task.id;
    v_release := 'completed';
  elsif p_disposition = 'failed' then
    -- `automation_tasks_outcome_iff_finished` requires the two together.
    update public.automation_tasks
       set status = 'failed', outcome = 'failed', finished_at = v_now
     where id = v_task.id;
    v_release := 'failed';
  else
    update public.automation_tasks set status = 'queued' where id = v_task.id;
    v_release := 'released';
  end if;

  update public.task_leases
     set released_at = v_now, release_reason = v_release
   where id = v_lease.id;

  insert into public.worker_events (user_id, supervisor_id, slot_id, task_id, kind, detail)
  values (v_cred.cred_user_id, v_cred.cred_supervisor_id, v_cred.cred_slot_id, v_task.id,
          'lease_released',
          jsonb_build_object('fence', v_lease.fence_token, 'disposition', p_disposition));

  if p_disposition = 'completed' then
    insert into public.worker_events (user_id, supervisor_id, slot_id, task_id, kind, detail)
    values (v_cred.cred_user_id, v_cred.cred_supervisor_id, v_cred.cred_slot_id, v_task.id,
            'task_completed', jsonb_build_object('fence', v_lease.fence_token));
  elsif p_disposition = 'failed' then
    insert into public.worker_events (user_id, supervisor_id, slot_id, task_id, kind, detail)
    values (v_cred.cred_user_id, v_cred.cred_supervisor_id, v_cred.cred_slot_id, v_task.id,
            'task_failed',
            jsonb_build_object('fence', v_lease.fence_token, 'reason', p_reason));
  end if;

  return query select true, p_disposition;
end;
$fn$;

revoke all on function public.worker_report_task(uuid, text, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.worker_report_task(uuid, text, bigint, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Self-verification. This migration ABORTS rather than leaving a boundary
-- wider than it claims to be.
-- ---------------------------------------------------------------------------
do $$
declare
  -- Every definer function that may exist, and the exact set service_role may
  -- execute. The resolver is deliberately in the first list and not the
  -- second: it is reachable only from inside another definer function.
  all_definers text[] := array[
    'worker_claim_task', 'worker_record_heartbeat', 'worker_redeem_pairing',
    'worker_renew_lease', 'worker_report_task', 'worker_resolve_credential'
  ];
  callable text[] := array[
    'worker_claim_task', 'worker_record_heartbeat', 'worker_redeem_pairing',
    'worker_renew_lease', 'worker_report_task'
  ];
  target text;
  p pg_proc%rowtype;
  offending text;
  worker_tables text[] := array[
    'worker_supervisors', 'worker_slots', 'automation_tasks', 'task_leases',
    'worker_events', 'worker_pairings', 'worker_credentials'
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
      raise exception '% does not pin search_path to the empty string: %',
        target, coalesce(array_to_string(p.proconfig, ','), 'unset');
    end if;
    if p.prosrc ~* '\mexecute\M' then
      raise exception '% contains dynamic SQL', target;
    end if;
    if has_function_privilege('authenticated', p.oid, 'EXECUTE')
       or has_function_privilege('anon', p.oid, 'EXECUTE')
    then
      raise exception '% is executable by a browser role', target;
    end if;
    if p.proacl is null then
      raise exception '% still holds default privileges, which grant EXECUTE to PUBLIC', target;
    end if;
    if exists (select 1 from unnest(p.proacl) item where item::text like '=%') then
      raise exception '% is executable by PUBLIC', target;
    end if;
    if not exists (
      select 1 from pg_roles r
      where r.oid = p.proowner and (r.rolsuper or r.rolbypassrls)
    ) then
      raise exception '% is owned by %, which cannot bypass forced RLS',
        target, (select rolname from pg_roles where oid = p.proowner);
    end if;

    -- service_role executes the five protocol operations and nothing else.
    if has_function_privilege('service_role', p.oid, 'EXECUTE') <> (target = any(callable)) then
      raise exception '% has the wrong service_role EXECUTE grant', target;
    end if;
  end loop;

  -- The old five-argument heartbeat is gone, not shadowed by an overload.
  if exists (
    select 1 from pg_proc p2 join pg_namespace n2 on n2.oid = p2.pronamespace
    where n2.nspname = 'public' and p2.proname = 'worker_record_heartbeat'
      and p2.pronargs <> 6
  ) then
    raise exception 'an old worker_record_heartbeat overload survives';
  end if;

  -- No definer function beyond the allow-list exists anywhere in public.
  /*
   * EVENT-TRIGGER FUNCTIONS ARE NOT PART OF THE SURFACE THIS POLICES.
   *
   * The predicate below used to read every SECURITY DEFINER function in
   * `public`. That holds on a pristine local database and is wrong on a hosted
   * project, which is the same lesson migration 7 already learned: a hosted
   * Supabase project carries `public.rls_auto_enable()`, owned by `postgres`,
   * belonging to no extension, and SECURITY DEFINER. This migration aborted on
   * it — `unexpected SECURITY DEFINER function(s): rls_auto_enable` — and
   * migrations 28 and 29 carried the identical predicate, so the same push
   * would have failed three times.
   *
   * WHAT THAT FUNCTION ACTUALLY IS, read from its definition rather than
   * assumed: an event trigger that runs
   * `alter table ... enable row level security` on every table created in
   * `public`. It is Supabase’s own auto-enable-RLS tooling, which is why
   * `postgres` owns it and no extension claims it.
   *
   * It only ever ENABLES row level security — it never disables, grants,
   * revokes or drops anything — so it is aligned with this schema’s posture
   * rather than in tension with it. Its one `format()` takes
   * `object_identity` from `pg_event_trigger_ddl_commands()`, a system
   * function, so no caller-controlled input reaches it.
   *
   * WHY THE RETURN TYPE IS THE RIGHT DISCRIMINATOR
   *
   * Ownership cannot separate them: that function is owned by `postgres`, the
   * same role that owns ours and the same role that runs `db push`. Extension
   * membership cannot either: it belongs to no extension. A name allow-list
   * would make this check vacuous, since a rogue definer is unexpected exactly
   * by not being named. And keying on `search_path` would be an inversion —
   * an unpinned search_path is the thing this check should FLAG, never a reason
   * to skip something.
   *
   * The return type is structural and safe. PostgreSQL refuses to invoke an
   * `event_trigger` function directly; it fires only through an event trigger,
   * and creating one of those requires superuser. So such a function is not
   * callable by `anon`, by `authenticated`, by `service_role`, or by anyone
   * else — which is why the default PUBLIC EXECUTE grant Postgres puts on it is
   * inert, and why it cannot be an RPC surface for this check to worry about.
   *
   * THE EXCLUSION IS PROVABLY EMPTY FOR OUR OWN CODE. No migration in this
   * repository creates a SECURITY DEFINER function returning `event_trigger`,
   * and scripts/test-worker-db-boundary.mjs asserts that it never will. So this
   * cannot hide one of ours; every callable definer we create is still checked
   * exactly as before, and a rogue one still aborts the migration.
   *
   * Nothing here grants, revokes, drops or alters that function. It is not ours
   * to touch — it is only excluded from an assertion that was never able to say
   * anything meaningful about it.
   */
  select string_agg(pr.proname, ', ') into offending
  from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
  where n.nspname = 'public'
    and pr.prosecdef
    and pr.prorettype <> 'pg_catalog.event_trigger'::regtype
    and not (pr.proname = any(all_definers));
  if offending is not null then
    raise exception 'unexpected SECURITY DEFINER function(s): %', offending;
  end if;

  -- THE INVARIANT EVERY ONE OF THESE EXISTS TO PRESERVE.
  select string_agg(distinct table_name || ':' || privilege_type, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('worker_supervisors', 'worker_slots', 'automation_tasks',
                       'task_leases', 'worker_events')
    and grantee = 'service_role';
  if offending is not null then
    raise exception 'service_role gained a table grant: %', offending;
  end if;

  select string_agg(privilege_type, ', ') into offending
  from (
    select distinct privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('worker_pairings', 'worker_credentials')
      and grantee = 'service_role'
    order by privilege_type
  ) s;
  if offending is distinct from 'INSERT, SELECT, UPDATE' then
    raise exception 'service_role grants on the pairing tables changed: %', offending;
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

  /*
   * NO WORKER PATH TO SUBMISSION.
   *
   * The two statuses that mean "this application was, or is about to be, sent"
   * must not appear in the CODE of any function a worker can reach. Checked as
   * text, because there is no other way to check it.
   *
   * Comments are stripped first. They discuss those statuses at length —
   * explaining why a worker stops short of them is most of the point — and a
   * scan that flagged its own explanation would have to be deleted, which is
   * how a check like this quietly stops existing.
   */
  select string_agg(pr.proname, ', ') into offending
  from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
  where n.nspname = 'public' and pr.proname = any(callable)
    and regexp_replace(
          regexp_replace(pr.prosrc, '/\*.*?\*/', '', 'gs'),
          '--[^' || chr(10) || ']*', '', 'g'
        ) ~ '(ready_to_submit|''submitted'')';
  if offending is not null then
    raise exception 'a worker-callable function can write a submission status: %', offending;
  end if;
end $$;
