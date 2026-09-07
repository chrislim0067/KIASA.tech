import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { logAdminError } from '@/lib/admin/api';

/**
 * Write side of the administrator surface: invitation, deletion, role changes.
 *
 * Every function returns a discriminated result rather than throwing, following
 * the contract `lib/profile/errors.ts` established for the candidate data
 * layer: expected failures are values a caller branches on, not exceptions it
 * has to parse.
 *
 * None of these check authorization. The route handler does that, once, before
 * calling in.
 */

export type AdminOpFailure =
  | 'already_exists'
  | 'already_invited'
  | 'invalid_email'
  | 'not_found'
  | 'rate_limited'
  | 'cannot_target_self'
  | 'last_admin'
  | 'upstream_error';

export type AdminOpResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: AdminOpFailure; readonly message: string };

const fail = (failure: AdminOpFailure, message: string): AdminOpResult<never> => ({
  ok: false,
  failure,
  message,
});

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------
export interface ExistingAccount {
  readonly user_id: string;
  readonly email: string | null;
  readonly account_status: string;
  readonly role: string;
}

/**
 * Find an account by email.
 *
 * Reads the directory view rather than paging `auth.admin.listUsers()`. Paging
 * the admin API to find one address is O(accounts) per lookup and becomes a
 * timeout as the platform grows; this is an indexed lookup.
 */
export async function findAccountByEmail(email: string): Promise<ExistingAccount | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('admin_user_directory')
    .select('user_id, email, account_status, role')
    .ilike('email', email)
    .limit(1)
    .maybeSingle();

  if (error) {
    logAdminError('users.find_by_email', error);
    throw error;
  }
  if (!data) return null;

  return {
    user_id: String(data.user_id),
    email: data.email ?? null,
    account_status: String(data.account_status),
    role: String(data.role),
  };
}

export async function findAccountById(userId: string): Promise<ExistingAccount | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('admin_user_directory')
    .select('user_id, email, account_status, role')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logAdminError('users.find_by_id', error);
    throw error;
  }
  if (!data) return null;

  return {
    user_id: String(data.user_id),
    email: data.email ?? null,
    account_status: String(data.account_status),
    role: String(data.role),
  };
}

// ---------------------------------------------------------------------------
// Invitation
// ---------------------------------------------------------------------------
export interface InviteResult {
  readonly userId: string;
  readonly email: string;
  readonly resent: boolean;
}

/**
 * Invite someone by email.
 *
 * Uses Supabase's own `inviteUserByEmail`, which creates the account in an
 * unconfirmed state and sends the invitation through the project's configured
 * mail provider and templates. KIASA does not mint its own tokens or send its
 * own mail: doing so would mean a second, unreviewed credential path into the
 * same accounts.
 *
 * `redirectTo` is a server-controlled absolute URL built from the deployment's
 * own site URL — never a value from the request. Accepting a caller-supplied
 * redirect on an invitation link is how an invite becomes a phishing vector.
 */
