import { NextResponse } from 'next/server';

import { isSupabaseConfigured } from '@/lib/supabase/env';
import { redeemPairing } from '@/lib/worker/endpoints';
import { createPairingStore } from '@/lib/worker/store';

/**
 * POST /api/worker/redeem — a worker exchanges a pairing code for a credential.
 *
 * THE ONLY WORKER ENDPOINT WITHOUT A SESSION, and deliberately so: the worker
 * is not signed in, and proving it holds the one-time code IS the
 * authentication. Ownership is therefore taken from the invitation row, which
 * was bound to a candidate when they created it — never from the request body,
 * which carries no identity field at all.
 *
 * Failures return a short code and nothing else. A message that distinguished
 * "no such code" from "wrong code" would be a guessing oracle; both are simply
 * refusals, and the attempt counter makes guessing finite regardless.
 */

export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store, max-age=0, must-revalidate' };

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, reason: 'unconfigured' }, { status: 503, headers: noStore });
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'malformed_request' }, { status: 400, headers: noStore });
  }

  const result = await redeemPairing(createPairingStore(), body, new Date());
  if (!result.ok) {
    // 400 for a malformed body; 403 for every refusal, so the shape of the
    // response does not distinguish which invitation state was hit.
    const status = result.reason === 'malformed_request' ? 400
      : result.reason === 'registration_failed' ? 500 : 403;
    return NextResponse.json({ ok: false, reason: result.reason }, { status, headers: noStore });
  }

  // The token exists in this response and in the worker's memory. Nowhere else.
  return NextResponse.json(
    {
      ok: true,
      token: result.token,
      supervisor_id: result.supervisorId,
      slot_id: result.slotId,
      expires_at: result.expiresAt,
    },
    { status: 200, headers: noStore }
  );
}
