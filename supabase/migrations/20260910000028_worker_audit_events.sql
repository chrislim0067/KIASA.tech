-- The last three audit events, and the end of the empty-string sentinel.
--
-- WHAT WAS MISSING
--
-- Migration 27 recorded every task and lease event, and every slot readiness
-- transition. Three kinds in `worker_events`' own vocabulary were still never
-- written: `supervisor_registered`, `slot_registered` and `supervisor_revoked`
-- — the beginning and the end of a worker's life. An audit trail that starts
-- at the first claim cannot answer "when did this machine appear, and who
-- turned it off".
--
-- Both ends are now written INSIDE the transaction that causes them. A
-- redemption that loses its race registers nothing and records nothing,
-- because the whole function rolls back together; a revoke that finds nothing
-- to revoke records nothing, because the event is written only where a row
-- actually transitioned.
--
-- THE BROWSER LOSES ITS WRITE ON THE AUDIT TABLE
--
-- Migration 22 granted `authenticated` SELECT and INSERT on `worker_events`,
-- from the loop that grants both on every worker table. Nothing has ever used
-- the INSERT, and it let a candidate's browser fabricate an event of any
-- allowed kind for its own account — a supervisor that never registered, a
-- task that never failed. It is revoked here. Events are now written by these
-- functions and by nothing else, so the trail records what the system did
-- rather than what a client said it did. SELECT stays: a candidate must be
-- able to read their own history.
--
-- THE EMPTY STRING IS NO LONGER A REASON
--
-- Migration 27 sent '' for "no reason", because `supabase gen types` cannot
-- see that a text parameter is nullable and types it `string`. That worked and
-- was documented, but it left one spelling of absence that the database had to
-- know about, and a sentinel is a thing to remember rather than a thing the
-- type system enforces. `p_reason` now has a DEFAULT, so an absent reason is
-- an ABSENT ARGUMENT: the store omits it and the database sees null. '' has no
-- special meaning any more — it is simply not a member of either vocabulary,
-- and every branch refuses it.

-- ---------------------------------------------------------------------------
-- 1. Registration: the supervisor and slot events, in the same transaction.
-- ---------------------------------------------------------------------------
create or replace function public.worker_redeem_pairing(
  p_secret_hash text,
  p_platform text,
  p_agent_version text,
  p_credential_id uuid,
  p_token_hash text,
  p_credential_expires_at timestamptz
)
returns table (ok boolean, reason text, new_supervisor_id uuid, new_slot_id uuid)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_pairing public.worker_pairings%rowtype;
  v_now timestamptz := now();
  v_supervisor uuid;
  v_slot uuid;
begin
  if p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$'
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_credential_id is null
     or p_platform is null or p_platform not in ('windows', 'macos', 'linux')
     or p_agent_version is null or p_agent_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
     or p_credential_expires_at is null
     or p_credential_expires_at <= v_now
     or p_credential_expires_at > v_now + interval '30 days'
  then
    return query select false, 'malformed_request'::text, null::uuid, null::uuid;
    return;
  end if;

  /*
   * The invitation is the only source of ownership, and FOR UPDATE is what
   * makes redemption single-use: the loser of a race blocks here, re-reads a
   * redeemed invitation, and leaves having inserted nothing — no supervisor,
   * no slot, no credential, and now no events either.
   */
  select * into v_pairing
  from public.worker_pairings
  where secret_hash = p_secret_hash
  for update;

  if not found then
    return query select false, 'not_found'::text, null::uuid, null::uuid;
    return;
  end if;
  if v_pairing.revoked_at is not null then
    return query select false, 'revoked'::text, null::uuid, null::uuid;
    return;
  end if;
  if v_pairing.redeemed_at is not null then
    return query select false, 'already_redeemed'::text, null::uuid, null::uuid;
    return;
  end if;
  if v_pairing.attempts >= 10 then
    return query select false, 'too_many_attempts'::text, null::uuid, null::uuid;
    return;
  end if;
  if v_pairing.expires_at <= v_now then
    return query select false, 'expired'::text, null::uuid, null::uuid;
    return;
  end if;

  insert into public.worker_supervisors
    (user_id, platform, agent_version, declared_slots, lifecycle)
  values
    (v_pairing.user_id, p_platform, p_agent_version, 1, 'starting')
  returning id into v_supervisor;

  insert into public.worker_slots
    (user_id, supervisor_id, slot_index, browser_context_id, capabilities, readiness)
  values
    (v_pairing.user_id, v_supervisor, 1, 'slot-1', array['form_fill']::text[], 'initializing')
  returning id into v_slot;

  insert into public.worker_credentials
    (id, user_id, supervisor_id, slot_id, token_hash, expires_at)
  values
    (p_credential_id, v_pairing.user_id, v_supervisor, v_slot,
     p_token_hash, p_credential_expires_at);

  update public.worker_pairings
     set redeemed_at = v_now,
         redeemed_supervisor_id = v_supervisor
   where id = v_pairing.id;

  /*
   * THE TWO REGISTRATION EVENTS.
   *
   * Exactly one of each, and only here — a second redemption of the same
   * invitation never reaches this line, because `already_redeemed` returns
   * above. The candidate comes from the locked pairing row, so a worker cannot
   * write an event for anybody else, and `detail` carries the coarse platform
   * bucket and the agent version: two values the schema already constrains,
   * and nothing that could be a hash, a token, a URL or a person.
   */
  insert into public.worker_events (user_id, supervisor_id, slot_id, kind, detail)
  values (v_pairing.user_id, v_supervisor, null, 'supervisor_registered',
          jsonb_build_object('platform', p_platform, 'agent_version', p_agent_version));
  insert into public.worker_events (user_id, supervisor_id, slot_id, kind, detail)
  values (v_pairing.user_id, v_supervisor, v_slot, 'slot_registered',
          jsonb_build_object('slot_index', 1));

  return query select true, 'redeemed'::text, v_supervisor, v_slot;
