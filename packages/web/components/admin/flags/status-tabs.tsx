import Link from 'next/link';
import { listHref, type ListStatus } from '@/lib/admin/flags/params';
import { cn } from '@/lib/utils';

const LABELS: Record<ListStatus, string> = { all: 'All active', enabled: 'Enabled', disabled: 'Disabled', killed: 'Killed', archived: 'Archived' };
export const STATUS_TAB_ORDER: ListStatus[] = ['all', 'enabled', 'disabled', 'killed', 'archived'];

/**
 * The status filter (W06 AS-02, AS-03): links, so the filter is in the URL and Back returns to the previous one. A new status
 * passes no cursor. Scrolls inside its own strip on a phone.
 */
export function StatusTabs({ status }: { status: ListStatus }) {
  return (
    <div className="overflow-x-auto">
      <div role="tablist" aria-label="Status" className="inline-flex gap-1 whitespace-nowrap">
        {STATUS_TAB_ORDER.map((value) => (
          <Link
            key={value}
            role="tab"
            aria-selected={status === value}
            href={listHref({ status: value })}
            className={cn(
              'inline-flex min-h-11 items-center rounded-md px-3 text-sm sm:min-h-8',
              status === value ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            {LABELS[value]}
          </Link>
        ))}
      </div>
    </div>
  );
}
