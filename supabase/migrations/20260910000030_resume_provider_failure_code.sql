-- Preserve the EXACT provider outcome on a failed résumé import.
--
-- WHY THIS COLUMN EXISTS
--
-- `resume_imports.failure_code` carries the CANDIDATE-FACING taxonomy: which
-- stage failed, in language that maps to a sentence a person is shown. Five
-- genuinely different provider outcomes —
--
--     reasoning_only     the model thought and never answered
--     refused            the model declined
--     no_content         the reply had no content at all
--     malformed_json     the content was not JSON
--     invalid_structure  it was JSON, and not a résumé
--
-- all collapse into the single value `no_structured_output`, because to a
-- candidate they mean the same thing: try the paste console instead. That
-- collapse is right for the person and useless for the operator. A production
-- import failed and there was no way to learn which of the five it was: the
-- specific code was computed in `lib/ai/openrouter.ts`, returned, and dropped.
--
-- So the exact code is stored beside the collapsed one, rather than instead of
-- it. Both questions get an answer, and neither has to be inferred.
--
-- WHY A SEPARATE COLUMN RATHER THAN WIDENING `failure_code`
--
-- `failure_code` is `text` with a length check and nothing else. Overloading it
-- would put two vocabularies in one column, so no reader could tell which it
-- was looking at, and would silently change the meaning of every row already
-- written. This column holds ONE vocabulary and the database enforces it.
--
-- WHAT IT CANNOT HOLD
--
-- A CHECK constraint pins it to thirteen literals. There is no free-text
-- diagnostic column here and there must never be one: a column that accepts
-- arbitrary text is a column a provider message, a prompt, a SQL error or a
-- line of someone's résumé will eventually be written into. A value outside
-- the list is rejected by the database, not sanitised by application code.

alter table public.resume_imports
  add column if not exists provider_failure_code text;

alter table public.resume_imports
  drop constraint if exists resume_imports_provider_failure_code_allowed;

alter table public.resume_imports
  add constraint resume_imports_provider_failure_code_allowed
  check (
    provider_failure_code is null
    or provider_failure_code in (
      -- Transport and configuration, before the model was reached.
      'not_configured',
      'timeout',
      'rate_limited',
      'auth_failed',
      'bad_request',
      'server_error',
      'connection_failed',
      -- The model answered, or failed to.
      'no_content',
      'output_truncated',
      'reasoning_only',
      'refused',
      'malformed_json',
      'invalid_structure'
    )
  );

-- A provider outcome belongs only to a row that actually failed. A parsed or
-- confirmed import carrying one would mean the two columns disagree about
-- whether anything went wrong.
alter table public.resume_imports
  drop constraint if exists resume_imports_provider_code_only_when_failed;

alter table public.resume_imports
  add constraint resume_imports_provider_code_only_when_failed
  check (provider_failure_code is null or status = 'failed');

comment on column public.resume_imports.provider_failure_code is
  'Exact bounded provider outcome for a failed import. Diagnostic only: never '
  'shown to a candidate, and constrained to a closed vocabulary so no message, '
  'prompt or document text can be written here.';

-- ---------------------------------------------------------------------------
-- Self-verification. A migration that cannot prove it did what it says is a
-- migration that quietly does not.
-- ---------------------------------------------------------------------------
do $$
declare
  expected text[] := array[
    'auth_failed', 'bad_request', 'connection_failed', 'invalid_structure',
    'malformed_json', 'no_content', 'not_configured', 'output_truncated',
    'rate_limited', 'reasoning_only', 'refused', 'server_error', 'timeout'
  ];
  found    text[];
  clause   text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'resume_imports'
      and column_name = 'provider_failure_code' and data_type = 'text'
  ) then
    raise exception 'resume_imports.provider_failure_code is missing';
  end if;

  -- The candidate-facing column keeps its own meaning and is untouched.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'resume_imports'
      and column_name = 'failure_code'
  ) then
    raise exception 'failure_code was removed; the two vocabularies are separate';
  end if;

  foreach clause in array array[
    'resume_imports_provider_failure_code_allowed',
    'resume_imports_provider_code_only_when_failed'
  ] loop
    if not exists (select 1 from pg_constraint where conname = clause) then
      raise exception 'missing constraint %', clause;
    end if;
  end loop;

  /*
   * THE VOCABULARY IS COMPARED AS A SET, NOT MATCHED AS TEXT.
   *
   * `provider_failure_code in ('a', 'b')` is stored by Postgres as a normalised
   * expression, so the literals can be pulled back out and compared exactly.
   * A regex asking "does the constraint mention reasoning_only" would pass on a
   * constraint that had gained a fourteenth member or lost a thirteenth; this
   * fails on both, because it compares the whole sorted set.
   *
   * Behavioural proof — that a real row actually stores and reads back each
   * code — belongs in scripts/test-resume-import.mjs, which runs against real
   * Postgres with a real user. It cannot live here: `user_id` is NOT NULL and
   * references auth.users, so an insert in this block would die on the foreign
   * key and an exception handler broad enough to survive that would swallow the
   * CHECK violation too, leaving a loop that proves nothing.
   */
  select array_agg(m[1] order by m[1]) into found
  from (
    select regexp_matches(pg_get_constraintdef(oid), '''([a-z_]+)''::text', 'g') as m
    from pg_constraint
    where conname = 'resume_imports_provider_failure_code_allowed'
  ) s;

  if found is distinct from expected then
    raise exception 'the provider vocabulary is wrong: got %, expected %',
      coalesce(array_to_string(found, ','), 'none'),
      array_to_string(expected, ',');
  end if;
end $$;
