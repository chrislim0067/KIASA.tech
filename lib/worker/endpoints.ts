import 'server-only';

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { WORKER_PAUSE_REASONS, WORKER_STOP_REASONS } from '@/lib/agent/contracts';
import {
  CREDENTIAL_TTL_MS,
  MAX_PAIRING_ATTEMPTS,
  PAIRING_TTL_MS,
  evaluateCredential,
  evaluatePairing,
  generatePairingSecret,
  generateWorkerToken,
  hashSecret,
  normalisePairingSecret,
  parseWorkerToken,
  visibleStatus,
  type CredentialRow,
  type PairingRow,
} from '@/lib/worker/pairing';

/**
 * The worker protocol's server half: pairing, credential issue, verification.
 *
 * SERVER ONLY. Importing this from a client component is a build error rather
 * than a published secret, which matters more here than anywhere else in the
 * codebase — this is the module that mints credentials.
 *
 * The database calls are INJECTED rather than imported. Every function below
 * takes the minimum data access it needs as a parameter, so the whole protocol
 * can be tested against fakes without a Postgres, on a machine that cannot
 * safely run one. The route handlers supply the real client.
 *
 * WHAT THE TRANSPORT IS, AND WHY
 *
 * Outbound HTTPS from the worker, short-lived requests, polling for state and
 * a periodic heartbeat. Not because it is elegant — a socket would be — but
 * because the control plane runs on serverless functions with no long-lived
 * connections, and because the alternative asks a candidate to open an inbound
 * port on their home network. A worker that needs port forwarding is a worker
 * most people cannot run and none should.
 */

/* ---------------------------------------------------------------- shapes */

/** What a worker sends when redeeming. Strict: an unknown key is a rejection. */
export const RedeemRequest = z
  .object({
    /** The one-time secret, as the candidate typed it. */
    pairing_secret: z.string().min(1).max(64),
    platform: z.enum(['windows', 'macos', 'linux']),
    agent_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  })
  .strict();
export type RedeemRequest = z.infer<typeof RedeemRequest>;

/**
 * What a worker sends on each heartbeat, and the states that must name a
 * reason.
 *
 * NOTE WHAT IS ABSENT: there is no `user_id`, no `candidate_id`, and no
 * `supervisor_id`. All three come from the verified credential. A body field
 * naming the candidate is a field the caller chose, and trusting it is exactly
 * how one worker ends up acting for another.
 *
 * These mirror `worker_slots_pause_reason_iff_paused` and
 * `worker_slots_stop_reason_iff_stopping` — constraints that bind in BOTH
 * directions, so a state that needs no reason must not carry one either.
 * `crashed` is deliberately in neither list: a crash explains itself.
 */
export const PAUSED_READINESS = 'paused' as const;
export const STOPPING_READINESS = ['stopping', 'stopped'] as const;

export const HeartbeatRequest = z
  .object({
    sequence: z.number().int().min(0),
    lifecycle: z.enum(['starting', 'running', 'stopping']),
    slot_readiness: z.enum([
      'initializing',
      'ready',
      'working',
      'paused',
      'stopping',
      'stopped',
      'crashed',
    ]),
    /**
     * BOUNDED, NEVER FREE TEXT. A worker picks from a list the database also
     * holds as a CHECK constraint; it does not describe its situation in
     * prose. Absent for every state that does not require one.
     */
    reason: z.enum([...WORKER_PAUSE_REASONS, ...WORKER_STOP_REASONS]).optional(),
  })
  .strict()
  .refine(
    (h) =>
      h.slot_readiness !== PAUSED_READINESS ||
      (h.reason !== undefined &&
        (WORKER_PAUSE_REASONS as readonly string[]).includes(h.reason)),
    { message: 'pause_reason_required', path: ['reason'] }
  )
  .refine(
    (h) =>
      !(STOPPING_READINESS as readonly string[]).includes(h.slot_readiness) ||
      (h.reason !== undefined &&
        (WORKER_STOP_REASONS as readonly string[]).includes(h.reason)),
    { message: 'stop_reason_required', path: ['reason'] }
  )
  .refine(
    (h) =>
      h.slot_readiness === PAUSED_READINESS ||
      (STOPPING_READINESS as readonly string[]).includes(h.slot_readiness) ||
      h.reason === undefined,
    { message: 'unexpected_reason', path: ['reason'] }
  );
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

/** What a worker sends to renew the lease it already holds. */
export const RenewRequest = z
  .object({
    /**
     * The fence it was given at claim. Checked by EQUALITY: a worker holding
     * an older number has been superseded, and one guessing a higher number is
     * refused just as firmly.
     */
    fence_token: z.number().int().min(1),
  })
  .strict();
