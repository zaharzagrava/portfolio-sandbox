/** The placeholder of the checkout review while the server guard and the first cart read run (W03 AS-70, FR-052). Server-renderable. */
export function ReviewSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-busy="true">
      <h1 className="text-2xl font-bold tracking-tight">Checkout</h1>
      <div aria-hidden="true" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="h-48 animate-pulse rounded-xl bg-muted" />
        <div className="h-32 animate-pulse rounded-xl bg-muted" />
      </div>
      <span className="sr-only">Loading checkout…</span>
    </div>
  );
}
