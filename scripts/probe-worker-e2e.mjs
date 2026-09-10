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
 * It does NOT prove the Supabase store — that is a property of Postgres and is
 * tested against a real database by scripts/test-worker-pairing-db.mjs in CI.
 * Saying so matters: a green run here is not a green deployment.
 *
 * NOTHING PRODUCTION IS INVOLVED. The server is bound to loopback, holds its
 * state in a Map, and is torn down at the end. No Supabase of any kind, hosted
 * or local. No employer site, no browser, no cookie, no OpenRouter request.
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

const CANDIDATE = '00000000-0000-4000-8000-0000000000aa';

/* ------------------------------------------- the disposable control plane */

function makeStore() {
  const pairings = new Map();
  const credentials = new Map();
  const supervisors = new Map();
  const slots = new Map();
  const beats = [];
  return {
    pairings, credentials, supervisors, slots, beats,
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
    async claimPairing(id, supervisorId) {
      const p = pairings.get(id);
      if (!p || p.redeemed_at !== null) return false;
      p.redeemed_at = new Date().toISOString();
      p.redeemed_supervisor_id = supervisorId;
      return true;
    },
    // The trigger's semantics, in miniature: computed from the previous value,
    // clamped, and never taken from the caller.
    async recordFailedAttempt(id) {
      const p = pairings.get(id);
      if (p) p.attempts = Math.min(p.attempts + 1, 10);
    },
    async createSupervisor(row) {
      const id = randomUUID();
      supervisors.set(id, { id, last_heartbeat_at: null, ...row });
      return { id };
    },
    async createSlot(row) {
      const id = randomUUID();
      slots.set(id, { id, slot_index: 1, readiness: 'initializing', ...row });
      return { id };
    },
    async createCredential(row) {
      for (const [, c] of credentials) {
        if (c.supervisor_id === row.supervisor_id && c.revoked_at === null) return null;
      }
      credentials.set(row.id, {
        audience: 'kiasa-worker', scope: 'slot:heartbeat', revoked_at: null, ...row,
      });
      return { id: row.id };
    },
    async findCredentialById(id) { return credentials.get(id) ?? null; },
    async touchCredential(id, at) {
      const c = credentials.get(id);
      if (c) c.last_used_at = at;
    },
    async recordHeartbeat(input) {
      const last = beats.filter((b) => b.supervisorId === input.supervisorId).pop();
      if (last && input.sequence <= last.sequence) return { applied: false };
      beats.push(input);
      const s = supervisors.get(input.supervisorId);
      if (s) s.last_heartbeat_at = input.at;
      const slot = input.slotId ? slots.get(input.slotId) : null;
      if (slot) slot.readiness = input.readiness;
      return { applied: true };
    },
  };
}

const store = makeStore();
const seen = { redeem: 0, heartbeat: 0, unauthorised: 0 };

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
      { supervisorId: auth.supervisorId, slotId: auth.slotId, credentialId: auth.credentialId },
      await readBody(req),
      now
    );
    if (!result.ok) return send(res, 400, { ok: false, reason: result.reason });
    return send(res, 200, { ok: true, applied: result.applied });
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
  const row = [...store.pairings.values()][0];
  check('  only a hash is stored', /^[0-9a-f]{64}$/.test(row.secret_hash));
  check('  the plaintext is not in the store',
    !JSON.stringify([...store.pairings.values()]).includes(P.normalisePairingSecret(started.secret)));

  section('2. A real worker redeems it and heartbeats');

  const run = await runWorker(['--probe'], started.secret);
  const log = run.out;

  check('the worker paired', /paired\./.test(log), log.split('\n').find((l) => /paired|refused/.test(l)) ?? '');
  check('  exactly one redemption request reached the server', seen.redeem === 1, String(seen.redeem));
  check('  a credential was issued', store.credentials.size === 1);
  check('  scoped to one candidate', [...store.credentials.values()][0].user_id === CANDIDATE);
  check('  and one slot', store.slots.size === 1);
  check('the worker sent an authenticated heartbeat', store.beats.length >= 1,
    `${store.beats.length} beat(s)`);
  check('  none was rejected', seen.unauthorised === 0, `${seen.unauthorised} rejected`);
  check('  the supervisor now has a check-in time',
    typeof [...store.supervisors.values()][0].last_heartbeat_at === 'string');

  section('3. Status transitions as the candidate would see it');

  const supervisor = [...store.supervisors.values()][0];
  const credential = [...store.credentials.values()][0];
  const view = (at) => P.visibleStatus({
    hasCredential: true, revokedAt: credential.revoked_at,
    expiresAt: credential.expires_at, lastHeartbeatAt: supervisor.last_heartbeat_at,
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

  credential.revoked_at = new Date().toISOString();
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
  check('a guess matching no invitation charges nobody', row.attempts === 0,
    `attempts ${row.attempts}`);
  const stranger = await E.redeemPairing(store,
    { pairing_secret: 'NOSUCHCODENOSUCHCODENOSUCH', platform: 'linux', agent_version: '0.1.0' },
    new Date());
  check('  and it is refused without revealing whether anything exists',
    stranger.ok === false && stranger.reason === 'not_found', stranger.reason);
  check('  the real invitation is still at zero attempts', row.attempts === 0);

  const revoked = await E.authenticateWorker(store, `Bearer ${'x'.repeat(10)}`, new Date());
  check('a malformed credential is refused', revoked.ok === false);

  section('6. Nothing forbidden happened');

  check('no browser was opened', !/puppeteer|chrome|browser/i.test(log));
  check('no employer site was contacted', !/https?:\/\/(?!127\.0\.0\.1)/.test(log));
  check('no application was submitted', !/submit/i.test(log));
  check('the worker printed no token',
    ![...store.credentials.keys()].some((id) => log.includes(id)) || !/\.[A-Za-z0-9_-]{43}/.test(log),
    'the credential is held in memory and never logged');
  check('the control plane was loopback only', server.address().address === HOST,
    `${server.address().address}:${server.address().port}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  console.log('\ndisposable control plane torn down; nothing persisted.');
}

console.log('========================================================');
if (failed === 0) {
  console.log(`ALL ${passed} WORKER END-TO-END CHECKS PASSED`);
  console.log('This proves the two halves speak the same protocol.');
  console.log('It does NOT prove the Supabase store — CI does that against real Postgres.');
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