end;
$fn$;

revoke all on function public.worker_redeem_pairing(
  text, text, text, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.worker_redeem_pairing(
  text, text, text, uuid, text, timestamptz
) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Revocation: one event, and only after a real transition.
--
-- NO PARAMETERS AT ALL. This is the only definer function a browser may
-- execute, so it takes nothing a browser could choose: the candidate is
-- `auth.uid()`, read from the verified session inside the function. There is
-- no argument to forge, so there is nothing to validate.
--
-- It is also the operation that makes revocation mean what a candidate expects.
-- Revoking used to end the credential and leave the supervisor marked running;
-- now the machine itself is disowned, which is what `guard_lease_supervisor_active`
-- and the heartbeat boundary both check.
-- ---------------------------------------------------------------------------
create or replace function public.worker_revoke_supervisor()
returns table (ok boolean, reason text, revoked_count integer)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := (select auth.uid());
  v_now timestamptz := now();
  v_supervisor uuid;
  v_count integer := 0;
begin
  if v_user is null then
    return query select false, 'unauthenticated'::text, 0;
    return;
  end if;

  /*
   * The credential first: it is what a worker presents, so ending it is what
   * stops the next request. Conditional on `revoked_at is null`, so a replayed
   * revoke updates nothing.
   */
  update public.worker_credentials
     set revoked_at = v_now, revoked_reason = 'candidate_requested'
   where user_id = v_user and revoked_at is null;

  -- Any outstanding invitation goes too: revoking should not leave a live code
  -- someone could still redeem.
  update public.worker_pairings
     set revoked_at = v_now
   where user_id = v_user and redeemed_at is null and revoked_at is null;

  /*
   * THE EVENT IS WRITTEN PER SUPERVISOR THAT ACTUALLY TRANSITIONED.
   *
   * `where revoked_at is null` is the transition test. A second revoke matches
   * no row, writes no event, and reports `already_revoked` — replaying the
   * request cannot manufacture a history of revocations that did not happen.
   */
  for v_supervisor in
    update public.worker_supervisors
       set revoked_at = v_now,
           revoked_reason = 'candidate_requested',
           lifecycle = 'offline'
     where user_id = v_user and revoked_at is null
    returning id
  loop
    insert into public.worker_events (user_id, supervisor_id, kind, detail)
    values (v_user, v_supervisor, 'supervisor_revoked',
            jsonb_build_object('reason', 'candidate_requested'));
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    return query select true, 'already_revoked'::text, 0;
    return;
  end if;
  return query select true, 'revoked'::text, v_count;
end;
$fn$;

revoke all on function public.worker_revoke_supervisor() from public, anon, service_role;
grant execute on function public.worker_revoke_supervisor() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The audit table stops accepting writes from a browser.
-- ---------------------------------------------------------------------------
revoke insert on public.worker_events from authenticated;

-- ---------------------------------------------------------------------------
-- 4. An absent reason becomes an absent ARGUMENT.
-- ---------------------------------------------------------------------------
create or replace function public.worker_record_heartbeat(
  p_credential_id uuid,
  p_token_hash text,
  p_sequence bigint,
  p_lifecycle text,
  p_readiness text,
  p_reason text default null
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
   * THE PAUSE AND STOP RULES.
   *
   * `worker_slots_pause_reason_iff_paused` and
   * `worker_slots_stop_reason_iff_stopping` bind in BOTH directions, so a
   * state that needs no reason must not carry one, and a heartbeat reporting
   * `ready` clears whatever was there atomically with the state.
   *
   * NULL IS THE ONLY SPELLING OF ABSENCE NOW. Migration 27 also accepted '';
   * that special case is gone, and '' falls through to the vocabulary check
   * like any other value that is not a reason.
   */
  if p_readiness = 'paused' then
    if p_reason is null or p_reason not in (
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
    if p_reason is null or p_reason not in (
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
    if p_reason is not null then
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

  -- Monotonic by sequence. A replay is accepted, applied to nothing, and
  -- writes no event: the bounded-rate rule that keeps a worker beating every
  -- thirty seconds from filling the audit table.
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

      -- An event on TRANSITION only.
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
          case when p_reason is null then '{}'::jsonb
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

create or replace function public.worker_report_task(
  p_credential_id uuid,
  p_token_hash text,
  p_fence_token bigint,
  p_disposition text,
  p_reason text default null
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

  -- A failure names a cause, from migration 22's own pause-reason vocabulary.
  -- A success or a release carries none, and sending one is a protocol error.
  if p_disposition = 'failed' then
    if p_reason is null or p_reason not in (
      'employer_authentication_required', 'claude_authentication_required',
      'captcha_detected', 'anti_bot_challenge_detected', 'mfa_required',
      'sensitive_information_requested', 'unknown_page', 'unknown_question',
      'unsupported_site', 'control_plane_paused'
    ) then
      return query select false, 'failure_reason_required'::text;
      return;
    end if;
  elsif p_reason is not null then
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

  if p_disposition = 'completed' then
    -- `manual_review`. A person continues from there, and there is no code
    -- path from here to the two statuses that mean an application was sent.
    update public.automation_tasks set status = 'manual_review' where id = v_task.id;
    v_release := 'completed';
  elsif p_disposition = 'failed' then
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
-- Self-verification. Aborts rather than leaving the boundary wider than it
-- claims to be.
-- ---------------------------------------------------------------------------
do $$
declare
  all_definers text[] := array[
    'worker_claim_task', 'worker_record_heartbeat', 'worker_redeem_pairing',
    'worker_renew_lease', 'worker_report_task', 'worker_resolve_credential',
    'worker_revoke_supervisor'
  ];
  -- What each API role may execute. The resolver is in neither list; the
  -- revoke is the ONLY definer function a browser may reach, and it takes no
  -- arguments at all.
  service_callable text[] := array[
    'worker_claim_task', 'worker_record_heartbeat', 'worker_redeem_pairing',
    'worker_renew_lease', 'worker_report_task'
  ];
  browser_callable text[] := array['worker_revoke_supervisor'];
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
    if p.proacl is null then
      raise exception '% still holds default privileges, which grant EXECUTE to PUBLIC', target;
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
    if not exists (
      select 1 from pg_roles r
      where r.oid = p.proowner and (r.rolsuper or r.rolbypassrls)
    ) then
      raise exception '% is owned by %, which cannot bypass forced RLS',
        target, (select rolname from pg_roles where oid = p.proowner);
    end if;
  end loop;

  -- THE ONE FUNCTION A BROWSER MAY CALL TAKES NO ARGUMENTS. An argument is
  -- something a caller chooses, and this one has nothing to choose.
  if (select pronargs from pg_proc p2 join pg_namespace n2 on n2.oid = p2.pronamespace
      where n2.nspname = 'public' and p2.proname = 'worker_revoke_supervisor') <> 0 then
    raise exception 'worker_revoke_supervisor takes arguments';
  end if;

  -- No definer function beyond the allow-list.
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

  -- THE AUDIT TABLE TAKES NO WRITE FROM A BROWSER.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'worker_events'
      and grantee = 'authenticated' and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'authenticated can still write worker_events';
  end if;
  if not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'worker_events'
      and grantee = 'authenticated' and privilege_type = 'SELECT'
  ) then
    raise exception 'authenticated can no longer read its own worker_events';
  end if;

  -- The invariant every one of these exists to preserve.
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
   * NO WORKER PATH TO SUBMISSION, still. Comments are stripped first: they
   * discuss those statuses at length, and a scan that flagged its own
   * explanation would have to be deleted.
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
