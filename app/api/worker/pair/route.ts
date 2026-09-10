import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { startPairing } from '@/lib/worker/endpoints';
import { createPairingStore } from '@/lib/worker/store';

/**
 * POST /api/worker/pair — the candidate asks for a one-time pairing code.
 *
 * AUTHENTICATED, and the identity comes from the session rather than the body.
 * There is no request body at all: nothing a caller could send would change
 * whose worker gets paired.
 *
 * The plaintext code is in this response and nowhere else, ever. It is not
 * logged, not stored, and not in the URL — which is why this is a POST that
 * returns it, rather than a GET a browser would keep in history.
 */

export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store, max-age=0, must-revalidate' };

export async function POST() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, reason: 'unconfigured' }, { status: 503, headers: noStore });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: 'unauthenticated' }, { status: 401, headers: noStore });
  }

  const result = await startPairing(createPairingStore(), user.id, new Date());
  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 500, headers: noStore });
  }

  return NextResponse.json(
    { ok: true, pairing_secret: result.secret, expires_at: result.expiresAt },
    { status: 200, headers: noStore }
  );
}
