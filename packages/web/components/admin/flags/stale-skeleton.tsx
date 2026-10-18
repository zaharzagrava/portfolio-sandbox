import { Skeleton } from '@/components/ui/skeleton';

/** Stale-report rows (table on desktop, cards on a phone): no text, no spinner (W06 AS-63). Server-safe. */
export function StaleSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden="true" data-skeleton="stale" className="space-y-3 rounded-xl border bg-background p-4">
      <Skeleton className="h-4 w-80 max-w-full" />
      <div className="space-y-2">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
