import 'server-only';

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

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
 * What a worker sends on each heartbeat.
 *
 * NOTE WHAT IS ABSENT: there is no `user_id`, no `candidate_id`, and no
 * `supervisor_id`. All three come from the verified credential. A body field
 * naming the candidate is a field the caller chose, and trusting it is exactly
 * how one worker ends up acting for another.
 */
export const HeartbeatRequest = z
  .object({
    sequence: z.number().int().min(0),
    lifecycle: z.enum(['starting', 'running', 'stopping']),
    slot_readiness: z.enum(['initializing', 'ready', 'working', 'paused', 'stopped', 'crashed']),
  })
  .strict();
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

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
  }): Promise<{ applied: boolean }>;
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
 * ORDER: parse, look up by hash, evaluate state before secret, then create the
 * supervisor, slot and credential, and only then claim the invitation. If the
 * claim loses a race the credential is orphaned rather than a second worker
 * being paired — the safer direction, and an orphan is inert because nothing
 * links it to a live invitation.
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
): Promise<{ ok: true; applied: boolean } | { ok: false; reason: 'malformed_request' }> {
  const parsed = HeartbeatRequest.safeParse(body);
  if (!parsed.success) return { ok: false, reason: 'malformed_request' };

  const { applied } = await store.recordHeartbeat({
    credentialId: identity.credentialId,
    tokenHash: identity.tokenHash,
    sequence: parsed.data.sequence,
    lifecycle: parsed.data.lifecycle,
    readiness: parsed.data.slot_readiness,
  });
  await store.touchCredential(identity.credentialId, now.toISOString());
  return { ok: true, applied };
}

/* ------------------------------------------------------------- the limits */

/** Re-exported so a route and a test agree on the same numbers. */
export const LIMITS = {
  pairingTtlMs: PAIRING_TTL_MS,
  maxPairingAttempts: MAX_PAIRING_ATTEMPTS,
  credentialTtlMs: CREDENTIAL_TTL_MS,
} as const;

export { visibleStatus };
