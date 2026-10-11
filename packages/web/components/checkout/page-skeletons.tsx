/**
 * The placeholders of the pay and success pages while the server guard and the first order read run (W03 AS-70, FR-052).
 * Server-renderable: a heading and one status, nothing that needs the request.
 */
export function PaySkeleton() {
  return (
    <div className="space-y-6" role="status" aria-busy="true">
      <h1 className="text-2xl font-bold tracking-tight">Pay for your order</h1>
      <div aria-hidden="true" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="h-48 animate-pulse rounded-xl bg-muted" />
        <div className="h-32 animate-pulse rounded-xl bg-muted" />
      </div>
      <span className="sr-only">Loading payment…</span>
    </div>
  );
}

export function SuccessSkeleton() {
  return (
    <div className="mx-auto max-w-xl space-y-6" role="status" aria-busy="true">
      <h1 className="text-2xl font-bold tracking-tight">Your order</h1>
      <div aria-hidden="true" className="h-48 animate-pulse rounded-xl bg-muted" />
      <span className="sr-only">Loading your order…</span>
    </div>
  );
}
