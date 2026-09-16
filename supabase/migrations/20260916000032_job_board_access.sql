-- The second gate: who may see the shared job board.
--
-- Joining KIASA is one decision, made in `user_access`. Seeing the job board is
-- a SECOND one, made here. An administrator approving a signup is saying "you
-- may use the product"; they are not thereby saying "you may read the postings
-- the extension has collected". Those are different questions and this table
-- keeps them different, so approving somebody for KIASA can never silently hand
-- them the board as well.
--
-- WHY ITS OWN TABLE RATHER THAN A COLUMN ON user_access
--
-- The same reasoning that put `user_access` beside `user_roles` instead of
-- inside it. A column would mean the row that grants entry is also the row that
-- grants the board, so a re-decision on one would touch the other, and the
-- audit trail for "when did they get the board" would be indistinguishable from
-- "when were they let in". They also revoke independently: taking the board
-- away is not a reason to lock somebody out of the product.
--
-- ABSENCE MEANS NO ACCESS
--
-- The third table in this schema to follow that rule, and for the third time it
-- is the only safe direction. There is no backfill: every existing account has
-- no row and therefore no board. A gate that admitted everyone the day it was
-- introduced would not be a gate.
--
-- WHY THERE IS NO 'pending'
--
-- `user_access` has one because a signup arrives on its own and waits. Nobody
-- arrives at this table on their own — a row exists only because an
-- administrator wrote it. So every row carries a decision, and `decided_at` is
-- NOT NULL rather than conditionally null.

create table public.job_board_access (
  user_id uuid primary key references auth.users (id) on delete cascade,

  status text not null
    constraint job_board_access_status_allowed check (status in ('granted', 'revoked')),

  -- Who decided, and when. Not a foreign key, for the same reason
  -- admin_audit_log carries none: the decision outlives the deciding account.
  decided_by uuid,
  decided_at timestamptz not null default now(),

  -- An administrator's note about why. Unlike a rejection reason this is not
  -- withheld from anyone in particular; it is simply not shown in the product.
  reason text
    constraint job_board_access_reason_length check (reason is null or length(reason) <= 500),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.job_board_access is
  'Second approval gate, separate from user_access: who may read the shared job '
  'board at /job-board. Absence of a row means no access.';

comment on column public.job_board_access.status is
  'granted or revoked. A revoked row is kept rather than deleted so the history '
  'of a withdrawn grant survives in the table as well as in the audit log.';

create index job_board_access_status_idx on public.job_board_access (status);
create index job_board_access_decided_idx on public.job_board_access (decided_at desc);

-- ---------------------------------------------------------------------------
-- RLS, grants and policies
-- ---------------------------------------------------------------------------
do $$
begin
  alter table public.job_board_access enable row level security;
  alter table public.job_board_access force row level security;

  revoke all on public.job_board_access from anon;
  revoke all on public.job_board_access from public;
  revoke all on public.job_board_access from authenticated;
  revoke all on public.job_board_access from service_role;

  -- A candidate may read their OWN grant and nothing else. That is what lets
  -- the page tell them where they stand without an elevated credential, exactly
  -- as `user_access` does for the waiting screen.
  grant select on public.job_board_access to authenticated;

  create policy job_board_access_select_own on public.job_board_access
    for select to authenticated
    using ((select auth.uid()) = user_id);

  -- No INSERT, UPDATE or DELETE for `authenticated`. Granting yourself the
  -- board is the threat this table exists to prevent, and the privilege to
  -- attempt it does not exist.

  -- Decisions are written by a server route handler holding the secret key,
  -- after guardApi('jobboard.grant') has already passed.
  grant select, insert, update, delete on public.job_board_access to service_role;
end;
$$;

create trigger job_board_access_set_row_timestamps
  before insert or update on public.job_board_access
  for each row execute function public.set_row_timestamps();

-- The subject of a decision may never be reassigned, mirroring
-- guard_user_access_subject() on user_access and guard_user_role_subject() on
-- user_roles. Moving a grant between accounts would be a privilege transfer
-- that leaves no trace in the audit log, because no grant action was recorded.
create or replace function public.guard_job_board_access_subject()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'job_board_access.user_id is immutable; delete and re-decide instead'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

comment on function public.guard_job_board_access_subject() is
  'BEFORE UPDATE on job_board_access: refuses to move a grant between accounts.';

create trigger job_board_access_zz_subject_immutable
  before update on public.job_board_access
  for each row execute function public.guard_job_board_access_subject();

revoke all on function public.guard_job_board_access_subject() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Audit vocabulary
-- ---------------------------------------------------------------------------
-- The action list is a CHECK, so granting and revoking have to be added to it
-- before the audit writer can record them. Kept in step with AUDIT_ACTIONS in
-- lib/admin/audit.ts.
alter table public.admin_audit_log
  drop constraint admin_audit_log_action_allowed;

alter table public.admin_audit_log
  add constraint admin_audit_log_action_allowed
  check (action in (
    'user.invited',
    'user.invite_resent',
    'user.deleted',
    'user.role_granted',
    'user.role_revoked',
    'user.approved',
    'user.rejected',
    'user.access_reset',
    'user.job_board_granted',
    'user.job_board_revoked',
    'admin.bootstrapped'
  ));

-- ---------------------------------------------------------------------------
-- Self-verification
-- ---------------------------------------------------------------------------
-- Everything above is worthless if a later edit quietly loosens it, so the
-- migration proves its own result before it commits.
do $$
declare
  n integer;
begin
  if not exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename = 'job_board_access' and rowsecurity
  ) then
    raise exception 'job_board_access does not have row level security enabled';
  end if;

  -- `authenticated` may read and nothing more. Any write privilege here would
  -- let a candidate grant themselves the board through PostgREST.
  select count(*) into n
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = 'job_board_access'
    and grantee = 'authenticated'
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE');

  if n > 0 then
    raise exception 'authenticated holds % write privilege(s) on job_board_access', n;
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'job_board_access'
      and grantee in ('anon', 'PUBLIC')
  ) then
    raise exception 'anon or PUBLIC holds a privilege on job_board_access';
  end if;

  -- No backfill: a new gate that starts open is not a gate.
  select count(*) into n from public.job_board_access;
  if n > 0 then
    raise exception 'job_board_access should start empty, found % row(s)', n;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'admin_audit_log_action_allowed'
      and pg_get_constraintdef(oid) like '%user.job_board_granted%'
  ) then
    raise exception 'the audit vocabulary was not extended';
  end if;
end;
$$;
