import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import AuthShell from '@/components/auth/AuthShell';
import ConfigNotice from '@/components/auth/ConfigNotice';
import SignOutForm from '@/components/auth/SignOutForm';
import { createClient } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { LOGIN } from '@/lib/auth/routes';
import { isAppRole, isAdminRole, DEFAULT_ROLE, ADMIN_ROOT } from '@/lib/auth/roles';
import {
  isAccessStatus,
  canUseProduct,
  DEFAULT_ACCESS,
  PENDING_ROUTE,
} from '@/lib/auth/access';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Dashboard | KIASA',
  robots: { index: false, follow: false },
};

/**
 * Temporary authenticated landing page.
 *
 * The proxy already bounces signed-out visitors, but that is an optimistic
 * check — proxy runs before the request reaches this route and the Next docs are
 * explicit that it is not an authorization boundary. This `getUser()` call is
 * the authoritative one: it revalidates the token with Supabase rather than
 * trusting the cookie, so the page cannot render for a forged or stale session.
 */
export default async function DashboardPage() {
  if (!isSupabaseConfigured()) {
    return (
      <AuthShell title="Dashboard" variant="dashboard">
        <ConfigNotice />
      </AuthShell>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect(LOGIN);

  /**
   * THE APPROVAL GATE.
   *
   * Confirming an email only proves control of a mailbox. Until an
   * administrator approves the account it reaches nothing, and is sent to the
   * waiting screen instead.
   *
   * Read with the caller's own session through `user_access_select_own`, and it
   * fails CLOSED: absence of a row and a failed read both mean `pending`.
   *
   * Administrators are exempt. Their role is a stronger claim than approval,
   * and gating both would deadlock the moment an administrator's access row was
   * missing — the only person who could approve them would be locked out of the
   * page where approving happens.
   */
  /**
   * Access and role, in ONE round trip rather than two.
   *
   * These were sequential awaits: the access read finished, then the role read
   * started, so the page paid two full Supabase round trips back to back before
   * it could render anything. They are independent questions about the same
   * user, so they go together.
   *
   * The role read is presentation only — it decides whether to offer the
   * administrator link. It grants nothing: /admin and every /api/admin route
   * re-check authorization server-side, so removing the link would not lock an
   * administrator out and forging it would not let anyone in.
   */
  const [accessResult, roleResult] = await Promise.all([
    supabase.from('user_access').select('status').eq('user_id', user.id).maybeSingle(),
    supabase.from('user_roles').select('role').eq('user_id', user.id).maybeSingle(),
  ]);

  const accessStatus = isAccessStatus(accessResult.data?.status)
    ? accessResult.data.status
    : DEFAULT_ACCESS;

  const role = isAppRole(roleResult.data?.role) ? roleResult.data.role : DEFAULT_ROLE;
  const showAdminLink = isAdminRole(role);

  const fullName =
    typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : null;

  // The gate, applied after the role is known so administrators are exempt.
  if (!showAdminLink && !canUseProduct(accessStatus)) redirect(PENDING_ROUTE);

  /**
   * How far through the profile they are.
   *
   * Read here so the dashboard can say something useful instead of only
   * offering a link — "3 of 4" is a reason to click; "Profile" on its own is
   * not. The four counted here are exactly the facts
   * `buildCompletenessReport()` treats as blocking, kept as four cheap counts
   * rather than assembling the whole candidate snapshot for a progress number.
   */
  const [profileRow, authCount, expCount, prefsRow] = await Promise.all([
    supabase
      .from('profiles')
      .select('legal_first_name, legal_last_name, contact_email')
      .eq('user_id', user.id)
      .maybeSingle(),
    supabase
      .from('work_authorizations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id),
    supabase
      .from('work_experiences')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id),
    supabase.from('job_preferences').select('user_id').eq('user_id', user.id).maybeSingle(),
  ]);

  const p = profileRow.data;
  const identityDone = Boolean(
    p?.legal_first_name?.trim() && p?.legal_last_name?.trim() && p?.contact_email?.trim()
  );

  const profileDone =
    Number(identityDone) +
    Number((authCount.count ?? 0) > 0) +
    Number((expCount.count ?? 0) > 0) +
    Number(prefsRow.data !== null);
  const profileTotal = 4;
  const profileReady = profileDone === profileTotal;

  return (
    <AuthShell title="Welcome to KIASA" variant="dashboard">
      <p className="kauth__subtitle">
        {profileReady
          ? 'Your profile is complete. Job discovery and applications are being built next.'
          : 'Start by completing your profile — KIASA needs it before it can apply for anything on your behalf.'}
      </p>

      {/*
        The profile card. This page previously offered no route into /profile at
        all, so the screens existed and nobody could reach them.
      */}
      <Link
        href="/profile"
        className="kauth__row"
        style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}
      >
        <span className="kauth__rowLabel">Your profile</span>
        <span className="kauth__email">
          {profileReady ? 'Complete ✓' : `${profileDone} of ${profileTotal} steps done →`}
        </span>
      </Link>

      {fullName ? (
        <div className="kauth__row">
          <span className="kauth__rowLabel">Name</span>
          <span className="kauth__email">{fullName}</span>
        </div>
      ) : null}

      <div className="kauth__row">
        <span className="kauth__rowLabel">Signed in as</span>
        <span className="kauth__email">{user.email}</span>
      </div>

      {showAdminLink ? (
        <div className="kauth__row">
          <span className="kauth__rowLabel">Role</span>
          <span className="kauth__email">Administrator</span>
        </div>
      ) : null}

      <div className="kauth__actions">
        {/*
          The primary action, and it changes with state: an incomplete profile
          is the one thing a candidate should be doing, so it leads. Once
          complete it steps back to a secondary style rather than disappearing —
          people need to edit a profile, not only fill one in.
        */}
        <Link
          className={`kauth__button${profileReady ? ' kauth__button--ghost' : ''}`}
          href="/profile"
        >
          {profileReady ? 'View profile' : 'Complete your profile'}
        </Link>

        {showAdminLink ? (
          <Link className="kauth__button kauth__button--ghost" href={ADMIN_ROOT}>
            Open admin
          </Link>
        ) : null}

        {/* Posts to /auth/signout, which clears the session and answers 303 so
            the browser performs a real document load of the homepage. */}
        <SignOutForm />
      </div>
    </AuthShell>
  );
}
