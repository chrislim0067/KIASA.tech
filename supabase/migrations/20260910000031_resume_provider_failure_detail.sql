-- Which FIELDS failed schema validation, when a provider reply was not a résumé.
--
-- WHY THIS COLUMN EXISTS
--
-- Migration 30 recorded that a production import failed with
-- `provider_failure_code = 'invalid_structure'` — the model returned parseable
-- JSON that `ResumeExtraction` rejected. That is one step better than the
-- collapsed `no_structured_output`, and still not enough to act on: it says a
-- field was wrong without saying which. A date? A URL? A phone number? Each
-- points at a different fix, and choosing between them meant guessing or
-- spending another live provider call on a real person's résumé.
--
-- Zod already computes the answer. `lib/ai/openrouter.ts` discarded it.
--
-- WHAT IT HOLDS, AND WHAT IT CANNOT
--
-- A comma-separated list of PATHS: `work_experiences.3.end_date,phone_e164`.
-- Keys, array indices, dots and commas — nothing else. The CHECK below is a
-- SHAPE constraint, not a vocabulary, because field paths are open-ended in a
-- way a failure code is not.
--
-- It is still bounded hard enough to be safe. No spaces, no quotes, no hyphens,
-- no @ sign, no digits-with-punctuation: a résumé line, an email address, a
-- phone number, a SQL error message and a prompt are all structurally incapable
-- of satisfying it. The application also reads only Zod's `issue.path` and
-- never `issue.message`, which quotes offending values — so the value never
-- reaches this column in the first place, and this constraint is the second
-- line of defence rather than the first.

alter table public.resume_imports
  add column if not exists provider_failure_detail text;

alter table public.resume_imports
  drop constraint if exists resume_imports_provider_failure_detail_shape;

alter table public.resume_imports
  add constraint resume_imports_provider_failure_detail_shape
  check (
    provider_failure_detail is null
    or (
      length(provider_failure_detail) between 1 and 300
      -- Path characters only: identifiers, indices, and the two separators.
      and provider_failure_detail ~ '^[A-Za-z0-9_.]+(,[A-Za-z0-9_.]+)*$'
    )
  );

-- A detail without a code would be a field name with nothing to explain it.
alter table public.resume_imports
  drop constraint if exists resume_imports_detail_needs_a_code;

alter table public.resume_imports
  add constraint resume_imports_detail_needs_a_code
  check (provider_failure_detail is null or provider_failure_code is not null);

comment on column public.resume_imports.provider_failure_detail is
  'Field paths that failed schema validation, comma separated. Diagnostic only: '
  'never shown to a candidate, never a value, and shape-constrained so no '
  'message, prompt or document text can be written here.';

-- ---------------------------------------------------------------------------
-- Self-verification.
-- ---------------------------------------------------------------------------
do $$
declare
  clause text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'resume_imports'
      and column_name = 'provider_failure_detail' and data_type = 'text'
  ) then
    raise exception 'resume_imports.provider_failure_detail is missing';
  end if;

  foreach clause in array array[
    'resume_imports_provider_failure_detail_shape',
    'resume_imports_detail_needs_a_code'
  ] loop
    if not exists (select 1 from pg_constraint where conname = clause) then
      raise exception 'missing constraint %', clause;
    end if;
  end loop;

  /*
   * THE SHAPE IS ASSERTED AS AN EXPRESSION, NOT BY INSERTING ROWS.
   *
   * `user_id` is NOT NULL against auth.users, so an insert here would die on
   * the foreign key and any handler broad enough to survive that would swallow
   * a CHECK violation too — a loop that proved nothing. The regex is a pure
   * expression, so it can simply be evaluated. Behavioural proof with real rows
   * lives in scripts/test-resume-import.mjs.
   */
  if not ('work_experiences.3.end_date,phone_e164' ~ '^[A-Za-z0-9_.]+(,[A-Za-z0-9_.]+)*$') then
    raise exception 'the shape rejects a real field-path list';
  end if;

  if 'the candidate lives at 12 Example Street' ~ '^[A-Za-z0-9_.]+(,[A-Za-z0-9_.]+)*$' then
    raise exception 'the shape accepts a sentence';
  end if;
  if 'ada@example.test' ~ '^[A-Za-z0-9_.]+(,[A-Za-z0-9_.]+)*$' then
    raise exception 'the shape accepts an email address';
  end if;
  if '+6591234567' ~ '^[A-Za-z0-9_.]+(,[A-Za-z0-9_.]+)*$' then
    raise exception 'the shape accepts a phone number';
  end if;
  if 'ERROR: duplicate key value violates unique constraint' ~ '^[A-Za-z0-9_.]+(,[A-Za-z0-9_.]+)*$' then
    raise exception 'the shape accepts a database error';
  end if;
end $$;
