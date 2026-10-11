import { isProviderError } from './copy';
import { safeReturnTo } from './return-to';

/**
 * Where a signed-in visitor goes when they open an auth page (W01 AS-16), or `null` to render the page. Pure: guards only
 * redirect for convenience; the BFF and the owning APIs authorize every data request again (VI.5).
 */
export function authPageRedirect(input: {
  user: { id: string } | null;
  returnTo?: string | string[] | null;
  error?: string | string[] | null;
}): string | null {
  if (!input.user) return null;
  if (isProviderError(input.error)) return `/account/security?tab=methods&error=${input.error}`;
  return safeReturnTo(input.returnTo);
}
