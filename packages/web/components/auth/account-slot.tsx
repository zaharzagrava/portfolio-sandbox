import { getServerSession } from '@/lib/auth/session.server';
import { AccountSlotClient } from './account-menu';

// Client modules (`'use client'` in account-menu) re-exported under the W07 contract names; the skeleton is a plain module.
export { MobileAccountEntries } from './account-menu';
export { AccountSlotSkeleton } from './account-skeleton';

/**
 * Desktop account control (Server Component). It reads the session on the server (rendered under the navbar's own
 * `<Suspense>` with `AccountSlotSkeleton` as fallback) and passes only `{id, email, role}` to the client leaf, which seeds
 * the session query and then follows it. A member is therefore server-rendered as the account menu, never as "Log in".
 */
export async function AccountSlot() {
  const session = await getServerSession();
  const initialUser = session ? { id: session.id, email: session.email, role: session.role } : null;
  return <AccountSlotClient initialUser={initialUser} />;
}
