-- Correct the `user_access.reason` comment.
--
-- Migration 18 documented the column as "Shown to the administrator, never to
-- the applicant". That was the intent of the UI at the time, but it was never
-- true of the data: `user_access_select_own` grants a user SELECT on their own
-- row, every column of it, so a rejected person could always read their own
-- reason straight from PostgREST. The UI simply did not display it.
--
-- The product decision is now to show it, which makes the behaviour honest
-- rather than merely apparent. Comments are documentation other engineers act
-- on, so a comment that misstates who can read a column is a trap — this
-- rewrites it to say what is actually the case.
--
-- Comment-only. No table, policy, grant or constraint changes.

comment on column public.user_access.reason is
  'Rejection reason. VISIBLE TO THE SUBJECT: the select-own policy covers this '
  'column, and the waiting screen displays it. Write it as something the '
  'applicant should read, never as a private note.';

do $$
declare
  current_comment text;
begin
  select col_description(
           (select oid from pg_class where relname = 'user_access'
              and relnamespace = 'public'::regnamespace),
           (select attnum from pg_attribute
             where attrelid = 'public.user_access'::regclass and attname = 'reason')
         )
    into current_comment;

  if current_comment is null or current_comment not like '%VISIBLE TO THE SUBJECT%' then
    raise exception 'user_access.reason comment was not updated';
  end if;

  -- The claim the comment now makes must actually hold: the subject can read
  -- their own row. If that policy were ever removed the comment would become
  -- wrong in the other direction.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_access'
      and cmd = 'SELECT' and policyname = 'user_access_select_own'
  ) then
    raise exception 'user_access_select_own is missing; the comment would be wrong';
  end if;

  raise notice 'user_access.reason documented as subject-visible.';
end;
$$;
