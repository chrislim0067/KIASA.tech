-- Completes the L1 "no blank entries" fix and removes a dead helper.
--
-- Step 2G found the previous rule incomplete: it used btrim(x) = '', and
-- single-argument btrim strips ONLY the space character (U+0020). A tab-only,
-- newline-only or non-breaking-space-only entry therefore passed as "not
-- blank". Measured on the local database:
--
--     btrim('   ') = ''    -> true   (space caught)
--     btrim(E'\t')  = ''   -> false  (tab NOT caught)
--     btrim(E'\n'), btrim(E'\r'), btrim(NBSP) -> all false
--
-- That mattered most for automation_settings.allowed_titles, which is an
-- ALLOWLIST: if future matching logic reads a blank entry as "match anything",
-- a tab-only entry fails open — exactly the hole the original fix targeted.
-- Fourteen array constraints and the other_links labels shared the flaw.
--
-- Append-only: the existing migrations keep their identifiers and are not
-- rewritten. The two central helpers are replaced in place with CREATE OR
-- REPLACE, so all fourteen constraints inherit the corrected behaviour without
-- being redefined one by one, and their existing grants are preserved.

-- ---------------------------------------------------------------------------
-- The blank rule
-- ---------------------------------------------------------------------------
-- A value is blank when, after deleting every character in an explicit
-- invisible-character set, nothing remains.
--
-- Why translate() and not btrim() or [[:space:]]:
--
--   * btrim(x) with one argument strips only U+0020. Demonstrated above.
--   * The regex class [[:space:]] resolves through the collation/ctype of the
--     database, so which code points it covers is not fixed by this migration.
--     It also does not include zero-width characters such as U+200B or U+FEFF,
--     which are invisible but are not "space" by any ctype definition.
--   * translate(value, set, '') performs exact code-point matching against a
--     literal we spell out here. It depends on no locale, no collation and no
--     regex flavour, so the behaviour is identical on every server that runs
--     this migration. Every character is written as a Unicode escape, so the
--     rule is legible and reviewable rather than hidden in invisible bytes.
--
-- Crucially this only ever evaluates a predicate. translate() is applied to a
-- copy inside the check; the value the user submitted is stored byte-for-byte
-- and is never trimmed, normalised or otherwise altered.
--
-- The set is the list required by the review plus three additions that are
-- invisible by the same reasoning — U+1680 ogham space mark (a space character
-- that renders blank in most fonts), U+200C zero-width non-joiner and U+200D
-- zero-width joiner. All 28 code points, in the order they appear in the
-- literal below:
--
-- U+0020 space, U+0009 tab, U+000A line feed, U+000B vertical tab,
-- U+000C form feed, U+000D carriage return, U+00A0 no-break space,
-- U+1680 ogham space mark, U+2000-U+200A (en/em quad, en/em space, three-per-em,
-- four-per-em, six-per-em, figure, punctuation, thin and hair spaces),
-- U+200B zero-width space, U+200C zero-width non-joiner,
-- U+200D zero-width joiner, U+2028 line separator, U+2029 paragraph separator,
-- U+202F narrow no-break space, U+205F medium mathematical space,
-- U+3000 ideographic space, U+FEFF byte-order mark / zero-width no-break space.
--
-- A string is rejected only when it is composed ENTIRELY of these. Any visible
-- character anywhere — ASCII, accented Latin, CJK, emoji — keeps it valid, so
-- "Software Engineer", "Ingénieur logiciel" and "软件工程师" all pass, and a
-- value is never rejected merely for containing a non-ASCII character.
create or replace function public.is_blank_or_invisible(value text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  -- One literal on one line on purpose: two adjacent U&'' literals are not a
  -- valid continuation, and a line break inside the set would be easy to
  -- misread. Every code point is escaped, so the line contains no invisible
  -- byte and can be reviewed character by character.
  select value is null
      or translate(
           value,
           U&'\0020\0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\200B\200C\200D\2028\2029\202F\205F\3000\FEFF',
           ''
         ) = '';
$$;

comment on function public.is_blank_or_invisible(text) is
  'True when the value is null or consists only of whitespace/invisible code '
  'points. Uses exact translate() matching, not btrim() or [[:space:]], so the '
  'result does not vary with locale. Never modifies stored data.';

-- ---------------------------------------------------------------------------
-- Route the centralised helpers through it
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE keeps each function's OID, so every CHECK constraint that
-- already references it picks up the new behaviour with no constraint changes.
-- Note that PostgreSQL does not re-validate existing rows when a function body
-- changes; that is immaterial here because the schema has never been deployed
-- and holds no rows.
create or replace function public.text_array_ok(arr text[], max_items integer, max_len integer)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select arr is null
     or (
       coalesce(array_length(arr, 1), 0) <= max_items
       and not exists (
         select 1 from unnest(arr) as element
         where element is null
            or public.is_blank_or_invisible(element)
            or length(element) > max_len
       )
     );
$$;

create or replace function public.jsonb_links_ok(links jsonb, max_items integer, max_url integer, max_label integer)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select links is null
     or (
       jsonb_typeof(links) = 'array'
       and jsonb_array_length(links) <= max_items
       and not exists (
         select 1
         from jsonb_array_elements(links) as element
         where jsonb_typeof(element) <> 'object'
            or coalesce(element ->> 'url', '') !~* '^https?://'
            or length(element ->> 'url') > max_url
            -- NULL label (key absent) is blank by definition of the helper.
            or public.is_blank_or_invisible(element ->> 'label')
            or length(element ->> 'label') > max_label
       )
     );
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
-- is_blank_or_invisible is called *from inside* text_array_ok and
-- jsonb_links_ok, both SECURITY INVOKER. A nested call in an invoker-rights
-- function runs as the original caller, so EXECUTE is checked against that
-- caller — the authenticated user performing the INSERT. Without this grant
-- every write touching a constrained array or other_links would fail with
-- "permission denied for function is_blank_or_invisible".
--
-- That is the entire justification: nothing broader is granted. The function
-- reads no table, so it cannot be used to reach another user's data, and it is
-- closed to PUBLIC, anon and service_role.
revoke all on function public.is_blank_or_invisible(text) from public, anon, authenticated, service_role;
grant execute on function public.is_blank_or_invisible(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Remove the dead helper
-- ---------------------------------------------------------------------------
-- text_array_no_blanks was superseded by text_array_ok in migration 10, which
-- dropped and replaced every constraint that used it. Confirmed at Step 2G to
-- be referenced by zero constraints. Dropped rather than left revoked: an
-- unused function is still an RPC surface and still something a future author
-- could wire up believing it enforces the corrected rule, which it does not.
do $$
declare
  users text;
begin
  -- Refuse to drop it if anything still depends on it.
  select string_agg(distinct t.relname || '.' || c.conname, ', ')
    into users
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and pg_get_constraintdef(c.oid) like '%text_array_no_blanks%';
  if users is not null then
    raise exception 'text_array_no_blanks is still referenced by: %', users;
  end if;

  -- p.prosrc, not pg_get_functiondef(p.oid): the planner is free to evaluate a
  -- function call in the WHERE clause before the nspname filter, and
  -- pg_get_functiondef() raises on an aggregate such as pg_catalog.array_agg.
  -- prosrc is a plain column, so it cannot raise and cannot be reordered into
  -- an error. prokind = 'f' keeps this to ordinary functions regardless.
  select string_agg(p.proname, ', ') into users
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.proname <> 'text_array_no_blanks'
    and p.prosrc like '%text_array_no_blanks%';
  if users is not null then
    raise exception 'text_array_no_blanks is still called by: %', users;
  end if;
end;
$$;

drop function if exists public.text_array_no_blanks(text[]);

-- ---------------------------------------------------------------------------
-- Self-verification
-- ---------------------------------------------------------------------------
do $$
declare
  ch text;
  offending text;
  invisible_samples text[] := array[
    ' ', E'\t', E'\n', E'\r', E'\x0C', E'\x0B',
    U&'\00A0', U&'\1680', U&'\2000', U&'\2002', U&'\2003', U&'\2009', U&'\200A',
    U&'\200B', U&'\200C', U&'\200D', U&'\2028', U&'\2029', U&'\202F', U&'\205F',
    U&'\3000', U&'\FEFF'
  ];
  visible_samples text[] := array[
    'Software Engineer', 'Senior Software Engineer', 'a',
    'Ingénieur logiciel', '软件工程师', 'Разработчик', 'مهندس برمجيات',
    U&'\00A0' || 'Engineer', 'Engineer' || U&'\200B'
  ];
begin
  -- Every invisible-only sample must be blank, alone and repeated.
  foreach ch in array invisible_samples loop
    if not public.is_blank_or_invisible(ch) then
      raise exception 'invisible character U+% not treated as blank', upper(to_hex(ascii(ch)));
    end if;
    if not public.is_blank_or_invisible(ch || ch || ch) then
      raise exception 'repeated invisible character U+% not treated as blank', upper(to_hex(ascii(ch)));
    end if;
  end loop;

  -- The empty string is blank; every visible sample is not.
  if not public.is_blank_or_invisible('') then
    raise exception 'empty string should be blank';
  end if;
  foreach ch in array visible_samples loop
    if public.is_blank_or_invisible(ch) then
      raise exception 'visible value "%" wrongly treated as blank', ch;
    end if;
  end loop;

  -- The centralised helpers must reject an invisible-only element.
  if public.text_array_ok(array[E'\t'], 10, 100) then
    raise exception 'text_array_ok still accepts a tab-only element';
  end if;
  if public.text_array_ok(array[U&'\FEFF'], 10, 100) then
    raise exception 'text_array_ok still accepts a BOM-only element';
  end if;
  if not public.text_array_ok(array['Software Engineer', '软件工程师'], 10, 100) then
    raise exception 'text_array_ok rejects legitimate visible titles';
  end if;
  if public.jsonb_links_ok(jsonb_build_array(jsonb_build_object('label', E'\t', 'url', 'https://e.com')), 20, 2048, 200) then
    raise exception 'jsonb_links_ok still accepts a tab-only label';
  end if;
  if not public.jsonb_links_ok(jsonb_build_array(jsonb_build_object('label', 'My Portfolio', 'url', 'https://e.com')), 20, 2048, 200) then
    raise exception 'jsonb_links_ok rejects a legitimate label';
  end if;

  -- All fourteen array constraints must route through the corrected helper.
  select count(*)::text into offending
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public' and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%text_array_ok%';
  if offending <> '14' then
    raise exception 'expected 14 constraints using text_array_ok, found %', offending;
  end if;

  -- The dead helper must be gone.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'text_array_no_blanks') then
    raise exception 'text_array_no_blanks was not dropped';
  end if;

  raise notice 'Whitespace rule verified across 14 constraints; dead helper removed.';
end;
$$;
