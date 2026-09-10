-- The worker authorization boundary.
--
-- THE PROBLEM THIS SOLVES
--
-- A worker redeeming a pairing secret has no session. Proving it holds the
-- secret IS the authentication, so there is no candidate context for RLS to
-- evaluate and the redeem and heartbeat paths cannot run under one. Until now
-- they ran under `service_role` and wrote to `worker_supervisors` and
-- `worker_slots` directly — and migration 22 revokes every privilege from
-- `service_role` on those tables and then ASSERTS the absence. So supervisor
-- registration, slot registration and every heartbeat were refused by the
-- database. Redemption failed closed with `registration_failed`, but it
-- failed: one-slot pairing has only ever worked against an in-memory store.
--
-- THE REJECTED FIX
--
-- `grant select, insert, update on worker_supervisors, worker_slots to
-- service_role` would work in four words. It would also hand every future bug
-- in any server route unrestricted read and write over every candidate's
-- supervisors and slots — and, by the same reasoning next time, tasks, leases
-- and events. Migration 22's zero-grant invariant is what makes "the elevated
-- client cannot touch worker state" a property of the database rather than a
-- habit of the code. It stays.
--
-- THE BOUNDARY
--
-- Two `security definer` functions, each performing exactly one protocol
-- operation. Nothing else in the database changes:
--
--   worker_redeem_pairing()   registers a supervisor and one slot, issues one
--                             credential, and claims the invitation — as ONE
--                             transaction.
--   worker_record_heartbeat() records one heartbeat for one credential.
--
-- Both are executable by `service_role` and by nobody else — not PUBLIC, not
-- `anon`, not `authenticated`. Both pin `search_path` to the empty string and
-- schema-qualify every reference, so no search_path trick can redirect them.
-- Neither contains dynamic SQL: no string in either becomes a statement.
--
-- OWNERSHIP IS NEVER A PARAMETER
--
-- This is the load-bearing property. Neither function accepts a candidate id,
-- a supervisor id, a slot id, or any other ownership field. Each takes a HASH
-- the caller must already possess — the pairing secret's hash, or the
-- credential token's hash — finds the one row that matches, and reads
-- ownership OUT of that row. A worker cannot name a candidate, so it cannot
-- choose one. Cross-candidate access is not refused by a check; it is
-- unreachable by construction.
--
-- WHY NOT ONE "WORKER ADMIN" FUNCTION
--
-- A function taking an operation name and a payload would be the service-role
-- grant again, wearing a different hat. Each of these does one thing,
-- validates every precondition of that one thing, and fails closed.
--
-- WHAT THEY MAY RETURN
--
-- Ids and a status. No `secret_hash`, no `token_hash`, no column of any row
-- the caller has not already proved it holds. `worker_redeem_pairing` does not
-- even return the candidate id: the caller read the invitation row itself
-- before calling, so returning it again would be surface for nothing.
--
-- RLS IS UNCHANGED. Every worker table keeps RLS enabled AND forced, and every
-- candidate-facing path still runs under the candidate's own session and their
-- own policies. These functions are reachable only by the server, and only for
-- the operations a candidate's browser genuinely cannot perform.

