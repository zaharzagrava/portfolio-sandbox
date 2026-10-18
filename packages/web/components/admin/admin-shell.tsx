import Link from 'next/link';
import type { ReactNode } from 'react';
import { AdminDrawer } from './admin-drawer';
import { AdminNav } from './admin-nav';
import { AdminOfflineBanner } from './admin-offline-banner';

/**
 * The frame of every `/admin/**` page (W06 FR-060, AS-59): a header row (brand, "Back to marketplace", the viewer's e-mail),
 * a persistent sidebar from 1024 px, a top bar with a drawer below. A Server Component with no session of its own: the guard
 * has already passed when it renders, so no navigation exists before then.
 */
export function AdminShell({ viewerEmail, children }: { viewerEmail: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[calc(100svh-3.5rem)] w-full flex-col bg-muted/40">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-background px-4 py-2 sm:px-6">
        <Link href="/admin" className="text-lg font-semibold">
          Marketplace Admin
        </Link>
        <Link href="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          Back to marketplace
        </Link>
        <span className="ml-auto min-w-0 truncate text-sm text-muted-foreground">{viewerEmail}</span>
      </header>
      <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
        <aside className="hidden w-64 shrink-0 border-r bg-background p-4 lg:block">
          <AdminNav />
        </aside>
        <AdminDrawer />
        <div className="min-w-0 flex-1 space-y-4 p-4 md:p-6 lg:p-8">
          <AdminOfflineBanner />
          {children}
        </div>
      </div>
    </div>
  );
}
