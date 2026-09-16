import { guardApi, apiOk, apiError, isUuid, readJsonBody, logAdminError } from '@/lib/admin/api';
import { setJobBoardAccess } from '@/lib/admin/users';
import { recordAudit } from '@/lib/admin/audit';

/**
 * PUT /api/admin/users/[userId]/job-board — grant or revoke the job board.
 *
 * THE SECOND GATE. `/api/admin/users/[userId]/access` decides whether somebody
 * may use KIASA; this decides whether they may read the shared board. They are
 * deliberately separate endpoints writing separate tables, so approving a
 * signup can never hand over the board as a side effect, and revoking the board
 * never locks anyone out of the product.
 *
 * Guards, in order: the `jobboard.grant` capability, a validated UUID, a
 * validated status, then the decision, then an audit record either way.
 *
 * No email. Approval and rejection tell the person because they are waiting on
 * that answer; nobody is waiting on this one, and a mail saying "you can now see
 * a page you did not know existed" is noise. The audit log records it.
 *
 * A candidate cannot reach the table by any other route: `authenticated` holds
 * SELECT and nothing else on `job_board_access` (migration 32), so a PostgREST
 * call with a valid session cannot write it.
 */

export const dynamic = 'force-dynamic';

export async function PUT(request: Request, context: { params: Promise<{ userId: string }> }) {
  const guard = await guardApi('jobboard.grant');
  if (!guard.ok) return guard.response;
  const { user } = guard.ctx;

  const { userId } = await context.params;
  if (!isUuid(userId)) return apiError('invalid_input', 'That is not a valid user id.');

  const body = await readJsonBody(request);
  if (!body) return apiError('invalid_input', 'Send a JSON object with a "status" field.');

  const status = body.status;
  if (status !== 'granted' && status !== 'revoked') {
    return apiError('invalid_input', 'Status must be "granted" or "revoked".');
  }

  const reason = typeof body.reason === 'string' ? body.reason : null;

  /*
   * Granting yourself is refused, as it is for account approval — and for the
   * same reason. It is not an escalation, because an administrator already sees
   * strictly more at /admin/jobs and passes this gate without a grant. It is
   * almost always a click on the wrong row.
   */
  if (userId === user.id) {
    return apiError('conflict', 'You already see the job board as an administrator.');
  }

  const action = status === 'granted' ? 'user.job_board_granted' : 'user.job_board_revoked';

  try {
    const result = await setJobBoardAccess({
      targetUserId: userId,
      actingAdminId: user.id,
      status,
      reason,
    });

    if (!result.ok) {
      await recordAudit({
        action,
        actorUserId: user.id,
        actorEmail: user.email ?? null,
        targetUserId: userId,
        result: 'failed',
        failureCode: result.failure,
        detail: {},
      });
      return apiError(result.failure === 'not_found' ? 'not_found' : 'upstream_error', result.message);
    }

    await recordAudit({
      action,
      actorUserId: user.id,
      actorEmail: user.email ?? null,
      targetUserId: result.value.userId,
      targetEmail: result.value.email,
      result: 'succeeded',
      // Administrator-written free text, scrubbed by recordAudit like every
      // other detail value.
      detail: { status, reason },
    });

    return apiOk({
      user: { id: result.value.userId, job_board_status: result.value.status },
      message:
        status === 'granted'
          ? 'They can now see the job board.'
          : 'Their access to the job board has been revoked.',
    });
  } catch (error) {
    logAdminError('users.job_board', error, {
      actor_user_id: user.id,
      target_user_id: userId,
    });
    return apiError('internal_error', 'The decision could not be saved.');
  }
}
