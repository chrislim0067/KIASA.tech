/**
 * One real worker, against a DISPOSABLE local control plane.
 *
 *   npm run probe:worker
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * It starts a throwaway HTTP server on 127.0.0.1 that serves the five worker
 * endpoints using the REAL `lib/worker/endpoints.ts` logic over an in-memory
 * store, then spawns the REAL `worker/kiasa-worker.mjs` against it and drives a
 * full pairing lifecycle.
 *
 * So it proves the parts that only run when the two halves meet: that the
 * worker's HTTP client speaks the protocol the endpoints expect, that a code
 * typed on stdin becomes a credential, that a credential produces an accepted
 * heartbeat, that revocation reaches the worker and stops it.
 *
 * BY DEFAULT it does NOT prove the Supabase store: the control plane holds its
 * state in a Map, and a green run here is not a green deployment. Set
 * KIASA_PROBE_STORE=database and the same lifecycle runs through
 * createPairingStore() against the disposable local Postgres — real grants,
 * forced RLS, real triggers, and the security-definer boundary from migration
 * 26. CI runs both: the offline one in static checks, the database one in the
 * database job.
 *
 * NOTHING PRODUCTION IS INVOLVED. The server is bound to loopback and is torn
 * down at the end; in database mode the throwaway candidate it creates is
 * deleted with it. No hosted Supabase. No employer site, no browser, no
 * cookie, no OpenRouter request.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');

/*
 * Loopback only, and a port outside the Hyper-V/WinNAT reserved ranges — a
 * bind inside one fails with WinError 10013, which reads like a conflict and
 * is not.
 */
const HOST = '127.0.0.1';
const PORT = 15173;

let passed = 0;
let failed = 0;
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

const E = await import('../lib/worker/endpoints.ts');
const P = await import('../lib/worker/pairing.ts');
const HTTP = await import('../lib/worker/http.ts');

import { createTaskMemory } from './lib/worker-task-memory.mjs';

/* ------------------------------------------- the disposable control plane */

