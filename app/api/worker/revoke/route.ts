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

  /*
   * ONE CALL, AND NO ARGUMENTS.
   *
   * This used to be three table writes from here — credential, invitation,
   * and nothing at all for the supervisor, which stayed marked running after
   * its candidate had disowned it. `worker_revoke_supervisor` does all three
   * in one transaction and records `supervisor_revoked` for each supervisor
   * that ACTUALLY transitioned, so a replayed revoke writes no event.
   *
   * It takes no parameters: the candidate is `auth.uid()`, read inside the
   * function from the session this client already carries. There is nothing
   * for a caller to choose, and therefore nothing to forge — which is why it
   * is the one definer function a browser is allowed to execute.
   */
  const { data, error } = await supabase.rpc('worker_revoke_supervisor');

  if (error) {
    // The reason is never echoed: a database message can quote a statement.
    return NextResponse.json({ ok: false, reason: 'update_failed' }, { status: 500, headers: noStore });
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (!row?.ok) {
    return NextResponse.json({ ok: false, reason: 'update_failed' }, { status: 500, headers: noStore });
  }

  return NextResponse.json(
    { ok: true, revoked: row.revoked_count ?? 0 },
    { status: 200, headers: noStore }
  );
}
