import { Suspense } from 'react';
import { LoginForm } from './login-form';

/** The form reads ?returnUrl etc. (useSearchParams), so it streams in behind Suspense; the shell is prerendered. */
export default function Page() {
  return (
    <Suspense fallback={<div className="min-h-[60vh]" />}>
      <LoginForm />
    </Suspense>
  );
}
