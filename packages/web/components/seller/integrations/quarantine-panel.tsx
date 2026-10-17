'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { NativeSelect, Instant, PageLinks } from '@/components/seller/developers/shared';
import { ProblemPanel, SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useDismissQuarantine, useQuarantine, useRetryQuarantine, type QuarantineItem } from '@/lib/api/seller-integrations';
import { detailHref } from './params';

const STATUS_LABEL: Record<string, string> = { OPEN: 'Open', RESOLVED: 'Resolved', DISMISSED: 'Dismissed' };
const subject = (item: QuarantineItem) => item.externalId ?? item.entity;

function statusText(item: QuarantineItem): string {
  if (item.status === 'RESOLVED') return item.resolution === 'expired' ? 'Closed: gone from the store' : 'Fixed in the store';
  return STATUS_LABEL[item.status] ?? item.status;
}

/**
 * The items the sync refused (S08 quarantine): the reason as plain text, how often and when it was seen, "Retry" (checks the
 * item again: `resolved` or `still_invalid`, and an item that is gone from the store is closed with resolution `expired`)
 * and "Dismiss" after a confirmation. Writes need `integrations.manage` (`canWrite`).
 */
export function QuarantinePanel({ shopId, integrationId, pathname, status, cursor, canWrite, writable }: { shopId: string; integrationId: string; pathname: string; status: string; cursor?: string; canWrite: boolean; writable: boolean }) {
  const router = useRouter();
  const filterId = useId();
  const list = useQuarantine(shopId, integrationId, { status, cursor });
  const retry = useRetryQuarantine(shopId, integrationId);
  const dismiss = useDismissQuarantine(shopId, integrationId);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [dismissing, setDismissing] = useState<QuarantineItem | null>(null);

  async function onRetry(item: QuarantineItem) {
    setNotice(null);
    setProblem(null);
    try {
      const { outcome, item: after } = await retry.mutateAsync(item.id);
      setNotice(outcome === 'still_invalid' ? 'Still invalid. Fix it in the store, then retry.' : after.resolution === 'expired' ? 'This item is gone from the store, so it was closed.' : 'The item passes now and was added.');
    } catch (error) {
      setProblem(problemFromError(error));
    }
  }

  async function onDismiss() {
    if (!dismissing) return;
    setNotice(null);
    setProblem(null);
    try {
      await dismiss.mutateAsync(dismissing.id);
      setNotice('Item dismissed.');
      setDismissing(null);
    } catch (error) {
      setProblem(problemFromError(error));
      setDismissing(null);
    }
  }

  const columns: Column<QuarantineItem>[] = [
    { id: 'item', header: 'Item', primary: true, cell: (row) => <span className="break-all font-mono text-xs">{subject(row)}</span> },
    {
      id: 'reason',
      header: 'Reason',
      cell: (row) => (
        <span className="space-y-0.5">
          <span className="block">{row.message}</span>
          <span className="block font-mono text-xs text-muted-foreground">{row.reasonCode}</span>
        </span>
      ),
    },
    {
      id: 'seen',
      header: 'Seen',
      cell: (row) => (
        <span>
          {row.occurrences === 1 ? '1 time' : `${row.occurrences} times`}, last <Instant value={row.lastSeenAt} />
        </span>
      ),
    },
    { id: 'status', header: 'Status', cell: (row) => <Badge variant={row.status === 'OPEN' ? 'secondary' : 'outline'}>{statusText(row)}</Badge> },
  ];

  return (
    <section aria-labelledby="quarantine-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="quarantine-heading" className="text-lg font-semibold">
          Quarantine
        </h2>
        <div className="flex items-center gap-2">
          <label htmlFor={filterId} className="text-sm font-medium">
            Show
          </label>
          <NativeSelect id={filterId} value={status} className="w-auto" onChange={(event) => router.push(detailHref(pathname, { tab: 'quarantine', status: event.target.value }))}>
            <option value="OPEN">Open</option>
            <option value="RESOLVED">Resolved</option>
            <option value="DISMISSED">Dismissed</option>
          </NativeSelect>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">Items from the store that could not be added because they failed a check. Fix them in the store, then retry.</p>

      {notice && <p role="status">{notice}</p>}
      {problem && <ProblemPanel problem={problem} context={{ place: 'dialog' }} subject="requests" />}

      {list.isError && !list.data ? (
        <SectionError error={list.error} onRetry={() => void list.refetch()} firstPageHref={detailHref(pathname, { tab: 'quarantine' })} />
      ) : !list.data ? (
        <div role="status" aria-label="Loading quarantine" className="h-24 animate-pulse rounded-lg bg-muted" />
      ) : list.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{status === 'OPEN' ? 'No open items.' : 'No items.'}</p>
      ) : (
        <>
          <ResponsiveTable
            caption="Quarantined items"
            captionHidden
            columns={columns}
            rows={list.data.items}
            rowKey={(row) => row.id}
            busy={list.isPlaceholderData}
            actions={
              canWrite
                ? (row) =>
                    row.status === 'OPEN' ? (
                      <span className="inline-flex flex-wrap gap-1">
                        <Button type="button" variant="outline" size="sm" aria-label={`Retry ${subject(row)}`} disabled={!writable || retry.isPending} onClick={() => void onRetry(row)}>
                          Retry
                        </Button>
                        <Button type="button" variant="ghost" size="sm" aria-label={`Dismiss ${subject(row)}`} disabled={!writable} onClick={() => (setProblem(null), setDismissing(row))}>
                          Dismiss
                        </Button>
                      </span>
                    ) : null
                : undefined
            }
          />
          <PageLinks
            firstHref={cursor ? detailHref(pathname, { tab: 'quarantine', status }) : undefined}
            nextHref={list.data.nextCursor ? detailHref(pathname, { tab: 'quarantine', status, cursor: list.data.nextCursor }) : null}
          />
        </>
      )}

      <ConfirmDialog
        open={dismissing !== null}
        onOpenChange={(open) => !open && setDismissing(null)}
        title="Dismiss this item?"
        description="It stays out of your catalogue until the store sends it again with a change."
        confirmLabel="Dismiss item"
        onConfirm={onDismiss}
      />
    </section>
  );
}
