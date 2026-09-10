import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import type { PairingStore } from '@/lib/worker/endpoints';
import type { CredentialRow, PairingRow } from '@/lib/worker/pairing';
import type { WorkerRpcClient } from '@/lib/worker/rpc';

/**
 * The Supabase-backed implementation of the worker protocol's data access.
 *
 * WHY THIS USES THE ELEVATED CLIENT, AND WHY THAT IS NOT A WIDENING
 *
 * A worker redeeming a pairing code has no session — proving it holds the code
 * IS the authentication, which is the whole point of pairing. So the redeem
 * and heartbeat paths cannot run under a candidate's RLS context; there is no
 * candidate context to run under.
 *
 * What keeps that safe is that ownership is never taken from the caller.
 * `findPairingByHash` looks up by a hash the caller must already possess, and
 * every downstream write derives the candidate from the row that hash found. A
 * worker cannot name a candidate, so it cannot choose one.
 *
 * TWO DIFFERENT KINDS OF ACCESS LIVE HERE, AND THE DIFFERENCE MATTERS
 *
 * `worker_pairings` and `worker_credentials` are read and written directly:
 * migration 24 grants `service_role` exactly SELECT, INSERT and UPDATE on
 * those two tables, and asserts that set.
 *
 * `worker_supervisors` and `worker_slots` are NOT. Migration 22 revokes every
 * privilege from `service_role` on them and asserts the absence, so this
 * client cannot read or write them at all — which is why registration and
 * heartbeat go through `worker_redeem_pairing` and `worker_record_heartbeat`,
 * the two `security definer` functions from migration 26. Each performs one
 * protocol operation, takes a hash rather than an id as its proof, and reads
 * ownership out of the row that hash matched.
 *
 * THE CANDIDATE-FACING PATHS DO NOT COME THROUGH HERE. Starting a pairing,
 * reading status and revoking all run under the candidate's own session and
 * their own RLS policies, so a browser can only ever act on its own rows.
 */

/** Columns the protocol needs from a pairing. Never a plaintext secret. */
const PAIRING_COLUMNS =
  'id, user_id, secret_hash, expires_at, redeemed_at, revoked_at, attempts';

const CREDENTIAL_COLUMNS =
  'id, user_id, supervisor_id, slot_id, token_hash, audience, scope, expires_at, revoked_at';

