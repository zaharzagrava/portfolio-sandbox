/** Exactly the size of the signed-in account button, so the header does not move while the session is read. No text: nothing is announced. */
export function AccountSlotSkeleton() {
  return <div aria-busy="true" data-slot="account-skeleton" className="size-9 rounded-full bg-muted" />;
}
