import { Skeleton } from '@/components/ui/skeleton';

/** Rows shaped like the table (cards on a phone), no text, no spinner (W06 AS-06, AS-63). Server-safe. */
export function FlagListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true" data-skeleton="flag-list" className="space-y-3 rounded-xl border bg-background p-4">
      <Skeleton className="h-8 w-80 max-w-full" />
      <div className="space-y-2">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
