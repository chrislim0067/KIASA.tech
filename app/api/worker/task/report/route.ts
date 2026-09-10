import { NextResponse } from 'next/server';

import { isSupabaseConfigured } from '@/lib/supabase/env';
import { authenticateWorker, reportTask } from '@/lib/worker/endpoints';
import { authStatus, noStore, operationStatus, readJson } from '@/lib/worker/http';
import { createPairingStore } from '@/lib/worker/store';

/**
 * POST /api/worker/task/report — "I am done with it."
 *
 * Three dispositions, and none of them is submission. `completed` leaves the
 * task in `manual_review` for a person to continue; `failed` names a cause
 * from a bounded list; `released` puts it back in the queue. There is no
 * disposition that sends an application, here or anywhere a worker can reach.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, reason: 'unconfigured' }, { status: 503, headers: noStore });
  }

  const store = createPairingStore();
  const auth = await authenticateWorker(store, request.headers.get('authorization'), new Date());
  if (!auth.ok) return NextResponse.json({ ok: false, reason: auth.reason }, { status: authStatus(auth.reason), headers: noStore });

  const body = await readJson(request);
  if (!body.ok) return NextResponse.json({ ok: false, reason: 'malformed_request' }, { status: 400, headers: noStore });

  const result = await reportTask(
    store,
    { credentialId: auth.credentialId, tokenHash: auth.tokenHash },
    body.body
  );
  if (!result.ok) return NextResponse.json({ ok: false, reason: result.reason }, { status: operationStatus(result.reason), headers: noStore });

  return NextResponse.json(
    { ok: true, disposition: result.disposition },
    { status: 200, headers: noStore }
  );
}
