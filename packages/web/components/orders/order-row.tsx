'use client';

import Link from 'next/link';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import type { OrderPageDto } from '@/lib/api/orders';
import { formatPlaced } from '@/lib/orders/format';
import { canCancel, canPay, shortOrderId } from '@/lib/orders/status';
import { orderHref, payHref } from '@/lib/routes';
import { formatMoney } from '@/lib/utils';
import { CancelOrderDialog } from './cancel-order-dialog';
import { StatusBadge } from './status-badge';

const CELL = 'max-md:flex max-md:items-center max-md:justify-between max-md:gap-3 md:px-3 md:py-3';

/**
 * One order of the history (W03 AS-51, FR-044): a table row on desktop, a card on mobile (the same markup, laid out by
 * CSS, so nothing depends on hover). The id is the React key and `data-order-id`.
 */
export function OrderRow({ order }: { order: OrderPageDto['items'][number] }) {
  const view = useRef<HTMLAnchorElement>(null);
  const short = shortOrderId(order.id);
  return (
    <tr data-order-id={order.id} className="border-b max-md:mb-3 max-md:block max-md:rounded-xl max-md:border max-md:p-4">
      <th scope="row" className={`${CELL} text-left font-medium`}>
        <span>Order #{short}</span>
      </th>
      <td className={CELL}>
        <time dateTime={order.createdAt}>{formatPlaced(order.createdAt)}</time>
      </td>
      <td className={CELL}>
        <StatusBadge status={order.status} />
      </td>
      <td className={`${CELL} md:text-right`}>{formatMoney(order.totalMinor, order.currency)}</td>
      <td className={`${CELL} md:text-right`}>
        <div className="flex flex-wrap gap-2 max-md:mt-2 md:justify-end">
          <Button asChild variant="outline" size="sm" className="min-h-11 sm:min-h-7">
            <Link ref={view} href={orderHref(order.id)} aria-label={`View order #${short}`}>
              View
            </Link>
          </Button>
          {canPay(order.status) && (
            <Button asChild size="sm" className="min-h-11 sm:min-h-7">
              <Link href={payHref(order.id)}>Pay now</Link>
            </Button>
          )}
          {canCancel(order.status) && <CancelOrderDialog orderId={order.id} returnFocus={() => view.current} />}
        </div>
      </td>
    </tr>
  );
}