export type RenewRequest = z.infer<typeof RenewRequest>;

/**
 * What a worker sends when it is done with a task.
 *
 * NOTE WHAT IS ABSENT: there is no "submit", no "ready to submit", and no free
 * text. The three dispositions are the only outcomes a worker can report, and
 * the furthest of them leaves the task needing a person.
 */
export const ReportRequest = z
  .object({
    fence_token: z.number().int().min(1),
    disposition: z.enum(['completed', 'failed', 'released']),
    reason: z.enum(WORKER_PAUSE_REASONS).optional(),
  })
  .strict()
  .refine((r) => r.disposition !== 'failed' || r.reason !== undefined, {
    message: 'failure_reason_required',
    path: ['reason'],
  })
  .refine((r) => r.disposition === 'failed' || r.reason === undefined, {
    message: 'unexpected_reason',
    path: ['reason'],
  });
export type ReportRequest = z.infer<typeof ReportRequest>;

export type WorkerAuthFailure =
  | 'missing_credential'
  | 'malformed_credential'
  | 'not_found'
  | 'expired'
  | 'revoked'
  | 'wrong_audience'
  | 'insufficient_scope'
  | 'secret_mismatch';

/* ------------------------------------------------------------- data access */

/**
 * The database operations this module needs, and nothing more.
 *
 * Narrow on purpose: a route handler hands over exactly these, so a reader can
 * see the whole data surface of the protocol in one place — and a test can
 * supply all of it in twenty lines.
 */
export interface PairingStore {
  /** Supersede any live invitation for this candidate, then insert a new one. */
  createPairing(row: {
    user_id: string;
    secret_hash: string;
    expires_at: string;
  }): Promise<{ id: string } | null>;
  /** Find the one live invitation for a secret hash, across all candidates. */
  findPairingByHash(secretHash: string): Promise<PairingRow | null>;
  /** Count a failed attempt. Bounded by a CHECK, so this can fail loudly. */
  recordFailedAttempt(id: string): Promise<void>;
  /**
   * Claim the invitation, register the supervisor and its one slot, and issue
   * the credential — ATOMICALLY, as a single operation.
   *
   * These were four calls once, and the ordering was a standing hazard: the
   * loser of a concurrent redemption had already created a supervisor, a slot
   * and a credential by the time its claim failed. One operation removes the
   * ordering question rather than answering it.
   *
   * NO OWNERSHIP FIELD IS AN ARGUMENT. `secretHash` is the proof, and the
   * candidate is whoever the matching invitation belongs to. An implementation
   * that accepted a candidate id here would be trusting its caller.
   */
  completeRedemption(input: {
    secretHash: string;
    platform: string;
    agentVersion: string;
    credentialId: string;
    tokenHash: string;
    credentialExpiresAt: string;
  }): Promise<
    { ok: true; supervisorId: string; slotId: string } | { ok: false; reason: string }
  >;
  findCredentialById(id: string): Promise<CredentialRow | null>;
  touchCredential(id: string, at: string): Promise<void>;
  /**
   * Record one heartbeat.
   *
   * Identified by the credential and the hash of the token presented with it —
   * never by a supervisor or slot id. Those are read from the credential row
   * by the implementation, so a caller cannot aim a heartbeat at a worker it
   * does not hold a token for.
   */
  recordHeartbeat(input: {
    credentialId: string;
    tokenHash: string;
    sequence: number;
    lifecycle: string;
    readiness: string;
    reason: string | null;
  }): Promise<{ ok: boolean; reason: string; applied: boolean }>;
  /**
   * Claim one approved task for this credential's candidate.
   *
   * THE WORKER NAMES NO TASK. It asks for work; the boundary hands it the
   * oldest task the candidate has approved. A worker that could name a task id
   * could probe for other people's.
   */
  claimTask(input: { credentialId: string; tokenHash: string }): Promise<{
    ok: boolean;
    reason: string;
    taskId: string | null;
    leaseId: string | null;
    fenceToken: number | null;
    leaseExpiresAt: string | null;
  }>;
  /** Extend the lease this slot already holds. Fence checked by equality. */
  renewLease(input: {
    credentialId: string;
    tokenHash: string;
    fenceToken: number;
  }): Promise<{ ok: boolean; reason: string; expiresAt: string | null }>;
  /** Finish with the task and release the lease. */
  reportTask(input: {
    credentialId: string;
    tokenHash: string;
    fenceToken: number;
    disposition: string;
    reason: string | null;
  }): Promise<{ ok: boolean; reason: string }>;
}

