-- Make the pairing attempt counter atomic.
--
-- THE DEFECT THIS FIXES
--
-- `recordFailedAttempt` read `attempts`, added one, and wrote it back. Two
-- concurrent wrong guesses both read 3, both write 4, and one attempt is lost.
-- The redeem endpoint is UNAUTHENTICATED by design — holding the code is the
-- authentication — so an attacker controls the concurrency directly, and enough
-- parallel guesses could keep the counter well below the ceiling indefinitely.
-- A ten-attempt limit that can be held at four is not a limit.
--
-- THE FIX: THE DATABASE OWNS THE ARITHMETIC
--
-- The trigger below computes `new.attempts` from `old.attempts` and ignores
-- whatever the client sent. `UPDATE` takes a row lock, so concurrent updates
-- serialise: each one reads the committed previous value and adds exactly one.
-- No update can be lost, because no value is ever carried across a gap between
-- a read and a write — there is no read.
--
-- WHY A TRIGGER RATHER THAN AN RPC FUNCTION
--
-- An `attempts = attempts + 1` statement cannot be expressed through PostgREST,
-- and a `SECURITY DEFINER` RPC would need a fresh EXECUTE grant for
-- service_role. This needs NO new grant of any kind: service_role already holds
-- UPDATE on this table from migration 24, and the trigger runs as part of that
-- update. Nothing else gains access to anything.
--
-- A SECOND PROPERTY, FOR FREE
--
-- Because the client's value is discarded rather than trusted, nobody can
-- write `attempts = 0` to reset the counter. Under the old code that was
-- possible for anything holding UPDATE; now it is arithmetically impossible.
-- Submitting 0 against a stored 3 counts an attempt and yields 4.
--
-- SCOPE: one trigger function on one table. No schema change, no new grant, no
-- other migration touched.

create or replace function public.guard_worker_pairing_immutable()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.secret_hash <> new.secret_hash then
    raise exception 'a pairing secret hash is fixed at creation' using errcode = 'check_violation';
  end if;
  if old.user_id <> new.user_id then
    raise exception 'a pairing may not change owner' using errcode = 'check_violation';
  end if;
  if old.redeemed_at is not null and new.redeemed_at is null then
    raise exception 'a redeemed pairing may not be un-redeemed' using errcode = 'check_violation';
  end if;
  if old.expires_at <> new.expires_at then
    raise exception 'a pairing expiry is fixed at creation' using errcode = 'check_violation';
  end if;

  /*
   * THE ATOMIC COUNTER.
   *
   * An update that CHANGES `attempts` is treated as "count one failed
   * attempt". The submitted value is DISCARDED — it is a signal, not data —
   * and the new value is computed from the locked previous row.
   *
   * "Changes" rather than "touches" is the whole subtlety, and it is why
   * `recordFailedAttempt` sends -1 rather than 0. A BEFORE trigger cannot see
   * which columns an UPDATE listed, only what the row now holds, so a guess
   * that submitted the value already stored would count nothing — and every
   * first guess submits 0 against a stored 0. -1 is outside
   * `worker_pairings_attempts_bounded` (0..10) and so can never equal a
   * stored value; it is also why a dropped trigger fails the write loudly
   * instead of writing a negative count.
   *
   * Revocation and redemption write other columns and leave this one alone,
   * so they still count nothing.
   *
   * At the ceiling the counter stops rather than the statement failing. An
   * exception here would turn a refused guess into a 500 and hand an attacker
   * a signal that the ceiling had been reached; holding at ten keeps every
   * refusal past that point indistinguishable, and `evaluatePairing` already
   * refuses at `attempts >= MAX` before it looks at the secret.
   */
  if new.attempts is distinct from old.attempts then
    new.attempts := least(old.attempts + 1, 10);
  end if;

  return new;
end;
$$;
revoke all on function public.guard_worker_pairing_immutable()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Self-verification. Aborts rather than leaving a counter that can be reset.
-- ---------------------------------------------------------------------------
do $$
declare
  body text;
begin
  select p.prosrc into body
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'guard_worker_pairing_immutable';

  if body is null then
    raise exception 'guard_worker_pairing_immutable is missing';
  end if;
  if position('least(old.attempts + 1, 10)' in body) = 0 then
    raise exception 'the attempt counter is not computed from the previous row';
  end if;

  -- The trigger must still be attached, and still BEFORE UPDATE: an AFTER
  -- trigger cannot rewrite the value.
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'worker_pairings'
      and t.tgname = 'worker_pairings_immutable'
      and (t.tgtype & 2) <> 0            -- BEFORE
      and (t.tgtype & 16) <> 0           -- UPDATE
  ) then
    raise exception 'worker_pairings_immutable is not a BEFORE UPDATE trigger';
  end if;

  -- No grant was added. `authenticated` must still hold UPDATE on the
  -- revocation column only, and must NOT have gained `attempts`.
  if exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'worker_pairings'
      and grantee = 'authenticated' and privilege_type = 'UPDATE'
      and column_name <> 'revoked_at'
  ) then
    raise exception 'authenticated can update a column other than revoked_at';
  end if;

  -- And nothing gained EXECUTE on the trigger function.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'guard_worker_pairing_immutable'
      and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('service_role', p.oid, 'EXECUTE'))
  ) then
    raise exception 'an API role can execute the pairing guard directly';
  end if;
end $$;
