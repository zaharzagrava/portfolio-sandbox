'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { useCartPage } from '@/lib/api/cart';
import { problemFromError } from '@/lib/api/errors';
import { problemCopy } from '@/lib/api/problem-copy';
import { groupByShop, unitCount } from '@/lib/cart/totals';
import { trackCheckoutStep } from '@/lib/checkout/events';
import { searchHref } from '@/lib/routes';
import { LINE_COLUMNS } from './cart-line';
import { CartFrame, CartSkeleton } from './cart-skeleton';
import { CartSummary } from './cart-summary';
import { MergeNotice } from './merge-notice';
import { ShopGroup } from './shop-group';

/**
 * The cart page's body (W03 AS-01..AS-13, FR-001, FR-040): reads the cart aggregate in the browser (`/cart` itself is a
 * static shell) and shows the loading, error, empty, partial and loaded states. Lines are grouped by shop; the writes are
 * the optimistic ones of `lib/api/cart.ts`. The `<h1>` is the same element in every state so focus can return to it.
 */
export function CartView() {
  const cart = useCartPage();
  const { isAuthenticated } = useAuth();
  const heading = useRef<HTMLHeadingElement>(null);
  const targets = useRef(new Map<string, HTMLElement>());
  const reported = useRef(false);
  const data = cart.data;

  // FR-090: the cart step once per view, with the unit count only.
  useEffect(() => {
    if (!data || reported.current || data.lines.length === 0) return;
    reported.current = true;
    trackCheckoutStep({ step: 'cart', items: unitCount(data.lines) });
  }, [data]);

  const registerFocus = (productId: string) => (element: HTMLElement | null) => {
    if (element) targets.current.set(productId, element);
    else targets.current.delete(productId);
  };

  /** AS-05: after a removal focus goes to the next line (the previous one for the last line), or to the heading when none is left. */
  const moveFocusFrom = (productId: string) => {
    const order = groupByShop(data?.lines ?? []).flatMap((group) => group.lines.map((line) => line.productId));
    const position = order.indexOf(productId);
    const neighbour = order[position + 1] ?? order[position - 1];
    const element = neighbour ? targets.current.get(neighbour) : undefined;
    (element ?? heading.current)?.focus();
  };

  if (cart.isPending) {
    return (
      <CartFrame headingRef={heading}>
        <CartSkeleton />
      </CartFrame>
    );
  }

  if (!data) {
    const copy = problemCopy('cart', problemFromError(cart.error), { operation: 'read' });
    return (
      <CartFrame headingRef={heading}>
        <div role="alert" tabIndex={-1} className="flex flex-col items-start gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
          <p>{copy.text}</p>
          {copy.reference ? <p className="text-xs">{copy.reference}</p> : null}
          <Button type="button" variant="outline" className="min-h-11 lg:min-h-8" onClick={() => void cart.refetch()}>
            Try again
          </Button>
        </div>
      </CartFrame>
    );
  }

  const detailsUnavailable = data.errors.some((entry) => entry.section === 'products');

  return (
    <CartFrame headingRef={heading}>
      <MergeNotice />
      {detailsUnavailable ? (
        <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted px-4 py-3 text-sm">
          <p>Some product details couldn&apos;t be loaded.</p>
          <Button type="button" variant="outline" className="min-h-11 lg:min-h-8" onClick={() => void cart.refetch()}>
            Reload
          </Button>
        </div>
      ) : null}

      {data.lines.length === 0 ? (
        <div className="rounded-lg border px-4 py-16 text-center">
          <p className="mb-4 text-lg font-medium">Your cart is empty</p>
          <Button asChild size="lg">
            <Link href={searchHref({})}>Browse products</Link>
          </Button>
        </div>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
          <div className="min-w-0">
            <div aria-hidden="true" className={`hidden border-b pb-2 text-sm font-medium text-muted-foreground lg:grid lg:gap-x-4 ${LINE_COLUMNS}`}>
              <span className="col-span-2">Product</span>
              <span className="text-right">Price</span>
              <span>Quantity</span>
              <span className="text-right">Total</span>
            </div>
            {groupByShop(data.lines).map((group) => (
              <ShopGroup key={group.shopId ?? 'other'} group={group} detailsUnavailable={detailsUnavailable} onBeforeRemove={moveFocusFrom} registerFocus={registerFocus} />
            ))}
            <Button asChild variant="link" className="mt-4 min-h-11 px-0 lg:min-h-8">
              <Link href={searchHref({})}>Continue shopping</Link>
            </Button>
          </div>
          <CartSummary lines={data.lines} detailsUnavailable={detailsUnavailable} authenticated={isAuthenticated} />
        </div>
      )}
    </CartFrame>
  );
}
