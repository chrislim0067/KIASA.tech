#!/usr/bin/env node
/**
 * The KIASA worker. One slot. Runs on the candidate's own computer.
 *
 *   node worker/kiasa-worker.mjs --pair        pair, then run
 *   node worker/kiasa-worker.mjs --probe       pair, run one local Claude probe, exit
 *   node worker/kiasa-worker.mjs --once        pair, one heartbeat, exit
 *
 * WHAT IT IS
 *
 * A small outbound-only process. It redeems a one-time pairing secret for a
 * scoped credential, then heartbeats over HTTPS until told to stop. It opens
 * no port, needs no forwarding, and is not reachable from the internet — the
 * control plane never connects to it, it connects to the control plane.
 *
 * WHAT IT NEVER HAS
 *
 * An OpenRouter key. A Supabase key of any kind. A Claude API key. A browser
 * cookie. An employer credential. It is not given them, it does not ask for
 * them, and there is no code path here that would accept one. The only secret
 * it holds is its own worker credential, in memory, for the life of the
 * process.
 *
 * HOW THE PAIRING SECRET IS READ
 *
 * From STDIN, never from argv. A command-line argument is visible to every
 * other process on the machine through the process list, and lands in shell
 * history. Reading it from stdin keeps it out of both.
 *
 * LOCAL CLAUDE
 *
 * Through the existing adapter in lib/local-claude, which spawns the official
 * CLI under the candidate's own login. No Anthropic API, no private endpoint,
 * no cookie, no session token, no second client. The probe below is a fixed
 * fictional fixture whose only purpose is to prove the connection works.
 */
import { createInterface } from 'node:readline';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');
const PROBE = args.has('--probe');

/** Where the control plane lives. Never a default that points at production. */
const BASE_URL = process.env.KIASA_BASE_URL;
const HEARTBEAT_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;

/* ------------------------------------------------------------- utilities */

const log = (...parts) => console.log(`[worker]`, ...parts);

/**
 * The credential, held ONLY here.
 *
 * Never written to disk. A plaintext token file is a credential anyone with
 * read access to the machine inherits, and silently creating one would be
 * worse than asking the candidate to pair again after a restart — which costs
 * them ten seconds. If an OS credential store is wired up later, this is the
 * one place that changes.
 */
let credential = null;
let stopping = false;

