import Link from 'next/link';
import { flagHref, historyHref, listHref, staleHref } from '@/lib/admin/flags/params';
import { cn } from '@/lib/utils';

type Tab = { id: string; label: string; href: string };

function Strip({ label, tabs, current }: { label: string; tabs: Tab[]; current: string }) {
  return (
    <div className="overflow-x-auto border-b">
      <div role="tablist" aria-label={label} className="inline-flex gap-1 whitespace-nowrap">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            role="tab"
            aria-selected={tab.id === current}
            href={tab.href}
            className={cn(
              'inline-flex min-h-11 items-center border-b-2 px-3 text-sm sm:min-h-9',
              tab.id === current ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** The tabs of the list page (W06 AS-45): Flags and Stale. */
export function ListTabs({ current }: { current: 'flags' | 'stale' }) {
  return (
    <Strip
      label="Feature flags views"
      current={current}
      tabs={[
        { id: 'flags', label: 'Flags', href: listHref({ status: 'all' }) },
        { id: 'stale', label: 'Stale', href: staleHref(14) },
      ]}
    />
  );
}

/** The tabs of the flag page (W06 AS-40): Definition and History. */
export function FlagPageTabs({ flagKey, current }: { flagKey: string; current: 'definition' | 'history' }) {
  return (
    <Strip
      label="Flag views"
      current={current}
      tabs={[
        { id: 'definition', label: 'Definition', href: flagHref(flagKey) },
        { id: 'history', label: 'History', href: historyHref(flagKey) },
      ]}
    />
  );
}
