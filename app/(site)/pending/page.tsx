import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import AuthShell from '@/components/auth/AuthShell';
import ConfigNotice from '@/components/auth/ConfigNotice';
import SignOutForm from '@/components/auth/SignOutForm';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { getCallerAccess } from '@/lib/auth/access-guard';
import { accessMessage, canUseProduct } from '@/lib/auth/access';
import { LOGIN, DASHBOARD } from '@/lib/auth/routes';

/**
 * Where a signed-in but unapproved account waits.
 *
 * Deliberately a dead end: it shows the person where they stand and offers a
 * sign-out, and nothing else. There is no "request access again" button —
 * re-requesting would just be a way to spam the administrator's queue, and the
 * decision is already recorded.
 *
 * An approved user who lands here is bounced to the dashboard, so the page can
 * never become a trap after someone is let in.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Account pending | KIASA',
  robots: { index: false, follow: false },
};

export default async function PendingPage() {
  if (!isSupabaseConfigured()) {
    return (
      <AuthShell title="Account" variant="card">
        <ConfigNotice />
      </AuthShell>
    );
  }

  const { user, status } = await getCallerAccess();
  if (!user) redirect(LOGIN);
  if (canUseProduct(status)) redirect(DASHBOARD);

  const { title, body } = accessMessage(status);

  return (
    <AuthShell title={title} variant="card">
      <p className="kauth__subtitle">{body}</p>

      <div className="kauth__row">
        <span className="kauth__rowLabel">Signed in as</span>
        <span className="kauth__email">{user.email}</span>
      </div>

      {status === 'pending' ? (
        <p className="kauth__hint">
          Approvals are done by a person, so this is not instant. You do not need to do
          anything else — signing in again will not speed it up.
        </p>
      ) : null}

      <div className="kauth__actions">
        <SignOutForm />
      </div>
    </AuthShell>
  );
}
