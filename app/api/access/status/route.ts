import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { isAccessStatus, DEFAULT_ACCESS } from '@/lib/auth/access';

/**
 * GET /api/access/status — "where does MY account stand?"
 *
 * Deliberately NOT under /api/admin. This is the candidate's own view of their
 * own row, and it uses their own session: the read goes through the
 * `user_access_select_own` policy, so a caller can only ever learn about
 * themselves. No elevated credential is involved at any point, which is why
 * this route needs no capability check — RLS *is* the check.
 *
 * It returns the rejection reason. That is a deliberate reversal of the
 * original design, which showed only the decision. Two things changed the
 * decision: the owner wants the applicant told why, and — more importantly —
 * the reason was ALREADY readable by that user through PostgREST, because the
 * select-own policy covers every column of their row. Hiding it in the UI was
 * therefore never a control, only an appearance of one. Showing it is the
 * honest option, and the admin UI now says plainly that the text will be seen.
 *
 * Never cached: a candidate refreshing after an approval must not be served a
 * stale "pending" from an intermediary.
 */

export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store, max-age=0, must-revalidate' };

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { ok: false, code: 'unconfigured' },
      { status: 503, headers: noStore }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { ok: false, code: 'unauthenticated' },
      { status: 401, headers: noStore }
    );
  }

  const { data, error } = await supabase
    .from('user_access')
    .select('status, reason, decided_at')
    .eq('user_id', user.id)
    .maybeSingle();

  // Absence of a row means pending, and so does a failed read — the same
  // fail-closed rule the page-level gate uses. A hiccup must never report
  // "approved" to someone who is not.
  const status = !error && data && isAccessStatus(data.status) ? data.status : DEFAULT_ACCESS;

  return NextResponse.json(
    {
      ok: true,
      status,
      // Only a rejection carries one, enforced by a CHECK constraint.
      reason: status === 'rejected' ? (data?.reason ?? null) : null,
      decidedAt: data?.decided_at ?? null,
    },
    { headers: noStore }
  );
}
