/**
 * The account-approval model.
 *
 * Confirming an email proves someone controls that mailbox. It does not mean
 * KIASA wants them on the platform. This is the gate between the two.
 *
 * The rules, and why:
 *
 *   * ABSENCE MEANS {@link DEFAULT_ACCESS} — `pending`. A brand-new signup has
 *     no `user_access` row and is therefore pending without anything having to
 *     write one at signup time. No trigger on auth.users, no bootstrap step
 *     that could fail and quietly admit someone.
 *
 *   * This is the mirror image of `lib/auth/roles.ts`, where absence means the
 *     LEAST privilege. Here absence means the LEAST access. Both fail towards
 *     "no", which is the only safe direction for either.
 *
 *   * Access and role are orthogonal. Being an administrator does not imply
 *     approval and approval does not imply a role; the two are separate tables
 *     and separate checks. In practice an administrator is always approved,
 *     because the only ways to become one — the bootstrap script or the admin
 *     UI — act on accounts that already exist and are already approved.
 */

export const ACCESS_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

/** What a user with no `user_access` row is treated as. */
export const DEFAULT_ACCESS: AccessStatus = 'pending';

export const isAccessStatus = (value: unknown): value is AccessStatus =>
  typeof value === 'string' && (ACCESS_STATUSES as readonly string[]).includes(value);

/**
 * Whether this status may use the product.
 *
 * Defined once, here, so the dashboard, the proxy-adjacent page checks and any
 * future API route all agree. Only `approved` passes — `rejected` and `pending`
 * are both "not yet", they simply differ in whether a decision was made.
 */
export function canUseProduct(status: AccessStatus): boolean {
  return status === 'approved';
}

/** Where a signed-in but unapproved user is sent. */
export const PENDING_ROUTE = '/pending';

/**
 * Human-readable copy for the waiting screen.
 *
 * A rejected person is told the decision, never the reason: the reason is an
 * internal note for the administrator, and echoing it invites argument with a
 * decision that has already been made.
 */
export function accessMessage(status: AccessStatus): { title: string; body: string } {
  switch (status) {
    case 'approved':
      return { title: 'Approved', body: 'Your account is active.' };
    case 'rejected':
      return {
        title: 'Account not approved',
        body:
          'Your request to join KIASA was not approved. If you believe this is a ' +
          'mistake, reply to the email you signed up with and a person will look at it.',
      };
    case 'pending':
    default:
      return {
        title: 'Waiting for approval',
        body:
          'Your email is confirmed and your account is waiting for a KIASA ' +
          'administrator to review it. You will receive an email once it is approved.',
      };
  }
}
