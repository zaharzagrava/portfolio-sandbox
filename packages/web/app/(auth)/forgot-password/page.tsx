import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth/auth-card';
import { ForgotPasswordForm } from './forgot-password-form';

export const metadata: Metadata = { title: 'Forgot password' };

/** Static page: nothing here reads the request, so the shell is prerendered and the client leaf takes over (W01 FR-023). */
export default function Page() {
  return (
    <AuthCard title="Forgot password" description="Enter your email address and we'll send you a link to reset your password.">
      <ForgotPasswordForm />
    </AuthCard>
  );
}
