/**
 * The worker authorization boundary, against a REAL database, through the REAL
 * store.
 *
 *   npm run db:start && node --import ./scripts/lib/register-hooks.mjs \
 *     scripts/test-worker-db-boundary.mjs
 *
 * WHY THIS SUITE HAD TO EXIST
 *
 * Every worker assertion in the repository used to run against an in-memory
 * store. That store answered every call, so it proved the protocol's LOGIC and
 * nothing about its AUTHORITY — and the two had quietly diverged: migration 22
 * revokes every privilege from `service_role` on `worker_supervisors` and
 * `worker_slots`, so supervisor registration, slot registration and every
 * heartbeat were refused by the database while 27 end-to-end checks passed.
 *
 * So this one uses `createPairingStore()` — the same object the route handlers
 * use — against Postgres, with RLS forced, real grants, real triggers and real
 * transactions. A mock cannot pass it, because there is nothing to mock.
 *
 * WHAT IT IS ALLOWED TO ASSUME
 *
 * Nothing. Users are created and deleted here, every fixture is synthetic, and
 * the only ids that cross a boundary are ones the database itself produced.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

import { statusEnvRaw } from './lib/supabase-cli.mjs';

/* ------------------------------------------------------------ environment */

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

/*
 * The real store reads its connection from the environment, exactly as it does
 * on a server. Setting it here rather than passing a client is deliberate: a
 * store constructed some other way would not be the store the routes use.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
process.env.SUPABASE_SECRET_KEY = SECRET_KEY;

const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_kiasa';

const sql = (statement) =>
  execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-qtAc', statement],
    { encoding: 'utf8' }
  ).trim();

/** Runs a statement expected to FAIL, and returns the message it failed with. */
function sqlExpectingFailure(statement) {
  try {
    sql(statement);
    return null;
  } catch (err) {
    return String(err.stderr ?? err.message ?? err).replace(/\s+/g, ' ').trim();
  }
}

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const anonClient = () => createClient(API_URL, PUBLISHABLE_KEY, opts);
const svcClient = () => createClient(API_URL, SECRET_KEY, opts);

/* ------------------------------------------------------------- reporting */

let passed = 0;
let failed = 0;
let lastSection = 'before the first section';

const section = (s) => {
  lastSection = s;
  console.log(`\n=== ${s} ===`);
};

/*
 * The workflow publishes only the failing suite's NAME, because the database
 * suites print local credentials and throwaway emails and this repository is
 * public. So the suite publishes its own annotations, and only what it owns:
 * the static label written in this file, plus a short detail, scrubbed.
 */
const scrub = (value) =>
  String(value)
    .replace(/eyJ[A-Za-z0-9_.-]{10,}/g, '[redacted-token]')
    .replace(/https?:\/\/\S+/g, '[redacted-url]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300);

const annotate = (line) => {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::error title=worker-db-boundary::${scrub(line)}`);
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

/* --------------------------------------------------------- the real thing */

const E = await import('../lib/worker/endpoints.ts');
const P = await import('../lib/worker/pairing.ts');
const { createPairingStore } = await import('../lib/worker/store.ts');

const store = createPairingStore();
const created = [];

async function makeCandidate(tag) {
  const email = `worker-${tag}-${randomUUID()}@example.test`;
  const password = randomUUID();
  const { data, error } = await svcClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser: ${error.message}`);
  created.push(data.user.id);

  // A real signed-in client, so RLS is evaluated the way a browser makes it.
  const session = anonClient();
  const { error: signIn } = await session.auth.signInWithPassword({ email, password });
  if (signIn) throw new Error(`signIn: ${signIn.message}`);
  return { id: data.user.id, session };
}

const countOf = (table, userId) =>
  Number(sql(`select count(*) from public.${table} where user_id = '${userId}'`));

const redeemBody = (secret) => ({
  pairing_secret: secret,
  platform: 'linux',
  agent_version: '0.1.0',
});

