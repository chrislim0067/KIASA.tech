/**
 * The pairing attempt counter, against a REAL database, under real concurrency.
 *
 *   npm run db:start && node scripts/test-worker-pairing-db.mjs
 *
 * This one cannot be faked. The property being tested — that concurrent
 * updates serialise on a row lock and each adds exactly one — is a property of
 * Postgres, not of JavaScript. A mock proves nothing about it, which is why
 * this lives in the database suite CI runs rather than in the offline tests.
 *
 * WHAT WENT WRONG BEFORE
 *
 * `recordFailedAttempt` read `attempts`, added one, and wrote it back. The
 * redeem endpoint is UNAUTHENTICATED by design — holding the code is the
 * authentication — so an attacker chooses the concurrency. Enough parallel
 * guesses and both requests read 3, both write 4, and the counter is pinned
 * below its ceiling for as long as they keep going. A ten-attempt limit that
 * can be held at four is not a limit.
 *
 * Migration 25 moved the arithmetic into a BEFORE UPDATE trigger. The tests
 * below fire many simultaneous updates and check the arithmetic came out
 * right — and that nothing else about the invitation was weakened to get there.
 *
 * WHAT THIS SUITE THEN FOUND, WHICH NO MOCK COULD HAVE
 *
 * The trigger counts an attempt when the submitted value DIFFERS from the
 * stored one, because that is how it tells a guess apart from a revocation.
 * `recordFailedAttempt` submitted 0 — equal to the stored 0 on every first
 * guess, and equal to the stored 0 for every member of a concurrent burst. The
 * limit was inert. The in-memory store the endpoint tests use increments
 * unconditionally, so 118 offline assertions passed over it. A real Postgres
 * did not. The signal is now -1, which the column's own 0..10 constraint
 * guarantees can never equal a stored value.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { statusEnvRaw } from './lib/supabase-cli.mjs';
import { createClient } from '@supabase/supabase-js';

function localEnv() {
  const env = {};
  for (const line of statusEnvRaw().split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m) env[m[1]] = m[2];
  }
  return {
    url: env.API_URL,
    key: env.PUBLISHABLE_KEY || env.ANON_KEY,
    secret: env.SECRET_KEY || env.SERVICE_ROLE_KEY,
  };
}

const { url: API_URL, key: PUBLISHABLE_KEY, secret: SECRET_KEY } = localEnv();
const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_kiasa';

const sql = (s) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-qtAc', s], {
    encoding: 'utf8',
  }).trim();

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const anonClient = () => createClient(API_URL, PUBLISHABLE_KEY, opts);
const svcClient = () => createClient(API_URL, SECRET_KEY, opts);

let failed = 0;
let passed = 0;
let lastSection = 'before the first section';
const section = (s) => {
  lastSection = s;
  console.log(`\n=== ${s} ===`);
};
/*
 * A FAILURE HERE MUST BE READABLE WITHOUT THE JOB LOG.
 *
 * The workflow publishes the failing suite's NAME as an annotation and nothing
 * else, deliberately: the database suites print local credentials and
 * throwaway user emails, and this repository is public. That rule is right,
 * but it left this suite diagnosable only by guessing, which cost two CI
 * cycles.
 *
 * So the suite publishes its own annotations, and only what it controls: the
 * static label of the check that failed, plus its short detail. Both are
 * written in this file. Nothing read from the database, the environment or the
 * Supabase client is annotated, and the scrub below is a second line of
 * defence rather than the first.
 */
