import type { Metadata } from 'next';
import { Suspense } from 'react';

import AuthShell from '@/components/auth/AuthShell';
import ConfigNotice from '@/components/auth/ConfigNotice';
import LoginForm from '@/components/auth/LoginForm';
import { isSupabaseConfigured } from '@/lib/supabase/env';

// Auth state is per-request; never serve a cached shell of these screens.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign in | KIASA',
  description: 'Sign in to your KIASA account.',
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <AuthShell title="Sign in" subtitle="Welcome back. Enter your details to continue.">
      {isSupabaseConfigured() ? (
        // LoginForm reads ?redirectTo and ?error via useSearchParams.
        <Suspense fallback={<p className="kauth__hint">Loading…</p>}>
          <LoginForm />
        </Suspense>
      ) : (
        <ConfigNotice />
      )}
    </AuthShell>
  );
}