/* --------------------------------------------------------------- pairing */

/**
 * Start pairing. Called with an ALREADY-AUTHENTICATED candidate id.
 *
 * The caller resolves the session; this function never reads a request body
 * for identity. The plaintext secret is returned exactly once and is the only
 * moment it exists outside the worker's memory.
 */
export async function startPairing(
  store: PairingStore,
  userId: string,
  now: Date
): Promise<{ ok: true; secret: string; expiresAt: string } | { ok: false; reason: 'failed' }> {
  const { display, normalised } = generatePairingSecret();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS).toISOString();

  const created = await store.createPairing({
    user_id: userId,
    secret_hash: hashSecret(normalised),
    expires_at: expiresAt,
  });
  if (!created) return { ok: false, reason: 'failed' };

  // The display form goes back to the browser once. The hash is what persists.
  return { ok: true, secret: display, expiresAt };
}

export type RedeemFailure =
  | 'malformed_request'
  | 'not_found'
  | 'expired'
  | 'already_redeemed'
  | 'revoked'
  | 'too_many_attempts'
  | 'secret_mismatch'
  | 'registration_failed';

/**
 * The same list, as a value, so a reason coming back from the database can be
 * checked against it rather than trusted. Kept adjacent to the type because
 * the two must not drift; `scripts/test-worker-endpoints.mjs` asserts they
 * have not.
 */
const REDEEM_FAILURES: ReadonlySet<RedeemFailure> = new Set([
  'malformed_request',
  'not_found',
  'expired',
  'already_redeemed',
  'revoked',
  'too_many_attempts',
  'secret_mismatch',
  'registration_failed',
]);

/**
 * Redeem a pairing secret for a scoped credential.
 *
 * THIS ENDPOINT HAS NO SESSION. The worker is not signed in — proving it holds
 * the secret is the whole authentication. So ownership is taken from the
 * invitation row, which was bound to the candidate when they created it.
 *
 * ORDER: parse, look up by hash, evaluate state before secret, then hand the
 * whole registration to `completeRedemption` — which claims the invitation,
 * creates the supervisor, the slot and the credential in ONE transaction. An
 * earlier version did those as four calls with the claim last, so the loser of
 * a race left a supervisor, a slot and a credential behind.
 */
export async function redeemPairing(
  store: PairingStore,
  body: unknown,
  now: Date
): Promise<
  | { ok: true; token: string; supervisorId: string; slotId: string; expiresAt: string }
  | { ok: false; reason: RedeemFailure }
> {
  const parsed = RedeemRequest.safeParse(body);
  if (!parsed.success) return { ok: false, reason: 'malformed_request' };

  const presented = normalisePairingSecret(parsed.data.pairing_secret);
  // Looked up BY HASH: the plaintext is never used as a query parameter, so it
  // cannot land in a query log or a slow-query trace.
  const row = await store.findPairingByHash(hashSecret(presented));

  const verdict = evaluatePairing(row, presented, now);
  if (!verdict.ok) {
    // A wrong secret against a real invitation costs an attempt. The other
    // refusals do not: they are already terminal, and counting them would let
    // an attacker exhaust somebody else's invitation by guessing at it.
    if (row && verdict.reason === 'secret_mismatch') {
      await store.recordFailedAttempt(row.id);
    }
    return { ok: false, reason: verdict.reason };
  }

  /*
   * THE ID IS MINTED HERE, NOT BY THE DATABASE.
   *
   * The token is `<credentialId>.<secret>`, so the id has to exist before the
   * token can be built — and the row must carry the hash of THAT token's
   * secret. Letting the database default the id would mean inserting a
   * placeholder, minting from the returned id, then updating the hash: two
   * writes, a window where a row holds a hash nobody can present, and an
   * immutability trigger that (correctly) forbids the second write.
   *
   * Generating a v4 UUID here collapses that to one insert with the right hash
   * from the start. The id is not a secret — it is half of a token whose other
   * half is 256 bits of CSPRNG — so choosing it client-side costs nothing.
   */
  const expiresAt = new Date(now.getTime() + CREDENTIAL_TTL_MS).toISOString();
  const credentialId = randomUUID();
  const { token, secret } = generateWorkerToken(credentialId);

  const registered = await store.completeRedemption({
    // The same hash the lookup above used. The store never sees the plaintext.
    secretHash: hashSecret(presented),
    platform: parsed.data.platform,
    agentVersion: parsed.data.agent_version,
    credentialId,
    tokenHash: hashSecret(secret),
    credentialExpiresAt: expiresAt,
  });

  if (!registered.ok) {
    /*
     * THE STORE'S REASON IS NOT PASSED THROUGH.
     *
     * The registration boundary re-checks every precondition this function
     * already checked — it is a second layer, and it can legitimately refuse
     * something that looked fine a microsecond earlier, most often because
     * another worker won the race. Its vocabulary happens to overlap this
     * one's, but "happens to" is not a contract: an unrecognised reason
     * becomes `registration_failed` rather than reaching a worker unexamined.
     */
    return {
      ok: false,
      reason: REDEEM_FAILURES.has(registered.reason as RedeemFailure)
        ? (registered.reason as RedeemFailure)
        : 'registration_failed',
    };
  }

  return {
    ok: true,
    token,
    supervisorId: registered.supervisorId,
    slotId: registered.slotId,
    expiresAt,
  };
}