function makeStore() {
  const pairings = new Map();
  const credentials = new Map();
  const supervisors = new Map();
  const slots = new Map();
  const beats = [];
  // The task, lease and event half — one implementation, shared with
  // scripts/test-worker-endpoints.mjs so the two cannot drift.
  const taskMemory = createTaskMemory({ credentials, uuid: randomUUID });
  return {
    pairings, credentials, supervisors, slots, beats,
    tasks: taskMemory.tasks, leases: taskMemory.leases, events: taskMemory.events,
    seedTask: taskMemory.seedTask,
    claimTask: taskMemory.claimTask,
    renewLease: taskMemory.renewLease,
    reportTask: taskMemory.reportTask,
    async createPairing(row) {
      for (const [, p] of pairings) {
        if (p.user_id === row.user_id && !p.redeemed_at && !p.revoked_at) {
          p.revoked_at = new Date().toISOString();
        }
      }
      const id = randomUUID();
      pairings.set(id, { id, attempts: 0, redeemed_at: null, revoked_at: null, ...row });
      return { id };
    },
    async findPairingByHash(h) {
      for (const [, p] of pairings) if (p.secret_hash === h) return p;
      return null;
    },
    // The trigger's semantics, in miniature: computed from the previous value,
    // clamped, and never taken from the caller.
    async recordFailedAttempt(id) {
      const p = pairings.get(id);
      if (p) p.attempts = Math.min(p.attempts + 1, 10);
    },
    /*
     * ONE OPERATION, THE WAY worker_redeem_pairing IS ONE OPERATION.
     *
     * The claim is decided before anything is created, so a loser leaves no
     * supervisor, slot or credential behind — and no candidate, supervisor or
     * slot id is an argument. The invitation the hash matches says who this is
     * for.
     */
    async completeRedemption(input) {
      let pairing = null;
      for (const [, p] of pairings) if (p.secret_hash === input.secretHash) pairing = p;
      if (!pairing) return { ok: false, reason: 'not_found' };
      if (pairing.revoked_at !== null) return { ok: false, reason: 'revoked' };
      if (pairing.redeemed_at !== null) return { ok: false, reason: 'already_redeemed' };
      if (pairing.attempts >= 10) return { ok: false, reason: 'too_many_attempts' };

      const supervisorId = randomUUID();
      supervisors.set(supervisorId, {
        id: supervisorId,
        user_id: pairing.user_id,
        platform: input.platform,
        agent_version: input.agentVersion,
        last_heartbeat_at: null,
        revoked_at: null,
      });
      const slotId = randomUUID();
      slots.set(slotId, {
        id: slotId,
        user_id: pairing.user_id,
        supervisor_id: supervisorId,
        slot_index: 1,
        readiness: 'initializing',
      });
      credentials.set(input.credentialId, {
        id: input.credentialId,
        user_id: pairing.user_id,
        supervisor_id: supervisorId,
        slot_id: slotId,
        token_hash: input.tokenHash,
        expires_at: input.credentialExpiresAt,
        audience: 'kiasa-worker',
        scope: 'slot:heartbeat',
        revoked_at: null,
      });
      pairing.redeemed_at = new Date().toISOString();
      // The two registration events, written with the registration itself.
      taskMemory.recordRegistration({
        userId: pairing.user_id,
        supervisorId,
        slotId,
        platform: input.platform,
        agentVersion: input.agentVersion,
      });
      pairing.redeemed_supervisor_id = supervisorId;
      return { ok: true, supervisorId, slotId };
    },
    async findCredentialById(id) { return credentials.get(id) ?? null; },
    async touchCredential(id, at) {
      const c = credentials.get(id);
      if (c) c.last_used_at = at;
    },
    async recordHeartbeat(input) {
      // Resolved from the credential the id AND hash match, exactly as
      // worker_record_heartbeat resolves it.
      const c = credentials.get(input.credentialId);
      if (!c || c.token_hash !== input.tokenHash) {
        return { ok: false, reason: 'not_found', applied: false };
      }
      if (c.revoked_at !== null) return { ok: false, reason: 'revoked', applied: false };

      const slot = c.slot_id ? slots.get(c.slot_id) : null;
      const previous = slot ? slot.readiness : null;
      if (slot) {
        // The pause and stop rules, before anything is written.
        const refusal = taskMemory.applyReadiness(slot, input.readiness, input.reason);
        if (refusal) return { ok: false, reason: refusal, applied: false };
      }

      const last = beats.filter((b) => b.supervisorId === c.supervisor_id).pop();
      if (last && input.sequence <= last.sequence) {
        return { ok: true, reason: 'stale_sequence', applied: false };
      }
      const at = new Date().toISOString();
      beats.push({ ...input, supervisorId: c.supervisor_id, slotId: c.slot_id, at });
      const s = supervisors.get(c.supervisor_id);
      if (s) s.last_heartbeat_at = at;
      if (slot) taskMemory.recordSlotTransition(c, slot, previous, input.readiness, input.reason);
      return { ok: true, reason: 'applied', applied: true };
    },
  };
}

/* --------------------------------------------- which store is under test */

/*
 * TWO BACKINGS, ONE PROBE.
 *
 * By default the control plane keeps its state in a Map. No database is
 * needed, the run is entirely offline, and what it proves is that the two
 * halves speak the same protocol.
 *
 * With KIASA_PROBE_STORE=database it uses `createPairingStore()` — the very
 * object the route handlers construct — against the disposable local
 * Postgres. The same lifecycle then runs through real grants, forced RLS, real
 * triggers and the `security definer` boundary from migration 26, driven by
 * the real worker process over real HTTP. CI runs it that way in the database
 * job, and THAT is the run that says something about a deployment.
 *
 * Every assertion below reads through `inspect`, so neither backing gets an
 * easier question than the other.
 */
const DATABASE_MODE = process.env.KIASA_PROBE_STORE === 'database';

