import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth/auth-card';
import { ResetPasswordForm } from './reset-password-form';

export const metadata: Metadata = { title: 'Reset password' };

/** Static page; the token lives in the URL fragment, which the server never sees (W01 FR-024). */
export default function Page() {
  return (
    <AuthCard title="Reset password" description="Choose a new password for your account.">
      <ResetPasswordForm />
    </AuthCard>
  );
}
