'use client';

import type { CartPageLine } from '@marketplace-sandbox/contracts';
import { ImageOff } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useSetCartLine } from '@/lib/api/cart';
import { problemFromError } from '@/lib/api/errors';
import { problemCopy } from '@/lib/api/problem-copy';
import { lineTotalMinor } from '@/lib/cart/totals';
import { productHref } from '@/lib/routes';
import { safeHttpsUrl } from '@/lib/safe-url';
import { formatMoney } from '@/lib/utils';
import { QuantityControl } from './quantity-control';

/** The grid of a line and of the desktop column headings above the lines: product (image + text), price, quantity, total. */
export const LINE_COLUMNS = 'lg:grid-cols-[4rem_minmax(0,1fr)_7rem_11rem_7rem]';
export const UNDO_MS = 8_000;

function showWriteProblem(error: unknown): void {
  const copy = problemCopy('cart', problemFromError(error), { operation: 'write' });
  toast.error(copy.text, copy.reference ? { description: copy.reference } : undefined);
}

/**
 * One cart line (W03 AS-03..AS-09, FR-040). Quantity changes and removal go through the optimistic, serialised write of
 * `lib/api/cart.ts`; the line shows the cache, so values are instant and a refused write is rolled back by the library.
 * **Remove** takes the line away at once and offers **Undo** for 8 seconds (the removal is already saved; Undo writes the
 * previous quantity back). `detailsUnavailable` is the aggregate's `products` error: the line then reads "Details
 * unavailable right now" instead of "No longer available".
 */
export function CartLine({
  line,
  detailsUnavailable,
  onBeforeRemove,
  primaryRef,
}: {
  line: CartPageLine;
  detailsUnavailable: boolean;
  /** Called before the line leaves, so the list can move focus to a neighbour. */
  onBeforeRemove?: (productId: string) => void;
  /** Receives the element focus goes to when this line is the next one (its title link, or Remove when there is none). */
  primaryRef?: (element: HTMLElement | null) => void;
}) {
  const setLine = useSetCartLine();
  const [writes, setWrites] = useState(0);
  const { product } = line;
  const title = product?.title ?? (detailsUnavailable ? 'item' : 'Unavailable product');
  const image = safeHttpsUrl(product?.imageUrl);
  const total = lineTotalMinor(line);

  const write = (quantity: number): Promise<boolean> => {
    setWrites((count) => count + 1);
    return setLine(line.productId, quantity)
      .then(() => true)
      .catch((error: unknown) => {
        showWriteProblem(error);
        return false;
      })
      .finally(() => setWrites((count) => count - 1));
  };

  const remove = () => {
    const previous = line.quantity;
    const productId = line.productId;
    onBeforeRemove?.(productId);
    const toastId = toast.success(`Removed ${title}`, {
      id: `cart-removed-${productId}`,
      duration: UNDO_MS,
      action: {
        label: 'Undo',
        onClick: () => {
          setLine(productId, previous).catch(showWriteProblem);
        },
      },
    });
    void write(0).then((saved) => {
      if (!saved) toast.dismiss(toastId);
    });
  };

  return (
    <li className={`grid grid-cols-[4rem_minmax(0,1fr)] gap-x-3 gap-y-2 py-4 lg:items-center lg:gap-x-4 ${LINE_COLUMNS}`}>
      <div aria-hidden="true" className="row-span-2 flex size-16 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground lg:row-span-1">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element -- hosts are pinned by the CSP `img-src`; the box fixes the size
          <img src={image} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
        ) : (
          <ImageOff className="size-6" />
        )}
      </div>

      <div className="flex min-w-0 flex-col items-start gap-1">
        {product ? (
          <Link ref={primaryRef} href={productHref(line.productId)} className="[overflow-wrap:anywhere] font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            {product.title}
          </Link>
        ) : (
          <p className="break-words font-medium text-muted-foreground">{detailsUnavailable ? 'Details unavailable right now' : 'Unavailable product'}</p>
        )}
        {!product && !detailsUnavailable ? <p className="text-sm text-destructive">No longer available</p> : null}
        {product && !product.inStock ? <p className="text-sm font-medium text-destructive">Out of stock</p> : null}
        <Button ref={product ? undefined : primaryRef} type="button" variant="ghost" className="-ml-2 min-h-11 px-2 text-destructive hover:text-destructive lg:min-h-8" onClick={remove}>
          Remove <span className="sr-only">{title}</span>
        </Button>
      </div>

      <p className="col-start-2 text-sm text-muted-foreground lg:col-start-auto lg:text-right lg:text-base lg:text-foreground">
        <span className="sr-only">Price: </span>
        {product ? formatMoney(product.priceMinor, product.currency) : '—'}
      </p>

      <div className="col-span-2 flex items-start justify-between gap-3 lg:contents">
        <QuantityControl title={title} quantity={line.quantity} busy={writes > 0} onChange={(quantity) => void write(quantity)} />
        <p className="[overflow-wrap:anywhere] text-right font-semibold lg:text-base">
          <span className="sr-only">Total: </span>
          {product && total !== null ? formatMoney(total, product.currency) : '—'}
        </p>
      </div>
    </li>
  );
}
