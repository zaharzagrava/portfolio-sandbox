'use client';

import { beginListNavigation, useListNavigationPending } from '@/components/dashboard/navigation-pending';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PlusIcon } from 'lucide-react';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { TableRowsSkeleton } from '@/components/seller/page-skeletons';
import { ProblemPanel, SectionError } from '@/components/seller/problem-states';
import { RowMenu } from '@/components/seller/row-menu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useShop } from '@/lib/api/seller';
import { fetchProduct, useInventory, useRestoreProduct, type InventoryPage, type InventoryRow } from '@/lib/api/seller-products';
import { shopCan, useShopWritable } from '@/lib/seller/permissions';
import { buildQuery, rawFromSearchParams, readInventoryParams, type InventoryParams } from '@/lib/seller/search-params';
import { useCanonicalSearch } from '@/lib/seller/use-canonical-search';
import { STOCK_LABEL, stockStatus } from '@/lib/seller/stock';
import { formatMoney } from '@/lib/utils';
import { ArchiveDialog } from './archive-dialog';
import { InventoryToolbar, SEARCH_MAX } from './inventory-toolbar';
import { ProductDialog } from './product-form';
import { StockPopover } from './stock-popover';

type Currency = { code: string; fractionDigits: number };

const URL_KEYS = ['q', 'status', 'inStock', 'cursor'] as const;

const sameParams = (a: InventoryParams, b: InventoryParams) => a.q === b.q && a.status === b.status && a.inStock === b.inStock && a.cursor === b.cursor;

/** The shop search refuses text over 100 characters with a 400 `validation_failed`: say that, instead of a vague field error. */
const tooLongSearch = (error: unknown, q: string) => problemFromError(error).code === 'validation_failed' && [...q.trim()].length > SEARCH_MAX;

function InventorySkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton aria-hidden="true" className="h-8 w-full max-sm:hidden" />
      <TableRowsSkeleton name="inventory" />
    </div>
  );
}

/**
 * The inventory page of a shop (W04 US3, FR-025..FR-029): the member list or the shop search, with status tabs and stock
 * filter in the URL, keyset paging, and the row actions for members who hold `products.write`. The server page seeds the
 * first page (`initialData`); the URL is the state afterwards.
 */
