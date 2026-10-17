'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useState } from 'react';
import { Instant, NativeSelect, PageLinks } from '@/components/seller/developers/shared';
import { ProblemPanel, SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useShop } from '@/lib/api/seller';
import { useDismissOfflineConflict, useOfflineConflicts, type SyncConflictPage } from '@/lib/api/seller-integrations';
import { readCursor } from '@/lib/seller/search-params';
import { shopCan, useShopWritable } from '@/lib/seller/permissions';
import { kindLabel } from './labels';

type Conflict = SyncConflictPage['items'][number];

const hrefFor = (pathname: string, status: string, cursor?: string) => {
  const query = new URLSearchParams();
  if (status !== 'open') query.set('status', status);
  if (cursor) query.set('cursor', cursor);
  const text = query.toString();
  return text ? `${pathname}?${text}` : pathname;
};

/**
 * Stock changes made offline that could not be applied in full (W04 F3, S09): read and dismissed through the HTTP routes
 * only. No event is subscribed (R-14), so the list is as fresh as the last time it was fetched.
 */
export function OfflineConflictsView({ shopId }: { shopId: string }) {
  const router = useRouter();
  const pathname = usePathname() ?? `/dashboard/seller/${shopId}/integrations/offline-conflicts`;
  const query = useSearchParams();
  const status = query.get('status') === 'dismissed' ? 'dismissed' : 'open';
  const cursor = readCursor(query.get('cursor') ?? undefined);
  const filterId = useId();
  const shop = useShop(shopId).data;
  const { writable, reason } = useShopWritable(shop);
  const canWrite = shopCan(shop, 'products.write');
  const list = useOfflineConflicts(shopId, { status, cursor });
  const dismiss = useDismissOfflineConflict(shopId);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function onDismiss(conflict: Conflict) {
    setProblem(null);
    try {
      await dismiss.mutateAsync(conflict.opId);
    } catch (error) {
      setProblem(problemFromError(error));
    }
  }

  const columns: Column<Conflict>[] = [
    { id: 'product', header: 'Product', primary: true, cell: (row) => <span className="break-all font-mono text-xs">{row.productId}</span> },
    { id: 'device', header: 'Device', cell: (row) => row.deviceId },
    { id: 'kind', header: 'Kind', cell: (row) => kindLabel(row.kind) },
    {
      id: 'numbers',
      header: 'What happened',
      cell: (row) => (
        <span>
          Asked for {row.requested}, applied {row.applied}, short by {row.shortfall}. Stock after: {row.quantityAfter}
        </span>
      ),
    },
    { id: 'opened', header: 'Opened', cell: (row) => <Instant value={row.createdAt} /> },
    { id: 'status', header: 'Status', cell: (row) => <Badge variant={row.status === 'open' ? 'secondary' : 'outline'}>{row.status === 'open' ? 'Open' : 'Dismissed'}</Badge> },
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href={`/dashboard/seller/${encodeURIComponent(shopId)}/integrations`} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          Integrations
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Offline stock conflicts</h1>
        <p className="text-sm text-muted-foreground">Stock changes made offline that could not be applied in full because the stock had already changed.</p>
      </div>

      {canWrite && !writable && reason && (
        <p role="status" className="rounded-lg border px-3 py-2 text-sm">
          {reason}
        </p>
      )}

      <div className="flex items-center gap-2">
        <label htmlFor={filterId} className="text-sm font-medium">
          Show
        </label>
        <NativeSelect id={filterId} value={status} className="w-auto" onChange={(event) => router.push(hrefFor(pathname, event.target.value))}>
          <option value="open">Open</option>
          <option value="dismissed">Dismissed</option>
        </NativeSelect>
      </div>

      {problem && <ProblemPanel problem={problem} context={{ place: 'dialog' }} subject="requests" />}

      {list.isError && !list.data ? (
        <SectionError error={list.error} onRetry={() => void list.refetch()} firstPageHref={pathname} />
      ) : !list.data ? (
        <div role="status" aria-label="Loading conflicts" className="h-32 animate-pulse rounded-lg bg-muted" />
      ) : list.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{status === 'open' ? 'No open conflicts.' : 'No dismissed conflicts.'}</p>
      ) : (
        <div className="space-y-3">
          <ResponsiveTable
            caption="Offline stock conflicts"
            captionHidden
            columns={columns}
            rows={list.data.items}
            rowKey={(row) => row.opId}
            busy={list.isPlaceholderData}
            actions={
              canWrite
                ? (row) =>
                    row.status === 'open' ? (
                      <Button type="button" variant="outline" size="sm" aria-label={`Dismiss conflict for ${row.productId}`} disabled={!writable || dismiss.isPending} onClick={() => void onDismiss(row)}>
                        Dismiss
                      </Button>
                    ) : null
                : undefined
            }
          />
          <PageLinks firstHref={cursor ? hrefFor(pathname, status) : undefined} nextHref={list.data.nextCursor ? hrefFor(pathname, status, list.data.nextCursor) : null} />
        </div>
      )}
    </div>
  );
}
