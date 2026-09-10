import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

/**
 * Pairing secrets and worker credentials: generation, hashing, verification.
 *
 * PURE. No database, no network, no clock of its own — every function that
 * needs the time is given it. That is what lets the security-critical parts be
 * tested exhaustively, which is the only reason to trust them.
 *
 * WHAT A PAIRING IS FOR
 *
 * A candidate runs a worker on their own computer. The worker needs to prove
 * to the control plane that it belongs to that candidate, and the candidate
 * must never have to paste a long-lived key into it. So: a short-lived
 * one-time secret, exchanged once, for a scoped credential.
 *
 * WHAT IS NEVER STORED
 *
 * The plaintext of either. The server keeps SHA-256 hashes; the plaintext
 * exists in a response body once and in the worker's memory. There is no
 * column, log line or file in this design that holds either in the clear.
 *
 * WHY SHA-256 AND NOT A PASSWORD HASH
 *
 * bcrypt and argon2 exist to make GUESSING a human-chosen password expensive.
 * These are 256 bits from the system CSPRNG: there is no dictionary, no
 * pattern and nothing to guess. What matters instead is that verification is
 * CONSTANT-TIME, which `timingSafeEqual` gives, and that the window is short.
 */

/* -------------------------------------------------------------- pairing */

/** Ten minutes. An invitation that lives for hours is one someone else finds. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Failed redemptions before the invitation is dead. Guessing is finite. */
export const MAX_PAIRING_ATTEMPTS = 10;

/**
 * The human-transcribed shape.
 *
 * Base32-style alphabet with I, L, O, U removed: those are the characters
 * people mistranscribe, and a candidate is going to read this off a screen and
 * type it into a terminal. Grouped for legibility, compared without the
 * grouping.
 *
 * 26 significant characters from a 32-symbol alphabet is 130 bits. The dashes
 * carry no entropy and are cosmetic.
 */
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const PAIRING_SECRET_LENGTH = 26;

export const PairingSecret = z
  .string()
  .min(PAIRING_SECRET_LENGTH)
  .max(PAIRING_SECRET_LENGTH + 8)
  .regex(/^[A-Z0-9-]+$/);

/** Generate a pairing secret. Formatted for a human, normalised for compare. */
export function generatePairingSecret(): { display: string; normalised: string } {
  const bytes = randomBytes(PAIRING_SECRET_LENGTH);
  let out = '';
  for (let i = 0; i < PAIRING_SECRET_LENGTH; i++) {
    // Modulo bias across 30 symbols from 256 values is negligible at this
    // length and this lifetime; the alternative is rejection sampling for a
    // ten-minute token.
    out += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  }
  const display = `${out.slice(0, 6)}-${out.slice(6, 12)}-${out.slice(12, 19)}-${out.slice(19)}`;
  return { display, normalised: out };
}

/**
 * Normalise what a human typed.
 *
 * Upper-cases and strips grouping and whitespace. It deliberately does NOT
 * substitute look-alike characters: silently turning a typed `0` into `O`
 * would let two different strings verify as one secret, which is a smaller
 * search space than it appears.
 */
export const normalisePairingSecret = (raw: string): string =>
  raw.trim().toUpperCase().replace(/[\s-]/g, '');

/* ---------------------------------------------------------- credentials */

/**
 * A worker token: `<credentialId>.<secret>`.
 *
 * The id is a lookup key so verification is an indexed read of ONE row rather
 * than a scan comparing every hash — which matters both for speed and because
 * a scan invites a timing signal across rows.
 *
 * The secret half is 32 bytes of CSPRNG, base64url. Only its hash is stored.
 */
export const WORKER_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;

export const WorkerToken = z.string().regex(WORKER_TOKEN_PATTERN);

/** Thirty days. Re-pairing is cheap; a stolen token should die on its own. */
export const CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function generateWorkerToken(credentialId: string): {
  token: string;
  secret: string;
} {
  const secret = randomBytes(32).toString('base64url');
  return { token: `${credentialId}.${secret}`, secret };
}

/** Split a presented token without trusting its shape. */
export function parseWorkerToken(
  raw: unknown
): { ok: true; credentialId: string; secret: string } | { ok: false } {
  if (typeof raw !== 'string' || !WORKER_TOKEN_PATTERN.test(raw)) return { ok: false };
  const dot = raw.indexOf('.');
  return { ok: true, credentialId: raw.slice(0, dot), secret: raw.slice(dot + 1) };
}

/* ------------------------------------------------------------- hashing */

/** SHA-256, hex. The only form either secret is ever stored in. */
export const hashSecret = (secret: string): string =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

/**
 * Constant-time comparison of two hex digests.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * timing signal and a crash, so lengths are checked first and a mismatch
 * returns false without comparing. Both inputs are hashes of the same
 * algorithm, so unequal lengths mean malformed input rather than a near miss.
 */
export function secretMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/* ------------------------------------------------------------ validity */