export async function inviteUser(params: {
  readonly email: string;
  readonly redirectTo: string;
  readonly invitedByEmail: string | null;
}): Promise<AdminOpResult<InviteResult>> {
  const email = params.email.trim().toLowerCase();
  const admin = createAdminClient();

  // Check first, so the common duplicate cases produce a precise message
  // instead of a generic upstream error.
  let existing: ExistingAccount | null = null;
  try {
    existing = await findAccountByEmail(email);
  } catch {
    return fail('upstream_error', 'Could not check whether that account already exists.');
  }

  if (existing) {
    if (existing.account_status === 'active') {
      return fail('already_exists', 'That email address already has an active KIASA account.');
    }
    if (existing.account_status === 'deleted') {
      return fail(
        'already_exists',
        'That email address belongs to a deleted account. Restore it rather than re-inviting.'
      );
    }
    // Invited or awaiting confirmation: re-sending is the useful behaviour, and
    // it is what an administrator means by inviting someone twice.
    const { error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: params.redirectTo,
    });
    if (error) {
      logAdminError('users.invite_resend', error, { email_domain: email.split('@')[1] ?? null });
      // Supabase rate-limits invitation mail per address.
      if (/rate|too many/i.test(error.message)) {
        return fail('rate_limited', 'Supabase is rate-limiting invitations to that address. Try again shortly.');
      }
      return fail('upstream_error', 'The invitation could not be re-sent.');
    }
    return { ok: true, value: { userId: existing.user_id, email, resent: true } };
  }

  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: params.redirectTo,
    data: params.invitedByEmail ? { invited_by: params.invitedByEmail } : undefined,
  });

  if (error) {
    // The email domain, never the address, so a log aggregator cannot become a
    // list of who was invited.
    logAdminError('users.invite', error, { email_domain: email.split('@')[1] ?? null });

    if (/already registered|already been registered|duplicate/i.test(error.message)) {
      return fail('already_exists', 'That email address already has a KIASA account.');
    }
    if (/rate|too many/i.test(error.message)) {
      return fail('rate_limited', 'Supabase is rate-limiting invitations. Try again shortly.');
    }
    if (/invalid|malformed/i.test(error.message)) {
      return fail('invalid_email', 'Supabase rejected that email address.');
    }
    return fail('upstream_error', 'The invitation could not be sent.');
  }

  const userId = data?.user?.id;
  if (!userId) {
    return fail('upstream_error', 'Supabase accepted the invitation but returned no account.');
  }

  return { ok: true, value: { userId, email, resent: false } };
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------
/**
 * What deletion does to a user's data. Exported so the confirmation dialog can
 * show the administrator exactly this, rather than a vague warning.
 *
 * SOFT (default): `auth.users.deleted_at` is set. Every owned row is left
 *   intact, the account cannot sign in, and the decision is reversible.
 *
 * HARD: the `auth.users` row is removed. Every table that references it
 *   declares ON DELETE CASCADE — those constraints predate this work and are
 *   asserted by migration 12's and 15's own verification blocks — so the
 *   following are permanently destroyed:
 *
 *     profiles, job_preferences, automation_settings, work_authorizations,
 *     work_experiences, education_entries, skills, certifications, projects,
 *     languages, verified_answers,
 *     jobs, job_snapshots, job_facts, job_events,
 *     applications, application_attempts,
 *     user_roles
 *
 *   `admin_audit_log` is the deliberate exception: its two references to
 *   auth.users are ON DELETE SET NULL and it snapshots the email at write time,
 *   so the record that an account existed and was deleted SURVIVES the
 *   deletion. An audit log that a deletion erases is not an audit log.
 */
export const DELETION_CASCADE_TABLES = Object.freeze([
  'profiles',
  'job_preferences',
  'automation_settings',
  'work_authorizations',
  'work_experiences',
  'education_entries',
  'skills',
  'certifications',
  'projects',
  'languages',
  'verified_answers',
  'jobs',
  'job_snapshots',
  'job_facts',
  'job_events',
  'applications',
  'application_attempts',
  'user_roles',
]);

export interface DeleteResult {
  readonly userId: string;
  readonly email: string | null;
  readonly mode: 'soft' | 'hard';
}

/**
 * Delete a user.
 *
 * Soft by default. The requirement is that an administrator can remove a user
 * while protecting platform integrity, and a reversible removal satisfies both;
 * an irreversible one satisfies only the first. Permanent deletion stays
 * available for a genuine erasure request, and says plainly what it destroys.
 *
 * Two refusals are enforced here rather than in the UI, because a UI-only rule
 * is not a rule:
 *   * an administrator may not delete their own account — that is almost always
 *     a misclick, and it can strand the platform with no administrator;
 *   * the last remaining administrator may not be deleted, for the same reason.
 */
