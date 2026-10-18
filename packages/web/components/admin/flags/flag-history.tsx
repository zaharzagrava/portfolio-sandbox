'use client';

import Link from 'next/link';
import type { FlagAuditPage } from '@marketplace-sandbox/contracts';
import { useFlagHistory } from '@/hooks/use-admin-flags';
import { useAuth } from '@/hooks/use-auth';
import { readFlagProblem } from '@/lib/api/admin-flags';
import { historyHref } from '@/lib/admin/flags/params';
import { FlagProblemAlert } from './flag-problem';
import { HistoryEntry } from './history-entry';
import { HistorySkeleton } from './history-skeleton';

/**
 * The audit trail of one flag (W06 AS-40..AS-44): newest first, the viewer's own changes as "You", paged by the cursor in the
 * URL. Opening the tab refetches (admin queries are never stale), and every successful change invalidates it.
 */
export function FlagHistory({ flagKey, cursor, initialData }: { flagKey: string; cursor?: string; initialData?: FlagAuditPage }) {
  const query = useFlagHistory(flagKey, { cursor }, initialData);
  const { user } = useAuth();
  const data = query.data;

  if (!data) {
    if (query.isError) return <FlagProblemAlert problem={readFlagProblem(query.error)} op="history" flagKey={flagKey} onRetry={() => void query.refetch()} />;
    return <HistorySkeleton />;
  }
  return (
    <div className="space-y-3">
      {query.isError && <p role="status" className="text-sm text-amber-900 dark:text-amber-100">Couldn&apos;t refresh. Showing the last loaded changes.</p>}
      {data.items.length === 0 ? (
        <p className="rounded-xl border bg-background p-6">No changes recorded yet.</p>
      ) : (
        <ol aria-label="Change history" className="space-y-3">
          {data.items.map((entry) => (
            <HistoryEntry key={entry.id} entry={entry} viewerId={user?.id} />
          ))}
        </ol>
      )}
      <nav aria-label="Pages" className="flex flex-wrap items-center gap-4 text-sm">
        {cursor && (
          <Link href={historyHref(flagKey)} className="underline underline-offset-4">
            Newest
          </Link>
        )}
        {data.nextCursor && (
          <Link href={historyHref(flagKey, data.nextCursor)} className="underline underline-offset-4">
            Older
          </Link>
        )}
      </nav>
    </div>
  );
}
