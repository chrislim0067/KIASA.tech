import 'server-only';

/**
 * The typed shape of the two worker RPCs from migration 26.
 *
 * WHY THIS FILE EXISTS, AND WHEN TO DELETE IT
 *
 * `lib/supabase/database.types.ts` is generated from a running database, and
 * the generator needs one. Until the regenerated file lands, `Database` does
 * not know these two functions exist and `db.rpc('worker_redeem_pairing', …)`
 * does not compile.
 *
 * The alternative — editing the generated file by hand — is forbidden, and
 * rightly: a hand-written entry that drifts from the schema is worse than no
 * entry at all. So the contract is declared HERE, in application code, exactly
 * as migration 26 defines it, and the client is narrowed to it at the one call
 * site. Nothing is silenced: the argument and return shapes below are checked
 * like any other type, and `scripts/test-worker-db-boundary.mjs` calls the
 * real functions against a real database, which is what actually proves the
 * two agree.
 *
 * When the generated types include these functions, delete this file and let
 * `Database` type the calls.
 */

/** `worker_redeem_pairing(p_secret_hash, …)` — migration 26. */
export type WorkerRedeemArgs = {
  p_secret_hash: string;
  p_platform: string;
  p_agent_version: string;
  p_credential_id: string;
  p_token_hash: string;
  p_credential_expires_at: string;
};

/** One row. `supervisor_id` and `slot_id` are null on every refusal. */
export type WorkerRedeemRow = {
  ok: boolean;
  reason: string;
  supervisor_id: string | null;
  slot_id: string | null;
};

/** `worker_record_heartbeat(p_credential_id, …)` — migration 26. */
export type WorkerHeartbeatArgs = {
  p_credential_id: string;
  p_token_hash: string;
  p_sequence: number;
  p_lifecycle: string;
  p_readiness: string;
};

export type WorkerHeartbeatRow = { ok: boolean; reason: string; applied: boolean };

/**
 * The two calls, and nothing else.
 *
 * Deliberately not `SupabaseClient<SomeWiderDatabase>`: widening the whole
 * client would type every table it can reach as well, and this narrowing is
 * meant to expire.
 */
export interface WorkerRpcClient {
  rpc(
    fn: 'worker_redeem_pairing',
    args: WorkerRedeemArgs
  ): PromiseLike<{ data: WorkerRedeemRow[] | null; error: { message: string } | null }>;
  rpc(
    fn: 'worker_record_heartbeat',
    args: WorkerHeartbeatArgs
  ): PromiseLike<{ data: WorkerHeartbeatRow[] | null; error: { message: string } | null }>;
}
