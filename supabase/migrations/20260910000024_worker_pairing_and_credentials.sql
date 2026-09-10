-- Worker pairing and scoped worker credentials.
--
-- How a candidate connects a worker running on their OWN computer to the
-- control plane, without either side ever holding the other's secrets.
--
-- THE SHAPE OF THE FLOW
--
--   1. A signed-in candidate asks for a pairing secret. The server generates
--      it, stores ONLY a SHA-256 hash, and shows the plaintext once.
--   2. The candidate pastes it into the worker on their machine.
--   3. The worker redeems it over HTTPS. Redemption is ATOMIC and SINGLE-USE.
--   4. The server issues a scoped credential, stores ONLY its hash, and binds
--      it to that candidate and one slot.
--   5. The worker keeps the credential in memory and heartbeats with it.
--
-- WHAT IS NEVER STORED HERE
--
-- The pairing secret in plaintext. The credential in plaintext. An OpenRouter
-- key. A Supabase service-role key. A Claude credential of any kind. A browser
-- cookie. An employer credential. There is no column any of those could go in,
-- and that is deliberate rather than incidental.
--
-- WHY ATTEMPT LIMITS LIVE IN THE DATABASE
--
-- The control plane runs on serverless functions. An in-memory rate limiter
-- there counts attempts per instance, which is to say it counts almost
-- nothing: a brute-force spread across warm lambdas would sail past it. The
-- counter is a column, incremented on every failed redemption, and the
-- constraint is enforced where the state actually lives.

-- ---------------------------------------------------------------------------
-- worker_pairings — a short-lived, one-time invitation
-- ---------------------------------------------------------------------------
create table public.worker_pairings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- SHA-256 of the pairing secret, hex. The secret itself is shown to the
  -- candidate once and never written down anywhere.
  --
  -- A hash rather than the value because this table is readable by a support
  -- process, a backup, and anyone who ever gets a copy of the database. A
  -- 256-bit random secret needs no salt or stretching: there is no dictionary
  -- to attack, and the row expires in minutes.
  secret_hash text not null
    constraint worker_pairings_secret_hash_shape check (secret_hash ~ '^[0-9a-f]{64}$'),

  -- Short-lived on purpose. An invitation that lives for hours is an
  -- invitation someone else can find.
  expires_at timestamptz not null,

  -- Set exactly once, atomically, by the redeeming request.
  redeemed_at timestamptz,
  redeemed_supervisor_id uuid references public.worker_supervisors (id) on delete set null,

  -- Failed redemption attempts. Bounded, so guessing is not merely slow but
  -- finite.
  attempts integer not null default 0
    constraint worker_pairings_attempts_bounded check (attempts between 0 and 10),

  revoked_at timestamptz,

  created_at timestamptz not null default now(),

  constraint worker_pairings_expires_after_creation check (expires_at > created_at),
  -- A redeemed pairing names what redeemed it.
  constraint worker_pairings_redemption_complete
    check ((redeemed_at is null) = (redeemed_supervisor_id is null)),
  -- Ten minutes is the ceiling, not merely the default.
  constraint worker_pairings_short_lived
    check (expires_at <= created_at + interval '10 minutes')
);

-- At most one live invitation per candidate. Asking again supersedes the old
-- one rather than accumulating a drawer of valid secrets.
create unique index worker_pairings_one_live_per_user
  on public.worker_pairings (user_id)
  where redeemed_at is null and revoked_at is null;

