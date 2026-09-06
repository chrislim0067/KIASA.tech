import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import AuthShell from '@/components/auth/AuthShell';
import ConfigNotice from '@/components/auth/ConfigNotice';
import LogoutButton from '@/components/auth/LogoutButton';
import { signOut } from '@/app/auth/actions';
import { createClient } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { LOGIN } from '@/lib/auth/routes';

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

  const fullName =
    typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : null;

  return (
    <AuthShell title="Welcome to KIASA" variant="dashboard">
      <p className="kauth__subtitle">
        You are signed in. This is a placeholder while the application dashboard is built.
      </p>

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

      <div className="kauth__actions">
        {/* Server Action, so the auth cookies are cleared on the response and
            sign-out still works without JavaScript. */}
        <form action={signOut}>
          <LogoutButton />
        </form>
      </div>
    </AuthShell>
  );
}
