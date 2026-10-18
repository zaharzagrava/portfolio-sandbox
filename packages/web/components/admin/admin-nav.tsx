'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { adminNavItems, isCurrentAdminItem } from '@/lib/admin/nav';
import { cn } from '@/lib/utils';

/** The navigation registry as a list named "Admin"; the current entry carries `aria-current="page"` (W06 AS-59). Same content in the sidebar and the drawer. */
export function AdminNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin">
      <ul className="flex flex-col gap-1">
        {adminNavItems.map((item) => {
          const current = isCurrentAdminItem(item, pathname);
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                aria-current={current ? 'page' : undefined}
                onClick={onNavigate}
                className={cn(
                  'flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:min-h-9',
                  current ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <item.icon aria-hidden="true" className="size-4 shrink-0" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
