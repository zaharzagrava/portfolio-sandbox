import { NOTICES, PROVIDER_ERRORS, isNotice, isProviderError } from '@/lib/auth/copy';

/**
 * One banner above the sign-in form for an allowlisted `?error=` (alert) or `?notice=` (status) value (W01 AS-15). Unknown
 * or repeated values show nothing and are never echoed. A Server Component: it renders text from the catalogue only.
 */
export function AuthBanner({ notice, error }: { notice?: string | string[]; error?: string | string[] }) {
  if (isProviderError(error)) {
    return (
      <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
        {PROVIDER_ERRORS[error]}
      </div>
    );
  }
  if (isNotice(notice)) {
    return (
      <div role="status" className="rounded-lg border border-emerald-600/30 bg-emerald-600/10 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-200">
        {NOTICES[notice]}
      </div>
    );
  }
  return null;
}
