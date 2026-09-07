import 'server-only';

import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { ensureProfile } from '@/lib/profile';
import type { ProfileClient } from '@/lib/profile';
import { isAccessStatus, canUseProduct, DEFAULT_ACCESS, PENDING_ROUTE } from '@/lib/auth/access';
import { LOGIN } from '@/lib/auth/routes';

/**
 * The gate every candidate page and action goes through.
 *
 * Three things happen here, in this order, and the order matters:
 *
 *   1. `getUser()` — revalidated with Supabase, never `getSession()`.
 *   2. The approval check. A pending or rejected account is sent to /pending
 *      and never reaches profile data. Fails CLOSED: absence of a row and a
 *      failed read both resolve to `pending`.
 *   3. `ensureProfile()` — creates the `profiles` row if it is the user's first
 *      visit. Doing it here rather than in each page means no page has to cope
 *      with a null profile, and it happens exactly once per request because of
 *      the `cache()` wrapper.
 *
 * Wrapped in React `cache()`, so a page and every server action it renders
 * share one auth round trip instead of paying for one each.
 */

export interface CandidateSession {
  readonly user: User;
  readonly supabase: ProfileClient;
}

export const resolveCandidate = cache(
  async (): Promise<
    { ok: true; session: CandidateSession } | { ok: false; reason: 'unconfigured' | 'unauthenticated' | 'not_approved' }
  > => {
    if (!isSupabaseConfigured()) return { ok: false, reason: 'unconfigured' };

    const supabase = (await createClient()) as ProfileClient;
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { ok: false, reason: 'unauthenticated' };

    const { data, error } = await supabase
      .from('user_access')
      .select('status')
      .eq('user_id', user.id)
      .maybeSingle();

    const status = !error && data && isAccessStatus(data.status) ? data.status : DEFAULT_ACCESS;
    if (!canUseProduct(status)) return { ok: false, reason: 'not_approved' };

    // Idempotent: creates the row on first visit, returns the existing one after.
    await ensureProfile(supabase, user.id);

    return { ok: true, session: { user, supabase } };
  }
);

/**
 * For pages: resolves or redirects. Never returns for an ineligible caller,
 * because `redirect()` throws.
 */
export async function requireCandidate(): Promise<CandidateSession> {
  const result = await resolveCandidate();
  if (result.ok) return result.session;

  switch (result.reason) {
    case 'unauthenticated':
      redirect(`${LOGIN}?redirectTo=%2Fprofile`);
    case 'not_approved':
      redirect(PENDING_ROUTE);
    case 'unconfigured':
    default:
      redirect(LOGIN);
  }
}
