import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import AuthShell from '@/components/auth/AuthShell';
import ConfigNotice from '@/components/auth/ConfigNotice';
import SignOutForm from '@/components/auth/SignOutForm';
import AccessWatcher from '@/components/auth/AccessWatcher';
import { createClient } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { accessMessage, canUseProduct, isAccessStatus, DEFAULT_ACCESS } from '@/lib/auth/access';
import { LOGIN, DASHBOARD } from '@/lib/auth/routes';

/**
 * Where a signed-in but unapproved account waits.
 *
 * Live: AccessWatcher polls the candidate's own status and moves them to the
 * dashboard the moment an administrator approves, without a refresh.
 *
 * The rejection reason IS shown. That reverses the original design, which
 * showed only the decision — the owner wants the applicant told why, and the
 * reason was in any case already readable by that user through PostgREST,
 * since the select-own policy covers every column of their own row. Hiding it
 * in the UI was an appearance of a control rather than a control. The admin
 * form now says plainly that the text will be shown.
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

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect(LOGIN);

  const { data, error } = await supabase
    .from('user_access')
    .select('status, reason, decided_at')
    .eq('user_id', user.id)
    .maybeSingle();

  // Absence and failure both mean pending — the same fail-closed rule the gate
  // itself uses.
  const status = !error && data && isAccessStatus(data.status) ? data.status : DEFAULT_ACCESS;
  const reason = status === 'rejected' ? (data?.reason ?? null) : null;

  if (canUseProduct(status)) redirect(DASHBOARD);

  const { title, body } = accessMessage(status);

  return (
    <AuthShell title={title} variant="card">
      <p className="kauth__subtitle">{body}</p>

      <div className="kauth__row">
        <span className="kauth__rowLabel">Signed in as</span>
        <span className="kauth__email">{user.email}</span>
      </div>

      {/* Renders the reason when there is one, and keeps the page in step with
          the decision without the person having to reload. */}
      <AccessWatcher initialStatus={status} initialReason={reason} />

      <div className="kauth__actions">
        <SignOutForm />
      </div>
    </AuthShell>
  );
}
