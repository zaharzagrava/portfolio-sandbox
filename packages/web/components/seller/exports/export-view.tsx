'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ProblemPanel } from '@/components/seller/problem-states';
import { TableRowsSkeleton } from '@/components/seller/page-skeletons';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { newIdempotencyKey } from '@/lib/api/idempotency';
import { useShop } from '@/lib/api/seller';
import {
  activeExportIdOf,
  applyExportEvent,
  cancelExport,
  fetchExportDownload,
  isExportTerminal,
  parseExportEvent,
  startExport,
  useExportRecord,
  useExports,
  type ExportFailureCode,
  type OrderExport,
  type OrderExportStatus,
} from '@/lib/api/seller-exports';
import { queryKeys } from '@/lib/query-keys';
import { subscribeTopic } from '@/lib/realtime/user-stream';
import { formatInstant } from '@/lib/seller/format-date';
import { shopWritable } from '@/lib/seller/permissions';

const STATUS_LABEL: Record<OrderExportStatus, string> = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  DONE: 'Done',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

const STATUS_VARIANT: Record<OrderExportStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  QUEUED: 'secondary',
  RUNNING: 'secondary',
  DONE: 'default',
  FAILED: 'destructive',
  CANCELLED: 'outline',
  EXPIRED: 'outline',
};

/** One fixed sentence per failure code (S12 `export-failure.ts`): the server's own text is never shown. */
const FAILURE_COPY: Record<ExportFailureCode, string> = {
  storage_unavailable: 'The file could not be stored. Start a new export.',
  catalog_unavailable: 'Product data was not available. Start a new export.',
  database_unavailable: 'Order data was not available. Start a new export.',
  row_limit_exceeded: 'There are more orders than one export can hold.',
  timeout: 'The export took too long. Start a new export.',
  shop_not_found: 'The shop is no longer available.',
  attempts_exhausted: 'The export could not be finished. Start a new export.',
  internal_error: 'The export failed. Start a new export.',
};

const ALREADY_RUNNING = 'An export is already running. Showing it.';

