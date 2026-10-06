import Link from 'next/link';
import { ReactNode } from 'react';
import { Flag, LayoutDashboard } from 'lucide-react';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen w-full flex-col bg-muted/40">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b bg-background px-4 sm:static sm:h-auto sm:border-0 sm:bg-transparent sm:px-6 sm:pt-4">
        <Link href="/admin" className="flex items-center gap-2 font-semibold">
          <LayoutDashboard className="h-5 w-5" />
          <span className="text-lg">Marketplace Admin</span>
        </Link>
      </header>
      <div className="flex flex-1 mt-4">
        <aside className="w-64 flex-col border-r bg-background p-4 hidden md:flex">
          <nav className="flex flex-col gap-2">
            <Link 
              href="/admin/feature-flags" 
              className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-primary transition-all hover:text-primary"
            >
              <Flag className="h-4 w-4" />
              Feature Flags
            </Link>
          </nav>
        </aside>
        <main className="flex-1 p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
