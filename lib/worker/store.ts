import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import type { PairingStore } from '@/lib/worker/endpoints';
import type { CredentialRow, PairingRow } from '@/lib/worker/pairing';

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
 * every downstream write uses the `user_id` from the row it found. A worker
 * cannot name a candidate, so it cannot choose one.
 *
 * Migration 24 grants `service_role` exactly SELECT, INSERT and UPDATE on the
 * two new tables — no DELETE, and nothing on any existing table. The migration
 * asserts that set and aborts if it differs.
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

    async claimPairing(id, supervisorId) {
      /*
       * THE CONDITIONAL UPDATE. `.is('redeemed_at', null)` is what makes
       * redemption single-use under concurrency: two workers racing both reach
       * here, and Postgres lets exactly one row-update win. The loser gets zero
       * rows back and is told the invitation was already redeemed.
       */
      const { data } = await db
        .from('worker_pairings')
        .update({ redeemed_at: new Date().toISOString(), redeemed_supervisor_id: supervisorId })
        .eq('id', id)
        .is('redeemed_at', null)
        .select('id');
      return Array.isArray(data) && data.length === 1;
    },

    async recordFailedAttempt(id) {
      // Read-then-write rather than an atomic increment, because PostgREST has
      // no `x = x + 1`. A lost update under concurrent guessing costs one
      // attempt of accuracy against a ten-attempt ceiling, and the window is
      // ten minutes — an acceptable trade for not adding a function.
      const { data } = await db
        .from('worker_pairings')
        .select('attempts')
        .eq('id', id)
        .maybeSingle<{ attempts: number }>();
      if (!data) return;
      await db
        .from('worker_pairings')
        .update({ attempts: Math.min(data.attempts + 1, 10) })
        .eq('id', id);
    },

    async createSupervisor(row) {
      const { data, error } = await db
        .from('worker_supervisors')
        .insert({ ...row, declared_slots: 1, lifecycle: 'starting' })
        .select('id')
        .maybeSingle<{ id: string }>();
      return error || !data ? null : { id: data.id };
    },

    async createSlot(row) {
      const { data, error } = await db
        .from('worker_slots')
        .insert({
          user_id: row.user_id,
          supervisor_id: row.supervisor_id,
          // ONE slot in this milestone. The schema allows ten; the runtime
          // uses the first and only.
          slot_index: 1,
          browser_context_id: 'slot-1',
          capabilities: ['form_fill'],
          readiness: 'initializing',
        })
        .select('id')
        .maybeSingle<{ id: string }>();
      return error || !data ? null : { id: data.id };
    },

    async createCredential(row) {
      const { data, error } = await db
        .from('worker_credentials')
        .insert(row)
        .select('id')
        .maybeSingle<{ id: string }>();
      return error || !data ? null : { id: data.id };
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
       * Monotonic by sequence. A retry that overtakes what it was retrying, or
       * a duplicate delivery, must not move the worker's state backwards — a
       * crashed slot showing as `working` would leave its task leased.
       */
      const { data: current } = await db
        .from('worker_supervisors')
        .select('heartbeat_sequence')
        .eq('id', input.supervisorId)
        .maybeSingle<{ heartbeat_sequence: number }>();

      if (current && input.sequence <= current.heartbeat_sequence) {
        return { applied: false };
      }

      await db
        .from('worker_supervisors')
        .update({
          heartbeat_sequence: input.sequence,
          last_heartbeat_at: input.at,
          lifecycle: input.lifecycle,
        })
        .eq('id', input.supervisorId);

      if (input.slotId) {
        await db
          .from('worker_slots')
          .update({
            heartbeat_sequence: input.sequence,
            last_heartbeat_at: input.at,
            readiness: input.readiness,
          })
          .eq('id', input.slotId);
      }
      return { applied: true };
    },
  };
}