create index worker_pairings_by_user on public.worker_pairings (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- worker_credentials — what the worker actually authenticates with
-- ---------------------------------------------------------------------------
create table public.worker_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- Bound to one supervisor and one slot. A credential that could act for any
  -- slot is a credential that can finish another slot's task.
  supervisor_id uuid not null references public.worker_supervisors (id) on delete cascade,
  slot_id uuid references public.worker_slots (id) on delete set null,

  -- SHA-256 of the secret half of the token, hex. The token is
  -- `<id>.<secret>`; the id is the lookup key so verification is an indexed
  -- read rather than a scan over every hash.
  token_hash text not null
    constraint worker_credentials_token_hash_shape check (token_hash ~ '^[0-9a-f]{64}$'),

  -- Audience and scope, checked on every request. A credential minted for a
  -- worker must not be accepted anywhere else, and this milestone issues
  -- exactly one scope.
  audience text not null default 'kiasa-worker'
    constraint worker_credentials_audience_allowed check (audience in ('kiasa-worker')),
  scope text not null default 'slot:heartbeat'
    constraint worker_credentials_scope_allowed
    check (scope in ('slot:heartbeat')),

  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,

  revoked_at timestamptz,
  revoked_reason text
    constraint worker_credentials_revoked_reason_allowed
    check (revoked_reason is null or revoked_reason in (
      'candidate_requested', 'superseded', 'suspected_compromise', 'supervisor_revoked'
    )),

  created_at timestamptz not null default now(),

  constraint worker_credentials_expires_after_issue check (expires_at > issued_at),
  -- Bounded lifetime. A worker credential is not a permanent key; re-pairing
  -- is cheap and a stolen one should stop working on its own.
  constraint worker_credentials_bounded_life
    check (expires_at <= issued_at + interval '30 days'),
  constraint worker_credentials_revocation_complete
    check ((revoked_at is null) = (revoked_reason is null))
);

-- One live credential per supervisor. Re-pairing supersedes rather than
-- accumulating usable tokens.
create unique index worker_credentials_one_live_per_supervisor
  on public.worker_credentials (supervisor_id)
  where revoked_at is null;

create index worker_credentials_by_user on public.worker_credentials (user_id, issued_at desc);

-- ---------------------------------------------------------------------------
-- RLS, grants and policies
--
-- COLUMN-LEVEL GRANTS, and this is the one departure from the template used by
-- migrations 7/13/22. Those tables have no column a candidate may not read;
-- these two do. Row security cannot hide a column, so `authenticated` is
-- granted SELECT on named columns and the hash columns are simply not among
-- them. A browser cannot read `secret_hash` or `token_hash` even for its own
-- rows — not because a policy forbids it, but because the privilege does not
-- exist.
-- ---------------------------------------------------------------------------
alter table public.worker_pairings enable row level security;
alter table public.worker_pairings force row level security;
alter table public.worker_credentials enable row level security;
alter table public.worker_credentials force row level security;

revoke all on public.worker_pairings from anon, public, authenticated, service_role;
revoke all on public.worker_credentials from anon, public, authenticated, service_role;

-- The candidate sees status, never material.
grant select (id, user_id, expires_at, redeemed_at, redeemed_supervisor_id,
              attempts, revoked_at, created_at)
  on public.worker_pairings to authenticated;
grant select (id, user_id, supervisor_id, slot_id, audience, scope,
              issued_at, expires_at, last_used_at, revoked_at, revoked_reason, created_at)
  on public.worker_credentials to authenticated;

-- Revoking is the one write a browser may make, and it may only ever set the
-- revocation columns on its own row.
grant update (revoked_at) on public.worker_pairings to authenticated;
grant update (revoked_at, revoked_reason) on public.worker_credentials to authenticated;

create policy worker_pairings_select_own on public.worker_pairings
  for select to authenticated using ((select auth.uid()) = user_id);
create policy worker_pairings_update_own on public.worker_pairings
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy worker_credentials_select_own on public.worker_credentials
  for select to authenticated using ((select auth.uid()) = user_id);
create policy worker_credentials_update_own on public.worker_credentials
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- The server issues and verifies, because a worker redeeming a secret has no
-- session to act under. Exactly the verbs those two operations need, on
-- exactly these two new tables — no existing grant is widened.
grant select, insert, update on public.worker_pairings to service_role;
grant select, insert, update on public.worker_credentials to service_role;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- A redeemed pairing stays redeemed, and a hash is never rewritten.
--
-- Single-use is enforced by the conditional UPDATE the server issues
-- (`where redeemed_at is null`), which is atomic in Postgres and lets exactly
-- one of two racing workers win. This trigger is the second layer: it refuses
-- to un-redeem, so a bug or a stray client cannot recycle an invitation.
create or replace function public.guard_worker_pairing_immutable()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.secret_hash <> new.secret_hash then
    raise exception 'a pairing secret hash is fixed at creation' using errcode = 'check_violation';
  end if;
  if old.user_id <> new.user_id then
    raise exception 'a pairing may not change owner' using errcode = 'check_violation';
  end if;
  if old.redeemed_at is not null and new.redeemed_at is null then
    raise exception 'a redeemed pairing may not be un-redeemed' using errcode = 'check_violation';
  end if;
  if old.expires_at <> new.expires_at then
    raise exception 'a pairing expiry is fixed at creation' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_worker_pairing_immutable()
  from public, anon, authenticated, service_role;

