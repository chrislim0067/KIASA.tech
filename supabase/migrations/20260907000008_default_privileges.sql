-- Durable default-privilege hardening.
--
-- Everything before this migration fixed the privileges on objects that already
-- exist. This closes the door for objects that do not exist yet: without it,
-- the next migration to add a table, function or sequence silently hands
-- anon/authenticated/service_role access to it, and the mistake is only caught
-- if someone remembers to look.
--
-- Two separate defaults are at work in a Supabase database:
--
--   1. PostgreSQL's own built-in default, which grants EXECUTE on every new
--      function to PUBLIC. This is NOT recorded in pg_default_acl — the
--      schema-scoped entry Supabase installs lists anon/authenticated/
--      service_role but no PUBLIC row, and functions created under it still
--      came out with "=X" (PUBLIC). It is applied on top and therefore has to
--      be revoked explicitly; assuming the schema-specific entry covered it
--      would leave every future function world-executable.
--
--   2. Supabase's own ALTER DEFAULT PRIVILEGES entries, which grant ALL on
--      tables and sequences and EXECUTE on functions to the three API roles.
--
-- Both are addressed below.
--
-- Scope: default privileges are recorded per (creating role, schema), so these
-- statements are issued FOR the role actually running the migration. Our
-- migrations run as `postgres` both locally and via `db push`, so the role that
-- matters is covered.
--
-- KNOWN LIMITATION — objects created by supabase_admin are NOT covered.
-- Supabase installs a second default-ACL entry for schema public owned by
-- supabase_admin, which grants anon/authenticated/service_role. Anything that
-- role creates picks those grants up, and `postgres` cannot alter another
-- role's default privileges. Demonstrated locally: installing pg_trgm into
-- public produced similarity() with proacl {=X/supabase_admin, ...,
-- authenticated=X} — executable by PUBLIC and authenticated, untouched by the
-- statements below.
--
-- This is accepted rather than worked around. Altering supabase_admin's
-- defaults would need elevated hosted permissions we should not request, and
-- the objects in question are Supabase's own (extensions and managed schemas),
-- not this application's. Every table and function THIS project creates is
-- covered, both by these defaults and by the explicit grants in migration 7.
-- The practical residue: if a future migration installs an extension into
-- public, review that extension's function privileges by hand.

do $$
declare
  migration_role text := current_user;
begin
  -- Tables: no automatic DML for the Data API roles.
  execute format(
    'alter default privileges for role %I in schema public revoke all on tables from anon, authenticated, service_role',
    migration_role);

  -- Sequences: no automatic USAGE/SELECT.
  execute format(
    'alter default privileges for role %I in schema public revoke all on sequences from anon, authenticated, service_role',
    migration_role);

  -- Functions, the API roles: schema-scoped is correct here, because these
  -- grants come from Supabase's own schema-scoped entry.
  execute format(
    'alter default privileges for role %I in schema public revoke all on functions from anon, authenticated, service_role',
    migration_role);

  -- Functions, PUBLIC: this one MUST be schema-less.
  --
  -- PostgreSQL's built-in "EXECUTE to PUBLIC" is a global default, and a
  -- schema-scoped statement cannot cancel it. Revoking PUBLIC only "IN SCHEMA
  -- public" leaves the schema entry holding just {postgres=X}, at which point a
  -- newly created function is stored with proacl = NULL — and NULL means "use
  -- the built-in default", which grants PUBLIC EXECUTE. The revoke appears to
  -- have worked while every new function is still world-executable.
  --
  -- Measured, not assumed:
  --   schema-scoped only  -> proacl NULL,                 PUBLIC=t anon=t
  --   plus schema-less    -> proacl {postgres=X/postgres} PUBLIC=f anon=f
  execute format(
    'alter default privileges for role %I revoke execute on functions from public',
    migration_role);

  raise notice 'Default privileges secured for role % (schema public + global PUBLIC/EXECUTE)', migration_role;
end;
$$;

-- ---------------------------------------------------------------------------
-- Verification: prove the defaults are actually in force, do not assume it.
-- ---------------------------------------------------------------------------
-- Real objects are created and inspected, then removed. A CREATE FUNCTION
-- cannot be rolled back inside a DO block, so the probes are dropped explicitly
-- and their absence asserted at the end.
do $$
declare
  offending text;
  probe_roles text[] := array['anon', 'authenticated', 'service_role'];
  role_name text;
begin
  create table public._defaclprobe_table (id integer);
  create sequence public._defaclprobe_seq;
  execute 'create function public._defaclprobe_fn() returns integer language sql immutable set search_path = '''' as $fn$ select 1 $fn$';

  -- No Data API role may have picked up anything.
  foreach role_name in array probe_roles loop
    if has_table_privilege(role_name, 'public._defaclprobe_table', 'SELECT')
       or has_table_privilege(role_name, 'public._defaclprobe_table', 'INSERT')
       or has_table_privilege(role_name, 'public._defaclprobe_table', 'UPDATE')
       or has_table_privilege(role_name, 'public._defaclprobe_table', 'DELETE') then
      raise exception 'Default privileges leak: % has DML on a new table', role_name;
    end if;

    if has_function_privilege(role_name, 'public._defaclprobe_fn()', 'EXECUTE') then
      raise exception 'Default privileges leak: % can execute a new function', role_name;
    end if;

    if has_sequence_privilege(role_name, 'public._defaclprobe_seq', 'USAGE')
       or has_sequence_privilege(role_name, 'public._defaclprobe_seq', 'SELECT') then
      raise exception 'Default privileges leak: % has access to a new sequence', role_name;
    end if;
  end loop;

  -- And PUBLIC must not have inherited EXECUTE from PostgreSQL's built-in rule.
  if has_function_privilege('public', 'public._defaclprobe_fn()', 'EXECUTE') then
    raise exception 'Default privileges leak: PUBLIC can execute a new function';
  end if;

  drop function public._defaclprobe_fn();
  drop sequence public._defaclprobe_seq;
  drop table public._defaclprobe_table;

  -- Nothing may be left behind.
  select string_agg(relname, ', ') into offending
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname like '\_defaclprobe%';
  if offending is not null then
    raise exception 'Probe objects were not cleaned up: %', offending;
  end if;

  raise notice 'Default privileges verified: new tables, functions and sequences grant nothing.';
end;
$$;
