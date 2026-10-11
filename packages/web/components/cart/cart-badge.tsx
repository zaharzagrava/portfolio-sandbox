'use client';

// Stand-in for the W03 contract: the owner replaces the body, never the name or props.

import Link from 'next/link';
import { ShoppingCart } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cartTotals, useCart } from '@/lib/api/cart';

/** Cart link with the item count. Always present; the badge appears only once the count is known and above zero. */
export function CartBadge() {
  const { data } = useCart();
  const count = data ? cartTotals(data).itemCount : undefined;
  const name = count ? `Cart, ${count} ${count === 1 ? 'item' : 'items'}` : 'Cart';

  return (
    <Link
      href="/cart"
      aria-label={name}
      className="relative inline-flex size-11 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-2 lg:size-9"
    >
      <ShoppingCart aria-hidden="true" className="h-5 w-5" />
      {count ? (
        <Badge aria-hidden="true" className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full p-0 px-1" variant="destructive">
          {count}
        </Badge>
      ) : null}
    </Link>
  );
}
