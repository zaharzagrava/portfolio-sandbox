import { Skeleton } from '@/components/ui/skeleton';

/** History entries shaped like the loaded list: no text, no spinner (W06 AS-63). Server-safe. */
export function HistorySkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden="true" data-skeleton="history" className="space-y-3">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-20 w-full rounded-xl" />
      ))}
    </div>
  );
}
