import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { adminAccess } from '@/lib/admin/access';
import { getServerSession, requireServerSession } from '@/lib/auth/session.server';
import { AdminShell } from './admin-shell';
import { ForbiddenPanel } from './forbidden-panel';

/**
 * Layout body of `/admin/**` (W06 FR-006, AS-47, AS-48): a Server Component rendered inside `<Suspense>` (the session read is
 * a request-time read). An admin gets the shell around the page; a signed-in member gets only the no-access panel; a
 * visitor gets the page bare (no navigation, no data) because every page runs `requireAdminPage` first and redirects to
 * `/login?returnTo=<its own path and query>`, which a layout cannot know. Convenience only: the API authorizes every call.
 */
export async function AdminGuard({ children }: { children: ReactNode }) {
  const user = await getServerSession();
  const access = adminAccess(user, '/admin/feature-flags');
  // The page is still rendered (hidden, and it requests nothing: `requireAdminPage` answers false) so the framework's
  // instant-navigation check sees every segment; the member sees only the panel.
  if (access.kind === 'forbidden') {
    return (
      <>
        <ForbiddenPanel />
        <div hidden>{children}</div>
      </>
    );
  }
  if (access.kind === 'redirect' || !user) return <>{children}</>;
  return <AdminShell viewerEmail={user.email}>{children}</AdminShell>;
}

/**
 * The guard every admin page calls first, before it reads or prefetches anything: anonymous → redirect with `returnTo`,
 * non-admin → `false` (the page renders nothing; the layout shows the panel), admin → `true`.
 */
export async function requireAdminPage(returnTo: string): Promise<boolean> {
  const user = await requireServerSession(returnTo);
  const access = adminAccess(user, returnTo);
  if (access.kind === 'redirect') redirect(access.to);
  return access.kind === 'ok';
}