function memoryBacking() {
  const s = makeStore();
  const one = (m) => [...m.values()][0];
  return {
    store: s,
    candidate: '00000000-0000-4000-8000-0000000000aa',
    pairingSecretHash: () => one(s.pairings).secret_hash,
    pairingRowsText: () => JSON.stringify([...s.pairings.values()]),
    pairingAttempts: () => one(s.pairings).attempts,
    credentialCount: () => s.credentials.size,
    credentialOwner: () => one(s.credentials).user_id,
    credentialIds: () => [...s.credentials.keys()],
    credentialRevokedAt: () => one(s.credentials).revoked_at ?? null,
    credentialExpiresAt: () => one(s.credentials).expires_at,
    slotCount: () => s.slots.size,
    appliedBeats: () => s.beats.length,
    supervisorLastBeat: () => one(s.supervisors).last_heartbeat_at,
    revokeCredential: () => {
      one(s.credentials).revoked_at = new Date().toISOString();
    },
    seedTask: () => s.seedTask('00000000-0000-4000-8000-0000000000aa'),
    taskStatus: () => (one(s.tasks) ? one(s.tasks).status : 'none'),
    eventKinds: () => [...new Set(s.events.map((e) => e.kind))].sort().join(','),
    cleanup: async () => {},
  };
}

async function databaseBacking() {
  const { execFileSync } = await import('node:child_process');
  const { statusEnvRaw } = await import('./lib/supabase-cli.mjs');
  const { createClient } = await import('@supabase/supabase-js');

  const env = {};
  for (const line of statusEnvRaw().split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m) env[m[1]] = m[2];
  }
  // The real store reads its connection from the environment, exactly as a
  // server does. Constructing it any other way would not be testing it.
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.API_URL;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.PUBLISHABLE_KEY || env.ANON_KEY;
  process.env.SUPABASE_SECRET_KEY = env.SECRET_KEY || env.SERVICE_ROLE_KEY;

  const container = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_kiasa';
  const q = (statement) =>
    execFileSync(
      'docker',
      ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-qtAc', statement],
      { encoding: 'utf8' }
    ).trim();

  const admin = createClient(env.API_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.auth.admin.createUser({
    email: `probe-${randomUUID()}@example.test`,
    password: randomUUID(),
    email_confirm: true,
  });
  if (error) throw new Error(`probe candidate: ${error.message}`);
  const candidate = data.user.id;

  const { createPairingStore } = await import('../lib/worker/store.ts');
  const mine = (table) => `from public.${table} where user_id = '${candidate}'`;
  const blank = (value) => (value === '' ? null : value);

  return {
    store: createPairingStore(),
    candidate,
    pairingSecretHash: () =>
      q(`select secret_hash ${mine('worker_pairings')} order by created_at desc limit 1`),
    // to_jsonb of the row: every column the table holds, so the plaintext
    // assertion is looking at everything rather than at a chosen projection.
    pairingRowsText: () =>
      q(`select coalesce(string_agg(to_jsonb(p)::text, ','), '')
         from public.worker_pairings p where p.user_id = '${candidate}'`),
    pairingAttempts: () =>
      Number(q(`select attempts ${mine('worker_pairings')} order by created_at desc limit 1`)),
    credentialCount: () => Number(q(`select count(*) ${mine('worker_credentials')}`)),
    credentialOwner: () => q(`select user_id ${mine('worker_credentials')} limit 1`),
    credentialIds: () =>
      q(`select coalesce(string_agg(id::text, ','), '') ${mine('worker_credentials')}`)
        .split(',')
        .filter(Boolean),
    credentialRevokedAt: () =>
      blank(q(`select coalesce(revoked_at::text, '') ${mine('worker_credentials')} limit 1`)),
    credentialExpiresAt: () => q(`select expires_at ${mine('worker_credentials')} limit 1`),
    slotCount: () => Number(q(`select count(*) ${mine('worker_slots')}`)),
    // A supervisor's sequence only advances when a heartbeat is APPLIED, so it
    // counts the same thing the in-memory list of beats counts.
    appliedBeats: () =>
      Number(q(`select coalesce(max(heartbeat_sequence), 0) ${mine('worker_supervisors')}`)),
    supervisorLastBeat: () =>
      blank(q(`select coalesce(last_heartbeat_at::text, '') ${mine('worker_supervisors')} limit 1`)),
    revokeCredential: () =>
      q(`update public.worker_credentials
         set revoked_at = now(), revoked_reason = 'candidate_requested'
         where user_id = '${candidate}'`),
    /*
     * A synthetic job and task, walked through the real pipeline to `queued`.
     * `queued` is the approval gate the worker's claim tests for, so a task
     * inserted straight into it would skip the only state that matters.
     */
    seedTask: () => {
      const jobId = q(`insert into public.jobs (user_id, submitted_url, canonical_url, source)
        values ('${candidate}', 'https://example.test/probe/role-1',
                'https://example.test/probe/role-1', 'user_link')
        returning id`);
      const taskId = q(`insert into public.automation_tasks
        (user_id, job_id, mode, idempotency_key, correlation_id)
        values ('${candidate}', '${jobId}', 'claude_max_assisted',
                'synthetic-probe-task-000001', gen_random_uuid())
        returning id`);
      for (const next of ['validated', 'snapshot_stored', 'normalized', 'scored', 'queued']) {
        q(`update public.automation_tasks set status = '${next}' where id = '${taskId}'`);
      }
      return taskId;
    },
    taskStatus: () =>
      blank(q(`select coalesce(status, '') ${mine('automation_tasks')} limit 1`)) ?? 'none',
    eventKinds: () =>
      q(`select coalesce(string_agg(distinct kind, ',' order by kind), '')
         ${mine('worker_events')}`),
    cleanup: async () => {
      await admin.auth.admin.deleteUser(candidate).catch(() => {});
    },
  };
}

