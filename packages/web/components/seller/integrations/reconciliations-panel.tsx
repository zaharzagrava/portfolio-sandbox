'use client';

import Link from 'next/link';
import { Instant, PageLinks } from '@/components/seller/developers/shared';
import { ProblemPanel, SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { Badge } from '@/components/ui/badge';
import { problemFromError } from '@/lib/api/errors';
import { useReconciliation, useReconciliations, type ReconciliationReport } from '@/lib/api/seller-integrations';
import { findingLabel, outcomeLabel } from './labels';
import { detailHref } from './params';

type Summary = { id: string; startedAt: string; finishedAt: string | null; outcome: string | null; counts: Record<string, number> };
type Finding = ReconciliationReport['findings'][number] & { key: string };

const COUNT_TEXT: Record<string, (n: number) => string> = {
  matched: (n) => `${n} match`,
  missing_at_provider: (n) => `${n} missing in the store`,
  missing_locally: (n) => `${n} missing here`,
  content_drift: (n) => `${n} with different content`,
  stock_drift: (n) => `${n} with different stock`,
  list_inconsistent: (n) => `${n} changed during the check`,
};
const countsText = (counts: Record<string, number>): string => {
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([kind, n]) => (COUNT_TEXT[kind] ?? ((count: number) => `${count} ${findingLabel(kind).toLowerCase()}`))(n));
  return parts.length > 0 ? parts.join(', ') : 'Nothing found';
};

/** A key per finding that is stable for the same report: kind and external id, with a counter when they repeat. */
function withKeys(findings: ReconciliationReport['findings']): Finding[] {
  const seen = new Map<string, number>();
  return findings.map((finding) => {
    const base = `${finding.kind}:${finding.externalId ?? ''}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...finding, key: `${base}:${n}` };
  });
}

/**
 * The reconciliation runs of an integration (S08) and, when `run` is in the address, one report: the counts, the findings
 * (a finding carried over from the earlier run shows what became of it: Fixed or Still open) and a note when the report
 * was cut at 1,000 findings.
 */
export function ReconciliationsPanel({ shopId, integrationId, pathname, cursor, run }: { shopId: string; integrationId: string; pathname: string; cursor?: string; run?: string }) {
  const list = useReconciliations(shopId, integrationId, { cursor });
  const report = useReconciliation(shopId, integrationId, run);

  const columns: Column<Summary>[] = [
    { id: 'started', header: 'Started', primary: true, cell: (row) => <Instant value={row.startedAt} /> },
    { id: 'outcome', header: 'Outcome', cell: (row) => outcomeLabel(row.outcome) },
    { id: 'counts', header: 'Result', cell: (row) => countsText(row.counts) },
  ];

  return (
    <section aria-labelledby="reconciliations-heading" className="space-y-4">
      <h2 id="reconciliations-heading" className="text-lg font-semibold">
        Reconciliations
      </h2>
      <p className="text-sm text-muted-foreground">A reconciliation compares every product here with the store and lists what differs.</p>

      {list.isError && !list.data ? (
        <SectionError error={list.error} onRetry={() => void list.refetch()} firstPageHref={detailHref(pathname, { tab: 'reconciliations' })} />
      ) : !list.data ? (
        <div role="status" aria-label="Loading reconciliations" className="h-24 animate-pulse rounded-lg bg-muted" />
      ) : list.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No reconciliations yet.</p>
      ) : (
        <>
          <ResponsiveTable
            caption="Reconciliations"
            captionHidden
            columns={columns}
            rows={list.data.items}
            rowKey={(row) => row.id}
            busy={list.isPlaceholderData}
            actions={(row) => (
              <Link href={detailHref(pathname, { tab: 'reconciliations', run: row.id })} className="text-sm underline underline-offset-4">
                View report
              </Link>
            )}
          />
          <PageLinks
            firstHref={cursor ? detailHref(pathname, { tab: 'reconciliations' }) : undefined}
            nextHref={list.data.nextCursor ? detailHref(pathname, { tab: 'reconciliations', cursor: list.data.nextCursor }) : null}
          />
        </>
      )}

      {run && (
        <div className="space-y-3" aria-live="polite">
          {report.isError ? (
            <ProblemPanel problem={problemFromError(report.error)} context={{ kind: 'read' }} onRetry={() => void report.refetch()} />
          ) : !report.data ? (
            <div role="status" aria-label="Loading report" className="h-24 animate-pulse rounded-lg bg-muted" />
          ) : (
            <Report report={report.data} pathname={pathname} />
          )}
        </div>
      )}
    </section>
  );
}

function Report({ report, pathname }: { report: ReconciliationReport; pathname: string }) {
  const findings = withKeys(report.findings);
  const columns: Column<Finding>[] = [
    { id: 'kind', header: 'Finding', primary: true, cell: (row) => findingLabel(row.kind) },
    { id: 'item', header: 'Product', cell: (row) => <span className="break-all font-mono text-xs">{row.externalId ?? 'Not linked'}</span> },
    { id: 'detail', header: 'Detail', cell: (row) => row.detail ?? '' },
    {
      id: 'outcome',
      header: 'Since the earlier run',
      cell: (row) => (row.outcome ? <Badge variant={row.outcome === 'fixed' ? 'default' : 'destructive'}>{row.outcome === 'fixed' ? 'Fixed' : 'Still open'}</Badge> : ''),
    },
  ];
  return (
    <section aria-label="Reconciliation report" className="space-y-3 rounded-lg border p-4">
      <h3 className="font-semibold">
        Report from <Instant value={report.startedAt} />
      </h3>
      <p className="text-sm">
        {outcomeLabel(report.outcome)}. {countsText(report.counts)}.
      </p>
      {report.previousRunId && (
        <Link href={detailHref(pathname, { tab: 'reconciliations', run: report.previousRunId })} className="text-sm underline underline-offset-4">
          Compare with the earlier run
        </Link>
      )}
      {report.truncated && <p role="status">Showing the first 1,000 findings. Fix some and run another reconciliation to see the rest.</p>}
      {findings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No findings.</p>
      ) : (
        <ResponsiveTable caption="Findings" captionHidden columns={columns} rows={findings} rowKey={(row) => row.key} />
      )}
    </section>
  );
}
