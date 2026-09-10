import { NextResponse } from 'next/server';

import { isSupabaseConfigured } from '@/lib/supabase/env';
import { authenticateWorker, claimTask } from '@/lib/worker/endpoints';
import { authStatus, noStore, operationStatus } from '@/lib/worker/http';
import { createPairingStore } from '@/lib/worker/store';

/**
 * POST /api/worker/task/claim — "give me work."
 *
 * NO BODY AT ALL. There is nothing for a worker to say here: it cannot name a
 * task, a candidate, a slot or a lease, so the request carries only the bearer
 * credential and the boundary decides what, if anything, it gets.
 *
 * What comes back is bounded — a task id, a lease id, a fence number and when
 * the lease dies. No job URL, no employer, no description. This milestone's
 * worker has nothing to do with any of them.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, reason: 'unconfigured' }, { status: 503, headers: noStore });
  }

  const store = createPairingStore();
  const auth = await authenticateWorker(store, request.headers.get('authorization'), new Date());
  if (!auth.ok) return NextResponse.json({ ok: false, reason: auth.reason }, { status: authStatus(auth.reason), headers: noStore });

  const result = await claimTask(store, {
    credentialId: auth.credentialId,
    tokenHash: auth.tokenHash,
  });
  if (!result.ok) return NextResponse.json({ ok: false, reason: result.reason }, { status: operationStatus(result.reason), headers: noStore });

  return NextResponse.json(
    {
      ok: true,
      task_id: result.taskId,
      lease_id: result.leaseId,
      fence_token: result.fenceToken,
      lease_expires_at: result.leaseExpiresAt,
    },
    { status: 200, headers: noStore }
  );
}
