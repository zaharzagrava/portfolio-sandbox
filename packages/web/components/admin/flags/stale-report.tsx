'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { StaleFlags } from '@marketplace-sandbox/contracts';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { useStaleFlags } from '@/hooks/use-admin-flags';
import { readFlagProblem } from '@/lib/api/admin-flags';
import { formatUtc } from '@/lib/admin/flags/format-time';
import { flagHref, staleHref, STALE_WINDOWS } from '@/lib/admin/flags/params';
import { FlagProblemAlert } from './flag-problem';
import { StaleSkeleton } from './stale-skeleton';
import { StatusBadge } from './status-badge';

type Row = StaleFlags['items'][number];

const Time = ({ iso }: { iso: string | null }) => (iso ? <time dateTime={iso}>{formatUtc(iso)}</time> : <span>—</span>);

/**
 * The stale-flag report (W06 AS-45, AS-46): expired flags and flags nobody evaluated in the window. Items are shown in the order
 * returned; a row links to its flag and the report has no actions of its own. The window is a choice in the URL.
 */
export function StaleReport({ days, initialData }: { days: number; initialData?: StaleFlags }) {
  const router = useRouter();
  const query = useStaleFlags({ days }, initialData);
  const data = query.data;
  const windows = (STALE_WINDOWS as readonly number[]).includes(days) ? [...STALE_WINDOWS] : [...STALE_WINDOWS, days].sort((a, b) => a - b);

  const columns: Column<Row>[] = [
    {
      id: 'key',
      header: 'Key',
      primary: true,
      cell: (row) => (
        <Link href={flagHref(row.key)} className="font-mono [overflow-wrap:anywhere] underline-offset-4 hover:underline">
          {row.key}
        </Link>
      ),
    },
    { id: 'owner', header: 'Owner', cell: (row) => <span className="[overflow-wrap:anywhere]">{row.owner}</span> },
    { id: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
    { id: 'reason', header: 'Reason', cell: (row) => <span>{row.reason === 'expired' ? 'Expired' : `Not evaluated in the last ${data?.days ?? days} days`}</span> },
    { id: 'expires', header: 'Expires', cell: (row) => <Time iso={row.expiresAt} /> },
    { id: 'created', header: 'Created', cell: (row) => <Time iso={row.createdAt} /> },
    { id: 'evaluations', header: 'Evaluations', cell: (row) => <span>{row.evaluations}</span> },
  ];

  let body;
  if (!data) {
    body = query.isError ? <FlagProblemAlert problem={readFlagProblem(query.error)} op="stale" onRetry={() => void query.refetch()} /> : <StaleSkeleton />;
  } else if (data.items.length === 0) {
    body = (
      <p className="rounded-xl border bg-background p-6">
        No stale flags. Nothing has expired and every flag has been evaluated in the last {data.days} days.
      </p>
    );
  } else {
    body = (
      <div className="rounded-xl border bg-background p-2 sm:p-4">
        <ResponsiveTable caption="Stale flags" captionHidden columns={columns} rows={data.items} rowKey={(row) => row.key} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-prose text-sm text-muted-foreground">
          Evaluation counts are approximate. Expiry is a reminder only: it never changes how a flag evaluates. Archived flags are not listed.
        </p>
        <div className="flex items-center gap-2 text-sm max-sm:w-full">
          <label htmlFor="stale-window">Window</label>
          <select
            id="stale-window"
            value={days}
            onChange={(event) => router.push(staleHref(Number(event.target.value)))}
            className="min-h-11 rounded-md border bg-background px-2 sm:min-h-8"
          >
            {windows.map((value) => (
              <option key={value} value={value}>
                {value} days
              </option>
            ))}
          </select>
        </div>
      </div>
      {data && query.isError && <p role="status" className="text-sm text-amber-900 dark:text-amber-100">Couldn&apos;t refresh. Showing the last loaded report.</p>}
      {body}
    </div>
  );
}
