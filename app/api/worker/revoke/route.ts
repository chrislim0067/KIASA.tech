import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/env';

/**
 * POST /api/worker/revoke — the candidate turns their worker off.
 *
 * Runs under the candidate's OWN session and their own UPDATE policy, so the
 * `.eq('user_id', …)` below is belt to RLS's braces rather than the only
 * control. Migration 24 grants `authenticated` UPDATE on the revocation
 * columns ONLY, so this is the entire write a browser can make to that table.
 *
 * Revocation is an update, not a delete: a credential that was used should
 * leave a record that it existed. The immutability trigger makes it final —
 * a revoked credential cannot be restored, only replaced by pairing again.
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

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('worker_credentials')
    .update({ revoked_at: now, revoked_reason: 'candidate_requested' })
    .eq('user_id', user.id)
    .is('revoked_at', null)
    .select('id');

  if (error) {
    return NextResponse.json({ ok: false, reason: 'update_failed' }, { status: 500, headers: noStore });
  }

  // Any outstanding invitation goes too: revoking the worker should not leave
  // a live code someone could still redeem.
  await supabase
    .from('worker_pairings')
    .update({ revoked_at: now })
    .eq('user_id', user.id)
    .is('redeemed_at', null)
    .is('revoked_at', null);

  return NextResponse.json(
    { ok: true, revoked: Array.isArray(data) ? data.length : 0 },
    { status: 200, headers: noStore }
  );
}
