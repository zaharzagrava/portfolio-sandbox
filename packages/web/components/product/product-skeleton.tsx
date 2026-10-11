import { Skeleton } from '@/components/ui/skeleton';

/** The product page while it streams: the same grid as the final page (gallery block, title lines, price, buttons, tab bar). */
export function ProductSkeleton() {
  return (
    <div aria-busy="true" aria-hidden="true" data-testid="product-skeleton">
      <Skeleton className="mb-6 h-5 w-64" />
      <div className="mb-12 grid grid-cols-1 gap-10 lg:grid-cols-2">
        <Skeleton className="aspect-square w-full rounded-lg" />
        <div className="space-y-4">
          <Skeleton className="h-9 w-3/4" />
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-5 w-24" />
          <div className="flex gap-3">
            <Skeleton className="h-11 w-40" />
            <Skeleton className="h-11 w-44" />
          </div>
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
      <Skeleton className="h-11 w-full" />
    </div>
  );
}
