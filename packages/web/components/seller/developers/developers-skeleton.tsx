import { Skeleton } from '@/components/ui/skeleton';

const ROWS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;

/** Decorative placeholder rows of a developer page while its data loads (W04 FR-005); hidden from assistive technology. */
export function RowsSkeleton({ name, rows = 4, heading = false }: { name: string; rows?: number; heading?: boolean }) {
  return (
    <div aria-hidden="true" data-skeleton={name} className="space-y-2">
      {heading && <Skeleton className="h-8 w-2/3" />}
      {ROWS.slice(0, rows).map((id) => (
        <Skeleton key={id} data-region="row" className="h-12 w-full max-sm:h-24" />
      ))}
    </div>
  );
}