export type PairingRejection =
  | 'not_found'
  | 'expired'
  | 'already_redeemed'
  | 'revoked'
  | 'too_many_attempts'
  | 'secret_mismatch';

export interface PairingRow {
  id: string;
  user_id: string;
  secret_hash: string;
  expires_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
  attempts: number;
}

/**
 * May this pairing be redeemed with this secret?
 *
 * ORDER MATTERS. Every cheap state check happens BEFORE the secret is
 * compared, so an attacker learns nothing from timing about whether a guess
 * was close — an expired or exhausted invitation is refused without the
 * comparison running at all. The secret check is last and constant-time.
 *
 * Fails closed: an unrecognised state is a refusal, never a pass.
 */
export function evaluatePairing(
  row: PairingRow | null,
  presentedSecret: string,
  now: Date
): { ok: true; userId: string } | { ok: false; reason: PairingRejection } {
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revoked_at !== null) return { ok: false, reason: 'revoked' };
  if (row.redeemed_at !== null) return { ok: false, reason: 'already_redeemed' };
  if (row.attempts >= MAX_PAIRING_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  const expires = Date.parse(row.expires_at);
  if (!Number.isFinite(expires) || expires <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }

  if (!secretMatches(presentedSecret, row.secret_hash)) {
    return { ok: false, reason: 'secret_mismatch' };
  }
  return { ok: true, userId: row.user_id };
}

export type CredentialRejection =
  | 'not_found'
  | 'expired'
  | 'revoked'
  | 'wrong_audience'
  | 'insufficient_scope'
  | 'secret_mismatch';

export interface CredentialRow {
  id: string;
  user_id: string;
  supervisor_id: string;
  slot_id: string | null;
  token_hash: string;
  audience: string;
  scope: string;
  expires_at: string;
  revoked_at: string | null;
}

/**
 * May this token act, and for whom?
 *
 * THE RETURNED `userId` IS THE ONLY SOURCE OF OWNERSHIP. Every worker endpoint
 * derives the candidate from here and never from a request body — a body field
 * is something the caller chose, and trusting it is how one worker acts for
 * another candidate.
 */
export function evaluateCredential(
  row: CredentialRow | null,
  presentedSecret: string,
  now: Date,
  required: { audience: string; scope: string }
):
  | { ok: true; userId: string; supervisorId: string; slotId: string | null }
  | { ok: false; reason: CredentialRejection } {
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revoked_at !== null) return { ok: false, reason: 'revoked' };

  const expires = Date.parse(row.expires_at);
  if (!Number.isFinite(expires) || expires <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  if (row.audience !== required.audience) return { ok: false, reason: 'wrong_audience' };
  if (row.scope !== required.scope) return { ok: false, reason: 'insufficient_scope' };

  if (!secretMatches(presentedSecret, row.token_hash)) {
    return { ok: false, reason: 'secret_mismatch' };
  }
  return {
    ok: true,
    userId: row.user_id,
    supervisorId: row.supervisor_id,
    slotId: row.slot_id,
  };
}

/* -------------------------------------------------------------- status */

/** How long without a heartbeat before a worker is treated as stale. */
export const STALE_AFTER_MS = 90_000;

export type WorkerVisibleStatus = 'not_paired' | 'online' | 'stale' | 'revoked' | 'expired';

/**
 * What the candidate is shown. Status only — never a hash, never a token.
 *
 * `stale` is deliberately distinct from `revoked`: a laptop that went to sleep
 * and a worker that was turned off are different facts, and a candidate
 * debugging the first should not be told the second.
 */
export function visibleStatus(
  input: {
    hasCredential: boolean;
    revokedAt: string | null;
    expiresAt: string | null;
    lastHeartbeatAt: string | null;
  },
  now: Date
): WorkerVisibleStatus {
  if (!input.hasCredential) return 'not_paired';
  if (input.revokedAt !== null) return 'revoked';
  const expires = input.expiresAt === null ? NaN : Date.parse(input.expiresAt);
  if (!Number.isFinite(expires) || expires <= now.getTime()) return 'expired';
  const beat = input.lastHeartbeatAt === null ? NaN : Date.parse(input.lastHeartbeatAt);
  if (!Number.isFinite(beat)) return 'stale';
  return now.getTime() - beat <= STALE_AFTER_MS ? 'online' : 'stale';
}

/**
 * The fields a worker-status response may contain.
 *
 * `.strict()`, and there is deliberately no field a hash or token could
 * occupy. A test asserts the key set, because "we would never add that" is not
 * a control.
 */
export const WorkerStatusView = z
  .object({
    status: z.enum(['not_paired', 'online', 'stale', 'revoked', 'expired']),
    supervisor_id: z.uuid().nullable(),
    slot_index: z.number().int().min(1).max(10).nullable(),
    last_heartbeat_at: z.iso.datetime().nullable(),
    paired_at: z.iso.datetime().nullable(),
    expires_at: z.iso.datetime().nullable(),
  })
  .strict();
export type WorkerStatusView = z.infer<typeof WorkerStatusView>;
