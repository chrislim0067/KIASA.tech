import { guardApi, apiOk, apiError, logAdminError } from '@/lib/admin/api';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * GET /api/admin/pulse — the small, frequent poll behind the live counters.
 *
 * This is what makes the admin surface feel live rather than static. The
 * browser calls it every few seconds and only re-renders when something it
 * cares about actually changed.
 *
 * Deliberately TINY. It reads one row from `admin_platform_stats` — a single
 * indexed pass PostgreSQL already computes for the dashboard — and returns four
 * integers. It never returns a user, an email or anything else personal, so a
 * poll that runs every few seconds for hours cannot become a slow leak of the
 * user table into browser memory or logs.
 *
 * WHY POLL RATHER THAN SUPABASE REALTIME
 *
 * Realtime respects RLS, and `user_access` grants a user only their own row.
 * Pushing other people's signups to an administrator's browser would require an
 * admin-wide RLS policy on that table — the exact thing the architecture avoids,
 * because a mistake in such a predicate exposes every user through PostgREST.
 * Polling keeps every authorization decision on the server, where it already is.
 */

export const dynamic = 'force-dynamic';

export async function GET() {
  const guard = await guardApi('users.list');
  if (!guard.ok) return guard.response;

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('admin_platform_stats')
      .select(
        'users_total, users_pending_approval, applications_total, admin_actions_7d'
      )
      .maybeSingle();

    if (error) throw error;

    const n = (v: unknown) => Number(v ?? 0);

    return apiOk({
      pulse: {
        usersTotal: n(data?.users_total),
        pendingApproval: n(data?.users_pending_approval),
        applicationsTotal: n(data?.applications_total),
        adminActions7d: n(data?.admin_actions_7d),
        at: Date.now(),
      },
    });
  } catch (error) {
    logAdminError('admin.pulse', error, { actor_user_id: guard.ctx.user.id });
    return apiError('internal_error', 'Could not read platform counters.');
  }
}
