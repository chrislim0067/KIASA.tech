-- Administrator authorization: role assignment and the administrative audit log.
--
-- Two tables, both deliberately unlike the eleven candidate tables and the four
-- job tables. Those are user-OWNED data: the owner reads and writes their own
-- rows. These are user-ABOUT data: the subject may read their own role (so the
-- UI can decide whether to render an Admin link) but may never write it, and
-- the audit log is not theirs at all.
--
-- The security model, stated once because everything below follows from it:
--
--   * A role is never client-writable. `authenticated` receives SELECT and
--     nothing else on user_roles. There is no INSERT, UPDATE or DELETE grant
--     and no policy for those verbs, so privilege escalation by a signed-in
--     user is not merely "denied by policy" — the verb is not reachable.
--
--   * The ABSENCE of a row means 'user'. No backfill is required for the
--     accounts that already exist, and a failure to read the table degrades to
--     the least privilege rather than the most.
--
--   * Administrative reads and writes go through server route handlers holding
--     the service-role key, never through PostgREST with an admin-shaped RLS
--     policy. That choice keeps every existing policy on every existing table
--     exactly as migration 7 and 13 left it: this migration adds no admin
--     bypass to profiles, jobs or anything else, so it cannot widen the blast
--     radius of a mistake in those policies.
--
--   * Consequently service_role is granted on these two tables, departing from
--     the "service_role holds nothing" rule of migration 7. The departure is
--     the point: auth.users is reachable only through the Auth admin API, so
--     listing, inviting and deleting users genuinely requires that credential.
--     Confining it to two tables that contain no candidate PII — a role name
--     and an action log — is what keeps the departure small.
--
--   * No function here is SECURITY DEFINER. The admin check is performed in the
--     server with the caller's own session ("read my own role row"), which
--     needs no elevated database privilege and cannot recurse.

-- ---------------------------------------------------------------------------
-- user_roles
-- ---------------------------------------------------------------------------
create table public.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,

  -- A CHECK rather than a PostgreSQL enum, matching every other constrained
  -- vocabulary in this schema (jobs.status, job_events.actor_type, ...).
  -- Adding a role later is one `alter ... drop constraint / add constraint`
  -- in a new migration; an enum would need ALTER TYPE and cannot drop a value.
  --
  -- Only the two roles KIASA needs today are legal. 'support', 'operator' and
  -- 'reviewer' are NOT declared here: an unused role in the vocabulary is an
  -- unused role in every authorization decision that reads it, and the
  -- capability map in lib/auth/roles.ts is where a new role would earn its
  -- meaning anyway.
  role text not null
    constraint user_roles_role_allowed check (role in ('user', 'admin')),

  -- Who granted it. NULL means the row was created by a migration or the
  -- bootstrap script rather than by a person — the first administrator has no
  -- administrator to have been granted by.
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default now(),

  -- Free-text justification captured at grant time. Non-secret by contract.
  note text
    constraint user_roles_note_length check (note is null or length(note) <= 500),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_roles is
  'Role assignment. Absence of a row means the ordinary "user" role. Never '
  'writable by the authenticated role; administrative writes use service_role '
  'from a server route handler after verifying the caller.';

comment on column public.user_roles.role is
  'Constrained vocabulary. Extend by replacing the CHECK in a new migration '
  'and adding the capability entry in lib/auth/roles.ts.';

create index user_roles_role_idx on public.user_roles (role);

-- ---------------------------------------------------------------------------
-- admin_audit_log
-- ---------------------------------------------------------------------------
-- Append-only record of every privileged action. Follows the job_events
-- pattern: immutable by trigger (not merely by withheld grant, because
-- service_role and postgres bypass RLS), with a constrained action vocabulary
-- so a reader branches on a value rather than parsing prose.
create table public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),

  -- The acting administrator.
  --
  -- DELIBERATELY NOT A FOREIGN KEY. Every other table here references
  -- auth.users; this one must not, for two reasons that only became obvious
  -- when the deletion path was tested end to end:
  --
  --   1. ON DELETE SET NULL is implemented as an UPDATE. This table refuses
  --      every UPDATE by trigger (below), so an FK with that action makes
  --      deleting any user who appears in the log fail outright — the audit
  --      log would silently become a lock on the delete feature. ON DELETE
  --      CASCADE is worse: deleting a user would erase the record that they
  --      were deleted.
  --   2. An audit row is a historical statement, not a live reference. "This
  --      administrator deleted this account at this time" stays true after
  --      both accounts are gone, and keeping the id lets rows about the same
  --      subject still be correlated afterwards.
  --
  -- The ids are therefore recorded values. actor_email and target_email are
  -- snapshots taken at write time so the row stays readable once the accounts
  -- no longer exist. The cost is that an id here may not resolve to a live
  -- account, which is correct for an audit trail and is handled in the UI.
  actor_user_id uuid,
  actor_email text
    constraint admin_audit_log_actor_email_length check (actor_email is null or length(actor_email) <= 320),

  action text not null
    constraint admin_audit_log_action_allowed
    check (action in (
      'user.invited',
      'user.invite_resent',
      'user.deleted',
      'user.role_granted',
      'user.role_revoked',
      'admin.bootstrapped'
    )),

  -- The subject. Not a foreign key either, for the reasons given above: the
  -- record that an account was deleted must outlive the account.
  target_user_id uuid,
  target_email text
    constraint admin_audit_log_target_email_length check (target_email is null or length(target_email) <= 320),

  result text not null
    constraint admin_audit_log_result_allowed check (result in ('succeeded', 'failed')),

  -- Machine-readable reason when result = 'failed'.
  failure_code text
    constraint admin_audit_log_failure_code_length check (failure_code is null or length(failure_code) <= 100),

  -- Non-secret context only. The writing layer is responsible for what goes in
  -- here; the size ceiling matches job_events.detail so a runaway payload
  -- cannot bloat the table.
  --
  -- By contract this must never contain passwords, access or refresh tokens,
  -- API keys, service credentials, or full secret values. The check below
  -- enforces the shape; scripts/test-admin-audit.mjs enforces the contract.
  detail jsonb not null default '{}'::jsonb
    constraint admin_audit_log_detail_is_object check (jsonb_typeof(detail) = 'object')
    constraint admin_audit_log_detail_size check (pg_column_size(detail) <= 8192),

  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- A failure must say why; a success must not carry a failure code.
  constraint admin_audit_log_failure_has_code
    check ((result = 'failed') = (failure_code is not null))
);

