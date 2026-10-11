import type { ReactNode, Ref } from 'react';
import { Skeleton } from '@/components/ui/skeleton';

/** The cart page's frame: the one `<h1>` and the page padding (room at the bottom for the mobile summary bar). */
export function CartFrame({ children, headingRef }: { children: ReactNode; headingRef?: Ref<HTMLHeadingElement> }) {
  return (
    <div className="container mx-auto px-4 pb-28 pt-8 md:px-6 lg:pb-10">
      <h1 ref={headingRef} tabIndex={-1} className="mb-6 text-3xl font-bold tracking-tight outline-none">
        Your cart
      </h1>
      {children}
    </div>
  );
}

/** Three placeholder lines, announced once as "Loading your cart" (W03 AS-09). */
export function CartSkeleton() {
  return (
    <div role="status">
      <span className="sr-only">Loading your cart</span>
      <div aria-hidden="true" className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <ul className="divide-y">
          {['a', 'b', 'c'].map((key) => (
            <li key={key} className="flex gap-3 py-4">
              <Skeleton className="size-16 shrink-0 rounded-md" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-11 w-40" />
              </div>
            </li>
          ))}
        </ul>
        <Skeleton className="hidden h-48 w-full rounded-lg lg:block" />
      </div>
    </div>
  );
}
