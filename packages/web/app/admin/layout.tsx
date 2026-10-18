import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';
import { AdminGuard } from '@/components/admin/admin-guard';
import { Skeleton } from '@/components/ui/skeleton';

export const metadata: Metadata = { title: 'Marketplace Admin', robots: { index: false, follow: false } };

/** The static frame while the session is read: header and sidebar shapes, no text, no spinner (W06 AS-63). */
function ShellSkeleton() {
  return (
    <div aria-hidden="true" data-skeleton="admin-shell" className="flex min-h-[calc(100svh-3.5rem)] flex-col lg:flex-row">
      <div className="hidden w-64 shrink-0 space-y-3 border-r p-4 lg:block">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
      <div className="min-w-0 flex-1 space-y-4 p-4 md:p-6 lg:p-8">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

/**
 * Every `/admin/**` page (W06 FR-002, FR-006): the layout does not await the session at its top level; the guard is a
 * component inside the boundary. No `instant = false`, nothing cached (per-user pages).
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <AdminGuard>{children}</AdminGuard>
    </Suspense>
  );
}
