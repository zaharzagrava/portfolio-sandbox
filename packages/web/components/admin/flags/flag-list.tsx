'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { Flag, FlagPage } from '@marketplace-sandbox/contracts';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { Button } from '@/components/ui/button';
import { useFlags } from '@/hooks/use-admin-flags';
import { readFlagProblem } from '@/lib/api/admin-flags';
import { flagHref, listHref, NEW_FLAG_PATH, type ListStatus } from '@/lib/admin/flags/params';
import { formatUtc } from '@/lib/admin/flags/format-time';
import { FlagListSkeleton } from './flag-list-skeleton';
import { FlagProblemAlert } from './flag-problem';
import { FlagRowActions } from './flag-row-actions';
import { StatusBadge } from './status-badge';
import { StatusTabs } from './status-tabs';

/** A 64-character key, a 500-character description or a long address wraps inside its cell and never widens the page (AS-60). */
export const WRAP = '[overflow-wrap:anywhere]';

const Time = ({ iso }: { iso: string | null }) => (iso ? <time dateTime={iso}>{formatUtc(iso)}</time> : <span>—</span>);

const COLUMNS: Column<Flag>[] = [
  {
    id: 'key',
    header: 'Key',
    primary: true,
    cell: (flag) => (
      <Link data-flag-link href={flagHref(flag.key)} className={`font-mono underline-offset-4 hover:underline ${WRAP}`}>
        {flag.key}
      </Link>
    ),
  },
  { id: 'description', header: 'Description', cell: (flag) => (flag.description ? <span className={WRAP}>{flag.description}</span> : <span aria-label="No description">—</span>) },
  { id: 'status', header: 'Status', cell: (flag) => <StatusBadge status={flag.status} /> },
  { id: 'owner', header: 'Owner', cell: (flag) => <span className={WRAP}>{flag.owner}</span> },
  { id: 'client', header: 'Client-side', cell: (flag) => <span>{flag.clientSide ? 'Yes' : 'No'}</span> },
  { id: 'expires', header: 'Expires', cell: (flag) => <Time iso={flag.expiresAt} /> },
  { id: 'updated', header: 'Updated', cell: (flag) => <Time iso={flag.updatedAt} /> },
];

/**
 * The flag list (W06 AS-01..AS-08, AS-65): the page of the URL's status and cursor, exactly as the API returns it (key order;
 * nothing is sorted or filtered here). `initialData` is the server's first answer (hydrated), so the first paint has rows.
 */
export function FlagList({ status, cursor, initialData }: { status: ListStatus; cursor?: string; initialData?: FlagPage }) {
  const query = useFlags({ status, cursor }, initialData);
  const data = query.data;
  const tableRef = useRef<HTMLDivElement>(null);
  const focused = useRef<number | null>(null);
  const keys = data?.items.map((flag) => flag.key).join('|') ?? '';

  // A removed row's focus falls to the next row's link, never to the top of the page (AS-65).
  useEffect(() => {
    const rows = tableRef.current?.querySelectorAll<HTMLElement>('[data-flag-link]');
    if (focused.current === null || !rows || rows.length === 0) return;
    const active = document.activeElement;
    if (!active || active === document.body) rows[Math.min(focused.current, rows.length - 1)]?.focus();
  }, [keys]);

  let body;
  if (!data) {
    body = query.isError ? (
      <FlagProblemAlert problem={readFlagProblem(query.error)} op="list" onRetry={() => void query.refetch()} />
    ) : (
      <FlagListSkeleton />
    );
  } else if (data.items.length === 0) {
    body =
      status === 'all' && !cursor ? (
        <div className="space-y-3 rounded-xl border bg-background p-6">
          <p>No feature flags yet.</p>
          <Button asChild className="min-h-11 sm:min-h-8">
            <Link href={NEW_FLAG_PATH}>New flag</Link>
          </Button>
        </div>
      ) : (
        <div className="space-y-3 rounded-xl border bg-background p-6">
          <p>{status === 'all' ? 'No more flags.' : `No ${status} flags.`}</p>
          <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
            <Link href={listHref({ status: 'all' })}>Show all active flags</Link>
          </Button>
        </div>
      );
  } else {
    body = (
      <div
        ref={tableRef}
        onFocusCapture={(event) => {
          const row = (event.target as HTMLElement).closest('tr');
          const rows = [...(tableRef.current?.querySelectorAll('tbody tr') ?? [])];
          const at = row ? rows.indexOf(row) : -1;
          focused.current = at >= 0 ? at : null;
        }}
        className="rounded-xl border bg-background p-2 sm:p-4"
      >
        <ResponsiveTable
          caption="Feature flags"
          captionHidden
          columns={COLUMNS}
          rows={data.items}
          rowKey={(flag) => flag.key}
          actions={(flag) => <FlagRowActions flag={flag} />}
          busy={query.isFetching && query.isPlaceholderData}
        />
        <nav aria-label="Pages" className="flex flex-wrap items-center gap-3 px-2 pt-3 text-sm">
          <p className="text-muted-foreground">Showing {data.items.length} {data.items.length === 1 ? 'flag' : 'flags'}</p>
          {cursor && (
            <Link href={listHref({ status })} className="underline underline-offset-4">
              First page
            </Link>
          )}
          {data.nextCursor && (
            <Link href={listHref({ status, cursor: data.nextCursor })} className="underline underline-offset-4">
              Next page
            </Link>
          )}
        </nav>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <StatusTabs status={status} />
      {data && query.isError && (
        <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-amber-900 dark:text-amber-100">
          Couldn&apos;t refresh. Showing the last loaded list.
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-7" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </p>
      )}
      {body}
    </div>
  );
}
