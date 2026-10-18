import type { ServerSessionUser } from '@/lib/api/session-server';

/**
 * W06 Provides (W07 follow-up): the one place the admin role is read. Presentation only (the storefront Admin entry and the
 * console guard's panel): authorization is enforced by the API on every call (W06 FR-006, constitution VI.5).
 */
export function isAdmin(user: Pick<ServerSessionUser, 'role'> | { role?: string } | null | undefined): boolean {
  return user?.role === 'ADMIN';
}
