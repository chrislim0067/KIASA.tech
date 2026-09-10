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
 */
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';

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
const section = (s) => console.log(`\n=== ${s} ===`);
function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
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

  const attemptsOf = (id) =>
    Number(sql(`select attempts from public.worker_pairings where id = '${id}'`));

  /* ==================================================== 1. THE ARITHMETIC */

  section('1. One update counts exactly one attempt');

  {
    const id = await newPairing(alice, 'GOODSECRETONE');
    check('a fresh invitation starts at zero', attemptsOf(id) === 0);

    await svc.from('worker_pairings').update({ attempts: 0 }).eq('id', id);
    check('an update counts one', attemptsOf(id) === 1, String(attemptsOf(id)));

    await svc.from('worker_pairings').update({ attempts: 0 }).eq('id', id);
    check('  and again', attemptsOf(id) === 2, String(attemptsOf(id)));

    // The submitted value is a SIGNAL, not data. Under the old code, anything
    // holding UPDATE could write a lower number and reset the counter.
    await svc.from('worker_pairings').update({ attempts: 0 }).eq('id', id);
    check('sending 0 cannot reset the counter', attemptsOf(id) === 3, String(attemptsOf(id)));
    await svc.from('worker_pairings').update({ attempts: 99 }).eq('id', id);
    check('sending 99 cannot jump the counter', attemptsOf(id) === 4, String(attemptsOf(id)));
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
        svcClient().from('worker_pairings').update({ attempts: 0 }).eq('id', id)
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
      await svc.from('worker_pairings').update({ attempts: 0 }).eq('id', id);
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
    const supervisor = await svc
      .from('worker_supervisors')
      .insert({ user_id: alice, platform: 'linux', agent_version: '0.1.0', declared_slots: 1 })
      .select('id').maybeSingle();

    const claim = async () => {
      const { data } = await svcClient()
        .from('worker_pairings')
        .update({ redeemed_at: new Date().toISOString(), redeemed_supervisor_id: supervisor.data.id })
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
  }
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
