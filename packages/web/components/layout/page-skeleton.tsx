import { Skeleton } from '@/components/ui/skeleton';

/** Page-shaped placeholder (decorative: the announcement is the single "Loading…" status of `app/loading.tsx`). */
export function PageSkeleton({ variant }: { variant: 'detail' | 'list' | 'form' }) {
  return (
    <div data-variant={variant} aria-hidden="true" className="container mx-auto max-w-7xl px-4 py-8 md:px-6">
      {variant === 'detail' && (
        <div className="grid grid-cols-1 gap-10 md:grid-cols-2">
          <Skeleton className="aspect-square w-full rounded-lg" />
          <div className="space-y-4">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-11 w-40" />
          </div>
        </div>
      )}
      {variant === 'list' && (
        <div className="space-y-6">
          <Skeleton className="h-8 w-1/3" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((key) => (
              <Skeleton key={key} className="h-56 w-full rounded-lg" />
            ))}
          </div>
        </div>
      )}
      {variant === 'form' && (
        <div className="mx-auto max-w-md space-y-5">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-32" />
        </div>
      )}
    </div>
  );
}