const scrub = (value) =>
  String(value)
    .replace(/eyJ[A-Za-z0-9_.-]{10,}/g, '[redacted-token]')
    .replace(/https?:\/\/\S+/g, '[redacted-url]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300);

const annotate = (line) => {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::error title=pairing-db::${scrub(line)}`);
  }
};

function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
    annotate(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const created = [];

async function makeUser(tag) {
  const admin = svcClient();
  const { data, error } = await admin.auth.admin.createUser({
    email: `pairing-${tag}-${randomUUID()}@example.test`,
    password: randomUUID(),
    email_confirm: true,
  });
  if (error) throw new Error(`createUser: ${error.message}`);
  created.push(data.user.id);
  return data.user.id;
}

const MAX = 10;

try {
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  const svc = svcClient();

  const newPairing = async (userId, secret) => {
    /*
     * Supersede any live invitation first.
     *
     * `worker_pairings_one_live_per_user` is a PARTIAL UNIQUE INDEX: at most
     * one row per candidate with `redeemed_at is null and revoked_at is null`.
     * A second insert for the same person is therefore REFUSED, not accepted —
     * which is what this test hit on its first CI run. `createPairing` in
     * lib/worker/store.ts revokes before inserting for exactly this reason, so
     * a test that skipped the revoke would not be testing the production shape.
     *
     * Revoking touches `revoked_at` only. The immutable guard leaves it alone,
     * and because `attempts` is absent from the payload the trigger sees
     * `new.attempts` equal to `old.attempts` and counts nothing.
     */
    await svc
      .from('worker_pairings')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('redeemed_at', null)
      .is('revoked_at', null);

    const { data, error } = await svc
      .from('worker_pairings')
      .insert({
        user_id: userId,
        secret_hash: hash(secret),
        expires_at: new Date(Date.now() + 9 * 60_000).toISOString(),
      })
      .select('id')
      .maybeSingle();
    if (error) throw new Error(`insert pairing: ${error.message}`);
    return data.id;
  };

  /*
   * EXACTLY WHAT recordFailedAttempt SENDS.
   *
   * Mirrored rather than described, because the value is the whole subtlety:
   * the trigger counts an attempt only when the submitted value DIFFERS from
   * the stored one, so a signal of 0 counted nothing against a stored 0 — and
   * a burst of concurrent guesses all seeing 0 counted nothing at all.
   */
  const countOne = (id) => svc.from('worker_pairings').update({ attempts: -1 }).eq('id', id);

  const attemptsOf = (id) =>
    Number(sql(`select attempts from public.worker_pairings where id = '${id}'`));

  /* ==================================================== 1. THE ARITHMETIC */

  section('1. One update counts exactly one attempt');

  {
    const id = await newPairing(alice, 'GOODSECRETONE');
    check('a fresh invitation starts at zero', attemptsOf(id) === 0);

    await countOne(id);
    check('one failed guess counts one', attemptsOf(id) === 1, String(attemptsOf(id)));

    await countOne(id);
    check('  and again', attemptsOf(id) === 2, String(attemptsOf(id)));

    // The submitted value is a SIGNAL, not data. Under the old code, anything
    // holding UPDATE could write a lower number and reset the counter.
    await svc.from('worker_pairings').update({ attempts: 0 }).eq('id', id);
    check('sending 0 against a stored 2 counts one, it does not reset',
      attemptsOf(id) === 3, String(attemptsOf(id)));
    await svc.from('worker_pairings').update({ attempts: 99 }).eq('id', id);
    check('sending 99 cannot jump the counter', attemptsOf(id) === 4, String(attemptsOf(id)));

    /*
     * THE TRAP THE PRODUCTION CODE FELL INTO.
     *
     * A BEFORE trigger cannot see which columns an UPDATE named, only what the
     * row now holds. Submitting the value already stored is indistinguishable
     * from not touching the column, so it counts nothing — which is correct
     * for a revocation and fatal for a guess. recordFailedAttempt sent 0, and
     * every first guess meets a stored 0.
     */
    await svc.from('worker_pairings').update({ attempts: 4 }).eq('id', id);
    check('submitting the value already stored counts NOTHING',
      attemptsOf(id) === 4, String(attemptsOf(id)));
    // Not asserted as a sentence: read the value production actually sends.
    const sent = readFileSync('lib/worker/store.ts', 'utf8')
      .match(/update\(\{ attempts: (-?\d+) \}\)/);
    check('  which is why the signal production sends lies outside 0..10',
      sent !== null && Number(sent[1]) < 0, sent ? sent[0] : 'no signal found');
  }

  section('1b. One live invitation per candidate; superseding counts nothing');

  {
    const first = await newPairing(alice, 'GOODSECRETFIRST');
    await countOne(first);
    check('the first invitation counted one attempt', attemptsOf(first) === 1);

    const second = await newPairing(alice, 'GOODSECRETSECOND');
    const live = Number(
      sql(`select count(*) from public.worker_pairings
           where user_id = '${alice}' and redeemed_at is null and revoked_at is null`)
    );
    check('asking again leaves exactly one live invitation', live === 1, `${live} live`);
    check('  the new one', second !== first);

    // Revocation writes `revoked_at` and nothing else. If the guard treated any
    // update as a failed guess, superseding would burn an attempt.
    check('superseding did not count an attempt against the old row',
      attemptsOf(first) === 1, String(attemptsOf(first)));
  }

  /* ============================================= 2. CONCURRENCY, FOR REAL */

  section('2. Many simultaneous guesses lose nothing and exceed nothing');

  {
    const id = await newPairing(alice, 'GOODSECRETTWO');
    const BURST = 40;

    // Forty updates issued together against one row. Under the old
    // read-then-write this reliably lost updates; under a row lock it cannot.
    const results = await Promise.all(
      Array.from({ length: BURST }, () =>
        svcClient().from('worker_pairings').update({ attempts: -1 }).eq('id', id)
      )
    );
    const rejected = results.filter((r) => r.error).length;

    const final = attemptsOf(id);
    check(`${BURST} concurrent updates NEVER exceed the ceiling`, final <= MAX,
      `attempts = ${final}, ceiling ${MAX}`);
    check('  and reach it exactly', final === MAX, String(final));
    check('  no update errored', rejected === 0, `${rejected} errored`);
    check('  nothing was lost below the ceiling', final === Math.min(BURST, MAX),
      'read-then-write would land under this, non-deterministically');
  }

  section('3. At the threshold the invitation is unusable, even with the right code');

  {
    const secret = 'GOODSECRETTHREE';
    const id = await newPairing(alice, secret);
    for (let i = 0; i < MAX; i++) {
      await countOne(id);
    }
    check('the counter sits at the ceiling', attemptsOf(id) === MAX, String(attemptsOf(id)));

    const { evaluatePairing } = await import('../lib/worker/pairing.ts');
    const { data: row } = await svc
      .from('worker_pairings')
      .select('id, user_id, secret_hash, expires_at, redeemed_at, revoked_at, attempts')
      .eq('id', id)
      .maybeSingle();

    const verdict = evaluatePairing(row, secret, new Date());
    check('the CORRECT code is refused past the threshold',
      verdict.ok === false && verdict.reason === 'too_many_attempts',
      verdict.ok ? 'REDEEMED' : verdict.reason);
    check('  and it is refused before the secret is compared',
      verdict.reason === 'too_many_attempts',
      'a right guess and a wrong one are indistinguishable here');

    // Still not redeemed, so the ceiling did not consume the invitation by
    // accident — it locked it.
    check('the invitation was locked, not redeemed', row.redeemed_at === null);
  }

  section('4. Single use survives the change');

  {
    const secret = 'GOODSECRETFOUR';
    const id = await newPairing(alice, secret);
    /*
     * The supervisor row is created through psql, NOT through the service-role
     * client, because service_role holds no grant of any kind on
     * `worker_supervisors` — migration 22 revokes it and then asserts it is
     * absent. Section 6 checks that this is still true.
     *
     * That is not a quirk of this test. `createPairingStore().createSupervisor`
     * uses the same elevated client and would be refused the same way, which
     * means the redeem path cannot register a supervisor against a real
     * database at all. See the milestone report: it needs a decision, not a
     * quiet grant.
     */
    const supervisorId = sql(`insert into public.worker_supervisors
      (user_id, platform, agent_version, declared_slots, lifecycle)
      values ('${alice}', 'linux', '0.1.0', 1, 'starting') returning id`);

    const claim = async () => {
      const { data } = await svcClient()
        .from('worker_pairings')
        .update({ redeemed_at: new Date().toISOString(), redeemed_supervisor_id: supervisorId })
        .eq('id', id)
        .is('redeemed_at', null)
        .select('id');
      return Array.isArray(data) && data.length === 1;
    };

    const [a, b, c] = await Promise.all([claim(), claim(), claim()]);
    check('exactly one of three concurrent claims wins',
      [a, b, c].filter(Boolean).length === 1,
      `${[a, b, c].filter(Boolean).length} winner(s)`);
  }

  section('5. Nothing about isolation or disclosure was weakened');

  {
    const secret = 'BOBSECRETFIVE';
    const bobsPairing = await newPairing(bob, secret);

    // A browser holding Alice's session must see nothing of Bob's row, and no
    // hash of anybody's.
    const anon = anonClient();
    const { data: leaked } = await anon.from('worker_pairings').select('id');
    check('an unauthenticated client reads no invitation',
      !leaked || leaked.length === 0, `${leaked?.length ?? 0} row(s)`);

    let hashBlocked = false;
    try {
      const r = sql(
        `set local role authenticated; select secret_hash from public.worker_pairings limit 1`
      );
      hashBlocked = r === '';
    } catch {
      hashBlocked = true;
    }
    check('the `authenticated` role cannot read secret_hash', hashBlocked,
      'a column privilege, not a policy — RLS cannot hide a column');

    check("Bob's invitation still exists and is untouched",
      attemptsOf(bobsPairing) === 0, String(attemptsOf(bobsPairing)));
  }

  section('6. The trigger is attached the way the migration says');

  {
    const kind = sql(`select tgtype from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname='public' and c.relname='worker_pairings'
        and t.tgname='worker_pairings_immutable'`);
    const bits = Number(kind);
    check('it is a BEFORE trigger', (bits & 2) !== 0, `tgtype ${bits}`);
    check('  firing on UPDATE', (bits & 16) !== 0);

    const grants = sql(`select coalesce(string_agg(distinct column_name, ','), 'none')
      from information_schema.column_privileges
      where table_schema='public' and table_name='worker_pairings'
        and grantee='authenticated' and privilege_type='UPDATE'`);
    check('authenticated may still update ONLY revoked_at', grants === 'revoked_at', grants);

    /*
     * NO SERVICE-ROLE GRANT WAS ADDED, ANYWHERE.
     *
     * The atomic counter was deliberately built as a trigger rather than a
     * SECURITY DEFINER RPC precisely so that this would stay true: the trigger
     * rides along on the UPDATE service_role already held from migration 24,
     * and nothing gained access to anything.
     *
     * The migration-22 tables are checked here as well, and they matter for a
     * second reason — `lib/worker/store.ts` writes to `worker_supervisors` and
     * `worker_slots` through the elevated client, and this proves it cannot.
     * If a later milestone decides to grant that access, this check must be
     * changed deliberately rather than discovered by accident.
     */
    const svcGrants = sql(`select coalesce(string_agg(distinct table_name, ','), 'none')
      from information_schema.role_table_grants
      where table_schema='public'
        and table_name in ('worker_supervisors', 'worker_slots')
        and grantee='service_role'`);
    check('service_role still holds nothing on the migration-22 worker tables',
      svcGrants === 'none', svcGrants);
  }
} catch (err) {
  // A throw here is a setup failure, not an assertion failure — a refused
  // insert, a missing grant, a constraint nobody expected. Without this the
  // process died on an unhandled rejection and published nothing but the
  // script's name.
  failed++;
  console.error(err);
  annotate(`THREW during "${lastSection}": ${err?.message ?? err}`);
} finally {
  const admin = svcClient();
  for (const id of created) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

console.log('\n========================================================');
if (failed === 0) {
  console.log(`ALL ${passed} PAIRING-CONCURRENCY CHECKS PASSED`);
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
