'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { UsageReport } from '@marketplace-sandbox/contracts';
import { SectionError } from '@/components/seller/problem-states';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useUsage } from '@/lib/api/seller-developers';
import { buildQuery, readUsageParams, USAGE_DAYS, type UsageParams } from '@/lib/seller/search-params';
import { RowsSkeleton } from './developers-skeleton';
import { NativeSelect } from './shared';

const DEFAULTS = { days: 30, livemode: true };

/**
 * Usage per day, version and route (W04 US6, AS-73): the period and the mode live in the URL, the table has a totals row,
 * and a call to a deprecated version says so in words. Days are UTC. There is no chart.
 */
export function UsageView({ shopId, serverParams, initialData }: { shopId: string; serverParams: UsageParams; initialData?: UsageReport }) {
  const router = useRouter();
  const pathname = usePathname() ?? `/dashboard/seller/${shopId}/developers/usage`;
  const searchParams = useSearchParams();
  const params = readUsageParams(Object.fromEntries(searchParams.entries()));
  const usage = useUsage(shopId, params, params.days === serverParams.days && params.livemode === serverParams.livemode ? initialData : undefined);

  const go = (next: Partial<UsageParams>) => {
    const merged = { ...params, ...next };
    const query = buildQuery({ days: merged.days, livemode: merged.livemode }, DEFAULTS);
    router.push(query ? `${pathname}?${query}` : pathname);
  };

  const data = usage.data;
  const busy = usage.isPlaceholderData;
  const totals = (data?.days ?? []).reduce((sum, row) => ({ calls: sum.calls + row.calls, errors: sum.errors + row.errors, deprecated: sum.deprecated + row.deprecatedCalls }), { calls: 0, errors: 0, deprecated: 0 });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Usage</h1>
        <p className="text-sm text-muted-foreground">API calls per day, version and route. Days are in UTC.</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="usage-period">Period</Label>
          <NativeSelect id="usage-period" value={String(params.days)} onChange={(event) => go({ days: Number(event.target.value) as UsageParams['days'] })}>
            {USAGE_DAYS.map((days) => (
              <option key={days} value={days}>
                Last {days} days
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="usage-mode">Mode</Label>
          <NativeSelect id="usage-mode" value={String(params.livemode)} onChange={(event) => go({ livemode: event.target.value === 'true' })}>
            <option value="true">Live</option>
            <option value="false">Test</option>
          </NativeSelect>
        </div>
      </div>

      <div role="region" aria-label="Usage report">
        {usage.isError ? (
          <SectionError error={usage.error} onRetry={() => void usage.refetch()} />
        ) : !data ? (
          <RowsSkeleton name="usage" rows={5} />
        ) : data.days.length === 0 && !busy ? (
          <div className="rounded-lg border border-dashed p-6 text-center">
            <p>No API calls in this period.</p>
          </div>
        ) : (
          <Table aria-busy={busy} className={busy ? 'opacity-60 transition-opacity' : undefined}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Day</TableHead>
                <TableHead scope="col">Version</TableHead>
                <TableHead scope="col">Route</TableHead>
                <TableHead scope="col" className="text-right">
                  Calls
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Errors
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Deprecated calls
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.days.map((row) => (
                <TableRow key={`${row.day}-${row.version}-${row.route}`}>
                  <TableCell>{row.day}</TableCell>
                  <TableCell>{row.version}</TableCell>
                  <TableCell className="font-mono text-xs break-all whitespace-normal">{row.route}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.calls}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.errors}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.deprecatedCalls}
                    {row.deprecatedCalls > 0 && <span className="text-amber-800 dark:text-amber-200"> Deprecated</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3} className="font-medium">
                  Total
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">{totals.calls}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{totals.errors}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{totals.deprecated}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </div>
    </div>
  );
}
