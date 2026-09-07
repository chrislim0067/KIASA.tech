import 'server-only';

import type { User } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { DEFAULT_ROLE, isAppRole, isAdminRole, can, type AppRole, type Capability } from '@/lib/auth/roles';

/**
 * THE authorization boundary for everything administrative.
 *
 * Every admin page and every admin route handler calls this first. Nothing else
 * is a boundary: not the proxy (which the Next docs are explicit is optimistic
 * only), not a hidden navigation link, not a 404 on an unknown route. Those are
 * UX. This is the check.
 *
 * How it works, and why it is shaped this way:
 *
 *   * `getUser()` revalidates the token with Supabase rather than trusting the
 *     cookie, matching what the dashboard page already does. `getSession()`
 *     would accept a forged cookie.
 *
 *   * The role is then read with THE CALLER'S OWN session, through the
 *     `user_roles_select_own` policy. This needs no elevated credential, so the
 *     authorization check itself never touches the service key — the key is
 *     only reached after the check has already passed. It also cannot recurse:
 *     there is no SECURITY DEFINER helper in the loop.
 *
 *   * Any failure resolves to {@link DEFAULT_ROLE}. A database hiccup makes a
 *     user less privileged, never more.
 */

export type AdminContext = {
  readonly user: User;
  readonly role: AppRole;
};

/** Why authorization did not succeed. Distinguished so callers can respond correctly. */
export type AuthzFailure =
  | { readonly ok: false; readonly reason: 'unconfigured' }
  | { readonly ok: false; readonly reason: 'unauthenticated' }
  | { readonly ok: false; readonly reason: 'forbidden'; readonly user: User; readonly role: AppRole };

export type AuthzResult = ({ readonly ok: true } & AdminContext) | AuthzFailure;

/**
 * Read the caller's role using their own session.
 *
 * Exported because the site header needs it to decide whether to render the
 * Admin link. That is presentation only — it grants nothing.
 */
export async function getCallerRole(): Promise<{ user: User | null; role: AppRole }> {
  if (!isSupabaseConfigured()) return { user: null, role: DEFAULT_ROLE };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { user: null, role: DEFAULT_ROLE };

  const { data, error } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();

  // No row is the ordinary case: absence means 'user'. An error is also
  // resolved to the default rather than thrown — failing closed on the *role*
  // is what keeps a transient database problem from escalating anyone.
  if (error || !data || !isAppRole(data.role)) {
    return { user, role: DEFAULT_ROLE };
  }

  return { user, role: data.role };
}

/**
 * Resolve the caller's administrative context without throwing.
 *
 * Pages use this so they can redirect; route handlers use {@link requireAdminApi}
 * so they can answer with a status code.
 */
export async function resolveAdmin(capability: Capability = 'admin.access'): Promise<AuthzResult> {
  if (!isSupabaseConfigured()) return { ok: false, reason: 'unconfigured' };

  const { user, role } = await getCallerRole();
  if (!user) return { ok: false, reason: 'unauthenticated' };

  if (!isAdminRole(role) || !can(role, capability)) {
    return { ok: false, reason: 'forbidden', user, role };
  }

  return { ok: true, user, role };
}

/**
 * Assert the caller holds `capability`, throwing {@link AdminAuthorizationError}
 * otherwise. For call sites where a failure is genuinely exceptional.
 */
export class AdminAuthorizationError extends Error {
  readonly reason: AuthzFailure['reason'];
  constructor(reason: AuthzFailure['reason']) {
    super(`Administrative authorization failed: ${reason}`);
    this.name = 'AdminAuthorizationError';
    this.reason = reason;
  }
}

export async function requireAdmin(capability: Capability = 'admin.access'): Promise<AdminContext> {
  const result = await resolveAdmin(capability);
  if (!result.ok) throw new AdminAuthorizationError(result.reason);
  return { user: result.user, role: result.role };
}
