import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { readWorkerStatus } from '@/lib/worker/status';

/**
 * GET /api/worker/status — "is my worker running?"
 *
 * The candidate's OWN session, so the read goes through their own RLS
 * policies: they can only ever learn about their own worker. No elevated
 * client is involved, which is why this route needs no ownership check of its
 * own — RLS is the check.
 *
 * The reading and the outbound validation both live in `lib/worker/status.ts`,
 * because the drafting page needs the same answer and should not fetch its own
 * API over HTTP to get it. This handler is the HTTP shape and nothing else.
 */

export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store, max-age=0, must-revalidate' };

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, reason: 'unconfigured' }, { status: 503, headers: noStore });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: 'unauthenticated' }, { status: 401, headers: noStore });
  }

  const worker = await readWorkerStatus(supabase);
  if (worker === null) {
    /*
     * The outbound schema refused the view. That is a bug to fix, not a shape
     * to publish, so nothing about it leaves the server.
     */
    return NextResponse.json({ ok: false, reason: 'invalid_view' }, { status: 500, headers: noStore });
  }

  return NextResponse.json({ ok: true, worker }, { status: 200, headers: noStore });
}