function Bar({ label, value }: { label: string; value: number }) {
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Opens a short-lived address by a click on a throwaway link (a download, never a stored address). */
function openAddress(url: string) {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * Order export (W04 US10, S12): one export at a time per shop. Start, follow `order-export:<exportId>` and download through
 * `GET …/download` only. A start that meets a running export (`409 export_already_active`) opens that export (L-010).
 */
export function ExportView({ shopId }: { shopId: string }) {
  const queryClient = useQueryClient();
  const shop = useShop(shopId).data;
  const { writable, reason } = shopWritable(shop);

  const [activeId, setActiveId] = useState<string | undefined>();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const key = useRef<string | null>(null);

  const record = useExportRecord(shopId, activeId);
  const list = useExports(shopId);
  const active = record.data;
  const terminal = active ? isExportTerminal(active.status) : false;

  const recordKey = (id: string) => queryKeys.seller.exports(shopId, 'record', id);
  const refresh = (id: string) => {
    void queryClient.invalidateQueries({ queryKey: recordKey(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.seller.exports(shopId, 'list') });
  };

  // The live topic of the export in view, while it can still change.
  useEffect(() => {
    if (!activeId || terminal) return;
    return subscribeTopic(
      `order-export:${activeId}`,
      (event) => {
        if (event.type === 'resync' || event.type === 'revoked') {
          void queryClient.invalidateQueries({ queryKey: queryKeys.seller.exports(shopId, 'record', activeId) });
          return;
        }
        const parsed = parseExportEvent(event.type, event.data);
        if (parsed) applyExportEvent(queryClient, shopId, activeId, parsed);
      },
      ['progress', 'done', 'failed', 'cancelled'],
    );
  }, [activeId, terminal, shopId, queryClient]);

  const start = useMutation({
    mutationFn: () => {
      key.current ??= newIdempotencyKey();
      return startExport(shopId, key.current);
    },
    onMutate: () => {
      setProblem(null);
      setNotice(null);
    },
    onSuccess: (created) => {
      key.current = null;
      queryClient.setQueryData(recordKey(created.exportId), created);
      void queryClient.invalidateQueries({ queryKey: queryKeys.seller.exports(shopId, 'list') });
      setActiveId(created.exportId);
    },
    onError: (error) => {
      const next = problemFromError(error);
      const existing = next.code === 'export_already_active' ? activeExportIdOf(error) : undefined;
      if (existing) {
        key.current = null;
        setNotice(ALREADY_RUNNING);
        setActiveId(existing);
        refresh(existing);
        return;
      }
      setProblem(next);
    },
  });

  const cancel = useMutation({
    mutationFn: (id: string) => cancelExport(shopId, id),
    onMutate: () => setProblem(null),
    onSuccess: (cancelled) => {
      queryClient.setQueryData(recordKey(cancelled.exportId), cancelled);
      void queryClient.invalidateQueries({ queryKey: queryKeys.seller.exports(shopId, 'list') });
    },
    onError: (error, id) => {
      setProblem(problemFromError(error));
      refresh(id);
    },
  });

  const download = useMutation({
    mutationFn: (id: string) => fetchExportDownload(shopId, id),
    onMutate: () => setProblem(null),
    onSuccess: (link) => openAddress(link.url),
    onError: (error, id) => {
      setProblem(problemFromError(error));
      refresh(id);
    },
  });

  const columns: Column<OrderExport>[] = [
    {
      id: 'started',
      header: 'Started',
      primary: true,
      cell: (row) => {
        const at = formatInstant(row.createdAt);
        return (
          <time dateTime={at.iso} title={at.utc}>
            {at.text}
          </time>
        );
      },
    },
    { id: 'status', header: 'Status', cell: (row) => <Badge variant={STATUS_VARIANT[row.status]}>{STATUS_LABEL[row.status]}</Badge> },
    { id: 'rows', header: 'Rows', cell: (row) => row.rowsWritten },
  ];

  const running = start.isPending;
  const inFlight = !!active && !terminal;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Order export</h1>
        <p className="text-sm text-muted-foreground">Export the orders of this shop as a CSV file. One export runs at a time.</p>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button type="button" className="min-h-11 sm:min-h-8" disabled={!writable || running || inFlight} aria-describedby={!writable ? 'export-reason' : undefined} onClick={() => start.mutate()}>
            Start export
          </Button>
        </div>
        {!writable && reason && (
          <p id="export-reason" className="text-sm text-muted-foreground">
            {reason}
          </p>
        )}
      </div>

      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {problem && <ProblemPanel problem={problem} context={{ place: 'page' }} />}

      {active && (
        <section aria-label="Export progress" data-testid="export-progress" className="space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Status</span>
            <span data-testid="export-status" className="font-medium">
              {STATUS_LABEL[active.status]}
            </span>
          </div>
          {active.status === 'RUNNING' && active.totalRows ? <Bar label="Export progress" value={(active.rowsWritten / active.totalRows) * 100} /> : null}
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Rows written</dt>
              <dd className="text-lg font-semibold tabular-nums" data-testid="export-rows">
                {active.rowsWritten}
              </dd>
            </div>
            {active.totalRows !== null && (
              <div>
                <dt className="text-xs text-muted-foreground">Rows in total</dt>
                <dd className="text-lg font-semibold tabular-nums">{active.totalRows}</dd>
              </div>
            )}
          </dl>
          {active.failure && <p className="text-sm text-destructive">{FAILURE_COPY[active.failure.code]}</p>}
          {active.status === 'DONE' && active.expiresAt && <p className="text-sm text-muted-foreground">The file is kept until {formatInstant(active.expiresAt).text}.</p>}
          <div className="flex flex-wrap gap-2">
            {!terminal && (
              <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={!writable || cancel.isPending} onClick={() => cancel.mutate(active.exportId)}>
                Cancel export
              </Button>
            )}
            {active.status === 'DONE' && (
              <Button type="button" className="min-h-11 sm:min-h-8" disabled={download.isPending} onClick={() => download.mutate(active.exportId)}>
                Download file
              </Button>
            )}
          </div>
        </section>
      )}

      <section aria-label="Earlier exports" className="space-y-3">
        <h2 className="text-lg font-semibold">Earlier exports</h2>
        {list.isError ? (
          <ProblemPanel problem={problemFromError(list.error)} context={{ kind: 'read' }} onRetry={() => void list.refetch()} />
        ) : !list.data ? (
          <TableRowsSkeleton name="exports" rows={3} />
        ) : list.data.items.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm">No exports yet.</p>
        ) : (
          <ResponsiveTable
            caption="Earlier exports"
            captionHidden
            columns={columns}
            rows={list.data.items}
            rowKey={(row) => row.exportId}
            actions={(row) => (
              <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-7" onClick={() => setActiveId(row.exportId)}>
                View
              </Button>
            )}
          />
        )}
      </section>
    </div>
  );
}
