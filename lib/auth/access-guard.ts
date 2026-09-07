import 'server-only';

import type { User } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { DEFAULT_ACCESS, isAccessStatus, canUseProduct, type AccessStatus } from '@/lib/auth/access';

/**
 * The approval gate.
 *
 * Read with the CALLER'S OWN session through the `user_access_select_own`
 * policy — no elevated credential, and a user can only ever see their own row.
 * The same shape `getCallerRole()` uses for roles.
 *
 * TWO DECISIONS WORTH KNOWING ABOUT
 *
 * 1. It fails CLOSED. Absence of a row means `pending`, and so does a failed
 *    read. A transient database problem therefore shows a legitimate user the
 *    waiting screen rather than letting an unapproved one through — annoying,
 *    self-healing, and the right direction for a gate to fail in.
 *
 * 2. `/admin` is NOT gated on approval. Administrators are checked on their
 *    role alone, which is a stronger claim than approval. Gating both would
 *    create a deadlock the moment an administrator's access row was wrong or
 *    missing: the only person who could approve them would be locked out of
 *    the page where approving happens. Role is the boundary for staff; approval
 *    is the boundary for customers.
 */
export async function getCallerAccess(): Promise<{ user: User | null; status: AccessStatus }> {
  if (!isSupabaseConfigured()) return { user: null, status: DEFAULT_ACCESS };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { user: null, status: DEFAULT_ACCESS };

  const { data, error } = await supabase
    .from('user_access')
    .select('status')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error || !data || !isAccessStatus(data.status)) {
    return { user, status: DEFAULT_ACCESS };
  }

  return { user, status: data.status };
}

/** Convenience for the product routes. */
export async function callerMayUseProduct(): Promise<boolean> {
  const { user, status } = await getCallerAccess();
  return Boolean(user) && canUseProduct(status);
}
