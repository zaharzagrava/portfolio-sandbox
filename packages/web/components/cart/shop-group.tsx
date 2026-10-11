'use client';

import { useId } from 'react';
import type { ShopGroup as ShopGroupModel } from '@/lib/cart/totals';
import { CartLine } from './cart-line';

/** The lines of one shop under "Sold by {shop name}"; lines with an unknown shop sit under "Other items" (W03 AS-03). */
export function ShopGroup({
  group,
  detailsUnavailable,
  onBeforeRemove,
  registerFocus,
}: {
  group: ShopGroupModel;
  detailsUnavailable: boolean;
  onBeforeRemove: (productId: string) => void;
  registerFocus: (productId: string) => (element: HTMLElement | null) => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="border-b last:border-b-0">
      <h2 id={headingId} className="[overflow-wrap:anywhere] pt-4 text-lg font-semibold">
        {group.shopId ? `Sold by ${group.name}` : group.name}
      </h2>
      <ul className="divide-y">
        {group.lines.map((line) => (
          <CartLine key={line.productId} line={line} detailsUnavailable={detailsUnavailable} onBeforeRemove={onBeforeRemove} primaryRef={registerFocus(line.productId)} />
        ))}
      </ul>
    </section>
  );
}