/** Outbound HTTPS with a bounded timeout. No retries on a refusal. */
async function request(pathname, { method = 'POST', body, bearer } = {}) {
  if (!BASE_URL) throw new Error('KIASA_BASE_URL is not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      // The worker sends no cookies, ever. It is not a browser and has no
      // session; its only credential is the bearer token above.
      credentials: 'omit',
      redirect: 'error',
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* a non-JSON body is reported by status alone */
    }
    return { status: response.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

/** Read one line from stdin without echoing it into the process list. */
function readSecretFromStdin(promptText) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const platform = () =>
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

/* ------------------------------------------------------------- lifecycle */

async function pair() {
  // stdin, not argv: an argument is visible in the process list to every other
  // process on this machine, and lands in shell history.
  const secret = await readSecretFromStdin('Paste the pairing code from KIASA: ');
  if (!secret) {
    log('no code entered; nothing was sent.');
    return false;
  }

  const { status, payload } = await request('/api/worker/redeem', {
    body: {
      pairing_secret: secret,
      platform: platform(),
      agent_version: '0.1.0',
    },
  });

  if (status !== 200 || !payload?.token) {
    // The reason is a short code from the server. No secret is echoed, and the
    // code the candidate typed is never printed back.
    log(`pairing refused (${status}): ${payload?.reason ?? 'unknown'}`);
    return false;
  }

  credential = {
    token: payload.token,
    supervisorId: payload.supervisor_id,
    slotId: payload.slot_id,
    expiresAt: payload.expires_at,
  };
  log(`paired. slot ${payload.slot_id?.slice(0, 8)}…, credential valid until ${payload.expires_at}`);
  return true;
}

let sequence = 0;

/**
 * One heartbeat.
 *
 * Returns false when the control plane says stop — a revoked or expired
 * credential is not something to retry through. The worker shuts down rather
 * than hammering an endpoint that will keep refusing it.
 */
async function heartbeat(readiness = 'ready', reason = null) {
  if (!credential) return false;
  /*
   * A STATE THAT NEEDS A REASON CARRIES ONE, AND THE WORKER NEVER INVENTS IT.
   *
   * `worker_slots` requires a pause reason for `paused` and a stop reason for
   * `stopping`/`stopped`, in both directions — a state that needs no reason
   * must not carry one. The values come from the control plane's own bounded
   * vocabulary; this process picks one that is true of itself
   * (`supervisor_shutdown` when it is shutting itself down) and has no way to
   * express anything else. There is no free-text field here.
   */
  const body = {
    sequence: ++sequence,
    lifecycle: stopping ? 'stopping' : 'running',
    slot_readiness: readiness,
  };
  if (reason !== null) body.reason = reason;

  const { status, payload } = await request('/api/worker/heartbeat', {
    bearer: credential.token,
    body,
  });

  if (status === 200) return true;
  if (status === 401 || status === 403) {
    log(`credential rejected (${payload?.reason ?? status}). Shutting down.`);
    credential = null;
    return false;
  }
  // A transient failure is not a reason to give up the process; the next beat
  // will try again on its own schedule.
  log(`heartbeat failed (${status}); will retry on the next interval.`);
  return true;
}

/* ------------------------------------------------- the local Claude probe */

/**
 * One harmless synthetic call, to prove the local connection works.
 *
 * Fictional fixture only. No candidate data, no employer, no job posting from
 * anywhere real. It goes through the EXISTING adapter — there is no second
 * Claude client here — and its output cannot authorise anything: the schema it
 * validates against has no field for that, and nothing in this worker submits.
 */
async function probeLocalClaude() {
  const { createCliTransport, probeLocalClaude: probe } = await import(
    `file://${path.join(ROOT, 'lib', 'local-claude', 'cli.ts').replaceAll('\\', '/')}`
  );

  const options = {
    model: process.env.KIASA_LOCAL_MODEL ?? 'sonnet',
    // Consent is explicit and must be given per run. The worker never assumes
    // it: an unset variable means "not consented", not "probably fine".
    consented: process.env.KIASA_LOCAL_CONSENT === 'yes',
  };

  const availability = await probe(options);
  log(`local Claude: ${availability.status}${availability.status !== 'supported' ? ` (${availability.reason})` : ` v${availability.version}, model ${availability.model}`}`);
  if (availability.status !== 'supported') return availability;

  const transport = createCliTransport(options);
  const outcome = await transport.run({
    request_id: '00000000-0000-4000-8000-000000000101',
    candidate_id: '00000000-0000-4000-8000-000000000102',
    task_id: '00000000-0000-4000-8000-000000000103',
    capability: 'application_answer_generation',
    model: options.model,
    prompt: [
      'You draft one short application answer.',
      '',
      'VERIFIED FACTS (the only facts you may use):',
      '  years_experience: 6',
      '  primary_skill: TypeScript',
      '',
      'QUESTION FROM Example Corp (a fictional employer):',
      '  "Briefly describe your experience with TypeScript."',
      '',
      'Return ONLY minified JSON matching exactly:',
      '{"answer":string,"used_fact_keys":string[],"uncertain":boolean}',
    ].join('\n'),
    timeout_ms: 120_000,
  });

  log(`probe: ${outcome.status}`);
  if (outcome.status === 'ok') {
    log(`  answer length: ${outcome.output.answer.length} chars`);
    log(`  used facts:    ${outcome.output.used_fact_keys.join(', ')}`);
    log(`  uncertain:     ${outcome.output.uncertain}`);
    log('  this answer authorises nothing: no submission path exists in this worker.');
  }
  return outcome;
}

/* ------------------------------------------------------- the task cycle */

/**
 * Claim one task, renew its lease once, and hand it back.
 *
 * THIS DOES NO WORK, AND THAT IS THE POINT OF THIS MILESTONE. There is no
 * browser here, no employer site, no form and no submission — the worker
 * proves it can hold and return a lease safely, and nothing more. It reports
 * `released`, which puts the task back in the queue, because pretending to
 * have completed something it never attempted would be a lie in an audit
 * trail.
 *
 * Fails closed at every step: no credential, a refusal, a stale fence, a dead
 * lease or a malformed answer all end the cycle rather than continuing on a
 * guess.
 */
async function taskCycle() {
  if (!credential) return false;

  const claim = await request('/api/worker/task/claim', { bearer: credential.token, body: {} });
  if (claim.status !== 200) {
    // `no_task_available` is the ordinary case, not a failure.
    log(`no task claimed (${claim.status}): ${claim.payload?.reason ?? 'unknown'}`);
    return false;
  }

  const fence = claim.payload?.fence_token;
  const taskId = claim.payload?.task_id;
  if (typeof fence !== 'number' || typeof taskId !== 'string') {
    log('claim response was malformed; nothing was attempted.');
    return false;
  }
  log(`claimed task ${taskId.slice(0, 8)}… at fence ${fence}.`);

  const renew = await request('/api/worker/task/renew', {
    bearer: credential.token,
    body: { fence_token: fence },
  });
  if (renew.status !== 200) {
    log(`lease renewal refused (${renew.status}): ${renew.payload?.reason ?? 'unknown'}`);
    // Fall through: the lease is still ours to release until it expires.
  } else {
    log('lease renewed.');
  }

  const report = await request('/api/worker/task/report', {
    bearer: credential.token,
    body: { fence_token: fence, disposition: 'released' },
  });
  if (report.status !== 200) {
    log(`report refused (${report.status}): ${report.payload?.reason ?? 'unknown'}`);
    return false;
  }
  log('task released back to the queue. No application was attempted.');
  return true;
}

/* ------------------------------------------------------------------ main */

async function main() {
  log('KIASA worker — one slot, outbound HTTPS only.');
  log('It holds no OpenRouter key, no Supabase key and no Claude credential.');

  if (!BASE_URL) {
    log('KIASA_BASE_URL is not set. Nothing was sent.');
    process.exitCode = 1;
    return;
  }

  if (!(await pair())) {
    process.exitCode = 1;
    return;
  }

  if (PROBE) {
    await probeLocalClaude();
    await heartbeat('ready');
    // One control-plane cycle, so the probe exercises the task path as well as
    // the pairing one. It claims nothing when the queue is empty.
    await taskCycle();
    await heartbeat('ready');
    return;
  }

  if (!(await heartbeat('ready'))) {
    process.exitCode = 1;
    return;
  }
  if (ONCE) return;

  const timer = setInterval(async () => {
    if (!(await heartbeat('ready'))) {
      clearInterval(timer);
      process.exitCode = 1;
    }
  }, HEARTBEAT_INTERVAL_MS);

  /** Clean shutdown: say goodbye once, then stop. */
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    log('shutting down…');
    // Truthful, and from the control plane's list: this process is stopping
    // because the supervisor was asked to stop.
    await heartbeat('stopped', 'supervisor_shutdown').catch(() => {});
    // The credential is dropped with the process. Nothing was written to disk.
    credential = null;
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  // A name, never a message: a message can quote a request body.
  log(`fatal: ${error?.name ?? 'error'}`);
  process.exitCode = 1;
});