/* ---------------------------------------------------------- authentication */

/**
 * Verify a worker's bearer credential.
 *
 * THE RETURNED IDENTITY IS THE ONLY SOURCE OF OWNERSHIP for every worker
 * endpoint. Nothing downstream reads a candidate id from a body.
 */
export async function authenticateWorker(
  store: PairingStore,
  authorizationHeader: string | null,
  now: Date
): Promise<
  | {
      ok: true;
      userId: string;
      supervisorId: string;
      slotId: string | null;
      credentialId: string;
      tokenHash: string;
    }
  | { ok: false; reason: WorkerAuthFailure }
> {
  if (!authorizationHeader) return { ok: false, reason: 'missing_credential' };
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/);
  if (!match) return { ok: false, reason: 'malformed_credential' };

  const parsed = parseWorkerToken(match[1].trim());
  if (!parsed.ok) return { ok: false, reason: 'malformed_credential' };

  const row = await store.findCredentialById(parsed.credentialId);
  const verdict = evaluateCredential(row, parsed.secret, now, {
    audience: 'kiasa-worker',
    scope: 'slot:heartbeat',
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  return {
    ok: true,
    userId: verdict.userId,
    supervisorId: verdict.supervisorId,
    slotId: verdict.slotId,
    credentialId: parsed.credentialId,
    /*
     * Computed only after `evaluateCredential` has accepted the secret in
     * constant time. It is carried on so that a downstream write can prove to
     * the DATABASE which credential it is acting for, rather than asserting an
     * id the database would have to take on faith. It is the hash of a secret
     * the caller already presented — it discloses nothing the caller does not
     * already hold — and it never leaves the server.
     */
    tokenHash: hashSecret(parsed.secret),
  };
}

/**
 * Record a heartbeat.
 *
 * IDEMPOTENT BY SEQUENCE. A retry that arrives twice, or late, does not move
 * the worker's state backwards: `recordHeartbeat` applies only a strictly
 * newer sequence, and a replayed one is accepted by the endpoint but changes
 * nothing. The caller gets `ok` either way, because a worker retrying a
 * heartbeat has done nothing wrong.
 */
export async function heartbeat(
  store: PairingStore,
  identity: { credentialId: string; tokenHash: string },
  body: unknown,
  now: Date
): Promise<{ ok: true; applied: boolean } | { ok: false; reason: WorkerOperationFailure }> {
  const parsed = HeartbeatRequest.safeParse(body);
  if (!parsed.success) {
    /*
     * A MISSING PAUSE REASON IS NOT THE SAME MISTAKE AS A MALFORMED BODY.
     *
     * The candidate's panel says something different for each, so the schema's
     * own message is used when it names a failure this protocol knows about,
     * and nothing else is ever passed through.
     */
    return { ok: false, reason: schemaFailure(parsed.error) };
  }

  const result = await store.recordHeartbeat({
    credentialId: identity.credentialId,
    tokenHash: identity.tokenHash,
    sequence: parsed.data.sequence,
    lifecycle: parsed.data.lifecycle,
    readiness: parsed.data.slot_readiness,
    reason: parsed.data.reason ?? null,
  });
  await store.touchCredential(identity.credentialId, now.toISOString());

  if (!result.ok) return { ok: false, reason: operationFailure(result.reason) };
  return { ok: true, applied: result.applied };
}

/* ------------------------------------------------------------------ tasks */

/**
 * Every refusal a task operation can return.
 *
 * CLOSED ON PURPOSE. The boundary functions return their own vocabulary, and
 * anything outside this list becomes `refused` rather than reaching a worker —
 * or a candidate's screen — unexamined. A database that starts saying
 * something new says it to the logs, not to a browser.
 */
export const WORKER_OPERATION_FAILURES = [
  'malformed_request',
  'not_found',
  'revoked',
  'expired',
  'out_of_scope',
  'no_slot',
  'slot_busy',
  'no_task_available',
  'attempts_exhausted',
  'no_active_lease',
  'stale_fence',
  'lease_expired',
  'task_not_active',
  'pause_reason_required',
  'stop_reason_required',
  'failure_reason_required',
  'unexpected_reason',
  'refused',
] as const;
export type WorkerOperationFailure = (typeof WORKER_OPERATION_FAILURES)[number];

const OPERATION_FAILURES: ReadonlySet<string> = new Set(WORKER_OPERATION_FAILURES);

/** Anything the boundary says that this protocol does not know becomes `refused`. */
function operationFailure(reason: string): WorkerOperationFailure {
  return OPERATION_FAILURES.has(reason) ? (reason as WorkerOperationFailure) : 'refused';
}

/**
 * A schema refusal, reduced to this protocol's vocabulary.
 *
 * Zod's issue list carries paths and received values; none of it reaches a
 * caller. Only the refine messages, which are written above and are members of
 * the closed list.
 */
function schemaFailure(error: z.ZodError): WorkerOperationFailure {
  for (const issue of error.issues) {
    if (OPERATION_FAILURES.has(issue.message)) return issue.message as WorkerOperationFailure;
  }
  return 'malformed_request';
}

/**
 * Claim one approved task.
 *
 * The identity is the verified credential and nothing else — no task id, no
 * candidate id, no slot id. What comes back is bounded: an opaque task id, the
 * lease, the fence and when the lease dies. No job URL, no employer name, no
 * description, because this milestone's worker has nothing to do with any of
 * them and a field that exists is a field that leaks.
 */
export async function claimTask(
  store: PairingStore,
  identity: { credentialId: string; tokenHash: string }
): Promise<
  | { ok: true; taskId: string; leaseId: string; fenceToken: number; leaseExpiresAt: string }
  | { ok: false; reason: WorkerOperationFailure }
> {
  const result = await store.claimTask(identity);
  if (
    !result.ok ||
    result.taskId === null ||
    result.leaseId === null ||
    result.fenceToken === null ||
    result.leaseExpiresAt === null
  ) {
    return { ok: false, reason: operationFailure(result.reason) };
  }
  return {
    ok: true,
    taskId: result.taskId,
    leaseId: result.leaseId,
    fenceToken: result.fenceToken,
    leaseExpiresAt: result.leaseExpiresAt,
  };
}

/** Extend the lease this slot holds. */
export async function renewLease(
  store: PairingStore,
  identity: { credentialId: string; tokenHash: string },
  body: unknown
): Promise<
  { ok: true; expiresAt: string } | { ok: false; reason: WorkerOperationFailure }
> {
  const parsed = RenewRequest.safeParse(body);
  if (!parsed.success) return { ok: false, reason: schemaFailure(parsed.error) };

  const result = await store.renewLease({ ...identity, fenceToken: parsed.data.fence_token });
  if (!result.ok || result.expiresAt === null) {
    return { ok: false, reason: operationFailure(result.reason) };
  }
  return { ok: true, expiresAt: result.expiresAt };
}

/**
 * Report how the task went.
 *
 * THE THREE DISPOSITIONS DO NOT INCLUDE SUBMISSION. `completed` leaves the
 * task in `manual_review`; deciding an application is ready to send is a
 * candidate's judgement and no worker or model makes it.
 */
export async function reportTask(
  store: PairingStore,
  identity: { credentialId: string; tokenHash: string },
  body: unknown
): Promise<
  { ok: true; disposition: string } | { ok: false; reason: WorkerOperationFailure }
> {
  const parsed = ReportRequest.safeParse(body);
  if (!parsed.success) return { ok: false, reason: schemaFailure(parsed.error) };

  const result = await store.reportTask({
    ...identity,
    fenceToken: parsed.data.fence_token,
    disposition: parsed.data.disposition,
    reason: parsed.data.reason ?? null,
  });
  if (!result.ok) return { ok: false, reason: operationFailure(result.reason) };
  return { ok: true, disposition: parsed.data.disposition };
}

/* ------------------------------------------------------------- the limits */

/** Re-exported so a route and a test agree on the same numbers. */
export const LIMITS = {
  pairingTtlMs: PAIRING_TTL_MS,
  maxPairingAttempts: MAX_PAIRING_ATTEMPTS,
  credentialTtlMs: CREDENTIAL_TTL_MS,
} as const;

export { visibleStatus };