try {
  const alice = await makeCandidate('alice');
  const bob = await makeCandidate('bob');
  const now = new Date();

  /* ============================================ 1. PAIRING, END TO END */

  section('1. Candidate A starts an invitation and a worker redeems it');

  const started = await E.startPairing(store, alice.id, now);
  check('the invitation is created through the real store', started.ok === true,
    started.ok ? '' : started.reason);
  check('  the secret is returned exactly once, in display form',
    typeof started.secret === 'string' && started.secret.length > 0);
  check('  and only its hash reached the table',
    sql(`select secret_hash from public.worker_pairings where user_id = '${alice.id}'`)
      === P.hashSecret(P.normalisePairingSecret(started.secret)),
    'the plaintext is never a column and never a query value');

  const issued = await E.redeemPairing(store, redeemBody(started.secret), now);
  check('THE WORKER REDEEMS IT AGAINST A REAL DATABASE', issued.ok === true,
    issued.ok ? 'registered' : issued.reason);
  check('  a token was issued', issued.ok && P.WORKER_TOKEN_PATTERN.test(issued.token));

  section('2. A supervisor and exactly one slot were registered');

  check('one supervisor exists for this candidate', countOf('worker_supervisors', alice.id) === 1,
    String(countOf('worker_supervisors', alice.id)));
  check('one slot exists', countOf('worker_slots', alice.id) === 1,
    String(countOf('worker_slots', alice.id)));
  check('  it is slot 1, with the one capability this milestone ships',
    sql(`select slot_index || '/' || browser_context_id || '/' || array_to_string(capabilities, '+')
         from public.worker_slots where user_id = '${alice.id}'`) === '1/slot-1/form_fill');
  check('  the supervisor belongs to the candidate who OWNED THE INVITATION',
    sql(`select user_id from public.worker_supervisors where id = '${issued.supervisorId}'`)
      === alice.id,
    'nothing in the redeem request named a candidate');
  check('  and the invitation now names the supervisor that redeemed it',
    sql(`select redeemed_supervisor_id from public.worker_pairings where user_id = '${alice.id}'`)
      === issued.supervisorId);

  section('3. Exactly one scoped credential was issued');

  check('one credential exists', countOf('worker_credentials', alice.id) === 1,
    String(countOf('worker_credentials', alice.id)));
  check('  scoped to heartbeat, for the worker audience, and no more',
    sql(`select audience || '/' || scope from public.worker_credentials
         where user_id = '${alice.id}'`) === 'kiasa-worker/slot:heartbeat');
  check('  bound to the supervisor and slot just created',
    sql(`select (supervisor_id = '${issued.supervisorId}') and (slot_id = '${issued.slotId}')
         from public.worker_credentials where user_id = '${alice.id}'`) === 't');
  check('  and stored as a hash, never as the token',
    sql(`select token_hash from public.worker_credentials where user_id = '${alice.id}'`)
      === P.hashSecret(issued.token.split('.')[1]));

  /* ================================================= 4. THE HEARTBEAT */

  section('4. A real authenticated heartbeat, through the real store');

  const auth = await E.authenticateWorker(store, `Bearer ${issued.token}`, now);
  check('the credential authenticates against the database', auth.ok === true,
    auth.ok ? '' : auth.reason);
  check('  and the identity it yields is the candidate who owns the invitation',
    auth.ok && auth.userId === alice.id);

  const identity = auth.ok ? { credentialId: auth.credentialId, tokenHash: auth.tokenHash } : null;
  const beat = (sequence, readiness = 'ready', lifecycle = 'running') =>
    E.heartbeat(store, identity, { sequence, lifecycle, slot_readiness: readiness }, new Date());

  const first = await beat(1);
  check('THE HEARTBEAT IS APPLIED BY THE DATABASE', first.ok === true && first.applied === true,
    first.ok ? String(first.applied) : first.reason);
  check('  the supervisor recorded it',
    sql(`select heartbeat_sequence || '/' || lifecycle from public.worker_supervisors
         where id = '${issued.supervisorId}'`) === '1/running');
  check('  and so did the slot',
    sql(`select heartbeat_sequence || '/' || readiness from public.worker_slots
         where id = '${issued.slotId}'`) === '1/ready');

  section('5. Sequences are monotonic, and a replay changes nothing');

  const replay = await beat(1);
  check('replaying the same sequence is accepted and applies nothing',
    replay.ok === true && replay.applied === false);
  const older = await beat(0);
  check('  an older sequence applies nothing', older.ok === true && older.applied === false);
  const newer = await beat(2, 'working');
  check('  a newer sequence applies', newer.ok === true && newer.applied === true);
  check('  the slot moved to working',
    sql(`select readiness from public.worker_slots where id = '${issued.slotId}'`) === 'working');
  check('  and the sequence never went backwards',
    Number(sql(`select heartbeat_sequence from public.worker_supervisors
                where id = '${issued.supervisorId}'`)) === 2);

  section('6. A stopping slot carries a stop reason, and clears it again');

  /*
   * `worker_slots_stop_reason_iff_stopping` requires readiness and stop_reason
   * to move together. The worker reports `stopped` on a clean shutdown and
   * carries no reason field, so the boundary supplies one — and must clear it
   * when the slot reports anything else, or the next heartbeat violates the
   * constraint. Both directions are checked because only the second one fails
   * quietly.
   */
  const stopped = await beat(3, 'stopped', 'stopping');
  check('a stopped slot is accepted', stopped.ok === true && stopped.applied === true);
  check('  with the reason the constraint requires',
    sql(`select readiness || '/' || coalesce(stop_reason, 'none') from public.worker_slots
         where id = '${issued.slotId}'`) === 'stopped/supervisor_shutdown');
  const restarted = await beat(4, 'ready');
  check('and a slot that reports ready again clears it', restarted.applied === true);
  check('  leaving no stale reason behind',
    sql(`select readiness || '/' || coalesce(stop_reason, 'none') from public.worker_slots
         where id = '${issued.slotId}'`) === 'ready/none');

  section('7. Online and stale, from what the database actually holds');

  const credentialRow = async () => {
    const { data } = await alice.session
      .from('worker_credentials')
      .select('id, revoked_at, expires_at')
      .maybeSingle();
    return data;
  };
  const supervisorBeat = () =>
    sql(`select coalesce(last_heartbeat_at::text, '') from public.worker_supervisors
         where id = '${issued.supervisorId}'`);

  {
    const cred = await credentialRow();
    const live = P.visibleStatus(
      {
        hasCredential: cred !== null,
        revokedAt: cred?.revoked_at ?? null,
        expiresAt: cred?.expires_at ?? null,
        lastHeartbeatAt: supervisorBeat(),
      },
      new Date()
    );
    check('a worker that just beat is ONLINE', live === 'online', live);

    // Push the last heartbeat past the staleness horizon, in the database.
    sql(`update public.worker_supervisors
         set last_heartbeat_at = now() - interval '10 minutes'
         where id = '${issued.supervisorId}'`);
    const stale = P.visibleStatus(
      {
        hasCredential: true,
        revokedAt: cred?.revoked_at ?? null,
        expiresAt: cred?.expires_at ?? null,
        lastHeartbeatAt: supervisorBeat(),
      },
      new Date()
    );
    check('  and one that has not is STALE', stale === 'stale', stale);
  }

  /* ============================================ 8. CROSS-CANDIDATE */

  section('8. Candidate B cannot see, touch, redeem or revoke A’s worker');

  {
    const tables = ['worker_supervisors', 'worker_slots', 'worker_pairings', 'worker_credentials'];
    for (const table of tables) {
      const { data } = await bob.session.from(table).select('id');
      check(`B reads no row of ${table}`, (data ?? []).length === 0,
        `${(data ?? []).length} row(s)`);
    }

    const { error: revokeError } = await bob.session
      .from('worker_credentials')
      .update({ revoked_at: new Date().toISOString(), revoked_reason: 'candidate_requested' })
      .eq('user_id', alice.id)
      .select('id');
    const stillLive = sql(`select coalesce(revoked_at::text, 'live') from public.worker_credentials
                           where user_id = '${alice.id}'`);
    check("B cannot revoke A's credential", stillLive === 'live',
      revokeError ? 'refused with an error' : 'refused by RLS, silently');

    // B has no token, so there is nothing to authenticate with. The closest B
    // can get is guessing, which is the pairing attempt ceiling's problem.
    const guess = await E.redeemPairing(store, redeemBody('ABCDEFGHJKMNPQRSTVWXYZ234'), now);
    check('B cannot redeem an invitation it does not hold the secret for',
      guess.ok === false, guess.ok ? 'REDEEMED' : guess.reason);

    /*
     * AND B CANNOT REACH THE BOUNDARY AT ALL. The two functions are executable
     * by service_role and nobody else, so a signed-in browser calling them
     * directly through PostgREST is refused by the privilege, not by a check
     * inside them.
     */
    for (const fn of ['worker_redeem_pairing', 'worker_record_heartbeat']) {
      const { error } = await bob.session.rpc(fn, {});
      check(`  and cannot call ${fn}()`, error !== null,
        error ? 'refused' : 'EXECUTED');
    }
  }

  /* ============================================ 9. HASHES AND GRANTS */

  section('9. No API role can read a hash, and service_role gained nothing');

  {
    for (const [table, column] of [
      ['worker_pairings', 'secret_hash'],
      ['worker_credentials', 'token_hash'],
    ]) {
      for (const role of ['authenticated', 'anon']) {
        const failure = sqlExpectingFailure(
          `set local role ${role}; select ${column} from public.${table} limit 1`
        );
        check(`${role} cannot read ${table}.${column}`, failure !== null,
          'a column privilege, not a policy — RLS cannot hide a column');
      }
    }

    const tableGrants = sql(`select coalesce(string_agg(distinct table_name, ','), 'none')
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name in ('worker_supervisors', 'worker_slots', 'automation_tasks',
                           'task_leases', 'worker_events')
        and grantee = 'service_role'`);
    check('SERVICE_ROLE STILL HOLDS NO TABLE GRANT ON THE MIGRATION-22 TABLES',
      tableGrants === 'none', tableGrants);

    const pairingGrants = sql(`select coalesce(string_agg(privilege_type, ','), 'none')
      from (select distinct privilege_type from information_schema.role_table_grants
            where table_schema = 'public'
              and table_name in ('worker_pairings', 'worker_credentials')
              and grantee = 'service_role'
            order by privilege_type) s`);
    check('  and exactly what migration 24 gave it on the pairing tables',
      pairingGrants === 'INSERT,SELECT,UPDATE', pairingGrants);

    const rls = sql(`select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('worker_supervisors', 'worker_slots', 'automation_tasks',
                          'task_leases', 'worker_events', 'worker_pairings', 'worker_credentials')
        and c.relrowsecurity and c.relforcerowsecurity`);
    check('  RLS is still enabled AND forced on all seven worker tables', rls === '7', rls);

    const execGrants = sql(`select coalesce(string_agg(p.proname || ':' || r.rolname, ','), 'none')
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
      where n.nspname = 'public'
        and p.proname in ('worker_redeem_pairing', 'worker_record_heartbeat')
        and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`);
    check('  and no browser role can execute either function', execGrants === 'none', execGrants);
  }

  /* ================================ 10. REVOCATION AND ITS FINALITY */

  section('10. Revocation stops the worker, through the candidate’s own session');

  {
    const { error } = await alice.session
      .from('worker_credentials')
      .update({ revoked_at: new Date().toISOString(), revoked_reason: 'candidate_requested' })
      .eq('user_id', alice.id);
    check('the candidate revokes their own credential', !error, error?.message ?? 'revoked');

    const afterAuth = await E.authenticateWorker(store, `Bearer ${issued.token}`, new Date());
    check('A REVOKED WORKER CANNOT AUTHENTICATE',
      afterAuth.ok === false && afterAuth.reason === 'revoked',
      afterAuth.ok ? 'STILL AUTHENTICATED' : afterAuth.reason);

    /*
     * And the database refuses it too, not merely the server. The identity
     * from before revocation is replayed straight at the store — the exact
     * shape a stolen in-flight credential would take.
     */
    const afterBeat = await store.recordHeartbeat({
      credentialId: identity.credentialId,
      tokenHash: identity.tokenHash,
      sequence: 99,
      lifecycle: 'running',
      readiness: 'ready',
    });
    check('  and the boundary refuses the write even with a valid token hash',
      afterBeat.applied === false);
    check('  the sequence did not move',
      Number(sql(`select heartbeat_sequence from public.worker_supervisors
                  where id = '${issued.supervisorId}'`)) === 4);
  }

  /* ============================== 11. FENCING AND LEASES, IN POSTGRES */

  section('11. Fence tokens only rise, and a revoked supervisor holds no lease');

  {
    const jobId = sql(`insert into public.jobs (user_id, submitted_url, canonical_url, source)
      values ('${alice.id}', 'https://example.test/job/1', 'https://example.test/job/1', 'user_link')
      returning id`);
    const taskId = sql(`insert into public.automation_tasks
      (user_id, job_id, mode, idempotency_key, correlation_id, fence_token, attempt)
      values ('${alice.id}', '${jobId}', 'claude_max_assisted',
              'synthetic-boundary-fixture-0001', gen_random_uuid(), 4, 2)
      returning id`);

    check('a task can hold a fence token', Number(sql(
      `select fence_token from public.automation_tasks where id = '${taskId}'`)) === 4);

    const lowered = sqlExpectingFailure(
      `update public.automation_tasks set fence_token = 3 where id = '${taskId}'`);
    check('LOWERING A FENCE TOKEN IS REFUSED', lowered !== null,
      'a fence that can be lowered is not a fence');
    const attemptBack = sqlExpectingFailure(
      `update public.automation_tasks set attempt = 1 where id = '${taskId}'`);
    check('  and attempts may not be walked back', attemptBack !== null);
    sql(`update public.automation_tasks set fence_token = 5 where id = '${taskId}'`);
    check('  raising it is allowed', Number(sql(
      `select fence_token from public.automation_tasks where id = '${taskId}'`)) === 5);

    // A lease for a live supervisor is allowed; the same lease is refused once
    // the supervisor is revoked. That is the stale-worker defence.
    const leaseId = sql(`insert into public.task_leases
      (user_id, task_id, slot_id, fence_token, expires_at)
      values ('${alice.id}', '${taskId}', '${issued.slotId}', 5, now() + interval '2 minutes')
      returning id`);
    check('a live supervisor may hold a lease', leaseId.length === 36, leaseId);

    const crossCandidate = sqlExpectingFailure(`insert into public.task_leases
      (user_id, task_id, slot_id, fence_token, expires_at)
      values ('${bob.id}', '${taskId}', '${issued.slotId}', 6, now() + interval '2 minutes')`);
    check('  a lease may not cross candidates', crossCandidate !== null,
      'the slot belongs to A; the lease claimed to belong to B');

    sql(`update public.worker_supervisors
         set revoked_at = now(), revoked_reason = 'candidate_requested', lifecycle = 'offline'
         where id = '${issued.supervisorId}'`);
    const staleLease = sqlExpectingFailure(`insert into public.task_leases
      (user_id, task_id, slot_id, fence_token, expires_at)
      values ('${alice.id}', '${taskId}', '${issued.slotId}', 7, now() + interval '2 minutes')`);
    check('A REVOKED SUPERVISOR MAY NOT ACQUIRE A LEASE', staleLease !== null);

    // And its worker cannot report in either, even holding a live credential.
    sql(`update public.worker_credentials set revoked_at = null, revoked_reason = null
         where user_id = '${alice.id}'`);
    const zombie = await store.recordHeartbeat({
      credentialId: identity.credentialId,
      tokenHash: identity.tokenHash,
      sequence: 100,
      lifecycle: 'running',
      readiness: 'ready',
    });
    check('  and a revoked supervisor accepts no heartbeat', zombie.applied === false,
      'revocation is final in both directions');
  }

  /* ====================== 12. SINGLE USE, REPLAY AND CONCURRENCY */

  section('12. One invitation, one worker — replayed and raced');

  {
    const carol = await makeCandidate('carol');
    const invitation = await E.startPairing(store, carol.id, new Date());
    const firstRedeem = await E.redeemPairing(store, redeemBody(invitation.secret), new Date());
    check('the invitation redeems once', firstRedeem.ok === true,
      firstRedeem.ok ? '' : firstRedeem.reason);

    const replayed = await E.redeemPairing(store, redeemBody(invitation.secret), new Date());
    check('REPLAYING IT IS REFUSED', replayed.ok === false && replayed.reason === 'already_redeemed',
      replayed.ok ? 'REDEEMED TWICE' : replayed.reason);
    check('  and created no second supervisor', countOf('worker_supervisors', carol.id) === 1,
      String(countOf('worker_supervisors', carol.id)));
    check('  no second slot', countOf('worker_slots', carol.id) === 1);
    check('  and no second credential', countOf('worker_credentials', carol.id) === 1,
      String(countOf('worker_credentials', carol.id)));

    // Now the race the replay cannot reach: two workers presenting the same
    // fresh secret at the same instant.
    const dave = await makeCandidate('dave');
    const raced = await E.startPairing(store, dave.id, new Date());
    const [a, b] = await Promise.all([
      E.redeemPairing(store, redeemBody(raced.secret), new Date()),
      E.redeemPairing(store, redeemBody(raced.secret), new Date()),
    ]);
    const winners = [a, b].filter((r) => r.ok).length;
    check('exactly one of two simultaneous redemptions wins', winners === 1,
      `${winners} winner(s): ${[a, b].map((r) => (r.ok ? 'ok' : r.reason)).join(', ')}`);
    check('  THE LOSER LEFT NO SUPERVISOR BEHIND', countOf('worker_supervisors', dave.id) === 1,
      String(countOf('worker_supervisors', dave.id)));
    check('  no orphan slot', countOf('worker_slots', dave.id) === 1,
      String(countOf('worker_slots', dave.id)));
    check('  and no orphan credential', countOf('worker_credentials', dave.id) === 1,
      String(countOf('worker_credentials', dave.id)));
  }

  section('13. Concurrent wrong guesses cannot exceed the ceiling');

  {
    const erin = await makeCandidate('erin');
    const invitation = await E.startPairing(store, erin.id, new Date());
    const id = sql(`select id from public.worker_pairings where user_id = '${erin.id}'`);

    // Straight at the real store, in parallel, the way an unauthenticated
    // endpoint lets an attacker call it.
    await Promise.all(
      Array.from({ length: 40 }, () => store.recordFailedAttempt(id))
    );
    const attempts = Number(sql(`select attempts from public.worker_pairings where id = '${id}'`));
    check('40 concurrent failed attempts land exactly on the ceiling', attempts === 10,
      String(attempts));

    const afterCeiling = await E.redeemPairing(store, redeemBody(invitation.secret), new Date());
    check('  and the CORRECT secret is refused past it',
      afterCeiling.ok === false && afterCeiling.reason === 'too_many_attempts',
      afterCeiling.ok ? 'REDEEMED' : afterCeiling.reason);
    check('  the invitation was locked, not consumed',
      sql(`select coalesce(redeemed_at::text, 'unredeemed') from public.worker_pairings
           where id = '${id}'`) === 'unredeemed');
    check('  and no worker was registered for it', countOf('worker_supervisors', erin.id) === 0,
      String(countOf('worker_supervisors', erin.id)));
  }

  section('14. Account deletion is still clean once a worker is paired');

  {
    const frank = await makeCandidate('frank');
    const invitation = await E.startPairing(store, frank.id, new Date());
    const paired = await E.redeemPairing(store, redeemBody(invitation.secret), new Date());
    check('the account has a paired worker', paired.ok === true,
      paired.ok ? '' : paired.reason);

    const { error } = await svcClient().auth.admin.deleteUser(frank.id);
    check('DELETING THE ACCOUNT SUCCEEDS', !error, error?.message ?? 'deleted');
    for (const table of ['worker_pairings', 'worker_credentials', 'worker_slots',
                         'worker_supervisors']) {
      check(`  ${table} is empty for them`, countOf(table, frank.id) === 0,
        String(countOf(table, frank.id)));
    }
  }

  section('15. The boundary refuses malformed input rather than trusting it');

  {
    const refuse = async (label, args, expected) => {
      const { data } = await svcClient().rpc('worker_redeem_pairing', args);
      const row = Array.isArray(data) ? data[0] : null;
      check(label, row !== null && row.ok === false && row.reason === expected,
        row ? row.reason : 'no row');
    };
    const base = {
      p_secret_hash: 'a'.repeat(64),
      p_platform: 'linux',
      p_agent_version: '0.1.0',
      p_credential_id: randomUUID(),
      p_token_hash: 'b'.repeat(64),
      p_credential_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    };
    await refuse('a hash of the wrong shape is refused',
      { ...base, p_secret_hash: 'not-a-hash' }, 'malformed_request');
    await refuse('  an unknown platform is refused',
      { ...base, p_platform: 'haiku-os' }, 'malformed_request');
    await refuse('  a malformed agent version is refused',
      { ...base, p_agent_version: 'v1' }, 'malformed_request');
    await refuse('  a credential lifetime beyond thirty days is refused',
      { ...base, p_credential_expires_at: new Date(Date.now() + 40 * 86_400_000).toISOString() },
      'malformed_request');
    await refuse('  and a hash matching no invitation is refused',
      base, 'not_found');

    const { data: hb } = await svcClient().rpc('worker_record_heartbeat', {
      p_credential_id: randomUUID(),
      p_token_hash: 'c'.repeat(64),
      p_sequence: 1,
      p_lifecycle: 'running',
      p_readiness: 'paused',
    });
    check('a paused slot is refused rather than given an invented reason',
      Array.isArray(hb) && hb[0]?.reason === 'pause_reason_required',
      hb?.[0]?.reason ?? 'no row');
  }
} catch (err) {
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
  console.log(`ALL ${passed} WORKER DATABASE-BOUNDARY CHECKS PASSED`);
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