const inspect = DATABASE_MODE ? await databaseBacking() : memoryBacking();
const store = inspect.store;
const CANDIDATE = inspect.candidate;
const seen = { redeem: 0, heartbeat: 0, unauthorised: 0, claim: 0, renew: 0, report: 0 };

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || 'null')); } catch { resolve(null); }
    });
  });

const send = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const now = new Date();

  if (url.pathname === '/api/worker/redeem' && req.method === 'POST') {
    seen.redeem += 1;
    const result = await E.redeemPairing(store, await readBody(req), now);
    if (!result.ok) return send(res, result.reason === 'malformed_request' ? 400 : 403,
      { ok: false, reason: result.reason });
    return send(res, 200, {
      ok: true, token: result.token, supervisor_id: result.supervisorId,
      slot_id: result.slotId, expires_at: result.expiresAt,
    });
  }

  if (url.pathname === '/api/worker/heartbeat' && req.method === 'POST') {
    seen.heartbeat += 1;
    const auth = await E.authenticateWorker(store, req.headers.authorization ?? null, now);
    if (!auth.ok) {
      seen.unauthorised += 1;
      const status = auth.reason === 'revoked' || auth.reason === 'expired' ? 403 : 401;
      return send(res, status, { ok: false, reason: auth.reason });
    }
    const result = await E.heartbeat(
      store,
      { credentialId: auth.credentialId, tokenHash: auth.tokenHash },
      await readBody(req),
      now
    );
    if (!result.ok) return send(res, 400, { ok: false, reason: result.reason });
    return send(res, 200, { ok: true, applied: result.applied });
  }

  /*
   * THE TASK ROUTES, THROUGH THE SAME ENDPOINT FUNCTIONS THE APP USES.
   *
   * The status mapping is `lib/worker/http.ts`'s, imported rather than
   * retyped: a probe that mapped refusals its own way would prove the worker
   * copes with THIS server rather than with the real one.
   */
  const taskRoute = url.pathname.startsWith('/api/worker/task/') && req.method === 'POST';
  if (taskRoute) {
    const auth = await E.authenticateWorker(store, req.headers.authorization ?? null, now);
    if (!auth.ok) {
      seen.unauthorised += 1;
      return send(res, HTTP.authStatus(auth.reason), { ok: false, reason: auth.reason });
    }
    const identity = { credentialId: auth.credentialId, tokenHash: auth.tokenHash };

    if (url.pathname === '/api/worker/task/claim') {
      seen.claim += 1;
      const r = await E.claimTask(store, identity);
      if (!r.ok) return send(res, HTTP.operationStatus(r.reason), { ok: false, reason: r.reason });
      return send(res, 200, {
        ok: true, task_id: r.taskId, lease_id: r.leaseId,
        fence_token: r.fenceToken, lease_expires_at: r.leaseExpiresAt,
      });
    }
    if (url.pathname === '/api/worker/task/renew') {
      seen.renew += 1;
      const r = await E.renewLease(store, identity, await readBody(req));
      if (!r.ok) return send(res, HTTP.operationStatus(r.reason), { ok: false, reason: r.reason });
      return send(res, 200, { ok: true, lease_expires_at: r.expiresAt });
    }
    if (url.pathname === '/api/worker/task/report') {
      seen.report += 1;
      const r = await E.reportTask(store, identity, await readBody(req));
      if (!r.ok) return send(res, HTTP.operationStatus(r.reason), { ok: false, reason: r.reason });
      return send(res, 200, { ok: true, disposition: r.disposition });
    }
  }

  return send(res, 404, { ok: false, reason: 'not_found' });
});

