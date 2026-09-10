import { NextResponse } from 'next/server';

import { isSupabaseConfigured } from '@/lib/supabase/env';
import { authenticateWorker, heartbeat } from '@/lib/worker/endpoints';
import { createPairingStore } from '@/lib/worker/store';

/**
 * POST /api/worker/heartbeat — "I am still here."
 *
 * Authenticated by the bearer credential and NOTHING ELSE. The candidate, the
 * supervisor and the slot all come from the verified credential; the body has
 * no field for any of them, so a worker cannot name a candidate and therefore
 * cannot choose one.
 *
 * Idempotent: a replayed or late sequence is accepted and changes nothing.
 * A worker retrying a heartbeat has done nothing wrong, so it is not an error —
 * but it must not move state backwards either, or a crashed slot would show as
 * working and its task would stay leased.
 */

export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store, max-age=0, must-revalidate' };

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, reason: 'unconfigured' }, { status: 503, headers: noStore });
  }

  const store = createPairingStore();
  const now = new Date();

  const auth = await authenticateWorker(store, request.headers.get('authorization'), now);
  if (!auth.ok) {
    // 401 for "you did not present a usable credential", 403 for one that was
    // valid and is not any more. A worker treats both as terminal and stops.
    const status = auth.reason === 'revoked' || auth.reason === 'expired' ? 403 : 401;
    return NextResponse.json({ ok: false, reason: auth.reason }, { status, headers: noStore });
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'malformed_request' }, { status: 400, headers: noStore });
  }

  const result = await heartbeat(
    store,
    // The credential, and the hash of the token presented for it. No
    // supervisor or slot id crosses this call: the database reads those out of
    // the credential row, so nothing downstream has to be taken on trust.
    { credentialId: auth.credentialId, tokenHash: auth.tokenHash },
    body,
    now
  );
  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 400, headers: noStore });
  }
  return NextResponse.json({ ok: true, applied: result.applied }, { status: 200, headers: noStore });
}
