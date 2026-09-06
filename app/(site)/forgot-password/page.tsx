import type { Metadata } from 'next';

import AuthShell from '@/components/auth/AuthShell';
import ConfigNotice from '@/components/auth/ConfigNotice';
import ForgotPasswordForm from '@/components/auth/ForgotPasswordForm';
import { isSupabaseConfigured } from '@/lib/supabase/env';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Reset your password | KIASA',
  description: 'Request a link to reset your KIASA password.',
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="Forgot password"
      subtitle="Enter your email and we will send you a link to set a new password."
    >
      {isSupabaseConfigured() ? <ForgotPasswordForm /> : <ConfigNotice />}
    </AuthShell>
  );
}
