'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TableRowsSkeleton } from '@/components/seller/page-skeletons';
import { useShop } from '@/lib/api/seller';
import { useShopOrders, type ShopOrderPageDto } from '@/lib/api/seller-orders';
import { buildQuery, readOrdersParams, type OrdersParams } from '@/lib/seller/search-params';
import { formatInstant } from '@/lib/seller/format-date';
import { formatMoney } from '@/lib/utils';
import { SHOP_ORDER_STATUSES } from '@marketplace-sandbox/contracts';

type Slice = ShopOrderPageDto['items'][number];

const sameParams = (a: OrdersParams, b: OrdersParams) => a.status === b.status && a.cursor === b.cursor;

/** "PARTIALLY_SHIPPED" -> "Partially Shipped": the label of a status this app does not know yet. */
export const orderStatusLabel = (status: string): string =>
  status
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

const STATUS_VARIANT: Record<string, 'secondary' | 'outline' | 'destructive' | 'default'> = { PAID: 'default', PENDING: 'secondary', CANCELLED: 'outline', REFUNDED: 'outline' };

/**
 * The order slices of a shop (W04 US8, FR-042, AS-83): newest first, a status filter and keyset paging in the URL. The
 * reference is the first 8 characters of the shop-order id; the buyer id is in the answer and is never rendered.
 */
export function OrdersView({ shopId, serverParams, initialData }: { shopId: string; serverParams: OrdersParams; initialData?: ShopOrderPageDto }) {
  const router = useRouter();
  const pathname = usePathname() ?? `/dashboard/seller/${shopId}/orders`;
  const params = readOrdersParams(Object.fromEntries(useSearchParams().entries()));
  const shop = useShop(shopId).data;
  const orders = useShopOrders(shopId, params, initialData && sameParams(params, serverParams) ? initialData : undefined);

  const hrefFor = (status: string | undefined, cursor?: string) => {
    const query = buildQuery({ status, cursor });
    return query ? `${pathname}?${query}` : pathname;
  };

  const columns: Column<Slice>[] = [
    { id: 'order', header: 'Order', primary: true, cell: (row) => <span className="font-mono">{row.shopOrderId.slice(0, 8)}</span> },
    { id: 'status', header: 'Status', cell: (row) => <Badge variant={STATUS_VARIANT[row.status] ?? 'outline'}>{orderStatusLabel(row.status)}</Badge> },
    { id: 'items', header: 'Items', cell: (row) => row.items.length },
    { id: 'subtotal', header: 'Subtotal', cell: (row) => formatMoney(row.subtotalMinor, row.currency) },
    {
      id: 'date',
      header: 'Date',
      cell: (row) => {
        const at = formatInstant(row.createdAt);
        return (
          <time dateTime={at.iso} title={at.utc}>
            {at.text}
          </time>
        );
      },
    },
  ];

  const data = orders.data;
  const busy = orders.isPlaceholderData;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Orders</h1>
        <p className="text-sm text-muted-foreground">{shop ? `The orders placed with ${shop.name}, newest first.` : 'The orders of this shop, newest first.'}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="orders-status" className="text-sm font-medium">
          Status
        </label>
        <select
          id="orders-status"
          value={params.status ?? ''}
          onChange={(event) => router.push(hrefFor(event.target.value || undefined))}
          className="h-11 rounded-lg border border-input bg-background px-3 text-sm sm:h-8"
        >
          <option value="">All statuses</option>
          {SHOP_ORDER_STATUSES.map((status) => (
            <option key={status} value={status}>
              {orderStatusLabel(status)}
            </option>
          ))}
        </select>
      </div>

      <div role="region" aria-label="Orders">
        {orders.isError ? (
          <SectionError error={orders.error} onRetry={() => void orders.refetch()} firstPageHref={pathname} />
        ) : !data ? (
          <TableRowsSkeleton name="orders" />
        ) : data.items.length === 0 && !busy ? (
          <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
            {params.cursor ? (
              <>
                <p>No orders on this page.</p>
                <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
                  <Link href={hrefFor(params.status)}>First page</Link>
                </Button>
              </>
            ) : params.status ? (
              <>
                <p>No orders match this status.</p>
                <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
                  <Link href={pathname}>Clear filter</Link>
                </Button>
              </>
            ) : (
              <p>No orders yet.</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <ResponsiveTable caption={`Orders of ${shop?.name ?? 'this shop'}`} captionHidden columns={columns} rows={data.items} rowKey={(row) => row.shopOrderId} busy={busy} />
            {!busy && (params.cursor || data.nextCursor) && (
              <nav aria-label="Pages" className="flex items-center justify-between gap-3">
                {params.cursor ? (
                  <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
                    <Link href={hrefFor(params.status)}>First page</Link>
                  </Button>
                ) : (
                  <span />
                )}
                {data.nextCursor && (
                  <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
                    <Link href={hrefFor(params.status, data.nextCursor)}>Next page</Link>
                  </Button>
                )}
              </nav>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