-- ---------------------------------------------------------------------------
-- 1. Redemption: supervisor, slot, credential and claim, atomically.
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
/*
 * THE OUT PARAMETERS DO NOT SHARE A NAME WITH ANY COLUMN THIS FUNCTION WRITES.
 *
 * `worker_credentials` has both a `supervisor_id` and a `slot_id`, and plpgsql
 * resolves an unqualified name to a variable before a column. Naming the
 * outputs after those columns is a footgun with no upside, so they are not.
 */
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
  /*
   * SHAPE FIRST, AND FAIL CLOSED.
   *
   * Each of these is also enforced by a CHECK constraint on the table being
   * written. Rejecting here turns what would be a 500 and a rolled-back
   * transaction into a clean refusal, and keeps a malformed call from ever
   * reaching an INSERT.
   */
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
   * THE INVITATION IS THE ONLY SOURCE OF OWNERSHIP.
   *
   * Found by hash, across all candidates, exactly as the server's own lookup
   * does — the plaintext is never a query value anywhere in this protocol.
   *
   * FOR UPDATE is what makes redemption single-use under concurrency. Two
   * workers presenting the same secret at the same instant both arrive here;
   * one takes the row lock, the other waits, and in READ COMMITTED the waiter
   * re-reads the row it blocked on and sees `redeemed_at` already set. It
   * leaves with `already_redeemed` having inserted nothing at all — no orphan
   * supervisor, no orphan slot, no orphan credential.
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
  -- The ceiling, checked before anything is written: a second layer, not a
  -- substitute for the server's own check.
  if v_pairing.attempts >= 10 then
    return query select false, 'too_many_attempts'::text, null::uuid, null::uuid;
    return;
  end if;
  if v_pairing.expires_at <= v_now then
    return query select false, 'expired'::text, null::uuid, null::uuid;
    return;
  end if;

  /*
   * From here the candidate is `v_pairing.user_id`, read out of the locked
   * row and never supplied by the caller.
   */
  insert into public.worker_supervisors
    (user_id, platform, agent_version, declared_slots, lifecycle)
  values
    (v_pairing.user_id, p_platform, p_agent_version, 1, 'starting')
  returning id into v_supervisor;

  -- ONE slot in this milestone. The schema allows ten; the runtime uses the
  -- first and only.
  insert into public.worker_slots
    (user_id, supervisor_id, slot_index, browser_context_id, capabilities, readiness)
  values
    (v_pairing.user_id, v_supervisor, 1, 'slot-1', array['form_fill']::text[], 'initializing')
  returning id into v_slot;

  /*
   * The credential id is chosen by the caller because the token is
   * `<id>.<secret>` and the row must carry the hash of THAT token's secret. It
   * is not a secret — the other half is 256 bits of CSPRNG — and it is bound
   * here to a supervisor and slot this function has just created, so a chosen
   * id cannot reach another candidate's worker.
   */
  insert into public.worker_credentials
    (id, user_id, supervisor_id, slot_id, token_hash, expires_at)
  values
    (p_credential_id, v_pairing.user_id, v_supervisor, v_slot,
     p_token_hash, p_credential_expires_at);

  update public.worker_pairings
     set redeemed_at = v_now,
         redeemed_supervisor_id = v_supervisor
   where id = v_pairing.id;

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
-- 2. Heartbeat: one credential, one supervisor, one slot.
-- ---------------------------------------------------------------------------
create or replace function public.worker_record_heartbeat(
  p_credential_id uuid,
  p_token_hash text,
  p_sequence bigint,
  p_lifecycle text,
  p_readiness text
)
returns table (ok boolean, reason text, applied boolean)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_cred public.worker_credentials%rowtype;
  v_supervisor public.worker_supervisors%rowtype;
  v_now timestamptz := now();
