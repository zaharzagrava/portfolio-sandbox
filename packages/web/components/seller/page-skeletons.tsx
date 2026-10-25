import { Skeleton } from '@/components/ui/skeleton';

/**
 * Layout-shaped placeholders for the seller pages (W04 AS-91, FR-002): same regions, same order and about the same size as
 * the loaded page, so nothing shifts when data arrives. Decorative (`aria-hidden`); no text, no spinner. Server-safe: no
 * state, no effect. The sidebar frame is not part of them: it is already on screen.
 */

function Heading({ withAction = false }: { withAction?: boolean }) {
  return (
    <div data-region="header" className="flex items-center justify-between gap-4">
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-40" />
      </div>
      {withAction && <Skeleton className="h-9 w-32" />}
    </div>
  );
}

export function OverviewSkeleton() {
  return (
    <div aria-hidden="true" data-skeleton="overview" className="space-y-6">
      <Heading />
      <div className="grid gap-4 lg:grid-cols-2">
        <div data-region="live">
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
        <div data-region="today">
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </div>
      <div data-region="tiles" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((key) => (
          <Skeleton key={key} className="h-24 w-full rounded-xl" />
        ))}
      </div>
      <div data-region="rank">
        <Skeleton className="h-20 w-full rounded-xl" />
      </div>
      <div data-region="chart">
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
      <div data-region="top-products">
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    </div>
  );
}

/** A heading with its primary action (`action={false}` for none), an optional filter bar (`selectOnly`: one select, as the orders page has), then a header row and `rows` body rows. */
export function ListPageSkeleton({ rows = 8, filters = true, action = true, selectOnly = false }: { rows?: number; filters?: boolean; action?: boolean; selectOnly?: boolean }) {
  return (
    <div aria-hidden="true" data-skeleton="list" className="space-y-6">
      <Heading withAction={action} />
      {filters && (
        <div data-region="toolbar" className="flex flex-wrap gap-3">
          {selectOnly ? (
            <Skeleton className="h-9 w-40" />
          ) : (
            <>
              <Skeleton className="h-9 w-full sm:w-72" />
              <Skeleton className="h-9 w-28" />
              <Skeleton className="h-9 w-28" />
            </>
          )}
        </div>
      )}
      <div className="space-y-2">
        <Skeleton className="h-8 w-full max-sm:hidden" />
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} data-region="row" className="h-12 w-full max-sm:h-24" />
        ))}
      </div>
    </div>
  );
}

/** Only the rows of a list, for a section of a page whose heading is already on screen. */
export function TableRowsSkeleton({ rows = 8, name = 'rows' }: { rows?: number; name?: string }) {
  return (
    <div aria-hidden="true" data-skeleton={name} className="space-y-2">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} data-region="row" className="h-12 w-full max-sm:h-24" />
      ))}
    </div>
  );
}

/** A summary card above a table (the endpoint deliveries page). */
export function DetailPageSkeleton() {
  return (
    <div aria-hidden="true" data-skeleton="detail" className="space-y-6">
      <Heading />
      <Skeleton className="h-28 w-full rounded-xl" />
      <div className="space-y-2">
        <Skeleton className="h-8 w-full max-sm:hidden" />
        {['a', 'b', 'c', 'd', 'e', 'f'].map((key) => (
          <Skeleton key={key} className="h-12 w-full max-sm:h-24" />
        ))}
      </div>
    </div>
  );
}

/** One card (API version, usage controls). */
export function CardPageSkeleton() {
  return (
    <div aria-hidden="true" data-skeleton="card" className="space-y-6">
      <Heading />
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-32 w-full rounded-xl" />
    </div>
  );
}
