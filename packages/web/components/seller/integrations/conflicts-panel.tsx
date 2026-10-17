'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { NativeSelect, Instant, PageLinks } from '@/components/seller/developers/shared';
import { ProblemPanel, SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useDismissStockConflict, useStockConflicts, type StockConflict } from '@/lib/api/seller-integrations';
import { kindLabel } from './labels';
import { detailHref } from './params';

/** The stock conflicts a sync could not settle on its own (S08): what each side had, what was kept, and "Dismiss" for an open one. */
export function ConflictsPanel({ shopId, integrationId, pathname, status, cursor, canWrite, writable }: { shopId: string; integrationId: string; pathname: string; status: string; cursor?: string; canWrite: boolean; writable: boolean }) {
  const router = useRouter();
  const filterId = useId();
  const list = useStockConflicts(shopId, integrationId, { status, cursor });
  const dismiss = useDismissStockConflict(shopId, integrationId);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function onDismiss(conflict: StockConflict) {
    setProblem(null);
    try {
      await dismiss.mutateAsync(conflict.id);
    } catch (error) {
      setProblem(problemFromError(error));
    }
  }

  const columns: Column<StockConflict>[] = [
    { id: 'item', header: 'Product', primary: true, cell: (row) => <span className="break-all font-mono text-xs">{row.externalId}</span> },
    { id: 'kind', header: 'Kind', cell: (row) => kindLabel(row.kind) },
    { id: 'what', header: 'What happened', cell: (row) => `Was ${row.base}, you changed it to ${row.local}, the store to ${row.remote}` },
    { id: 'result', header: 'Result', cell: (row) => `Resolved to ${row.resolvedTo}` },
    { id: 'status', header: 'Status', cell: (row) => <Badge variant={row.status === 'OPEN' ? 'secondary' : 'outline'}>{row.status === 'OPEN' ? 'Open' : 'Dismissed'}</Badge> },
    { id: 'created', header: 'Opened', cell: (row) => <Instant value={row.createdAt} /> },
  ];

  return (
    <section aria-labelledby="conflicts-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="conflicts-heading" className="text-lg font-semibold">
          Stock conflicts
        </h2>
        <div className="flex items-center gap-2">
          <label htmlFor={filterId} className="text-sm font-medium">
            Show
          </label>
          <NativeSelect id={filterId} value={status} className="w-auto" onChange={(event) => router.push(detailHref(pathname, { tab: 'conflicts', status: event.target.value }))}>
            <option value="OPEN">Open</option>
            <option value="DISMISSED">Dismissed</option>
          </NativeSelect>
        </div>
      </div>
      {problem && <ProblemPanel problem={problem} context={{ place: 'dialog' }} subject="requests" />}
      {list.isError && !list.data ? (
        <SectionError error={list.error} onRetry={() => void list.refetch()} firstPageHref={detailHref(pathname, { tab: 'conflicts' })} />
      ) : !list.data ? (
        <div role="status" aria-label="Loading conflicts" className="h-24 animate-pulse rounded-lg bg-muted" />
      ) : list.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{status === 'OPEN' ? 'No open conflicts.' : 'No conflicts.'}</p>
      ) : (
        <>
          <ResponsiveTable
            caption="Stock conflicts"
            captionHidden
            columns={columns}
            rows={list.data.items}
            rowKey={(row) => row.id}
            busy={list.isPlaceholderData}
            actions={
              canWrite
                ? (row) =>
                    row.status === 'OPEN' ? (
                      <Button type="button" variant="outline" size="sm" aria-label={`Dismiss conflict for ${row.externalId}`} disabled={!writable || dismiss.isPending} onClick={() => void onDismiss(row)}>
                        Dismiss
                      </Button>
                    ) : null
                : undefined
            }
          />
          <PageLinks
            firstHref={cursor ? detailHref(pathname, { tab: 'conflicts', status }) : undefined}
            nextHref={list.data.nextCursor ? detailHref(pathname, { tab: 'conflicts', status, cursor: list.data.nextCursor }) : null}
          />
        </>
      )}
    </section>
  );
}