begin
  if p_credential_id is null
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_sequence is null or p_sequence < 0
     or p_lifecycle is null or p_lifecycle not in ('offline', 'starting', 'running', 'stopping')
     or p_readiness is null or p_readiness not in (
       'initializing', 'ready', 'working', 'stopping', 'stopped', 'crashed'
     )
  then
    return query select false, 'malformed_request'::text, false;
    return;
  end if;

  /*
   * A PAUSED SLOT HAS A REASON, AND THE HEARTBEAT CANNOT CARRY ONE.
   *
   * `worker_slots_pause_reason_iff_paused` requires the two to move together,
   * and inventing a reason here would put a fiction in the audit trail. The
   * heartbeat contract gains a reason field in the milestone that gives a slot
   * something to be paused BY; until then this refuses rather than guesses.
   */
  if p_readiness = 'paused' then
    return query select false, 'pause_reason_required'::text, false;
    return;
  end if;

  /*
   * OWNERSHIP COMES FROM THE TOKEN HASH.
   *
   * The id alone names a row; the hash proves the caller holds the token that
   * row was minted for. Both must match, and every id used below — candidate,
   * supervisor, slot — is read out of the row that matched, never taken from a
   * parameter. The server has already compared the token's secret against this
   * hash in constant time; this is the database's own check that it is acting
   * for the credential it was told about.
   */
  select * into v_cred
  from public.worker_credentials
  where id = p_credential_id and token_hash = p_token_hash;

  if not found then
    return query select false, 'not_found'::text, false;
    return;
  end if;
  if v_cred.revoked_at is not null then
    return query select false, 'revoked'::text, false;
    return;
  end if;
  if v_cred.expires_at <= v_now then
    return query select false, 'expired'::text, false;
    return;
  end if;
  -- Scope is checked in the database as well as in the server. A credential
  -- minted for one thing must not be spendable on another.
  if v_cred.audience <> 'kiasa-worker' or v_cred.scope <> 'slot:heartbeat' then
    return query select false, 'out_of_scope'::text, false;
    return;
  end if;

  select * into v_supervisor
  from public.worker_supervisors
  where id = v_cred.supervisor_id and user_id = v_cred.user_id;

  if not found then
    return query select false, 'not_found'::text, false;
    return;
  end if;
  -- A disowned machine may not report in. Revocation is final.
  if v_supervisor.revoked_at is not null then
    return query select false, 'revoked'::text, false;
    return;
  end if;

  /*
   * MONOTONIC BY SEQUENCE. A duplicate delivery, or a retry that overtakes
   * what it was retrying, must not move a worker's state backwards — a crashed
   * slot showing as `working` would leave its task leased. Accepted, applied
   * to nothing.
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

  if v_cred.slot_id is not null then
    /*
     * `worker_slots_stop_reason_iff_stopping` requires a stop reason exactly
     * when readiness is stopping or stopped, and requires its ABSENCE
     * otherwise. A slot that reported `stopped` and later reports `ready`
     * would violate the constraint if the old reason were left behind, so both
     * reason columns are written on every heartbeat rather than only when they
     * change.
     */
    update public.worker_slots
       set heartbeat_sequence = p_sequence,
           last_heartbeat_at = v_now,
           readiness = p_readiness,
           stop_reason = case
             when p_readiness in ('stopping', 'stopped') then 'supervisor_shutdown'
             else null
           end,
           pause_reason = null
     where id = v_cred.slot_id
       and user_id = v_cred.user_id;
  end if;

  return query select true, 'applied'::text, true;
end;
$fn$;

revoke all on function public.worker_record_heartbeat(
  uuid, text, bigint, text, text
) from public, anon, authenticated;
grant execute on function public.worker_record_heartbeat(
  uuid, text, bigint, text, text
) to service_role;

-- ---------------------------------------------------------------------------
-- Self-verification. This migration ABORTS rather than leaving a boundary
-- wider than it claims to be.
-- ---------------------------------------------------------------------------
do $$
declare
  fns text[] := array['worker_redeem_pairing', 'worker_record_heartbeat'];
  target text;
  p pg_proc%rowtype;
  offending text;
  worker_tables text[] := array[
    'worker_supervisors', 'worker_slots', 'automation_tasks', 'task_leases',
    'worker_events', 'worker_pairings', 'worker_credentials'
  ];
