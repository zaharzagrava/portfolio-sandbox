import { Skeleton } from '@/components/ui/skeleton';

/** Placeholder while the guard and the first read run, announced once as "Loading order" (W03 AS-57). Server-renderable. */
export function OrderDetailSkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-6">
      <h1 className="mb-6 text-3xl font-bold tracking-tight">Your order</h1>
      <div role="status">
        <span className="sr-only">Loading order</span>
        <div aria-hidden="true" className="space-y-4">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
