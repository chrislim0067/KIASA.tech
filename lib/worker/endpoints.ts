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
  /**
   * Claim the invitation. MUST be a conditional update — `where redeemed_at is
   * null` — so two workers racing produce exactly one winner.
   */
  claimPairing(id: string, supervisorId: string): Promise<boolean>;
  /** Count a failed attempt. Bounded by a CHECK, so this can fail loudly. */
  recordFailedAttempt(id: string): Promise<void>;
  createSupervisor(row: {
    user_id: string;
    platform: string;
    agent_version: string;
  }): Promise<{ id: string } | null>;
  createSlot(row: { user_id: string; supervisor_id: string }): Promise<{ id: string } | null>;
  createCredential(row: {
    id: string;
    user_id: string;
    supervisor_id: string;
    slot_id: string;
    token_hash: string;
    expires_at: string;
  }): Promise<{ id: string } | null>;
  findCredentialById(id: string): Promise<CredentialRow | null>;
  touchCredential(id: string, at: string): Promise<void>;
  recordHeartbeat(input: {
    supervisorId: string;
    slotId: string | null;
    sequence: number;
    lifecycle: string;
    readiness: string;
    at: string;
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

  const userId = verdict.userId;

  const supervisor = await store.createSupervisor({
    user_id: userId,
    platform: parsed.data.platform,
    agent_version: parsed.data.agent_version,
  });
  if (!supervisor) return { ok: false, reason: 'registration_failed' };

  const slot = await store.createSlot({ user_id: userId, supervisor_id: supervisor.id });
  if (!slot) return { ok: false, reason: 'registration_failed' };

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

  const stored = await store.createCredential({
    id: credentialId,
    user_id: userId,
    supervisor_id: supervisor.id,
    slot_id: slot.id,
    token_hash: hashSecret(secret),
    expires_at: expiresAt,
  });
  if (!stored) return { ok: false, reason: 'registration_failed' };

  const claimed = await store.claimPairing(row!.id, supervisor.id);
  if (!claimed) return { ok: false, reason: 'already_redeemed' };

  return {
    ok: true,
    token,
    supervisorId: supervisor.id,
    slotId: slot.id,
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
  | { ok: true; userId: string; supervisorId: string; slotId: string | null; credentialId: string }
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
  identity: { supervisorId: string; slotId: string | null; credentialId: string },
  body: unknown,
  now: Date
): Promise<{ ok: true; applied: boolean } | { ok: false; reason: 'malformed_request' }> {
  const parsed = HeartbeatRequest.safeParse(body);
  if (!parsed.success) return { ok: false, reason: 'malformed_request' };

  const at = now.toISOString();
  const { applied } = await store.recordHeartbeat({
    supervisorId: identity.supervisorId,
    slotId: identity.slotId,
    sequence: parsed.data.sequence,
    lifecycle: parsed.data.lifecycle,
    readiness: parsed.data.slot_readiness,
    at,
  });
  await store.touchCredential(identity.credentialId, at);
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
