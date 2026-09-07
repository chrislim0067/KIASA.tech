import { guardApi, apiOk, apiError, isUuid, readJsonBody, logAdminError } from '@/lib/admin/api';
import { setUserRole } from '@/lib/admin/users';
import { recordAudit, checkRateLimit, RATE_LIMITS } from '@/lib/admin/audit';
import { APP_ROLES, isAppRole } from '@/lib/auth/roles';

/**
 * PUT /api/admin/users/[userId]/role — grant or revoke the administrator role.
 *
 * This is the privilege-escalation surface, so it is the one endpoint where the
 * threat is an administrator acting carelessly rather than an outsider getting
 * in. Guards: the `roles.grant` capability, a validated role value, a rate
 * limit, refusal to revoke your own role or the last administrator's, and an
 * audit record naming who granted what to whom.
 *
 * A normal user cannot reach the underlying table by any route: `authenticated`
 * holds SELECT and nothing else on user_roles (migration 14), so even a
 * PostgREST call straight to the table with a valid session cannot write it.
 */

export const dynamic = 'force-dynamic';

export async function PUT(request: Request, context: { params: Promise<{ userId: string }> }) {
  const guard = await guardApi('roles.grant');
  if (!guard.ok) return guard.response;
  const { user } = guard.ctx;

  const { userId } = await context.params;
  if (!isUuid(userId)) return apiError('invalid_input', 'That is not a valid user id.');

  const body = await readJsonBody(request);
  if (!body) return apiError('invalid_input', 'Send a JSON object with a "role" field.');

  const role = body.role;
  if (!isAppRole(role)) {
    return apiError('invalid_input', `Role must be one of: ${APP_ROLES.join(', ')}.`);
  }

  const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;

  const limit = await checkRateLimit(
    user.id,
    ['user.role_granted', 'user.role_revoked'],
    RATE_LIMITS.roleChange.limit,
    RATE_LIMITS.roleChange.windowMinutes
  );
  if (!limit.allowed) {
    return apiError(
      'rate_limited',
      `Role-change limit reached (${limit.limit} per ${limit.windowMinutes} minutes).`
    );
  }

  const action = role === 'admin' ? 'user.role_granted' : 'user.role_revoked';

  try {
    const result = await setUserRole({
      targetUserId: userId,
      actingAdminId: user.id,
      role,
      note,
    });

    if (!result.ok) {
      await recordAudit({
        action,
        actorUserId: user.id,
        actorEmail: user.email ?? null,
        targetUserId: userId,
        result: 'failed',
        failureCode: result.failure,
        detail: { requested_role: role },
      });

      const code =
        result.failure === 'not_found'
          ? 'not_found'
          : result.failure === 'cannot_target_self' || result.failure === 'last_admin'
            ? 'conflict'
            : 'upstream_error';
      return apiError(code, result.message);
    }

    await recordAudit({
      action,
      actorUserId: user.id,
      actorEmail: user.email ?? null,
      targetUserId: userId,
      result: 'succeeded',
      // The note is administrator-written free text. It is stored because the
      // reason for a privilege grant is worth keeping, and it is scrubbed by
      // recordAudit like every other detail value.
      detail: { role, note },
    });

    return apiOk({ user: { id: userId, role: result.value.role } });
  } catch (error) {
    logAdminError('users.role', error, { actor_user_id: user.id, target_user_id: userId });
    return apiError('internal_error', 'The role could not be changed.');
  }
}
