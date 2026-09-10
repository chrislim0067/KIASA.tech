-- Widen `provider_usage.operation` to every capability OpenRouter can serve.
--
-- Migration 21 created the table when résumé extraction was the only provider
-- call, so its CHECK listed one value. Milestone 2C added job scoring and was
-- not permitted to touch migrations, which left the TypeScript vocabulary and
-- the database constraint deliberately out of step — a gap the writer had to
-- refuse up front. This closes it.
--
-- WHAT THE LIST IS DERIVED FROM
--
-- Exactly `AI_CAPABILITIES` in lib/agent/ai-mode.ts, MINUS
-- `eligibility_evaluation`. Eligibility is decided by deterministic rules and
-- never reaches a provider, so an eligibility usage row would be a record of
-- something that cannot happen — and `EligibilityDecision.evaluator` is a
-- z.literal('deterministic_rules'), so the contract cannot express it either.
--
-- The three candidate-voice capabilities ARE included, and that is not an
-- oversight. In `claude_max_assisted` they run on the candidate's own machine
-- and produce no usage row at all — a local call has no provider, no key and
-- no cost to record. In `openrouter_only` the same three are ordinary provider
-- calls, and those rows are legitimate. The mode decides; the vocabulary
-- covers both.
--
-- `scripts/test-openrouter-gateway.mjs` parses the constraint below and
-- asserts it matches `PROVIDER_OPERATIONS` in both directions, so the two
-- cannot drift without a failing test.
--
-- STILL A CLOSED VOCABULARY. This widens a list; it does not become free text.
-- An unrecognised operation is still rejected by the database, which is the
-- point of having the constraint at all.
--
-- SCOPE: one constraint on one table. No other table, column, policy, grant,
-- trigger or migration is touched, and no data is rewritten — a CHECK change
-- validates existing rows rather than modifying them.

alter table public.provider_usage
  drop constraint if exists provider_usage_operation_allowed;

alter table public.provider_usage
  add constraint provider_usage_operation_allowed
  check (operation in (
    'resume_extraction',
    'resume_analysis',
    'job_scanning',
    'job_analysis',
    'job_scoring',
    'structured_task_creation',
    'resume_tailoring',
    'application_answer_generation',
    'candidate_profile_drafting'
  ));

-- ---------------------------------------------------------------------------
-- Self-verification. This migration ABORTS rather than leaving the constraint
-- half-applied, following migrations 7, 13, 21 and 22.
-- ---------------------------------------------------------------------------
do $$
declare
  definition text;
  expected text[] := array[
    'resume_extraction', 'resume_analysis', 'job_scanning', 'job_analysis',
    'job_scoring', 'structured_task_creation', 'resume_tailoring',
    'application_answer_generation', 'candidate_profile_drafting'
  ];
  missing text;
  n integer;
begin
  select pg_get_constraintdef(c.oid) into definition
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace ns on ns.oid = t.relnamespace
  where ns.nspname = 'public'
    and t.relname = 'provider_usage'
    and c.conname = 'provider_usage_operation_allowed';

  if definition is null then
    raise exception 'provider_usage_operation_allowed is missing';
  end if;

  -- Every intended value is listed.
  foreach missing in array expected loop
    if position(quote_literal(missing) in definition) = 0 then
      raise exception 'operation % is not permitted by the constraint', missing;
    end if;
  end loop;

  -- And nothing beyond them: a constraint that accepts an unlisted value is
  -- not a closed vocabulary. Counts the quoted literals in the definition.
  select count(*) into n
  from regexp_matches(definition, '''([a-z_]+)''', 'g');
  if n <> array_length(expected, 1) then
    raise exception 'constraint lists % values, expected %', n, array_length(expected, 1);
  end if;

  -- Eligibility must NOT be persistable: it never reaches a provider.
  if position('''eligibility_evaluation''' in definition) > 0 then
    raise exception 'eligibility_evaluation must never be a provider operation';
  end if;

  -- The protections from migration 21 are still in force. A constraint swap
  -- must not have disturbed row security, the grants, or immutability.
  if not exists (
    select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname = 'provider_usage'
      and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'provider_usage lost RLS';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'provider_usage'
      and grantee in ('anon', 'PUBLIC')
  ) then
    raise exception 'provider_usage granted to anon or PUBLIC';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'provider_usage'
      and grantee = 'authenticated' and privilege_type <> 'SELECT'
  ) then
    raise exception 'authenticated holds more than SELECT on provider_usage';
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'provider_usage_zz_immutable'
  ) then
    raise exception 'the provider_usage immutability trigger is missing';
  end if;
end $$;
