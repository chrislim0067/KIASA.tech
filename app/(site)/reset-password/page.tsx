import type { Metadata } from 'next';

import AuthShell from '@/components/auth/AuthShell';
import ConfigNotice from '@/components/auth/ConfigNotice';
import ResetPasswordForm from '@/components/auth/ResetPasswordForm';
import { isSupabaseConfigured } from '@/lib/supabase/env';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Set a new password | KIASA',
  description: 'Choose a new password for your KIASA account.',
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return (
    <AuthShell title="Set a new password" subtitle="Choose a password you have not used before.">
      {isSupabaseConfigured() ? <ResetPasswordForm /> : <ConfigNotice />}
    </AuthShell>
  );
}