export function createPairingStore(): PairingStore {
  const db = createAdminClient();
  /*
   * The same connection, narrowed to the two functions migration 26 defines.
   * See lib/worker/rpc.ts for why the declaration lives in application code
   * and when it should be deleted.
   */
  const rpc = db as unknown as WorkerRpcClient;

  return {
    async createPairing(row) {
      /*
       * Supersede any live invitation first.
       *
       * `worker_pairings_one_live_per_user` is a partial unique index, so
       * inserting a second live row would fail rather than replace. Revoking
       * the old one makes "ask again" mean what a candidate expects, and keeps
       * at most one usable secret in existence per person at any moment.
       */
      await db
        .from('worker_pairings')
        .update({ revoked_at: new Date().toISOString() })
        .eq('user_id', row.user_id)
        .is('redeemed_at', null)
        .is('revoked_at', null);

      const { data, error } = await db
        .from('worker_pairings')
        .insert(row)
        .select('id')
        .maybeSingle<{ id: string }>();
      return error || !data ? null : { id: data.id };
    },

    async findPairingByHash(secretHash) {
      /*
       * Looked up BY HASH across all candidates, which is correct: whoever
       * holds the code was given it by its owner, and the row is what says who
       * that is. The plaintext is never a query value, so it cannot appear in
       * a slow-query log.
       */
      const { data } = await db
        .from('worker_pairings')
        .select(PAIRING_COLUMNS)
        .eq('secret_hash', secretHash)
        .maybeSingle();
      return (data as PairingRow | null) ?? null;
    },

    async completeRedemption(input) {
      /*
       * REGISTRATION IS ONE TRANSACTION, AND IT IS NOT THIS PROCESS'S TO MAKE.
       *
       * `service_role` holds nothing on `worker_supervisors` or `worker_slots`
       * — migration 22 revoked it and asserts the absence — so this cannot be
       * four statements from here however carefully they are ordered. It is
       * one call into `worker_redeem_pairing`, which takes the pairing row's
       * lock, checks state, creates the supervisor, the slot and the
       * credential, and claims the invitation.
       *
       * That also closes a race the four-statement version had: it created the
       * supervisor, slot and credential BEFORE claiming, so the loser of a
       * concurrent redemption left all three behind. Inside the function the
       * loser blocks on the row lock, re-reads a redeemed invitation, and
       * writes nothing at all.
       *
       * NO ID IS SENT AS PROOF. The secret's hash is the proof; the candidate
       * comes out of the row it matches.
       */
      const { data, error } = await rpc.rpc('worker_redeem_pairing', {
        p_secret_hash: input.secretHash,
        p_platform: input.platform,
        p_agent_version: input.agentVersion,
        p_credential_id: input.credentialId,
        p_token_hash: input.tokenHash,
        p_credential_expires_at: input.credentialExpiresAt,
      });

      const row = Array.isArray(data) ? data[0] : null;
      // A transport error, a missing function, a revoked EXECUTE grant: all
      // indistinguishable from here, and all mean the same thing to a worker.
      if (error || !row) return { ok: false, reason: 'registration_failed' };
      if (!row.ok || !row.new_supervisor_id || !row.new_slot_id) {
        return { ok: false, reason: row.reason };
      }
      return { ok: true, supervisorId: row.new_supervisor_id, slotId: row.new_slot_id };
    },

    async recordFailedAttempt(id) {
      /*
       * ONE STATEMENT, NO READ.
       *
       * This used to select `attempts`, add one, and write it back — a lost
       * update waiting to happen, on the one endpoint an attacker can call
       * without authenticating and therefore parallelise at will. Enough
       * concurrent guesses could have pinned the counter well below its
       * ceiling indefinitely.
       *
       * The arithmetic now lives in the BEFORE UPDATE trigger (migration 25).
       * The value sent here is a SIGNAL, not data: the trigger discards it and
       * computes `least(old.attempts + 1, 10)` from the locked previous row.
       * Concurrent updates serialise on that row lock, so every attempt counts
       * exactly once and none can be lost.
       *
       * WHY THE SIGNAL IS -1 AND NOT 0.
       *
       * The trigger counts an attempt when `new.attempts is distinct from
       * old.attempts` — that is how it tells a failed guess apart from a
       * revocation, which writes `revoked_at` and leaves this column alone.
       * Sending 0 therefore counted NOTHING while the stored value was still
       * 0, which is every first wrong guess; and under a burst of concurrent
       * guesses that all see 0 it counted nothing at all, leaving the limit
       * inert. The endpoint tests missed it because their in-memory store
       * increments unconditionally. scripts/test-worker-pairing-db.mjs, run
       * against a real Postgres, did not.
       *
       * -1 cannot equal a stored value: `worker_pairings_attempts_bounded`
       * confines the column to 0..10. Every call is therefore distinct and
       * counts exactly once, and the choice is self-enforcing — if the trigger
       * were ever dropped, -1 would violate that constraint and this write
       * would fail loudly rather than silently record a negative count.
       *
       * The value still cannot be chosen by a caller: the trigger discards it
       * either way, so nothing can reset the counter or jump it.
       */
      await db.from('worker_pairings').update({ attempts: -1 }).eq('id', id);
    },

    async findCredentialById(id) {
      const { data } = await db
        .from('worker_credentials')
        .select(CREDENTIAL_COLUMNS)
        .eq('id', id)
        .maybeSingle();
      return (data as CredentialRow | null) ?? null;
    },

    async touchCredential(id, at) {
      await db.from('worker_credentials').update({ last_used_at: at }).eq('id', id);
    },

    async recordHeartbeat(input) {
      /*
       * ONE CALL, AND NO SUPERVISOR OR SLOT ID CROSSES IT.
       *
       * The read-then-write this replaced had two problems. The smaller one is
       * that `service_role` cannot read or write either table, so neither
       * statement could ever have run. The larger one is that it took
       * `supervisorId` and `slotId` as arguments: the server derived them
       * honestly from the credential, but the DATABASE had no way to know
       * that, and a boundary that trusts its caller's ids is a boundary in
       * name only.
       *
       * `worker_record_heartbeat` takes the credential id and the token's
       * hash, requires both to match one row, and reads the candidate, the
       * supervisor and the slot out of it. It also owns the monotonic-sequence
       * check, which is now a comparison inside one transaction rather than a
       * read and a write with a gap between them.
       */
      const { data, error } = await rpc.rpc('worker_record_heartbeat', {
        p_credential_id: input.credentialId,
        p_token_hash: input.tokenHash,
        p_sequence: input.sequence,
        p_lifecycle: input.lifecycle,
        p_readiness: input.readiness,
      });

      const row = Array.isArray(data) ? data[0] : null;
      if (error || !row || !row.ok) return { applied: false };
      return { applied: row.applied };
    },
  };
}
