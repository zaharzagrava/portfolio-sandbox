'use client';

import Link from 'next/link';
import { ShoppingCart } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useCartCount } from '@/lib/api/cart';
import { cartHref } from '@/lib/routes';

export { useCartCount };

/** "Cart" while the count is unknown or zero, otherwise "Cart, {n} items" (one unit reads "Cart, 1 item"). */
export function cartLabel(count: number | null): string {
  if (!count) return 'Cart';
  return `Cart, ${count} ${count === 1 ? 'item' : 'items'}`;
}

/**
 * The navbar's cart link with the unit count (W03 FR-005, AS-13). The count is the cheap lines entry of the query cache, so
 * it follows every cart change in this tab at once and is re-read when the tab regains focus (the `cart` query defaults).
 * The badge is absent until the count is known and while it is zero; above 99 it reads `99+`. Nothing is hard-coded.
 */
export function CartBadge() {
  const count = useCartCount();

  return (
    <Link
      href={cartHref()}
      aria-label={cartLabel(count)}
      className="relative inline-flex size-11 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-2 lg:size-9"
    >
      <ShoppingCart aria-hidden="true" className="h-5 w-5" />
      {count ? (
        <Badge aria-hidden="true" className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full p-0 px-1" variant="destructive">
          {count > 99 ? '99+' : count}
        </Badge>
      ) : null}
    </Link>
  );
}