export function InventoryView({
  shopId,
  serverParams,
  initialData,
  currency,
}: {
  shopId: string;
  /** The parameters the server page read; `initialData` belongs to them. */
  serverParams: InventoryParams;
  initialData?: InventoryPage;
  /** `PLATFORM_CURRENCY`; absent: products cannot be created. */
  currency?: Currency;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? `/dashboard/seller/${shopId}/inventory`;
  const searchParams = useSearchParams();
  const params = readInventoryParams(rawFromSearchParams(new URLSearchParams(searchParams.toString())));
  useCanonicalSearch(URL_KEYS, buildQuery({ q: params.q, status: params.status, inStock: params.inStock, cursor: params.cursor }, { status: 'ACTIVE' }));
  const shopQuery = useShop(shopId);
  const shop = shopQuery.data;
  const { writable, reason } = useShopWritable(shop);
  const canWrite = shopCan(shop, 'products.write');
  const inventory = useInventory(shopId, params, initialData && sameParams(params, serverParams) ? initialData : undefined);
  const restore = useRestoreProduct(shopId);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<InventoryRow | null>(null);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [actionProblem, setActionProblem] = useState<Problem | null>(null);
  // A rate-limit countdown after a failed restore: "Restore" stays disabled until it ends (B-098).
  const [counting, setCounting] = useState(false);

  const hrefFor = (next: Partial<Pick<InventoryParams, 'q' | 'status' | 'inStock'>>, cursor?: string) => {
    const merged = { q: params.q, status: params.status, inStock: params.inStock, ...next };
    const query = buildQuery({ q: merged.q, status: merged.status, inStock: merged.inStock, cursor }, { status: 'ACTIVE' });
    return query ? `${pathname}?${query}` : pathname;
  };

  async function restoreRow(row: InventoryRow) {
    setActionProblem(null);
    try {
      const expectedVersion = row.version ?? (await fetchProduct(shopId, row.id)).version;
      await restore.mutateAsync({ productId: row.id, expectedVersion });
      toast.success('Product restored');
    } catch (error) {
      setActionProblem(problemFromError(error));
    }
  }

  const listPending = useListNavigationPending();

  if (!shop) return <InventorySkeleton />;

  const searching = params.q.trim().length > 0;
  const data = inventory.data;
  const busy = inventory.isPlaceholderData || listPending;
  const addDisabled = !writable || !currency;
  const addNote = !writable ? reason : !currency ? "Adding products isn't set up on this platform yet." : null;

  const columns: Column<InventoryRow>[] = [
    { id: 'name', header: 'Name', primary: true, cell: (row) => row.title },
    { id: 'price', header: 'Price', cell: (row) => formatMoney(row.priceMinor, row.currency) },
    {
      id: 'stock',
      header: 'Stock',
      cell: (row) => (
        <StockPopover shopId={shopId} row={row} open={adjusting === row.id} onOpenChange={(open) => setAdjusting(open ? row.id : null)} onStale={setActionProblem}>
          {row.quantity}
        </StockPopover>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => {
        const status = stockStatus(row.quantity, row.status);
        return (
          <span className="inline-flex flex-wrap gap-1">
            {data?.source === 'search' && row.status === 'ACTIVE' && <Badge variant="outline">Active</Badge>}
            <Badge variant={status === 'in' ? 'secondary' : status === 'archived' ? 'outline' : 'destructive'}>{STOCK_LABEL[status]}</Badge>
          </span>
        );
      },
    },
  ];

  function menuFor(row: InventoryRow) {
    const active = row.status === 'ACTIVE';
    return [
      { id: 'edit', label: 'Edit', hidden: !canWrite || !active, onSelect: () => (setActionProblem(null), setEditing(row.id)) },
      { id: 'stock', label: 'Adjust stock', hidden: !canWrite || !active, onSelect: () => (setActionProblem(null), setAdjusting(row.id)) },
      { id: 'media', label: 'Photos and video', hidden: !canWrite || !active, onSelect: () => router.push(`/dashboard/seller/${encodeURIComponent(shopId)}/products/${encodeURIComponent(row.id)}/media`) },
      { id: 'draft', label: 'Edit together', hidden: !canWrite || !active, onSelect: () => router.push(`/dashboard/seller/${encodeURIComponent(shopId)}/products/${encodeURIComponent(row.id)}/draft`) },
      { id: 'archive', label: 'Archive', hidden: !canWrite || !active, destructive: true, onSelect: () => (setActionProblem(null), setArchiving(row)) },
      { id: 'restore', label: 'Restore', hidden: !canWrite || active, disabled: counting && actionProblem !== null, onSelect: () => void restoreRow(row) },
    ];
  }

  function empty() {
    if (params.cursor) {
      return (
        <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
          <p>No products on this page.</p>
          <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
            <Link href={pathname}>First page</Link>
          </Button>
        </div>
      );
    }
    if (searching) {
      return (
        <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
          <p>No products match “{params.q.trim()}”.</p>
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => router.replace(hrefFor({ q: '' }))}>
            Clear search
          </Button>
        </div>
      );
    }
    if (params.status === 'ARCHIVED') {
      return (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p>No archived products.</p>
        </div>
      );
    }
    if (params.inStock !== undefined) {
      return (
        <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
          <p>No products match these filters.</p>
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => router.push(pathname)}>
            Clear filters
          </Button>
        </div>
      );
    }
    return (
      <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
        <p>No products yet.</p>
        {canWrite && (
          <Button type="button" className="min-h-11 sm:min-h-8" disabled={addDisabled} onClick={() => setCreating(true)}>
            Add product
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
          <h1 className="text-2xl font-bold tracking-tight">Inventory</h1>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">The products of {shop.name}.</p>
        </div>
        {canWrite && (
          <div className="flex flex-col items-end gap-1">
            <Button type="button" className="min-h-11 sm:min-h-8" disabled={addDisabled} aria-describedby={addNote ? 'inventory-add-note' : undefined} onClick={() => setCreating(true)}>
              <PlusIcon aria-hidden="true" />
              Add product
            </Button>
            {addNote && (
              <p id="inventory-add-note" role={writable ? 'alert' : undefined} className="max-w-xs text-right text-xs text-muted-foreground">
                {addNote}
              </p>
            )}
          </div>
        )}
      </div>

      <InventoryToolbar
        params={params}
        onSearch={(q) => router.replace(hrefFor({ q }))}
        onStatus={(status) => router.push(hrefFor({ status }))}
        onStock={(inStock) => router.push(hrefFor({ inStock }))}
        onClear={() => router.push(pathname)}
      />

      {actionProblem && <ProblemPanel problem={actionProblem} context={{ place: 'page' }} onActiveChange={setCounting} />}

      <div role="region" aria-label="Products">
        {inventory.isError && tooLongSearch(inventory.error, params.q) ? (
          <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
            That search is too long. Use at most {SEARCH_MAX} characters.
          </p>
        ) : inventory.isError ? (
          <SectionError error={inventory.error} onRetry={() => void inventory.refetch()} firstPageHref={pathname} />
        ) : !data ? (
          <InventorySkeleton />
        ) : data.items.length === 0 && !busy ? (
          empty()
        ) : (
          <div className="space-y-4">
            <ResponsiveTable
              caption={`Products of ${shop.name}`}
              captionHidden
              columns={columns}
              rows={data.items}
              rowKey={(row) => row.id}
              busy={busy}
              actions={(row) => <RowMenu label={row.title} items={menuFor(row)} disabledReason={writable ? null : reason} />}
            />
            {!busy && (params.cursor || data.nextCursor) && (
              <nav aria-label="Pages" className="flex items-center justify-between gap-3">
                {params.cursor ? (
                  <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
                    <Link href={hrefFor({})} onClick={beginListNavigation}>First page</Link>
                  </Button>
                ) : (
                  <span />
                )}
                {data.nextCursor && (
                  <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
                    <Link href={hrefFor({}, data.nextCursor)} onClick={beginListNavigation}>Next page</Link>
                  </Button>
                )}
              </nav>
            )}
          </div>
        )}
      </div>

      <ProductDialog open={creating} onOpenChange={setCreating} mode="create" shopId={shopId} currency={currency} />
      <ProductDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} mode="edit" shopId={shopId} productId={editing ?? undefined} />
      <ArchiveDialog shopId={shopId} row={archiving} onClose={() => setArchiving(null)} onStale={setActionProblem} />
    </div>
  );
}
