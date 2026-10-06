import { Suspense } from 'react';
import { DashboardShell } from '@/components/dashboard/dashboard-shell';

/**
 * The shell reads the URL (usePathname/useParams) and the session on the client, so it streams in behind a
 * Suspense boundary; the static fallback is prerendered (Cache Components / instant navigation).
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading...</div>}>
      <DashboardShell>{children}</DashboardShell>
    </Suspense>
  );
}