await new Promise((resolve) => server.listen(PORT, HOST, resolve));
console.log(`disposable control plane on http://${HOST}:${PORT} (loopback only, in-memory)`);

/* ------------------------------------------------------------ the driver */

function runWorker(args, secret) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '--import', './scripts/lib/register-hooks.mjs',
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      'worker/kiasa-worker.mjs', ...args,
    ], {
      cwd: ROOT,
      shell: false,
      env: {
        ...process.env,
        KIASA_BASE_URL: `http://${HOST}:${PORT}`,
        // Consent is deliberately NOT granted, to show the gate refusing.
        KIASA_LOCAL_CONSENT: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    // The pairing code goes over STDIN — never argv, which the process list
    // and shell history would both capture.
    child.stdin.end(`${secret}\n`);
    child.on('close', (code) => resolve({ code, out }));
  });
}

try {
  section('1. The candidate asks for a pairing code');

  const started = await E.startPairing(store, CANDIDATE, new Date());
  check('a code was issued', started.ok === true);
  check('  only a hash is stored', /^[0-9a-f]{64}$/.test(inspect.pairingSecretHash()));
  check('  the plaintext is nowhere in the row',
    !inspect.pairingRowsText().includes(P.normalisePairingSecret(started.secret)));

  // One approved task, waiting. The worker claims it during its probe run.
  inspect.seedTask();

  section('2. A real worker redeems it and heartbeats');

  const run = await runWorker(['--probe'], started.secret);
  const log = run.out;

  check('the worker paired', /paired\./.test(log), log.split('\n').find((l) => /paired|refused/.test(l)) ?? '');
  check('  exactly one redemption request reached the server', seen.redeem === 1, String(seen.redeem));
  check('  a credential was issued', inspect.credentialCount() === 1,
    String(inspect.credentialCount()));
  check('  scoped to one candidate', inspect.credentialOwner() === CANDIDATE);
  check('  and one slot', inspect.slotCount() === 1, String(inspect.slotCount()));
  check('the worker sent an authenticated heartbeat', inspect.appliedBeats() >= 1,
    `${inspect.appliedBeats()} applied`);
  check('  none was rejected', seen.unauthorised === 0, `${seen.unauthorised} rejected`);
  check('  the supervisor now has a check-in time',
    typeof inspect.supervisorLastBeat() === 'string');

  section('2b. The worker ran one control-plane task cycle');

  check('it claimed the approved task', /claimed task/.test(log),
    log.split('\n').find((l) => /claimed task|no task claimed/.test(l)) ?? '(no line)');
  check('  exactly one claim request reached the server', seen.claim === 1, String(seen.claim));
  check('  it renewed the lease', seen.renew === 1, String(seen.renew));
  check('  and reported once', seen.report === 1, String(seen.report));
  check('  the task went back to the queue', inspect.taskStatus() === 'queued',
    inspect.taskStatus());
  check('  NO APPLICATION WAS ATTEMPTED', /No application was attempted/.test(log),
    'the worker holds and returns a lease; it does not do the work');
  check('  the cycle was recorded', /lease_acquired/.test(inspect.eventKinds()) &&
    /lease_released/.test(inspect.eventKinds()), inspect.eventKinds());
  check('  and no event kind is outside the table’s list',
    inspect.eventKinds().split(',').filter(Boolean).every((k) => [
      'supervisor_registered', 'supervisor_revoked', 'supervisor_heartbeat',
      'slot_registered', 'slot_heartbeat', 'slot_paused', 'slot_stopped', 'slot_crashed',
      'lease_acquired', 'lease_renewed', 'lease_expired', 'lease_released', 'lease_refused',
      'task_started', 'task_paused', 'task_completed', 'task_failed',
      'local_claude_used', 'local_claude_unavailable', 'manual_fallback_used',
    ].includes(k)), inspect.eventKinds());

  section('3. Status transitions as the candidate would see it');

  const view = (at) => P.visibleStatus({
    hasCredential: true,
    revokedAt: inspect.credentialRevokedAt(),
    expiresAt: inspect.credentialExpiresAt(),
    lastHeartbeatAt: inspect.supervisorLastBeat(),
  }, at);

  check('right after a beat: online', view(new Date()) === 'online');
  check('  after the stale window: stale',
    view(new Date(Date.now() + P.STALE_AFTER_MS + 1000)) === 'stale');

  section('4. The local-Claude consent gate refuses without consent');

  check('the probe reported local Claude as unusable',
    /local Claude: (manual_required|unsupported)/.test(log),
    log.split('\n').find((l) => /local Claude:/.test(l)) ?? '(no line)');
  check('  and named consent as the reason',
    /candidate_has_not_consented/.test(log),
    'an unset variable means not consented, not probably fine');
  check('  no Claude call was made', !/probe: ok/.test(log));

  section('5. Revocation reaches the worker, and it stops');

  inspect.revokeCredential();
  const after = await runWorker(['--once'], 'WRONGCODEWRONGCODEWRONGCOD');
  check('a revoked worker cannot re-pair with a wrong code',
    /pairing refused/.test(after.out), after.out.split('\n').find((l) => /refused/.test(l)) ?? '');
  check('  and it exited non-zero', after.code !== 0, `exit ${after.code}`);
  /*
   * `row.attempts >= 0` was the first version of this line, which is vacuously
   * true and proved nothing. The real property is subtler and worth stating:
   * a guess whose hash matches NO invitation charges nothing, because there is
   * no row to charge. Only a near miss against a real invitation costs an
   * attempt — otherwise anyone could exhaust a stranger's invitation by
   * guessing at it.
   */
  check('a guess matching no invitation charges nobody', inspect.pairingAttempts() === 0,
    `attempts ${inspect.pairingAttempts()}`);
  const stranger = await E.redeemPairing(store,
    { pairing_secret: 'NOSUCHCODENOSUCHCODENOSUCH', platform: 'linux', agent_version: '0.1.0' },
    new Date());
  check('  and it is refused without revealing whether anything exists',
    stranger.ok === false && stranger.reason === 'not_found', stranger.reason);
  check('  the real invitation is still at zero attempts', inspect.pairingAttempts() === 0);

  const revoked = await E.authenticateWorker(store, `Bearer ${'x'.repeat(10)}`, new Date());
  check('a malformed credential is refused', revoked.ok === false);

  section('6. Nothing forbidden happened');

  check('no browser was opened', !/puppeteer|chrome|browser/i.test(log));
  check('no employer site was contacted', !/https?:\/\/(?!127\.0\.0\.1)/.test(log));
  check('no application was submitted', !/submit/i.test(log));
  check('the worker printed no token',
    !inspect.credentialIds().some((id) => log.includes(id)) || !/\.[A-Za-z0-9_-]{43}/.test(log),
    'the credential is held in memory and never logged');
  check('the control plane was loopback only', server.address().address === HOST,
    `${server.address().address}:${server.address().port}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await inspect.cleanup();
  console.log(
    DATABASE_MODE
      ? '\ndisposable control plane torn down; the throwaway candidate was deleted.'
      : '\ndisposable control plane torn down; nothing persisted.'
  );
}

console.log('========================================================');
if (failed === 0) {
  console.log(`ALL ${passed} WORKER END-TO-END CHECKS PASSED`);
  console.log(
    DATABASE_MODE
      ? 'Driven through the REAL store against real Postgres: grants, RLS and triggers included.'
      : 'This proves the two halves speak the same protocol, over an in-memory store.'
  );
  if (!DATABASE_MODE) {
    console.log('Run it with KIASA_PROBE_STORE=database to drive the same lifecycle through Postgres.');
  }
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
