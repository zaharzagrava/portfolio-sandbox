import { loginHref } from '@/lib/auth/return-to';
import { isAdmin } from './is-admin';

export type AdminAccess = { kind: 'redirect'; to: string } | { kind: 'forbidden' } | { kind: 'ok' };

/**
 * What a visitor gets at `/admin/**` (W06 AS-47, AS-48): anonymous → sign in and come back to `returnTo`; a signed-in member
 * who is not an admin → the no-access panel, with nothing requested; an admin → the page. Convenience only: the API decides
 * on every call (FR-006).
 */
export function adminAccess(user: { role?: string } | null | undefined, returnTo: string): AdminAccess {
  if (!user) return { kind: 'redirect', to: loginHref(returnTo) };
  return isAdmin(user) ? { kind: 'ok' } : { kind: 'forbidden' };
}

/** `path?query` of an admin page, the `returnTo` of its guard. Repeated parameters stay repeated. */
export function adminReturnTo(pathname: string, searchParams: Record<string, string | string[] | undefined> = {}): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(searchParams)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(name, item);
  }
  const text = query.toString();
  return text ? `${pathname}?${text}` : pathname;
}