begin
  foreach target in array fns loop
    select pr.* into p
    from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
    where n.nspname = 'public' and pr.proname = target;

    if not found then
      raise exception '% is missing', target;
    end if;

    -- SECURITY DEFINER, or it cannot write at all.
    if not p.prosecdef then
      raise exception '% is not security definer', target;
    end if;

    -- A definer function without a pinned search_path is a privilege
    -- escalation waiting for someone to create a shadowing object.
    --
    -- `search_path` is a GUC_LIST_QUOTE setting, so an empty value is stored
    -- QUOTED — `search_path=""`, not `search_path=`. Matching the literal
    -- aborted this migration on its first CI run. Both spellings are accepted
    -- here and nothing else is.
    if p.proconfig is null or not exists (
      select 1 from unnest(p.proconfig) entry
      where entry = 'search_path=' or entry = 'search_path=""'
        or entry = 'search_path='''''
    ) then
      raise exception '% does not pin search_path to the empty string: %',
        target, coalesce(array_to_string(p.proconfig, ','), 'unset');
    end if;

    -- No dynamic SQL. No string in this function may become a statement.
    if p.prosrc ~* '\mexecute\M' then
      raise exception '% contains dynamic SQL', target;
    end if;

    -- Not reachable by a browser or an anonymous caller.
    if has_function_privilege('authenticated', p.oid, 'EXECUTE')
       or has_function_privilege('anon', p.oid, 'EXECUTE')
    then
      raise exception '% is executable by an API role other than service_role', target;
    end if;

    /*
     * And not by PUBLIC, which is where a function is most easily left open:
     * EXECUTE is granted to PUBLIC BY DEFAULT, so a missing REVOKE is a silent
     * hole rather than a visible one.
     *
     * Checked through the ACL rather than has_function_privilege(), which
     * would answer the narrower question. A NULL ACL means the function still
     * carries DEFAULT privileges, and the default for a function is EXECUTE to
     * PUBLIC — the dangerous case, and one a privilege lookup on a specific
     * role reports the same way as a locked-down function. An ACL item
     * beginning with '=' is an explicit PUBLIC grant. Both are refused.
     */
    if p.proacl is null then
      raise exception '% still holds default privileges, which grant EXECUTE to PUBLIC', target;
    end if;
    if exists (select 1 from unnest(p.proacl) item where item::text like '=%') then
      raise exception '% is executable by PUBLIC', target;
    end if;
    if not has_function_privilege('service_role', p.oid, 'EXECUTE') then
      raise exception '% is not executable by service_role', target;
    end if;

    -- A definer function is only as safe as its owner. These write to tables
    -- with FORCE ROW LEVEL SECURITY, which applies to the owner too, so the
    -- owner must be able to bypass it.
    -- The catalogue records the two separately, and a SUPERUSER bypasses row
    -- security whether or not rolbypassrls is set. Requiring only rolbypassrls
    -- would abort on a stack whose owner is a superuser, which is how the
    -- local one is configured.
    if not exists (
      select 1 from pg_roles r
      where r.oid = p.proowner and (r.rolsuper or r.rolbypassrls)
    ) then
      raise exception '% is owned by %, which cannot bypass forced RLS',
        target, (select rolname from pg_roles where oid = p.proowner);
    end if;
  end loop;

  -- THE INVARIANT THIS MIGRATION EXISTS TO PRESERVE. No table grant was added
  -- to service_role on any migration-22 worker table.
  select string_agg(distinct table_name || ':' || privilege_type, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('worker_supervisors', 'worker_slots', 'automation_tasks',
                       'task_leases', 'worker_events')
    and grantee = 'service_role';
  if offending is not null then
    raise exception 'service_role gained a table grant: %', offending;
  end if;

  -- And the migration-24 grants are still exactly what migration 24 gave.
  select string_agg(distinct privilege_type, ', ') into offending
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

  -- RLS is still enabled AND forced everywhere.
  foreach target in array worker_tables loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = target
        and c.relrowsecurity and c.relforcerowsecurity
    ) then
      raise exception '% lost RLS', target;
    end if;
  end loop;

  -- Nothing gained access to a hash column.
  if exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public'
      and table_name in ('worker_pairings', 'worker_credentials')
      and column_name in ('secret_hash', 'token_hash')
      and grantee in ('anon', 'authenticated', 'PUBLIC')
  ) then
    raise exception 'an API role can read a hash column';
  end if;
end $$;
