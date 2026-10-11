import { Skeleton } from '@/components/ui/skeleton';

const CARDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;

/** Placeholder for the filter column and the grid at their final size. Decorative: no announcement. */
export function SearchShellSkeleton() {
  return (
    <div aria-busy="true" aria-hidden="true" className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-8">
      <div className="hidden space-y-4 lg:block">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <div className="min-w-0 space-y-4">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-5 w-24" />
        <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {CARDS.map((name) => (
            <li key={name}>
              <Skeleton className="aspect-[3/4] w-full rounded-xl" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