comment on table public.admin_audit_log is
  'Append-only log of privileged administrative actions. Immutable by trigger. '
  'Never contains secrets.';

create index admin_audit_log_occurred_idx on public.admin_audit_log (occurred_at desc);
create index admin_audit_log_actor_idx on public.admin_audit_log (actor_user_id, occurred_at desc);
create index admin_audit_log_target_idx on public.admin_audit_log (target_user_id, occurred_at desc);
create index admin_audit_log_action_idx on public.admin_audit_log (action, occurred_at desc);

-- ---------------------------------------------------------------------------
-- RLS, grants and policies
-- ---------------------------------------------------------------------------
do $$
begin
  -- ---- user_roles -------------------------------------------------------
  alter table public.user_roles enable row level security;
  alter table public.user_roles force row level security;

  revoke all on public.user_roles from anon;
  revoke all on public.user_roles from public;
  revoke all on public.user_roles from authenticated;
  revoke all on public.user_roles from service_role;

  -- SELECT only, and only your own row. This is what lets the server answer
  -- "is the caller an admin?" using the caller's own session, with no elevated
  -- credential and no recursion through a SECURITY DEFINER helper.
  grant select on public.user_roles to authenticated;

  create policy user_roles_select_own on public.user_roles
    for select to authenticated
    using ((select auth.uid()) = user_id);

  -- Deliberately no INSERT/UPDATE/DELETE grant and no policy for them.
  -- A signed-in user cannot make themselves an administrator because the
  -- privilege to attempt it does not exist, not because a predicate says no.

  -- The administrative surface. See the header for why this departs from
  -- migration 7's blanket service_role revoke.
  grant select, insert, update, delete on public.user_roles to service_role;

  -- ---- admin_audit_log --------------------------------------------------
  alter table public.admin_audit_log enable row level security;
  alter table public.admin_audit_log force row level security;

  revoke all on public.admin_audit_log from anon;
  revoke all on public.admin_audit_log from public;
  revoke all on public.admin_audit_log from authenticated;
  revoke all on public.admin_audit_log from service_role;

  -- `authenticated` gets nothing at all, not even on rows naming them. The log
  -- is read by administrators through a server route handler, so there is no
  -- reason for the browser role to reach it, and a user being able to read
  -- rows about themselves would leak which administrator acted on them.
  grant select, insert on public.admin_audit_log to service_role;
  -- No UPDATE and no DELETE for anyone. Append-only.
end;
$$;

-- ---------------------------------------------------------------------------
-- Timestamps and immutability
-- ---------------------------------------------------------------------------
-- Reuse the existing conventions rather than inventing new ones:
-- set_row_timestamps() for the mutable table, refuse_row_update() for the log.
create trigger user_roles_set_row_timestamps
  before insert or update on public.user_roles
  for each row execute function public.set_row_timestamps();

create trigger admin_audit_log_immutable
  before update on public.admin_audit_log
  for each row execute function public.refuse_row_update();

-- The audit log's own clock, mirroring set_event_created_at() on job_events:
-- created_at is stamped server-side and a future occurred_at is clamped, so a
-- caller cannot backdate or postdate an administrative action.
create or replace function public.set_audit_created_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.created_at := now();
  if new.occurred_at is null or new.occurred_at > now() then
    new.occurred_at := now();
  end if;
  return new;
end;
$$;

