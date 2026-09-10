import { NextResponse } from 'next/server';

import { isSupabaseConfigured } from '@/lib/supabase/env';
import { authenticateWorker, renewLease } from '@/lib/worker/endpoints';
import { authStatus, noStore, operationStatus, readJson } from '@/lib/worker/http';
import { createPairingStore } from '@/lib/worker/store';

/**
 * POST /api/worker/task/renew — "I am still working on it."
 *
 * The body carries one field: the fence number the worker was given when it
 * claimed. That is the only thing it sends which is not derived from its
 * credential, and it is checked by equality — a worker that has been
 * superseded cannot renew, and cannot guess its way back in either.
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

  const result = await renewLease(
    store,
    { credentialId: auth.credentialId, tokenHash: auth.tokenHash },
    body.body
  );
  if (!result.ok) return NextResponse.json({ ok: false, reason: result.reason }, { status: operationStatus(result.reason), headers: noStore });

  return NextResponse.json(
    { ok: true, lease_expires_at: result.expiresAt },
    { status: 200, headers: noStore }
  );
}
