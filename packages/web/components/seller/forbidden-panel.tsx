import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { roleLabel, sellerNavItems } from '@/lib/seller/nav';

/** Shown in place of a page whose permission the member lacks (W04 FR-011, AS-54). It never includes the page's content. */
export function ForbiddenPanel({ shopId, role }: { shopId: string; role?: string }) {
  const overview = sellerNavItems[0]!.href(shopId);
  return (
    <section className="mx-auto flex max-w-prose flex-col items-start gap-3 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">You don&apos;t have access to this page.</h1>
      {role && <p className="text-muted-foreground">Your role in this shop: {roleLabel(role)}.</p>}
      <p className="text-muted-foreground">Ask a shop owner or admin to change your role.</p>
      <Button asChild variant="outline">
        <Link href={overview}>Overview</Link>
      </Button>
    </section>
  );
}
