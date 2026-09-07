import { guardApi, apiOk, apiError, isUuid, readJsonBody, logAdminError } from '@/lib/admin/api';
import { deleteUser } from '@/lib/admin/users';
import { recordAudit, checkRateLimit, RATE_LIMITS } from '@/lib/admin/audit';

/**
 * DELETE /api/admin/users/[userId] — remove a user.
 *
 * The destructive endpoint, so it carries the most guards:
 *   * `users.delete` capability, checked server-side;
 *   * the id must be a well-formed UUID before it reaches any query — this is
 *     the IDOR surface, and a caller substituting another user's id is exactly
 *     what the capability check above is for. Being an administrator is what
 *     authorises acting on someone else's id; a non-administrator cannot reach
 *     this line at all;
 *   * a confirmation token echoing the target id, so a CSRF-style cross-origin
 *     POST or a mis-wired client cannot delete by accident;
 *   * a durable rate limit;
 *   * refusal to delete yourself or the last administrator (in lib/admin/users);
 *   * an audit record either way.
 */

export const dynamic = 'force-dynamic';

export async function DELETE(request: Request, context: { params: Promise<{ userId: string }> }) {
  const guard = await guardApi('users.delete');
  if (!guard.ok) return guard.response;
  const { user } = guard.ctx;

  const { userId } = await context.params;
  if (!isUuid(userId)) {
    return apiError('invalid_input', 'That is not a valid user id.');
  }

  const body = (await readJsonBody(request)) ?? {};

  /**
   * Deletion must be deliberate.
   *
   * The client echoes the id it intends to delete. A cross-origin request
   * cannot read the page to learn the id, and a client that has drifted (a
   * stale row, a mis-bound handler) will send a mismatched one. Supabase's auth
   * cookies are SameSite=Lax, so a cross-site DELETE does not carry them in the
   * first place — this is the second layer, not the only one.
   */
  if (body.confirmUserId !== userId) {
    return apiError(
      'invalid_input',
      'Deletion must be confirmed by echoing the user id. Nothing was deleted.'
    );
  }

  // Soft unless permanent erasure is explicitly requested.
  const mode = body.mode === 'hard' ? 'hard' : 'soft';

  const limit = await checkRateLimit(
    user.id,
    ['user.deleted'],
    RATE_LIMITS.deletion.limit,
    RATE_LIMITS.deletion.windowMinutes
  );
  if (!limit.allowed) {
    await recordAudit({
      action: 'user.deleted',
      actorUserId: user.id,
      actorEmail: user.email ?? null,
      targetUserId: userId,
      result: 'failed',
      failureCode: 'rate_limited',
      detail: { used: limit.used, limit: limit.limit, window_minutes: limit.windowMinutes, mode },
    });
    return apiError(
      'rate_limited',
      `Deletion limit reached (${limit.limit} per ${limit.windowMinutes} minutes). Try again later.`
    );
  }

  try {
    const result = await deleteUser({
      targetUserId: userId,
      actingAdminId: user.id,
      mode,
    });

    if (!result.ok) {
      await recordAudit({
        action: 'user.deleted',
        actorUserId: user.id,
        actorEmail: user.email ?? null,
        targetUserId: userId,
        result: 'failed',
        failureCode: result.failure,
        detail: { mode },
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
      action: 'user.deleted',
      actorUserId: user.id,
      actorEmail: user.email ?? null,
      targetUserId: result.value.userId,
      targetEmail: result.value.email,
      result: 'succeeded',
      detail: { mode: result.value.mode },
    });

    return apiOk({
      deleted: { id: result.value.userId, mode: result.value.mode },
      message:
        result.value.mode === 'soft'
          ? 'Account deactivated. Its data is retained and the deletion can be reversed.'
          : 'Account and all of its data permanently deleted.',
    });
  } catch (error) {
    logAdminError('users.delete', error, { actor_user_id: user.id, target_user_id: userId });
    await recordAudit({
      action: 'user.deleted',
      actorUserId: user.id,
      actorEmail: user.email ?? null,
      targetUserId: userId,
      result: 'failed',
      failureCode: 'exception',
      detail: { mode },
    });
    return apiError('internal_error', 'The account could not be deleted.');
  }
}
