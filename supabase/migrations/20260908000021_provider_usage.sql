-- AI provider usage: metadata about calls, and nothing else.
--
-- WHY THIS TABLE EXISTS
--
-- One provider call currently happens in this product — reading a résumé — and
-- more are coming: job scoring, tailoring, question answering. Each costs
-- money, each can be slow, and each can fail in a way worth counting. Without
-- somewhere to record that, "why did last month cost what it cost" and "how
-- often does extraction actually fail" are unanswerable, and the honest answer
-- to both is a shrug.
--
-- WHAT IT MUST NEVER HOLD, AND HOW THAT IS ENFORCED
--
-- Not the prompt. Not the completion. Not the résumé text. Not a candidate
-- fact. Not a key, a header or a raw provider response.
--
-- The one thing this platform sends to a third party is the text of somebody's
-- résumé, and a usage table is exactly the well-meaning "just for debugging"
-- surface that ends up holding a copy of it. So the columns below are the
-- entire vocabulary: there is no free-text column, no jsonb payload, no
-- `detail` field, and nothing a future caller could quietly stuff a prompt
-- into. `lib/ai/usage.ts` mirrors this with a `.strict()` Zod schema, and
-- scripts/test-provider-usage.mjs asserts both halves.
--
-- WHY IT IS SERVER-WRITTEN AND SERVER-READ
--
-- A row here is an assertion about what our server did and what it was
-- charged. A browser cannot know either, so `authenticated` gets no INSERT and
-- no UPDATE — only SELECT of its own rows, so a candidate can see that a call
-- was made on their behalf. Rows are append-only by trigger, because a cost
-- record that can be edited is not a cost record.
--
-- The user reference is deliberately NULLABLE and ON DELETE SET NULL: deleting
-- an account must not delete the accounting, and a usage row with no user is
-- still a true statement about money that was spent.

create table public.provider_usage (
  id uuid primary key default gen_random_uuid(),

  user_id uuid references auth.users (id) on delete set null,

  provider text not null
    constraint provider_usage_provider_allowed
    check (provider in ('openrouter')),

  model text not null
    constraint provider_usage_model_length
    check (length(model) between 1 and 200),

  operation text not null
    constraint provider_usage_operation_allowed
    check (operation in ('resume_extraction')),

  status text not null
    constraint provider_usage_status_allowed
    check (status in ('succeeded', 'failed', 'not_attempted')),

  -- The same vocabulary resume_imports uses, so an import row and a usage row
  -- describe the same event in the same words.
  failure_class text
    constraint provider_usage_failure_class_allowed
    check (failure_class is null or failure_class in ('unreadable', 'too_large', 'model_error', 'timeout')),
  failure_code text
    constraint provider_usage_failure_code_length
    check (failure_code is null or length(failure_code) between 1 and 100),

  latency_ms integer not null
    constraint provider_usage_latency_sane
    check (latency_ms between 0 and 3600000),

  attempts smallint not null
    constraint provider_usage_attempts_sane
    check (attempts between 0 and 50),

  -- Only ever what the provider reported. Never estimated locally: a guess
  -- that looks like an invoice is worse than no number, because someone will
  -- eventually reconcile against it.
  prompt_tokens integer
    constraint provider_usage_prompt_tokens_sane
    check (prompt_tokens is null or prompt_tokens >= 0),
  completion_tokens integer
    constraint provider_usage_completion_tokens_sane
    check (completion_tokens is null or completion_tokens >= 0),
  total_tokens integer
    constraint provider_usage_total_tokens_sane
    check (total_tokens is null or total_tokens >= 0),

  cost_usd numeric(12, 6)
    constraint provider_usage_cost_sane
    check (cost_usd is null or (cost_usd >= 0 and cost_usd <= 10000)),

  provider_request_id text
    constraint provider_usage_request_id_length
    check (provider_request_id is null or length(provider_request_id) between 1 and 200),

  -- Ties a call to the import it belonged to. No foreign key: usage outlives
  -- the record it describes, and accounting must not be deleted by a cascade.
  correlation_id uuid,

  created_at timestamptz not null default now(),

  -- A call that did not succeed carries a reason; a success does not pretend
  -- to have one.
  --
  -- Written against `succeeded` rather than `failed` deliberately. An earlier
  -- version said `(status = 'failed') = (failure_class is not null)`, which
  -- forbade a reason on a `not_attempted` row — and `not_attempted` is
  -- precisely the case where the reason matters most: the call was refused
  -- before it was made, because the provider was not configured. The adapter
  -- emits exactly that row, so the constraint and the code disagreed and every
  -- unconfigured call would have failed to record. CI caught it.
  constraint provider_usage_outcome_has_reason
    check ((status = 'succeeded') = (failure_class is null)),
  -- Nothing was attempted, so nothing can have been charged or counted.
  constraint provider_usage_not_attempted_is_empty
    check (
      status <> 'not_attempted'
      or (attempts = 0 and total_tokens is null and cost_usd is null and provider_request_id is null)
    )
);

comment on table public.provider_usage is
  'Metadata about AI provider calls. Never prompts, completions, résumé text, candidate facts or credentials.';

create index provider_usage_user_created_idx
  on public.provider_usage (user_id, created_at desc);
create index provider_usage_created_idx
  on public.provider_usage (created_at desc);

-- ---------------------------------------------------------------- RLS and grants

