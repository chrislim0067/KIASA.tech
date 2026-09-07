-- Step 2: candidate profile and decision memory — helpers.
--
-- No extensions are required. gen_random_uuid() is built into PostgreSQL 13+
-- (Supabase runs 15+), so pgcrypto is deliberately not installed: fewer
-- extensions is less surface to keep patched.

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER (the default) so the function can never be used to escalate
-- privilege, and an explicitly empty search_path so a caller cannot shadow the
-- identifiers it resolves. With search_path = '' everything must be schema
-- qualified; only pg_catalog operators and the built-in now() remain reachable.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at. search_path is empty by design.';

-- ---------------------------------------------------------------------------
-- Element-wise validation for text[] columns
-- ---------------------------------------------------------------------------
-- A CHECK constraint may not contain a subquery, so validating every element of
-- an array needs an IMMUTABLE helper. Immutability is what makes it legal in a
-- CHECK: unnest and the regex operator are both immutable, so the result
-- depends only on the arguments.
create or replace function public.text_array_matches(arr text[], pattern text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select arr is null
      or not exists (select 1 from unnest(arr) as element where element !~ pattern);
$$;

comment on function public.text_array_matches(text[], text) is
  'True when every element matches pattern. IMMUTABLE so it is usable in CHECK.';

-- Rejects '' and whitespace-only entries in free-text arrays such as
-- desired_titles, so a stray blank cannot become a match-everything rule.
create or replace function public.text_array_no_blanks(arr text[])
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select arr is null
      or not exists (select 1 from unnest(arr) as element where element is null or btrim(element) = '');
$$;

comment on function public.text_array_no_blanks(text[]) is
  'True when no element is null, empty or whitespace-only. IMMUTABLE.';

-- ---------------------------------------------------------------------------
-- Function EXECUTE privileges (least privilege, established by testing)
-- ---------------------------------------------------------------------------
-- Two separate defaults conspire to over-grant here:
--   1. PostgreSQL grants EXECUTE on a new function to PUBLIC.
--   2. Supabase's default privileges grant it to anon, authenticated and
--      service_role as well.
-- Left alone, a signed-out visitor could call every one of these.
--
-- Revoke first, then grant back only what was proven necessary:
--
--   set_updated_at        NO grant. EXECUTE on a trigger function is checked
--                         when CREATE TRIGGER runs (as the owner), not when the
--                         trigger fires. Verified: updates still stamp
--                         updated_at with EXECUTE denied to PUBLIC, anon and
--                         authenticated.
--
--   text_array_matches    GRANT to authenticated. These are evaluated inside
--   text_array_no_blanks  CHECK constraints in the *inserting user's* context,
--                         so without EXECUTE every INSERT/UPDATE touching a
--                         validated array column fails with
--                         "permission denied for function". Verified by
--                         revoking and watching 23 tests fail.
--
-- service_role is revoked too. No application code holds that key — the app
-- reaches this data only as an ordinary authenticated user — so leaving it a
-- standing RLS-bypassing grant would be privilege kept "just in case". The
-- database owner retains everything, which is what migrations and maintenance
-- actually run as.

revoke all on function public.set_updated_at() from public, anon, authenticated, service_role;
revoke all on function public.text_array_matches(text[], text) from public, anon, authenticated, service_role;
revoke all on function public.text_array_no_blanks(text[]) from public, anon, authenticated, service_role;

grant execute on function public.text_array_matches(text[], text) to authenticated;
grant execute on function public.text_array_no_blanks(text[]) to authenticated;
