import { guardApi, apiOk, apiError, isUuid, readJsonBody, logAdminError } from '@/lib/admin/api';
import { setUserAccess } from '@/lib/admin/users';
import { recordAudit } from '@/lib/admin/audit';
import { sendEmail, isEmailConfigured } from '@/lib/notifications/email';
import { approvedEmail, rejectedEmail } from '@/lib/notifications/templates';

/**
 * PUT /api/admin/users/[userId]/access — approve or reject an account.
 *
 * This is the gate the signup flow waits on. Guards, in order: the
 * `users.approve` capability, a validated UUID, a validated status, then the
 * decision, then an audit record either way.
 *
 * No rate limit. Approving is the administrator's ordinary daily work and a
 * queue of new signups is exactly when they need to move quickly; unlike
 * deletion, a mistake here is fully reversible by deciding again.
 *
 * A normal user cannot reach the underlying table by any route: `authenticated`
 * holds SELECT and nothing else on `user_access` (migration 18), so even a
 * PostgREST call with a valid session cannot write it.
 */

export const dynamic = 'force-dynamic';

export async function PUT(request: Request, context: { params: Promise<{ userId: string }> }) {
  const guard = await guardApi('users.approve');
  if (!guard.ok) return guard.response;
  const { user } = guard.ctx;

  const { userId } = await context.params;
  if (!isUuid(userId)) return apiError('invalid_input', 'That is not a valid user id.');

  const body = await readJsonBody(request);
  if (!body) return apiError('invalid_input', 'Send a JSON object with a "status" field.');

  const status = body.status;
  if (status !== 'approved' && status !== 'rejected') {
    return apiError('invalid_input', 'Status must be "approved" or "rejected".');
  }

  const reason = typeof body.reason === 'string' ? body.reason : null;

  // Approving yourself is not a security hole — you already hold the
  // capability — but it is almost always a misclick on the wrong row, and an
  // administrator is exempt from the gate anyway.
  if (userId === user.id) {
    return apiError('conflict', 'You do not need to approve your own account.');
  }

  const action = status === 'approved' ? 'user.approved' : 'user.rejected';

  try {
    const result = await setUserAccess({
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

    /**
     * Tell the person.
     *
     * Awaited, but incapable of failing the request: sendEmail never throws and
     * has its own timeout. The decision is already committed at this point, so
     * a mail outage must not surface as an error that invites the administrator
     * to click Approve again.
     *
     * The outcome is recorded in the audit entry and returned to the UI, so
     * "approved but not emailed" is visible rather than assumed. Silently
     * failing here is how you end up believing people were told when they
     * were not.
     */
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin;
    let delivery: string = 'skipped_no_address';

    if (result.value.email) {
      const message =
        status === 'approved'
          ? approvedEmail({ to: result.value.email, siteUrl })
          : rejectedEmail({ to: result.value.email, siteUrl, reason });

      const outcome = await sendEmail(message);
      delivery = outcome.sent ? 'sent' : outcome.reason;
    }

    await recordAudit({
      action,
      actorUserId: user.id,
      actorEmail: user.email ?? null,
      targetUserId: result.value.userId,
      targetEmail: result.value.email,
      result: 'succeeded',
      // The reason is administrator-written free text, scrubbed by recordAudit
      // like every other detail value.
      detail: { status, reason, email: delivery },
    });

    const decided = status === 'approved' ? 'Account approved.' : 'Account rejected.';
    const emailNote =
      delivery === 'sent'
        ? ' They have been emailed.'
        : delivery === 'not_configured'
          ? ' No email was sent — email is not configured on this deployment.'
          : delivery === 'skipped_no_address'
            ? ''
            : ' The notification email could not be delivered.';

    return apiOk({
      user: { id: result.value.userId, access_status: result.value.status },
      emailDelivery: delivery,
      emailConfigured: isEmailConfigured(),
      message: decided + emailNote,
    });
  } catch (error) {
    logAdminError('users.access', error, { actor_user_id: user.id, target_user_id: userId });
    return apiError('internal_error', 'The decision could not be saved.');
  }
}