do $$
begin
  alter table public.provider_usage enable row level security;
  alter table public.provider_usage force row level security;

  revoke all on public.provider_usage from anon;
  revoke all on public.provider_usage from public;
  revoke all on public.provider_usage from authenticated;
  revoke all on public.provider_usage from service_role;

  -- A candidate may see that a call was made on their behalf, and what it
  -- cost. They may not write one: only the server knows what happened.
  grant select on public.provider_usage to authenticated;

  create policy provider_usage_select_own on public.provider_usage
    for select to authenticated
    using ((select auth.uid()) = user_id);

  -- The server writes. No UPDATE and no DELETE for anyone: a cost record that
  -- can be edited is not a cost record.
  grant select, insert on public.provider_usage to service_role;
end
$$;

-- ------------------------------------------------------------- append-only
--
-- Two dedicated functions rather than the existing helpers, for concrete
-- reasons rather than taste:
--
--   * `set_audit_created_at()` and `set_event_created_at()` both assign
--     `new.occurred_at`, and this table has no such column. Reusing either
--     would raise "record new has no field occurred_at" on EVERY insert.
--
--   * `refuse_row_update()` is a BEFORE UPDATE guard and says so in its
--     message. This table must also refuse DELETE, because `service_role`
--     holds no DELETE grant but the table OWNER always does, and a grant
--     cannot bind an owner. A trigger is the only mechanism that does.
--
-- Both follow the project rule asserted by migration 13: SECURITY INVOKER,
-- empty search_path, and no execute grant to any API role.

create or replace function public.set_provider_usage_created_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Stamped by the server, never accepted from a caller: a usage row is an
  -- accounting record, and its timestamp is not the caller's to choose.
  new.created_at := now();
  return new;
end;
$$;

comment on function public.set_provider_usage_created_at() is
  'BEFORE INSERT on provider_usage: stamps created_at server-side.';

revoke all on function public.set_provider_usage_created_at()
  from public, anon, authenticated, service_role;

create or replace function public.guard_provider_usage_immutable()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  /*
   * ONE permitted update: the foreign key anonymising a row.
   *
   * `user_id` is ON DELETE SET NULL, and that referential action is performed
   * as an UPDATE. A blanket refusal therefore does not merely block editing —
   * it blocks DELETING A USER ACCOUNT, because the FK's update is rejected and
   * the whole delete fails. CI caught exactly that.
   *
   * So the anonymisation is allowed, and nothing else is: `user_id` must be
   * going from set to null, and every other column must be byte-for-byte
   * unchanged. Comparing the rows minus `user_id` is what makes that precise
   * rather than a hopeful guess, and it means this exception cannot be used to
   * smuggle an edit through alongside a null.
   */
  if tg_op = 'UPDATE'
     and old.user_id is not null
     and new.user_id is null
     and (to_jsonb(new) - 'user_id') = (to_jsonb(old) - 'user_id')
  then
    return new;
  end if;

  raise exception 'public.provider_usage rows are append-only and cannot be %',
    lower(tg_op)
    using errcode = 'restrict_violation';
end;
$$;

comment on function public.guard_provider_usage_immutable() is
  'BEFORE UPDATE OR DELETE on provider_usage. Raises for every role, including '
  'the owner and roles that bypass RLS — a cost record that can be changed is '
  'not a cost record.';

revoke all on function public.guard_provider_usage_immutable()
  from public, anon, authenticated, service_role;

create trigger provider_usage_set_created_at
  before insert on public.provider_usage
  for each row execute function public.set_provider_usage_created_at();

create trigger provider_usage_zz_immutable
  before update or delete on public.provider_usage
  for each row execute function public.guard_provider_usage_immutable();

-- ------------------------------------------------------------- verification
--
-- Every migration in this project proves its own result and aborts if the
-- database disagrees, so a partial or wrong apply fails loudly.

do $$
declare
  offending text;
  forbidden text;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'provider_usage'
      and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'RLS not enabled and forced on provider_usage';
  end if;

  select string_agg(distinct privilege_type, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'provider_usage'
    and grantee = 'authenticated' and privilege_type <> 'SELECT';
  if offending is not null then
    raise exception 'authenticated holds unexpected privileges on provider_usage: %', offending;
  end if;

  select string_agg(distinct grantee, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'provider_usage'
    and grantee in ('anon', 'PUBLIC');
  if offending is not null then
    raise exception 'anon/PUBLIC hold grants on provider_usage: %', offending;
  end if;

  select string_agg(distinct privilege_type, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'provider_usage'
    and grantee = 'service_role' and privilege_type not in ('SELECT', 'INSERT');
  if offending is not null then
    raise exception 'service_role holds unexpected privileges on provider_usage: %', offending;
  end if;

  -- The privacy rule, asserted against the catalogue rather than trusted: no
  -- column exists that a prompt or a résumé could be put into.
  select string_agg(column_name, ', ') into forbidden
  from information_schema.columns
  where table_schema = 'public' and table_name = 'provider_usage'
    and column_name in (
      'prompt', 'system', 'user_prompt', 'messages', 'input', 'output',
      'completion', 'response', 'text', 'resume', 'resume_text', 'extracted',
      'content', 'detail', 'payload', 'api_key', 'authorization', 'headers'
    );
  if forbidden is not null then
    raise exception 'provider_usage has content-bearing column(s): %', forbidden;
  end if;

  -- No jsonb anywhere: a jsonb column is a place to hide a prompt.
  select string_agg(column_name, ', ') into forbidden
  from information_schema.columns
  where table_schema = 'public' and table_name = 'provider_usage'
    and data_type in ('json', 'jsonb');
  if forbidden is not null then
    raise exception 'provider_usage has json column(s), which could carry content: %', forbidden;
  end if;
end
$$;
