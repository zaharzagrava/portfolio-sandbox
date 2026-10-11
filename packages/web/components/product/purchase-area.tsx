'use client';

import Link from 'next/link';
import { MessagesSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AddToCartButton } from '@/components/add-to-cart-button';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/utils';

/**
 * The buying controls of a product (W02 FR-057, AS-37): **Add to cart** (W03's control, given the product id, its
 * category and `disabled`) and the **Chat with seller** link (W05). At 640 px and below a bar fixed to the bottom repeats
 * the price and Add to cart while this area is out of view, and never covers the element that has focus.
 */
export function PurchaseArea({
  productId,
  category,
  inStock,
  priceMinor,
  currency,
}: {
  productId: string;
  category: string;
  inStock: boolean;
  priceMinor: number;
  currency: string;
}) {
  const main = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [mainInView, setMainInView] = useState(true);

  useEffect(() => {
    const node = main.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setMainInView(entry?.isIntersecting ?? true));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const showBar = !mainInView;
  useEffect(() => {
    if (!showBar) return;
    // A focused element hidden under the bar is scrolled into the middle of the screen.
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      const barBox = bar.current?.getBoundingClientRect();
      // The bar is hidden by CSS from 640 px up (an empty box): nothing can be covered then.
      if (!(target instanceof HTMLElement) || !barBox || barBox.height === 0 || bar.current?.contains(target)) return;
      const box = target.getBoundingClientRect();
      if (box.bottom > barBox.top && box.top < barBox.bottom) target.scrollIntoView({ block: 'center' });
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, [showBar]);

  return (
    <>
      <div ref={main} className="flex flex-wrap gap-3" data-testid="purchase-area">
        <AddToCartButton productId={productId} category={category} disabled={!inStock} />
        <Button size="lg" variant="outline" asChild>
          <Link href={`/chat?product=${productId}`}>
            <MessagesSquare aria-hidden="true" className="mr-2 size-4" />
            Chat with seller
          </Link>
        </Button>
      </div>

      {showBar ? (
        <div
          ref={bar}
          data-testid="mobile-purchase-bar"
          className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-3 border-t bg-background px-4 py-3 sm:hidden"
        >
          <p className="text-lg font-semibold">{formatMoney(priceMinor, currency)}</p>
          <AddToCartButton productId={productId} category={category} disabled={!inStock} />
        </div>
      ) : null}
    </>
  );
}
