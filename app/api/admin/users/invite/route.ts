import { guardApi, apiOk, apiError, isEmail, readJsonBody, logAdminError } from '@/lib/admin/api';
import { inviteUser } from '@/lib/admin/users';
import { recordAudit, checkRateLimit, RATE_LIMITS } from '@/lib/admin/audit';

/**
 * POST /api/admin/users/invite — invite a new person to KIASA.
 *
 * Order of operations matters and is deliberate:
 *   1. authorize
 *   2. validate input
 *   3. rate-limit
 *   4. perform
 *   5. audit — ALWAYS, success or failure
 *
 * The audit write is last and unconditional. An invitation that failed is as
 * interesting as one that worked, and rate limiting counts audit rows, so an
 * unaudited failure would also be an unlimited one.
 */

export const dynamic = 'force-dynamic';

/**
 * Where the invitation link lands.
 *
 * Server-controlled. Preferring the configured site URL over the request's own
 * origin matters: `Host` is attacker-influenceable in general, and an
 * invitation email carrying an attacker-chosen link is a phishing message sent
 * from KIASA's own domain with KIASA's own branding. The request origin is only
 * used as a development fallback when no site URL is configured.
 */
function inviteRedirectTarget(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  const base = configured ?? new URL(request.url).origin;
  return new URL('/reset-password', base).toString();
}

export async function POST(request: Request) {
  const guard = await guardApi('users.invite');
  if (!guard.ok) return guard.response;
  const { user } = guard.ctx;

  const body = await readJsonBody(request);
  if (!body) return apiError('invalid_input', 'Send a JSON object with an "email" field.');

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!isEmail(email)) {
    return apiError('invalid_input', 'Enter a valid email address.');
  }

  const limit = await checkRateLimit(
    user.id,
    ['user.invited', 'user.invite_resent'],
    RATE_LIMITS.invite.limit,
    RATE_LIMITS.invite.windowMinutes
  );
  if (!limit.allowed) {
    await recordAudit({
      action: 'user.invited',
      actorUserId: user.id,
      actorEmail: user.email ?? null,
      targetEmail: email,
      result: 'failed',
      failureCode: 'rate_limited',
      detail: { used: limit.used, limit: limit.limit, window_minutes: limit.windowMinutes },
    });
    return apiError(
      'rate_limited',
      `Invitation limit reached (${limit.limit} per ${limit.windowMinutes} minutes). Try again later.`
    );
  }

  try {
    const result = await inviteUser({
      email,
      redirectTo: inviteRedirectTarget(request),
      invitedByEmail: user.email ?? null,
    });

    if (!result.ok) {
      await recordAudit({
        action: 'user.invited',
        actorUserId: user.id,
        actorEmail: user.email ?? null,
        targetEmail: email,
        result: 'failed',
        failureCode: result.failure,
        detail: {},
      });

      const code =
        result.failure === 'already_exists'
          ? 'conflict'
          : result.failure === 'invalid_email'
            ? 'invalid_input'
            : result.failure === 'rate_limited'
              ? 'rate_limited'
              : 'upstream_error';

      return apiError(code, result.message);
    }

    await recordAudit({
      action: result.value.resent ? 'user.invite_resent' : 'user.invited',
      actorUserId: user.id,
      actorEmail: user.email ?? null,
      targetUserId: result.value.userId,
      targetEmail: result.value.email,
      result: 'succeeded',
      detail: { resent: result.value.resent },
    });

    return apiOk(
      {
        user: { id: result.value.userId, email: result.value.email },
        resent: result.value.resent,
        message: result.value.resent
          ? 'That account was already pending, so the invitation was sent again.'
          : 'Invitation sent.',
      },
      201
    );
  } catch (error) {
    logAdminError('users.invite', error, { actor_user_id: user.id });
    await recordAudit({
      action: 'user.invited',
      actorUserId: user.id,
      actorEmail: user.email ?? null,
      targetEmail: email,
      result: 'failed',
      failureCode: 'exception',
      detail: {},
    });
    return apiError('internal_error', 'The invitation could not be sent.');
  }
}
