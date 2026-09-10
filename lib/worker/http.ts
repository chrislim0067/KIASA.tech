import 'server-only';

import type { WorkerAuthFailure, WorkerOperationFailure } from '@/lib/worker/endpoints';

/**
 * The shared HTTP shape of the worker's task routes.
 *
 * WHY THIS IS ONE FILE AND NOT THREE COPIES
 *
 * NO FRAMEWORK IMPORT LIVES HERE. The mapping is pure — a reason in, a number
 * out — so scripts/probe-worker-e2e.mjs can import the very same function the
 * routes use instead of writing its own. A probe with its own status mapping
 * proves the worker copes with the probe.
 *
 * Claim, renew and report differ by one function call each. Copying the
 * authentication, the body parsing and — most importantly — the status mapping
 * into three files is how one of them ends up returning 500 where the others
 * return 409, or leaking an error the others redact. The mapping below is the
 * only place a database refusal becomes a number.
 */

export const noStore = { 'Cache-Control': 'no-store, max-age=0, must-revalidate' };

/**
 * 401 for "you did not present a usable credential", 403 for one that was
 * valid and is not any more. A worker treats both as terminal and stops.
 */
export function authStatus(reason: WorkerAuthFailure): number {
  return reason === 'revoked' || reason === 'expired' ? 403 : 401;
}

/**
 * A refusal, as a number a worker can act on.
 *
 * NOTHING HERE IS DERIVED FROM AN ERROR MESSAGE. The reason has already been
 * narrowed to a closed vocabulary by `lib/worker/endpoints.ts`; this maps that
 * vocabulary and nothing else, so an unrecognised database error can only ever
 * arrive as `refused` and leave as 409.
 *
 *   400  the request was wrong — malformed, or missing a required reason
 *   403  the credential is no longer usable
 *   404  there was nothing to act on
 *   409  the world moved: someone else holds the slot, the fence is stale,
 *        the lease died, the task is no longer active
 */
export function operationStatus(reason: WorkerOperationFailure): number {
  switch (reason) {
    case 'malformed_request':
    case 'pause_reason_required':
    case 'stop_reason_required':
    case 'failure_reason_required':
    case 'unexpected_reason':
      return 400;
    case 'revoked':
    case 'expired':
    case 'out_of_scope':
      return 403;
    case 'not_found':
    case 'no_slot':
    case 'no_task_available':
    case 'no_active_lease':
      return 404;
    default:
      // slot_busy, stale_fence, lease_expired, task_not_active,
      // attempts_exhausted, refused.
      return 409;
  }
}

/**
 * Read a JSON body, or fail closed.
 *
 * A body that will not parse is a malformed request, not a 500 — and the parse
 * error itself never reaches the caller, because it can quote the bytes that
 * failed.
 */
export async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
}