comment on function public.set_audit_created_at() is
  'BEFORE INSERT on admin_audit_log: stamps created_at server-side and clamps '
  'a future occurred_at to now.';

create trigger admin_audit_log_set_created_at
  before insert on public.admin_audit_log
  for each row execute function public.set_audit_created_at();

revoke all on function public.set_audit_created_at() from public, anon, authenticated, service_role;

-- A role row's subject may never be reassigned. Without this, an UPDATE could
-- move an existing 'admin' grant from one user_id to another and the audit log
-- would still describe the original grant.
create or replace function public.guard_user_role_subject()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'user_roles.user_id is immutable; delete and re-grant instead'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

comment on function public.guard_user_role_subject() is
  'BEFORE UPDATE on user_roles: refuses to move a grant between accounts.';

create trigger user_roles_zz_subject_immutable
  before update on public.user_roles
  for each row execute function public.guard_user_role_subject();

revoke all on function public.guard_user_role_subject() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Self-verification
-- ---------------------------------------------------------------------------
do $$
declare
  offending text;
  n integer;
begin
  -- Both tables exist with RLS enabled and forced.
  select string_agg(t, ', ') into offending
  from unnest(array['user_roles', 'admin_audit_log']) t
  where not exists (
    select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname = t and c.relrowsecurity and c.relforcerowsecurity
  );
  if offending is not null then
    raise exception 'RLS not enabled and forced on: %', offending;
  end if;

  -- anon and PUBLIC hold nothing on either table.
  select string_agg(distinct grantee || ' on ' || table_name, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('user_roles', 'admin_audit_log')
    and grantee in ('anon', 'PUBLIC');
  if offending is not null then
    raise exception 'anon/PUBLIC hold grants: %', offending;
  end if;

  -- THE escalation control: authenticated may only SELECT user_roles.
  select string_agg(privilege_type, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'user_roles'
    and grantee = 'authenticated' and privilege_type <> 'SELECT';
  if offending is not null then
    raise exception 'authenticated can write user_roles (%). Privilege escalation is possible.', offending;
  end if;

  -- authenticated must not reach the audit log at all.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'admin_audit_log' and grantee = 'authenticated'
  ) then
    raise exception 'authenticated holds grants on admin_audit_log';
  end if;

  -- The audit log is append-only for every role that reaches it through the
  -- API. The table OWNER is excluded here for the same reason migration 13
  -- scopes its checks to the API roles: an owner always holds ALL on its own
  -- tables and cannot be revoked into safety. Immutability against the owner is
  -- the admin_audit_log_immutable trigger's job, asserted below, and a trigger
  -- is the only mechanism that binds a role holding BYPASSRLS.
  select string_agg(grantee || '.' || privilege_type, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'admin_audit_log'
    and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
    and privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE');
  if offending is not null then
    raise exception 'admin_audit_log is not append-only (%)', offending;
  end if;

  -- Exactly one policy on user_roles (select own), none on the audit log.
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'user_roles';
  if n <> 1 then
    raise exception 'expected exactly 1 policy on user_roles, found %', n;
  end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'admin_audit_log';
  if n <> 0 then
    raise exception 'expected no policies on admin_audit_log, found %', n;
  end if;

  -- Guard triggers attached.
  select string_agg(t, ', ') into offending
  from unnest(array[
    'user_roles_set_row_timestamps', 'user_roles_zz_subject_immutable',
    'admin_audit_log_immutable', 'admin_audit_log_set_created_at'
  ]) t
  where not exists (select 1 from pg_trigger where tgname = t and not tgisinternal);
  if offending is not null then
    raise exception 'missing triggers: %', offending;
  end if;

  -- The audit log must carry NO foreign key.
  --
  -- This is not a style rule, it is a regression guard for a bug that a test
  -- caught after this table was first written: an FK with ON DELETE SET NULL
  -- fires an UPDATE, the immutability trigger above refuses every UPDATE, and
  -- the two together made `delete from auth.users` fail for any account that
  -- appeared in the log — silently disabling user deletion. ON DELETE CASCADE
  -- fails differently, by erasing the evidence. Neither action is acceptable,
  -- so there is no FK at all and the ids are recorded values.
  select string_agg(conname, ', ') into offending
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace ns on ns.oid = t.relnamespace
  where ns.nspname = 'public' and t.relname = 'admin_audit_log' and c.contype = 'f';
  if offending is not null then
    raise exception
      'admin_audit_log must have no foreign keys (found: %). An FK here breaks user deletion against the immutability trigger.',
      offending;
  end if;

  -- The project-wide rule from migration 13: no function THIS MIGRATION SET
  -- owns may be SECURITY DEFINER or carry an unpinned search_path. Re-asserted
  -- here so this migration cannot be the one that breaks it. Scoped by name —
  -- a hosted Supabase project also carries platform helpers that are not ours
  -- to audit; see migration 7.
  select string_agg(p.proname, ', ') into offending
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
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

  raise notice 'Roles and admin audit log created; authenticated cannot write roles.';
end;
$$;
