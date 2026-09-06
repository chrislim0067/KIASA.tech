import type { Metadata } from 'next';

import AuthShell from '@/components/auth/AuthShell';
import ConfigNotice from '@/components/auth/ConfigNotice';
import SignupForm from '@/components/auth/SignupForm';
import { isSupabaseConfigured } from '@/lib/supabase/env';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Create an account | KIASA',
  description: 'Create a KIASA account.',
  robots: { index: false, follow: false },
};

export default function SignupPage() {
  return (
    <AuthShell title="Create account" subtitle="Set up your KIASA account in a few seconds.">
      {isSupabaseConfigured() ? <SignupForm /> : <ConfigNotice />}
    </AuthShell>
  );
}