create trigger worker_pairings_immutable
  before update on public.worker_pairings
  for each row execute function public.guard_worker_pairing_immutable();

-- A credential's identity, binding and hash are fixed; revocation is final.
create or replace function public.guard_worker_credential_immutable()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.token_hash <> new.token_hash then
    raise exception 'a credential hash is fixed at issue' using errcode = 'check_violation';
  end if;
  if old.user_id <> new.user_id or old.supervisor_id <> new.supervisor_id then
    raise exception 'a credential may not be rebound' using errcode = 'check_violation';
  end if;
  if old.audience <> new.audience or old.scope <> new.scope then
    raise exception 'a credential scope is fixed at issue' using errcode = 'check_violation';
  end if;
  if old.expires_at <> new.expires_at then
    raise exception 'a credential expiry is fixed at issue' using errcode = 'check_violation';
  end if;
  if old.revoked_at is not null and new.revoked_at is null then
    raise exception 'a revoked credential may not be restored' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_worker_credential_immutable()
  from public, anon, authenticated, service_role;

create trigger worker_credentials_immutable
  before update on public.worker_credentials
  for each row execute function public.guard_worker_credential_immutable();

-- ---------------------------------------------------------------------------
-- Self-verification. Aborts rather than leaving either table half-secured.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  n integer;
  offending text;
begin
  foreach t in array array['worker_pairings', 'worker_credentials'] loop
    if not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relname = t
        and c.relrowsecurity and c.relforcerowsecurity
    ) then
      raise exception '% does not have RLS enabled and forced', t;
    end if;

    -- No anon or PUBLIC access of any kind.
    if exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = t and grantee in ('anon', 'PUBLIC')
    ) then
      raise exception '% is reachable by anon or PUBLIC', t;
    end if;

    -- THE HASH COLUMNS ARE NOT READABLE BY A BROWSER. This is the control that
    -- keeps credential material away from client JavaScript, so it is asserted
    -- rather than assumed.
    if exists (
      select 1 from information_schema.column_privileges
      where table_schema = 'public' and table_name = t
        and grantee = 'authenticated'
        and column_name in ('secret_hash', 'token_hash')
    ) then
      raise exception 'authenticated can read a hash column on %', t;
    end if;

    -- And no blanket DELETE for a browser: revocation is an update, so that a
    -- worker credential's history survives being turned off.
    if exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = t
        and grantee = 'authenticated' and privilege_type = 'DELETE'
    ) then
      raise exception '% grants DELETE to authenticated', t;
    end if;
  end loop;

  -- Every UPDATE policy carries WITH CHECK.
  select count(*) into n from pg_policies
  where schemaname = 'public' and tablename in ('worker_pairings', 'worker_credentials')
    and cmd = 'UPDATE' and with_check is null;
  if n > 0 then
    raise exception '% UPDATE policies lack WITH CHECK', n;
  end if;

  -- Two tables x (select + update) = 4.
  select count(*) into n from pg_policies
  where schemaname = 'public' and tablename in ('worker_pairings', 'worker_credentials');
  if n <> 4 then
    raise exception 'expected 4 policies, found %', n;
  end if;

  -- The single-use and one-live indexes exist.
  foreach t in array array[
    'worker_pairings_one_live_per_user', 'worker_credentials_one_live_per_supervisor'
  ] loop
    if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = t) then
      raise exception 'missing index %', t;
    end if;
  end loop;

  -- service_role holds exactly what issuing and verifying need, and no DELETE.
  select string_agg(distinct privilege_type, ',' order by privilege_type) into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name in ('worker_pairings', 'worker_credentials')
    and grantee = 'service_role';
  if offending is distinct from 'INSERT,SELECT,UPDATE' then
    raise exception 'service_role holds % on the pairing tables', coalesce(offending, 'nothing');
  end if;
end $$;