export async function deleteUser(params: {
  readonly targetUserId: string;
  readonly actingAdminId: string;
  readonly mode: 'soft' | 'hard';
}): Promise<AdminOpResult<DeleteResult>> {
  const { targetUserId, actingAdminId, mode } = params;

  if (targetUserId === actingAdminId) {
    return fail('cannot_target_self', 'You cannot delete your own administrator account.');
  }

  const admin = createAdminClient();

  let target: ExistingAccount | null;
  try {
    target = await findAccountById(targetUserId);
  } catch {
    return fail('upstream_error', 'Could not load that account.');
  }
  if (!target) return fail('not_found', 'That account no longer exists.');

  if (target.role === 'admin') {
    const { count, error: countError } = await admin
      .from('user_roles')
      .select('user_id', { count: 'exact', head: true })
      .eq('role', 'admin');

    if (countError) {
      logAdminError('users.delete_admin_count', countError);
      return fail('upstream_error', 'Could not verify how many administrators remain.');
    }
    if ((count ?? 0) <= 1) {
      return fail(
        'last_admin',
        'That is the only administrator account. Grant the role to someone else first.'
      );
    }
  }

  // `shouldSoftDelete` is the second argument. Supabase revokes the account's
  // ability to authenticate in both modes; see docs/ADMIN.md for the measured
  // session-termination behaviour of each.
  const { error } = await admin.auth.admin.deleteUser(targetUserId, mode === 'soft');

  if (error) {
    logAdminError('users.delete', error, { target_user_id: targetUserId, mode });
    if (/not found/i.test(error.message)) {
      return fail('not_found', 'That account no longer exists.');
    }
    return fail('upstream_error', 'The account could not be deleted.');
  }

  return { ok: true, value: { userId: targetUserId, email: target.email, mode } };
}

// ---------------------------------------------------------------------------
// Role changes
// ---------------------------------------------------------------------------
/**
 * Grant or revoke the administrator role.
 *
 * Writes `user_roles` with the service key — the only path that can, since
 * `authenticated` holds no write privilege on that table at all. Revoking is a
 * DELETE rather than an UPDATE to 'user', because absence already means 'user'
 * and storing the default would create two representations of one state.
 */
export async function setUserRole(params: {
  readonly targetUserId: string;
  readonly actingAdminId: string;
  readonly role: 'user' | 'admin';
  readonly note?: string | null;
}): Promise<AdminOpResult<{ userId: string; role: string }>> {
  const { targetUserId, actingAdminId, role } = params;
  const admin = createAdminClient();

  if (targetUserId === actingAdminId && role === 'user') {
    return fail('cannot_target_self', 'You cannot revoke your own administrator role.');
  }

  let target: ExistingAccount | null;
  try {
    target = await findAccountById(targetUserId);
  } catch {
    return fail('upstream_error', 'Could not load that account.');
  }
  if (!target) return fail('not_found', 'That account no longer exists.');

  if (role === 'user') {
    // Refuse to remove the last administrator, same reasoning as deletion.
    const { count, error: countError } = await admin
      .from('user_roles')
      .select('user_id', { count: 'exact', head: true })
      .eq('role', 'admin');
    if (countError) {
      logAdminError('users.role_admin_count', countError);
      return fail('upstream_error', 'Could not verify how many administrators remain.');
    }
    if ((count ?? 0) <= 1 && target.role === 'admin') {
      return fail('last_admin', 'That is the only administrator account.');
    }

    const { error } = await admin.from('user_roles').delete().eq('user_id', targetUserId);
    if (error) {
      logAdminError('users.role_revoke', error, { target_user_id: targetUserId });
      return fail('upstream_error', 'The role could not be revoked.');
    }
    return { ok: true, value: { userId: targetUserId, role: 'user' } };
  }

  const { error } = await admin.from('user_roles').upsert(
    {
      user_id: targetUserId,
      role,
      granted_by: actingAdminId,
      note: params.note ?? null,
    },
    { onConflict: 'user_id' }
  );

  if (error) {
    logAdminError('users.role_grant', error, { target_user_id: targetUserId });
    return fail('upstream_error', 'The role could not be granted.');
  }

  return { ok: true, value: { userId: targetUserId, role } };
}
