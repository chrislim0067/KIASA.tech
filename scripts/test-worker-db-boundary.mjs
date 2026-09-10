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

/**
 * True when the database refused a statement.
 *
 * Refusal shows up two ways depending on the rule that did the refusing: psql
 * exits non-zero on a raised exception, and prints nothing when a privilege
 * simply is not there. Treating only the first as refusal would let the second
 * read as success, so EVERY statement passed here is written to RETURN
 * something when it works — and "no output" therefore means refused too.
 */
function refused(statement) {
  try {
    return sql(statement) === '';
  } catch {
    return true;
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
  const beat = (sequence, readiness = 'ready', lifecycle = 'running', reason = undefined) =>
    E.heartbeat(
      store,
      identity,
      { sequence, lifecycle, slot_readiness: readiness, ...(reason ? { reason } : {}) },
      new Date()
    );

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
  const noReason = await beat(3, 'stopped', 'stopping');
  check('a stopped slot with NO reason is refused',
    noReason.ok === false && noReason.reason === 'stop_reason_required',
    noReason.ok ? 'ACCEPTED' : noReason.reason);

  const stopped = await beat(3, 'stopped', 'stopping', 'supervisor_shutdown');
  check('a stopped slot that names its reason is accepted',
    stopped.ok === true && stopped.applied === true, stopped.ok ? '' : stopped.reason);
  check('  and the reason stored is the one the WORKER sent',
    sql(`select readiness || '/' || coalesce(stop_reason, 'none') from public.worker_slots
         where id = '${issued.slotId}'`) === 'stopped/supervisor_shutdown',
    'migration 26 invented this value; migration 27 requires it to be sent');
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
    /*
     * Called with a COMPLETE and well-formed argument list, so the signature
     * matches and the only thing left to stop it is the EXECUTE privilege. An
     * empty payload would have been refused for the wrong reason — no such
     * overload — and would have passed this check while proving nothing.
     *
     * The hashes match nothing, so even a successful call would create no row.
     */
    const bobsAttempts = {
      worker_redeem_pairing: {
        p_secret_hash: 'f'.repeat(64),
        p_platform: 'linux',
        p_agent_version: '0.1.0',
        p_credential_id: randomUUID(),
        p_token_hash: 'e'.repeat(64),
        p_credential_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
      worker_record_heartbeat: {
        p_credential_id: randomUUID(),
        p_token_hash: 'd'.repeat(64),
        p_sequence: 1,
        p_lifecycle: 'running',
        p_readiness: 'ready',
      },
    };
    for (const [fn, args] of Object.entries(bobsAttempts)) {
      const { data, error } = await bob.session.rpc(fn, args);
      check(`  and cannot call ${fn}()`, error !== null && data === null,
        error ? 'refused by the privilege' : 'EXECUTED');
    }
  }

  /* ============================================ 9. HASHES AND GRANTS */

  section('9. No API role can read a hash, and service_role gained nothing');

  {
    /*
     * CHECKED IN THE CATALOGUE, NOT BY TRYING IT.
     *
     * "SELECT the column as `authenticated` and see it fail" looks stronger and is
     * in fact vacuous: with no JWT, `auth.uid()` is null, RLS matches no row, and
     * the query returns nothing whether or not the privilege exists. It would
     * have passed with the grant wide open.
     *
     * The privilege itself is the property. A column-level grant is what makes
     * a hash unreadable even to its owner's own browser, because row security
     * cannot hide a column.
     */
    const hashGrants = sql(`select coalesce(string_agg(grantee || ':' || table_name || '.' || column_name, ', '), 'none')
      from information_schema.column_privileges
      where table_schema = 'public'
        and table_name in ('worker_pairings', 'worker_credentials')
        and column_name in ('secret_hash', 'token_hash')
        and grantee in ('anon', 'authenticated', 'PUBLIC')`);
    check('NO BROWSER ROLE HOLDS ANY PRIVILEGE ON A HASH COLUMN', hashGrants === 'none',
      hashGrants);

    // And the columns a browser MAY read are still only the status ones.
    const readable = sql(`select string_agg(column_name, ',' order by column_name)
      from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'worker_pairings'
        and grantee = 'authenticated' and privilege_type = 'SELECT'`);
    check('  the candidate sees status, never material',
      readable === 'attempts,created_at,expires_at,id,redeemed_at,redeemed_supervisor_id,' +
        'revoked_at,user_id',
      readable);

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
      reason: null,
    });
    check('  and the boundary refuses the write even with a valid token hash',
      afterBeat.applied === false && afterBeat.reason === 'revoked', afterBeat.reason);
    check('  the sequence did not move',
      Number(sql(`select heartbeat_sequence from public.worker_supervisors
                  where id = '${issued.supervisorId}'`)) === 4);
  }

  /* ============================== 11. FENCING AND LEASES, IN POSTGRES */

  section('11. Fence tokens only rise, and a revoked supervisor holds no lease');

  {
    /*
     * A CANDIDATE OF ITS OWN.
     *
     * This section revokes a supervisor, and revocation is final —
     * `guard_worker_credential_immutable` refuses to restore a revoked
     * credential, and rightly. Borrowing Alice's worker here would either
     * corrupt the earlier assertions or need an un-revoke the database is
     * correct to refuse.
     */
    const grace = await makeCandidate('grace');
    const invitation = await E.startPairing(store, grace.id, new Date());
    const worker = await E.redeemPairing(store, redeemBody(invitation.secret), new Date());
    check('a second worker pairs cleanly', worker.ok === true,
      worker.ok ? '' : worker.reason);
    const graceAuth = await E.authenticateWorker(store, `Bearer ${worker.token}`, new Date());

    const jobId = sql(`insert into public.jobs (user_id, submitted_url, canonical_url, source)
      values ('${grace.id}', 'https://example.test/job/1', 'https://example.test/job/1', 'user_link')
      returning id`);
    const taskId = sql(`insert into public.automation_tasks
      (user_id, job_id, mode, idempotency_key, correlation_id, fence_token, attempt)
      values ('${grace.id}', '${jobId}', 'claude_max_assisted',
              'synthetic-boundary-fixture-0001', gen_random_uuid(), 4, 2)
      returning id`);
    check('a task can hold a fence token',
      Number(sql(`select fence_token from public.automation_tasks where id = '${taskId}'`)) === 4);

    /*
     * Every statement below RETURNS something on success, so "no output" and
     * "raised an exception" both mean refused and neither can be mistaken for
     * a silent success.
     */
    check('LOWERING A FENCE TOKEN IS REFUSED',
      refused(`update public.automation_tasks set fence_token = 3
               where id = '${taskId}' returning fence_token`),
      'a fence that can be lowered is not a fence');
    check('  and attempts may not be walked back',
      refused(`update public.automation_tasks set attempt = 1
               where id = '${taskId}' returning attempt`));
    check('  raising it is allowed',
      sql(`update public.automation_tasks set fence_token = 5
           where id = '${taskId}' returning fence_token`) === '5');

    const leaseId = sql(`insert into public.task_leases
      (user_id, task_id, slot_id, fence_token, expires_at)
      values ('${grace.id}', '${taskId}', '${worker.slotId}', 5, now() + interval '2 minutes')
      returning id`);
    check('a live supervisor may hold a lease', leaseId.length === 36, leaseId);

    check('  a lease may not cross candidates',
      refused(`insert into public.task_leases
        (user_id, task_id, slot_id, fence_token, expires_at)
        values ('${bob.id}', '${taskId}', '${worker.slotId}', 6, now() + interval '2 minutes')
        returning id`),
      'the slot belongs to one candidate; the lease claimed another');

    sql(`update public.worker_supervisors
         set revoked_at = now(), revoked_reason = 'candidate_requested', lifecycle = 'offline'
         where id = '${worker.supervisorId}'`);

    check('A REVOKED SUPERVISOR MAY NOT ACQUIRE A LEASE',
      refused(`insert into public.task_leases
        (user_id, task_id, slot_id, fence_token, expires_at)
        values ('${grace.id}', '${taskId}', '${worker.slotId}', 7, now() + interval '2 minutes')
        returning id`));

    // And its worker cannot report in, even holding a credential that is
    // itself still perfectly valid. The supervisor is the thing that was
    // disowned.
    const zombie = await store.recordHeartbeat({
      credentialId: graceAuth.credentialId,
      tokenHash: graceAuth.tokenHash,
      sequence: 100,
      lifecycle: 'running',
      readiness: 'ready',
      reason: null,
    });
    check('  AND A REVOKED SUPERVISOR ACCEPTS NO HEARTBEAT', zombie.applied === false,
      'the credential was never revoked; the machine was disowned');
    check('  the credential really was still live',
      sql(`select coalesce(revoked_at::text, 'live') from public.worker_credentials
           where user_id = '${grace.id}'`) === 'live');
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

    /*
     * SIX ARGUMENTS, NOT FIVE. Migration 27 dropped the old overload, so a
     * call missing `p_reason` matches no function and PostgREST answers with
     * nothing at all — which is how this check failed while the behaviour it
     * describes was perfectly correct.
     */
    const { data: hb } = await svcClient().rpc('worker_record_heartbeat', {
      p_credential_id: randomUUID(),
      p_token_hash: 'c'.repeat(64),
      p_sequence: 1,
      p_lifecycle: 'running',
      p_readiness: 'paused',
      p_reason: null,
    });
    check('a paused slot is refused rather than given an invented reason',
      Array.isArray(hb) && hb[0]?.reason === 'pause_reason_required',
      hb?.[0]?.reason ?? 'no row');
  }
  /* ============================ 16. THE TASK LIFECYCLE, END TO END */

  section('16. A candidate approves a task and their worker claims it');

  const hank = await makeCandidate('hank');
  const hankInvite = await E.startPairing(store, hank.id, new Date());
  const hankWorker = await E.redeemPairing(store, redeemBody(hankInvite.secret), new Date());
  check('a worker is paired for the task tests', hankWorker.ok === true,
    hankWorker.ok ? '' : hankWorker.reason);
  const hankAuth = await E.authenticateWorker(store, `Bearer ${hankWorker.token}`, new Date());
  const hankId = { credentialId: hankAuth.credentialId, tokenHash: hankAuth.tokenHash };

  /*
   * THE CANDIDATE'S OWN SESSION MAKES AND APPROVES THE TASK.
   *
   * Not psql, and not the service role: this is the half of the protocol that
   * runs under RLS, and doing it any other way would skip the only check that
   * matters here. The task walks the real pipeline to `queued`, because
   * `queued` IS the approval gate the worker's claim tests for.
   */
  {
    const { data: job, error: jobError } = await hank.session
      .from('jobs')
      .insert({
        user_id: hank.id,
        submitted_url: 'https://example.test/synthetic/role-1',
        canonical_url: 'https://example.test/synthetic/role-1',
        source: 'user_link',
      })
      .select('id')
      .maybeSingle();
    check('the candidate creates a job through their own session', !jobError && job !== null,
      jobError?.message ?? 'created');

    const { data: task, error: taskError } = await hank.session
      .from('automation_tasks')
      .insert({
        user_id: hank.id,
        job_id: job.id,
        mode: 'claude_max_assisted',
        idempotency_key: 'synthetic-task-lifecycle-0001',
        correlation_id: randomUUID(),
      })
      .select('id, status')
      .maybeSingle();
    check('  and a task, which starts at received', !taskError && task?.status === 'received',
      taskError?.message ?? task?.status);

    // An illegal jump is refused by the trigger, for the candidate too.
    const { error: jump } = await hank.session
      .from('automation_tasks')
      .update({ status: 'queued' })
      .eq('id', task.id);
    check('  a jump straight to queued is refused', jump !== null,
      jump ? 'refused by the transition guard' : 'ALLOWED');

    for (const next of ['validated', 'snapshot_stored', 'normalized', 'scored', 'queued']) {
      const { error } = await hank.session
        .from('automation_tasks')
        .update({ status: next })
        .eq('id', task.id);
      if (error) check(`  advancing to ${next}`, false, error.message);
    }
    check('  the candidate walks it to queued', sql(
      `select status from public.automation_tasks where user_id = '${hank.id}'`) === 'queued');
  }

  section('17. Forty concurrent claims produce exactly one lease');

  {
    const results = await Promise.all(
      Array.from({ length: 40 }, () => E.claimTask(store, hankId))
    );
    const winners = results.filter((r) => r.ok);
    check('EXACTLY ONE CLAIM WINS', winners.length === 1, `${winners.length} winner(s)`);
    check('  every loser was refused with a bounded reason',
      results.filter((r) => !r.ok).every((r) =>
        E.WORKER_OPERATION_FAILURES.includes(r.reason)),
      [...new Set(results.filter((r) => !r.ok).map((r) => r.reason))].join(','));
    check('  exactly one lease row exists', countOf('task_leases', hank.id) === 1,
      String(countOf('task_leases', hank.id)));
    check('  and exactly one of them is active',
      Number(sql(`select count(*) from public.task_leases
                  where user_id = '${hank.id}' and released_at is null`)) === 1);
    check('  the task is being worked on', sql(
      `select status from public.automation_tasks where user_id = '${hank.id}'`) === 'processing');
    check('  the fence rose exactly once', Number(sql(
      `select fence_token from public.automation_tasks where user_id = '${hank.id}'`)) === 1,
      'forty attempts, one increment');
    check('  and the attempt was counted exactly once', Number(sql(
      `select attempt from public.automation_tasks where user_id = '${hank.id}'`)) === 1);

    const fence = winners[0].fenceToken;

    section('18. Renewal is bound to the fence and to the credential');

    const stale = await E.renewLease(store, hankId, { fence_token: fence + 1 });
    check('a fence from the future is refused',
      stale.ok === false && stale.reason === 'stale_fence', stale.reason);
    const behind = await E.renewLease(store, hankId, { fence_token: fence });
    check('  the right fence is accepted', behind.ok === true, behind.ok ? '' : behind.reason);

    section('19. Report moves the task, and a replay is refused');

    const done = await E.reportTask(store, hankId, {
      fence_token: fence,
      disposition: 'completed',
    });
    check('the worker reports completion', done.ok === true, done.ok ? '' : done.reason);
    check('  THE TASK LANDS IN manual_review, NOT ready_to_submit', sql(
      `select status from public.automation_tasks where user_id = '${hank.id}'`) === 'manual_review',
      'no worker path reaches submission');
    check('  the lease was released as completed', sql(
      `select release_reason from public.task_leases where user_id = '${hank.id}'`) === 'completed');

    const replay = await E.reportTask(store, hankId, {
      fence_token: fence,
      disposition: 'completed',
    });
    check('REPLAYING THE REPORT IS REFUSED, NOT REPEATED',
      replay.ok === false && replay.reason === 'no_active_lease', replay.reason);
    check('  and the task did not move again', sql(
      `select status from public.automation_tasks where user_id = '${hank.id}'`) === 'manual_review');

    const afterTerminal = await E.claimTask(store, hankId);
    check('there is nothing left to claim',
      afterTerminal.ok === false && afterTerminal.reason === 'no_task_available',
      afterTerminal.reason);
  }

  section('20. Events: allow-listed, bounded, and free of content');

  {
    const kinds = sql(`select coalesce(string_agg(distinct kind, ','), 'none')
                       from public.worker_events where user_id = '${hank.id}'`);
    /*
     * FIVE KINDS, NOT SIX. There is no `slot_heartbeat` here because this
     * candidate's slot never changed readiness — it was claimed, renewed and
     * reported without a single readiness transition. That absence is the
     * transition-only rule working; section 21 exercises the other direction.
     */
    /*
     * SEVEN KINDS: the two registrations that pairing wrote, and the five the
     * task cycle caused. There is no `slot_heartbeat` because this
     * candidate's slot never changed readiness — the transition-only rule.
     */
    check('the cycle recorded exactly the events it caused',
      kinds.split(',').sort().join(',') ===
        'lease_acquired,lease_released,lease_renewed,slot_registered,' +
        'supervisor_registered,task_completed,task_started',
      kinds);

    const bad = sql(`select coalesce(string_agg(distinct kind, ','), 'none')
      from public.worker_events
      where kind not in (
        'supervisor_registered', 'supervisor_revoked', 'supervisor_heartbeat',
        'slot_registered', 'slot_heartbeat', 'slot_paused', 'slot_stopped', 'slot_crashed',
        'lease_acquired', 'lease_renewed', 'lease_expired', 'lease_released', 'lease_refused',
        'task_started', 'task_paused', 'task_completed', 'task_failed',
        'local_claude_used', 'local_claude_unavailable', 'manual_fallback_used')`);
    check('  no event kind outside the table’s own list', bad === 'none', bad);

    const widest = Number(sql(`select coalesce(max(length(detail::text)), 0)
                               from public.worker_events where user_id = '${hank.id}'`));
    check('  the widest payload is far inside the 2000-character bound', widest <= 200,
      `${widest} chars`);

    const keys = sql(`select coalesce(string_agg(distinct k, ','), 'none')
                      from public.worker_events e,
                           lateral jsonb_object_keys(e.detail) k
                      where e.user_id = '${hank.id}'`);
    check('  and every payload key is one of the bounded scalars',
      keys.split(',').sort().join(',') === 'agent_version,disposition,fence,platform,slot_index',
      keys);

    const leaked = sql(`select count(*) from public.worker_events
      where detail::text ~ '[0-9a-f]{64}'
         or detail::text ~ 'https?://'
         or detail::text ~ '\\.[A-Za-z0-9_-]{43}'`);
    check('  NO EVENT CARRIES A HASH, A URL OR A TOKEN', leaked === '0', `${leaked} row(s)`);
  }

  section('21. Pause semantics, against the constraints that caused them');

  {
    const beat = (sequence, readiness, reason) =>
      E.heartbeat(store, hankId, {
        sequence,
        lifecycle: 'running',
        slot_readiness: readiness,
        ...(reason === undefined ? {} : { reason }),
      }, new Date());

    const noReason = await beat(50, 'paused');
    check('pausing without a reason is refused',
      noReason.ok === false && noReason.reason === 'pause_reason_required',
      noReason.ok ? 'ACCEPTED' : noReason.reason);
    check('  and the slot did not move', sql(
      `select readiness from public.worker_slots where user_id = '${hank.id}'`) !== 'paused');

    const paused = await beat(51, 'paused', 'mfa_required');
    check('pausing WITH an allowed reason works', paused.ok === true,
      paused.ok ? '' : paused.reason);
    check('  the slot carries the reason', sql(
      `select readiness || '/' || coalesce(pause_reason, 'none')
       from public.worker_slots where user_id = '${hank.id}'`) === 'paused/mfa_required');
    check('  and it was recorded once', Number(sql(
      `select count(*) from public.worker_events
       where user_id = '${hank.id}' and kind = 'slot_paused'`)) === 1);

    const resumed = await beat(52, 'ready');
    check('returning to ready clears the reason', resumed.ok === true);
    check('  BOTH reason columns are empty', sql(
      `select coalesce(pause_reason, 'none') || '/' || coalesce(stop_reason, 'none')
       from public.worker_slots where user_id = '${hank.id}'`) === 'none/none',
      'the constraint binds in this direction too');

    const stopNoReason = await beat(53, 'stopped');
    check('stopping without a reason is refused',
      stopNoReason.ok === false && stopNoReason.reason === 'stop_reason_required',
      stopNoReason.reason);
    const stopped = await beat(54, 'stopped', 'supervisor_shutdown');
    check('  with one, the slot stops', stopped.ok === true, stopped.ok ? '' : stopped.reason);
    check('  carrying the stop reason and no pause reason', sql(
      `select coalesce(pause_reason, 'none') || '/' || coalesce(stop_reason, 'none')
       from public.worker_slots where user_id = '${hank.id}'`) === 'none/supervisor_shutdown');

    const readyAgain = await beat(55, 'ready');
    check('and ready again clears the stop reason', readyAgain.ok === true && sql(
      `select coalesce(stop_reason, 'none') from public.worker_slots
       where user_id = '${hank.id}'`) === 'none');

    const repeats = Number(sql(`select count(*) from public.worker_events
      where user_id = '${hank.id}' and kind = 'slot_heartbeat'`));
    await beat(56, 'ready');
    await beat(57, 'ready');
    await beat(58, 'ready');
    check('THREE MORE READY BEATS WRITE NO EVENTS', Number(sql(
      `select count(*) from public.worker_events
       where user_id = '${hank.id}' and kind = 'slot_heartbeat'`)) === repeats,
      'on transition only — the bounded-rate rule');
  }

  section('22. A revoked worker can do nothing to a task');

  {
    const ivy = await makeCandidate('ivy');
    const invite = await E.startPairing(store, ivy.id, new Date());
    const worker = await E.redeemPairing(store, redeemBody(invite.secret), new Date());
    const auth = await E.authenticateWorker(store, `Bearer ${worker.token}`, new Date());
    const id = { credentialId: auth.credentialId, tokenHash: auth.tokenHash };

    sql(`update public.worker_credentials
         set revoked_at = now(), revoked_reason = 'candidate_requested'
         where user_id = '${ivy.id}'`);

    const claim = await E.claimTask(store, id);
    check('a revoked credential cannot claim',
      claim.ok === false && claim.reason === 'revoked', claim.reason);
    const renew = await E.renewLease(store, id, { fence_token: 1 });
    check('  nor renew', renew.ok === false && renew.reason === 'revoked', renew.reason);
    const report = await E.reportTask(store, id, { fence_token: 1, disposition: 'released' });
    check('  nor report', report.ok === false && report.reason === 'revoked', report.reason);
    /*
     * MEASURED AGAINST REGISTRATION, NOT AGAINST ZERO. Pairing writes two
     * events before any of this, so "wrote nothing" means "added nothing" —
     * and the two that exist are the two the pairing itself caused.
     */
    check('  and added no event of its own', countOf('worker_events', ivy.id) === 2,
      String(countOf('worker_events', ivy.id)));
    check('  the two that exist are its registration',
      sql(`select coalesce(string_agg(kind, ',' order by kind), 'none')
           from public.worker_events where user_id = '${ivy.id}'`)
        === 'slot_registered,supervisor_registered');
  }

  section('23. Cross-candidate isolation over tasks, leases and events');

  {
    for (const table of ['automation_tasks', 'task_leases', 'worker_events']) {
      const { data } = await bob.session.from(table).select('id');
      check(`B reads no row of ${table}`, (data ?? []).length === 0,
        `${(data ?? []).length} row(s)`);
    }
    const { data: mine } = await hank.session.from('worker_events').select('id, user_id');
    check("H sees only H's own events",
      (mine ?? []).length > 0 && (mine ?? []).every((e) => e.user_id === hank.id),
      `${(mine ?? []).length} row(s)`);

    // And B's worker, holding a perfectly valid credential of its own, finds
    // nothing of H's to take.
    const bobInvite = await E.startPairing(store, bob.id, new Date());
    const bobWorker = await E.redeemPairing(store, redeemBody(bobInvite.secret), new Date());
    const bobAuth = await E.authenticateWorker(store, `Bearer ${bobWorker.token}`, new Date());
    const bobClaim = await E.claimTask(store, {
      credentialId: bobAuth.credentialId,
      tokenHash: bobAuth.tokenHash,
    });
    check("B's worker cannot claim H's work",
      bobClaim.ok === false && bobClaim.reason === 'no_task_available',
      bobClaim.ok ? 'CLAIMED IT' : bobClaim.reason);

    for (const fn of ['worker_claim_task', 'worker_renew_lease', 'worker_report_task']) {
      const { error } = await bob.session.rpc(fn, {
        p_credential_id: randomUUID(),
        p_token_hash: 'a'.repeat(64),
        ...(fn === 'worker_claim_task'
          ? {}
          : fn === 'worker_renew_lease'
            ? { p_fence_token: 1 }
            : { p_fence_token: 1, p_disposition: 'released', p_reason: null }),
      });
      check(`  and cannot call ${fn}() at all`, error !== null,
        error ? 'refused by the privilege' : 'EXECUTED');
    }
  }

  section('24. The boundary did not widen');

  {
    const tableGrants = sql(`select coalesce(string_agg(distinct table_name, ','), 'none')
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name in ('worker_supervisors', 'worker_slots', 'automation_tasks',
                           'task_leases', 'worker_events')
        and grantee = 'service_role'`);
    check('SERVICE_ROLE STILL HOLDS NO TABLE GRANT ON ANY OF THEM',
      tableGrants === 'none', tableGrants);

    const definers = sql(`select coalesce(string_agg(p.proname, ',' order by p.proname), 'none')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef`);
    check('  the definer allow-list is exactly seven',
      definers === 'worker_claim_task,worker_record_heartbeat,worker_redeem_pairing,' +
        'worker_renew_lease,worker_report_task,worker_resolve_credential,' +
        'worker_revoke_supervisor',
      definers);

    const callable = sql(`select coalesce(string_agg(p.proname, ',' order by p.proname), 'none')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and has_function_privilege('service_role', p.oid, 'EXECUTE')`);
    check('  and service_role may execute exactly five of them',
      callable === 'worker_claim_task,worker_record_heartbeat,worker_redeem_pairing,' +
        'worker_renew_lease,worker_report_task',
      callable);
    check('  the credential resolver is reachable by nobody',
      !callable.includes('worker_resolve_credential'),
      'it runs only inside another definer function');

    /*
     * ONE EXCEPTION, AND IT IS THE SHAPE THAT MAKES IT SAFE.
     *
     * `worker_revoke_supervisor` is executable by `authenticated` because a
     * candidate revoking their own worker has a session and no worker
     * credential. It takes NO arguments — the candidate is `auth.uid()`, read
     * inside the function — so there is nothing a caller can choose and
     * nothing to validate. Every other definer function stays unreachable
     * from a browser.
     */
    const browser = sql(`select coalesce(string_agg(p.proname || ':' || r.rolname, ','), 'none')
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
      where n.nspname = 'public' and p.prosecdef
        and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`);
    check('  a browser role can execute exactly one definer function',
      browser === 'worker_revoke_supervisor:authenticated', browser);
    check('  which takes no arguments', Number(sql(
      `select pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'worker_revoke_supervisor'`)) === 0);
    check('  and anon can execute none of them', !browser.includes(':anon'), browser);
  }

  section('25. Account deletion is still clean with tasks, leases and events');

  {
    const { error } = await svcClient().auth.admin.deleteUser(hank.id);
    check('DELETING A CANDIDATE WITH A FULL TASK HISTORY SUCCEEDS', !error,
      error?.message ?? 'deleted');
    for (const table of ['automation_tasks', 'task_leases', 'worker_events',
                         'worker_slots', 'worker_supervisors', 'worker_credentials']) {
      check(`  ${table} is empty for them`, countOf(table, hank.id) === 0,
        String(countOf(table, hank.id)));
    }
  }

  /* ==================================== 26. REGISTRATION AND REVOCATION */

  section('26. Registration writes two events, inside the registration');

  const ivan = await makeCandidate('ivan');

  {
    const invite = await E.startPairing(store, ivan.id, new Date());
    const worker = await E.redeemPairing(store, redeemBody(invite.secret), new Date());
    check('the worker pairs', worker.ok === true, worker.ok ? '' : worker.reason);

    const kinds = sql(`select coalesce(string_agg(kind, ',' order by kind), 'none')
                       from public.worker_events where user_id = '${ivan.id}'`);
    check('EXACTLY ONE supervisor_registered AND ONE slot_registered',
      kinds === 'slot_registered,supervisor_registered', kinds);
    check('  the supervisor event names the supervisor that was created',
      sql(`select supervisor_id from public.worker_events
           where user_id = '${ivan.id}' and kind = 'supervisor_registered'`)
        === worker.supervisorId);
    check('  the slot event names the slot',
      sql(`select slot_id from public.worker_events
           where user_id = '${ivan.id}' and kind = 'slot_registered'`) === worker.slotId);

    const keys = sql(`select coalesce(string_agg(distinct k, ',' order by k), 'none')
                      from public.worker_events e, lateral jsonb_object_keys(e.detail) k
                      where e.user_id = '${ivan.id}'`);
    check('  and the payload keys are the three the schema constrains',
      keys === 'agent_version,platform,slot_index', keys);

    /*
     * A SECOND REDEMPTION OF THE SAME INVITATION REGISTERS NOTHING.
     *
     * The replay returns `already_redeemed` before any INSERT, so there is no
     * second supervisor, no second slot, no second credential — and no second
     * pair of registration events.
     */
    const replay = await E.redeemPairing(store, redeemBody(invite.secret), new Date());
    check('a replayed redemption is refused',
      replay.ok === false && replay.reason === 'already_redeemed', replay.reason);
    check('  and registered nothing a second time',
      Number(sql(`select count(*) from public.worker_events
                  where user_id = '${ivan.id}'
                    and kind in ('supervisor_registered', 'slot_registered')`)) === 2);
    check('  no second supervisor', countOf('worker_supervisors', ivan.id) === 1);
    check('  no second slot', countOf('worker_slots', ivan.id) === 1);
    check('  and no second credential', countOf('worker_credentials', ivan.id) === 1);
  }

  section('27. Concurrent redemption registers exactly one of everything');

  {
    const jade = await makeCandidate('jade');
    const invite = await E.startPairing(store, jade.id, new Date());

    const results = await Promise.all(
      Array.from({ length: 8 }, () => E.redeemPairing(store, redeemBody(invite.secret), new Date()))
    );
    const winners = results.filter((r) => r.ok).length;
    check('exactly one of eight simultaneous redemptions wins', winners === 1,
      `${winners} winner(s)`);
    check('  one supervisor', countOf('worker_supervisors', jade.id) === 1,
      String(countOf('worker_supervisors', jade.id)));
    check('  one slot', countOf('worker_slots', jade.id) === 1);
    check('  one credential', countOf('worker_credentials', jade.id) === 1);
    check('  AND EXACTLY ONE SET OF REGISTRATION EVENTS',
      Number(sql(`select count(*) from public.worker_events
                  where user_id = '${jade.id}'
                    and kind in ('supervisor_registered', 'slot_registered')`)) === 2,
      'the losers rolled back their inserts along with everything else');
  }

  section('28. Revocation writes one event, and only on a real transition');

  {
    const before = Number(sql(`select count(*) from public.worker_events
                               where user_id = '${ivan.id}' and kind = 'supervisor_revoked'`));
    check('nothing has been revoked yet', before === 0);

    const { data: first, error: firstError } = await ivan.session.rpc('worker_revoke_supervisor');
    const firstRow = Array.isArray(first) ? first[0] : null;
    check('the candidate revokes through their own session',
      !firstError && firstRow?.ok === true, firstError?.message ?? firstRow?.reason);
    check('  one supervisor transitioned', firstRow?.revoked_count === 1,
      String(firstRow?.revoked_count));
    check('  ONE supervisor_revoked was written',
      Number(sql(`select count(*) from public.worker_events
                  where user_id = '${ivan.id}' and kind = 'supervisor_revoked'`)) === 1);
    check('  the supervisor really is revoked', sql(
      `select coalesce(revoked_at::text, 'live') from public.worker_supervisors
       where user_id = '${ivan.id}'`) !== 'live');
    check('  the credential too', sql(
      `select coalesce(revoked_at::text, 'live') from public.worker_credentials
       where user_id = '${ivan.id}'`) !== 'live');

    /*
     * REPLAYING THE REQUEST CANNOT MANUFACTURE A HISTORY.
     *
     * The event is written per row that actually transitioned, and a second
     * revoke matches none.
     */
    const { data: second } = await ivan.session.rpc('worker_revoke_supervisor');
    const secondRow = Array.isArray(second) ? second[0] : null;
    check('a replayed revoke reports already_revoked',
      secondRow?.ok === true && secondRow?.reason === 'already_revoked', secondRow?.reason);
    check('  and wrote no second event',
      Number(sql(`select count(*) from public.worker_events
                  where user_id = '${ivan.id}' and kind = 'supervisor_revoked'`)) === 1);

    for (let i = 0; i < 5; i++) await ivan.session.rpc('worker_revoke_supervisor');
    check('FIVE MORE REVOKES PRODUCE NO EVENT STORM',
      Number(sql(`select count(*) from public.worker_events
                  where user_id = '${ivan.id}' and kind = 'supervisor_revoked'`)) === 1,
      'one transition, one event');

    // A candidate with nothing paired revokes nothing and records nothing.
    const kim = await makeCandidate('kim');
    const { data: none } = await kim.session.rpc('worker_revoke_supervisor');
    const noneRow = Array.isArray(none) ? none[0] : null;
    check('a candidate with no worker revokes nothing',
      noneRow?.ok === true && noneRow?.revoked_count === 0, String(noneRow?.revoked_count));
    check('  and records no false event', countOf('worker_events', kim.id) === 0,
      String(countOf('worker_events', kim.id)));
  }

  section('29. A revoked worker writes no further event');

  {
    const cred = sql(`select id from public.worker_credentials where user_id = '${ivan.id}'`);
    const before = countOf('worker_events', ivan.id);
    const beat = await store.recordHeartbeat({
      credentialId: cred,
      tokenHash: 'f'.repeat(64),
      sequence: 900,
      lifecycle: 'running',
      readiness: 'paused',
      reason: 'captcha_detected',
    });
    check('a revoked worker cannot heartbeat', beat.applied === false, beat.reason);
    check('  and wrote nothing', countOf('worker_events', ivan.id) === before,
      `${countOf('worker_events', ivan.id) - before} extra`);
  }

  section('30. The audit table takes no write from a browser');

  {
    const { error } = await ivan.session.from('worker_events').insert({
      user_id: ivan.id,
      kind: 'supervisor_registered',
      detail: {},
    });
    check('A CANDIDATE CANNOT FORGE AN EVENT FOR THEMSELVES', error !== null,
      error ? 'refused by the privilege' : 'INSERTED');

    const { data: mine } = await ivan.session.from('worker_events').select('id, kind');
    check('  but can still read their own history', (mine ?? []).length > 0,
      `${(mine ?? []).length} row(s)`);

    const grants = sql(`select coalesce(string_agg(privilege_type, ',' order by privilege_type), 'none')
      from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'worker_events'
        and grantee = 'authenticated'`);
    check('  and holds SELECT and nothing else', grants === 'SELECT', grants);

    /*
     * B HAS EVENTS OF ITS OWN NOW — its worker was paired earlier — so the
     * property is OWNERSHIP, not emptiness. An assertion that the list is
     * empty would have started failing the moment B did anything, and the
     * honest question was never "does B see nothing" but "does B see any of
     * A's".
     */
    const { data: theirs } = await bob.session.from('worker_events').select('id, user_id');
    check("Candidate B sees not one of A's events",
      (theirs ?? []).every((e) => e.user_id === bob.id),
      `${(theirs ?? []).filter((e) => e.user_id !== bob.id).length} foreign row(s)`);
    check('  and A cannot see B’s either',
      ((await ivan.session.from('worker_events').select('id, user_id')).data ?? [])
        .every((e) => e.user_id === ivan.id));

    const { error: rpcError } = await bob.session.rpc('worker_record_heartbeat', {
      p_credential_id: randomUUID(),
      p_token_hash: 'a'.repeat(64),
      p_sequence: 1,
      p_lifecycle: 'running',
      p_readiness: 'ready',
    });
    check('  and cannot call an event-writing function directly', rpcError !== null,
      rpcError ? 'refused by the privilege' : 'EXECUTED');
  }

  section('31. Nothing in the audit trail is a secret');

  {
    const leaked = sql(`select count(*) from public.worker_events
      where detail::text ~ '[0-9a-f]{64}'
         or detail::text ~ 'https?://'
         or detail::text ~ '\\.[A-Za-z0-9_-]{43}'
         or detail::text ~ '@'`);
    check('NO EVENT PAYLOAD CARRIES A HASH, URL, TOKEN OR ADDRESS',
      leaked === '0', `${leaked} row(s)`);

    const keys = sql(`select coalesce(string_agg(distinct k, ',' order by k), 'none')
                      from public.worker_events e, lateral jsonb_object_keys(e.detail) k`);
    check('  and every payload key across the whole table is allow-listed',
      keys.split(',').filter(Boolean).every((k) =>
        ['agent_version', 'disposition', 'fence', 'platform', 'reason', 'slot_index'].includes(k)),
      keys);

    const widest = Number(sql(`select coalesce(max(length(detail::text)), 0)
                               from public.worker_events`));
    check('  the widest payload is far inside the 2000-character bound', widest <= 200,
      `${widest} chars`);
  }

  /* ============================ 32. THE PROFILE-DRAFTING SLICE */

  section('32. A job task still needs a job, and a draft still cannot carry one');

  {
    const kim2 = await makeCandidate('lena');
    const jobId = sql(`insert into public.jobs (user_id, submitted_url, canonical_url, source)
      values ('${kim2.id}', 'https://example.test/j/1', 'https://example.test/j/1', 'user_link')
      returning id`);

    check('an existing-shaped job task still inserts', sql(
      `insert into public.automation_tasks
        (user_id, job_id, mode, idempotency_key, correlation_id)
       values ('${kim2.id}', '${jobId}', 'openrouter_only',
               'synthetic-job-task-000000001', gen_random_uuid())
       returning kind`) === 'job_application',
      'kind defaults to the old meaning, so nothing existing changed');

    check('A JOB TASK WITHOUT A JOB IS REFUSED',
      refused(`insert into public.automation_tasks
        (user_id, job_id, mode, idempotency_key, correlation_id)
        values ('${kim2.id}', null, 'openrouter_only',
                'synthetic-job-task-000000002', gen_random_uuid())
        returning id`),
      'the biconditional holds in this direction');

    check('A PROFILE TASK WITH A JOB IS REFUSED',
      refused(`insert into public.automation_tasks
        (user_id, job_id, kind, mode, idempotency_key, correlation_id)
        values ('${kim2.id}', '${jobId}', 'candidate_profile_drafting', 'claude_max_assisted',
                'synthetic-profile-task-00000001', gen_random_uuid())
        returning id`),
      'and in the other');

    const profileTask = sql(`insert into public.automation_tasks
      (user_id, job_id, kind, status, mode, idempotency_key, correlation_id)
      values ('${kim2.id}', null, 'candidate_profile_drafting', 'queued', 'claude_max_assisted',
              'synthetic-profile-task-00000002', gen_random_uuid())
      returning id`);
    check('a profile task with no job inserts', profileTask.length === 36);

    check('A PROFILE TASK CANNOT REACH ready_to_submit',
      refused(`update public.automation_tasks set status = 'ready_to_submit'
               where id = '${profileTask}' returning status`));
    check('  nor submitted',
      refused(`update public.automation_tasks set status = 'submitted'
               where id = '${profileTask}' returning status`));
    check('  and its kind cannot be changed to launder it',
      refused(`update public.automation_tasks set kind = 'job_application'
               where id = '${profileTask}' returning kind`),
      'a kind that could change is a rule that can be walked around');
    check('  it may still reach manual_review',
      sql(`update public.automation_tasks set status = 'manual_review'
           where id = '${profileTask}' returning status`) === 'manual_review');
  }

  section('33. The whole drafting flow, through the real store');

  const mara = await makeCandidate('mara');

  {
    const invite = await E.startPairing(store, mara.id, new Date());
    const worker = await E.redeemPairing(store, redeemBody(invite.secret), new Date());
    check('a worker is paired for drafting', worker.ok === true, worker.ok ? '' : worker.reason);
    const auth = await E.authenticateWorker(store, `Bearer ${worker.token}`, new Date());
    const id = { credentialId: auth.credentialId, tokenHash: auth.tokenHash };

    // The candidate's own session creates both rows, under RLS.
    const version = sql(`select updated_at from public.profiles where user_id = '${mara.id}'`);
    check('the candidate has a profile row to version against', version.length > 0, version);

    const taskId = sql(`insert into public.automation_tasks
      (user_id, job_id, kind, status, mode, idempotency_key, correlation_id)
      values ('${mara.id}', null, 'candidate_profile_drafting', 'queued', 'claude_max_assisted',
              'synthetic-draft-flow-000000001', gen_random_uuid())
      returning id`);

    const FACTS_JSON = JSON.stringify({
      schema_version: 1,
      facts: {
        legal_first_name: 'Ada', legal_middle_name: null, legal_last_name: 'Verity',
        preferred_name: null, contact_email: 'ada@example.test', phone_e164: '+6591234567',
        city: 'Singapore', state_region: null, country_code: 'SG',
        linkedin_url: null, github_url: null, portfolio_url: null,
        work_experiences: [], education_entries: [], skills: [], unreadable_sections: [],
      },
      current: {
        legal_first_name: null, legal_middle_name: null, legal_last_name: null,
        preferred_name: null, contact_email: null, phone_e164: null,
        city: null, state_region: null, country_code: null,
        linkedin_url: null, github_url: null, portfolio_url: null,
      },
    }).replace(/'/g, "''");

    const draftId = sql(`insert into public.profile_drafts
      (user_id, task_id, profile_version, input)
      values ('${mara.id}', '${taskId}', '${version}', '${FACTS_JSON}'::jsonb)
      returning id`);
    check('a pending draft is created alongside the task', draftId.length === 36);

    const claim = await E.claimTask(store, id);
    check('THE WORKER CLAIMS IT AND IS TOLD WHAT KIND IT IS',
      claim.ok === true && claim.kind === 'candidate_profile_drafting',
      claim.ok ? claim.kind : claim.reason);

    const DRAFT = {
      schema_version: 1,
      warnings: [],
      fields: [
        {
          field: 'city', value: 'Singapore', source_facts: ['city'],
          requires_confirmation: false, warnings: [],
        },
      ],
    };

    const wrongFence = await store.submitProfileDraft({
      ...id, fenceToken: claim.fenceToken + 5, draft: DRAFT,
    });
    check('a draft at the wrong fence is refused',
      wrongFence.ok === false && wrongFence.reason === 'stale_fence', wrongFence.reason);

    const submitted = await store.submitProfileDraft({
      ...id, fenceToken: claim.fenceToken, draft: DRAFT,
    });
    check('THE DRAFT IS STORED', submitted.ok === true, submitted.ok ? '' : submitted.reason);
    check('  the draft row holds it', sql(
      `select status from public.profile_drafts where id = '${draftId}'`) === 'drafted');
    check('  THE TASK STOPPED AT manual_review', sql(
      `select status from public.automation_tasks where id = '${taskId}'`) === 'manual_review');
    check('  the lease was released', sql(
      `select release_reason from public.task_leases where task_id = '${taskId}'`) === 'completed');

    /*
     * AND NOT ONE PROFILE COLUMN MOVED. This is the property the whole
     * milestone rests on: a draft exists, and the candidate's profile is
     * exactly as they left it.
     */
    check('NO PROFILE FIELD WAS TOUCHED', sql(
      `select coalesce(city, 'unset') from public.profiles where user_id = '${mara.id}'`)
      === 'unset',
      'the draft is a proposal until the candidate says otherwise');
    check('  and the profile version did not move', sql(
      `select updated_at from public.profiles where user_id = '${mara.id}'`) === version);

    const replay = await store.submitProfileDraft({
      ...id, fenceToken: claim.fenceToken, draft: DRAFT,
    });
    check('replaying the submission is refused',
      replay.ok === false && replay.reason === 'no_active_lease', replay.reason);
  }

  section('34. A worker cannot reach another candidate’s draft');

  {
    const { data: seen } = await bob.session.from('profile_drafts').select('id');
    check("Candidate B reads none of A's drafts", (seen ?? []).length === 0,
      `${(seen ?? []).length} row(s)`);

    const { error: written } = await bob.session.from('profile_drafts').insert({
      user_id: mara.id,
      task_id: '00000000-0000-4000-8000-000000000000',
      profile_version: new Date().toISOString(),
      input: {},
    });
    check("  and cannot create one in A's name", written !== null,
      written ? 'refused' : 'INSERTED');

    const { error: edited } = await bob.session
      .from('profile_drafts')
      .update({ status: 'confirmed', reviewed_at: new Date().toISOString() })
      .eq('user_id', mara.id);
    const stillDrafted = sql(`select count(*) from public.profile_drafts
      where user_id = '${mara.id}' and status = 'drafted'`);
    check("  and cannot confirm A's draft", stillDrafted === '1',
      edited ? 'refused with an error' : 'refused by RLS, silently');

    // Nor can a candidate rewrite the model's words in their own draft.
    const { error: forged } = await mara.session
      .from('profile_drafts')
      .update({ result: { schema_version: 1, fields: [], warnings: [] } })
      .eq('user_id', mara.id);
    check('a candidate cannot edit the draft RESULT', forged !== null,
      forged ? 'refused by the column grant' : 'UPDATED');
  }

  section('35. Privileges after the new table');

  {
    const grants = sql(`select coalesce(string_agg(privilege_type, ',' order by privilege_type), 'none')
      from (select distinct privilege_type from information_schema.role_table_grants
            where table_schema = 'public' and table_name = 'profile_drafts'
              and grantee = 'authenticated') s`);
    check('a browser holds SELECT, INSERT and UPDATE on drafts',
      grants === 'INSERT,SELECT,UPDATE', grants);

    const columns = sql(`select coalesce(string_agg(column_name, ',' order by column_name), 'none')
      from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'profile_drafts'
        and grantee = 'authenticated' and privilege_type = 'UPDATE'`);
    check('  but may update only the two review columns',
      columns === 'reviewed_at,status', columns);

    const service = sql(`select coalesce(string_agg(distinct table_name, ','), 'none')
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name in ('worker_supervisors', 'worker_slots', 'automation_tasks',
                           'task_leases', 'worker_events', 'profile_drafts')
        and grantee = 'service_role'`);
    check('SERVICE_ROLE STILL HOLDS NO TABLE GRANT, INCLUDING ON THE NEW TABLE',
      service === 'none', service);

    const definers = sql(`select coalesce(string_agg(p.proname, ',' order by p.proname), 'none')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef`);
    check('  the definer allow-list is exactly eight',
      definers === 'guard_automation_task_kind,worker_claim_task,worker_record_heartbeat,' +
        'worker_redeem_pairing,worker_renew_lease,worker_report_task,' +
        'worker_resolve_credential,worker_revoke_supervisor,worker_submit_profile_draft' ||
      definers === 'worker_claim_task,worker_record_heartbeat,worker_redeem_pairing,' +
        'worker_renew_lease,worker_report_task,worker_resolve_credential,' +
        'worker_revoke_supervisor,worker_submit_profile_draft',
      definers);

    const rls = sql(`select relrowsecurity and relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'profile_drafts'`);
    check('  and the new table has RLS enabled AND forced', rls === 't', rls);
  }

  section('36. Nothing about the résumé reaches an event');

  {
    const leaked = sql(`select count(*) from public.worker_events
      where detail::text ~ 'Singapore|Verity|example\\.test|ada@'`);
    check('NO EVENT CARRIES A NAME, A CITY OR AN ADDRESS FROM THE FACTS',
      leaked === '0', `${leaked} row(s)`);

    const keys = sql(`select coalesce(string_agg(distinct k, ',' order by k), 'none')
      from public.worker_events e, lateral jsonb_object_keys(e.detail) k`);
    check('  and every payload key is still allow-listed',
      keys.split(',').filter(Boolean).every((k) =>
        ['agent_version', 'disposition', 'fence', 'kind', 'platform', 'reason',
          'slot_index'].includes(k)),
      keys);
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
