import { OverviewSkeleton } from '@/components/seller/page-skeletons';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * What shows while the layout reads the session and the shop (W04 AS-91): the sidebar's shape and a content skeleton. No
 * text and no spinner; decorative.
 */
export function ShellSkeleton() {
  return (
    <div aria-hidden="true" data-skeleton="shell" className="flex min-h-[calc(100svh-3.5rem)] flex-col lg:flex-row">
      <div className="hidden w-64 shrink-0 space-y-3 border-r bg-muted/40 p-4 lg:block">
        <Skeleton className="h-9 w-full" />
        {Array.from({ length: 9 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
      <div className="flex items-center gap-2 border-b px-2 py-1 lg:hidden">
        <Skeleton className="size-11" />
        <Skeleton className="h-8 w-40" />
      </div>
      <div className="min-w-0 flex-1 p-4 md:p-6 lg:p-8">
        <OverviewSkeleton />
      </div>
    </div>
  );
}
