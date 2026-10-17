import Link from 'next/link';
import { Store } from 'lucide-react';
import { SELLER_HOME } from '@/lib/seller/nav';

/**
 * The sidebar of a member with no shop (W04 AS-01): the single entry "Start selling" and no seller entries, because
 * being a seller means being a member of a shop.
 */
export function StartSellingNav() {
  return (
    <nav aria-label="Seller" className="flex flex-col">
      <Link
        href={SELLER_HOME}
        aria-current="page"
        className="flex min-h-11 items-center gap-3 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:min-h-9"
      >
        <Store aria-hidden="true" className="size-4" />
        Start selling
      </Link>
    </nav>
  );
}
