'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { RequestLogRow } from '@marketplace-sandbox/contracts';
import { CopyButton } from '@/components/seller/copy-button';
import { SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { problemFromError } from '@/lib/api/errors';
import { useApiKeys, useRequestLogs } from '@/lib/api/seller-developers';
import { LOG_STATUSES, buildQuery, readLogsParams, type LogsParams } from '@/lib/seller/search-params';
import { RowsSkeleton } from './developers-skeleton';
import { FieldError, fieldMessages, Instant, NativeSelect, PageLinks } from './shared';

type LogPage = { items: RequestLogRow[]; nextCursor: string | null };

const FILTER_FIELDS = ['requestId', 'status', 'route', 'keyId', 'livemode', 'from', 'to'] as const;
const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Logs are kept 30 days (W04 AS-71). */
const LOG_WINDOW_DAYS = 30;

const sameParams = (a: LogsParams, b: LogsParams) => JSON.stringify(a) === JSON.stringify(b);
const activeFilters = (params: LogsParams) => ({
  requestId: params.requestId,
  status: params.status,
  route: params.route,
  keyId: params.keyId,
  livemode: params.livemode,
  from: params.from,
  to: params.to,
});

/**
 * The request log (W04 US6, AS-70..AS-72): filters in the URL (so the address can be shared), the newest requests first, and
 * a details dialog with what support needs. It shows no body, header or secret.
 */
export function RequestLogsView({ shopId, serverParams, initialData }: { shopId: string; serverParams: LogsParams; initialData?: LogPage }) {
  const router = useRouter();
  const pathname = usePathname() ?? `/dashboard/seller/${shopId}/developers/logs`;
  const searchParams = useSearchParams();
  const params = readLogsParams(Object.fromEntries(searchParams.entries()));
  const logs = useRequestLogs(shopId, params, initialData && sameParams(params, serverParams) ? initialData : undefined);
  const keys = useApiKeys(shopId);
  const [selected, setSelected] = useState<RequestLogRow | null>(null);

  const keyItems = keys.data?.items ?? [];
  const keyName = (keyId: string) => keyItems.find((item) => item.id === keyId)?.name ?? `${keyId.slice(0, 8)}…`;
  const hrefFor = (cursor?: string) => {
    const query = buildQuery({ ...activeFilters(params), cursor }, { status: 'any' });
    return query ? `${pathname}?${query}` : pathname;
  };

  const problem = logs.isError ? problemFromError(logs.error) : null;
  const fieldErrors = fieldMessages(problem, FILTER_FIELDS);
  const data = logs.data;
  const busy = logs.isPlaceholderData;
  const rows = data ? data.items.filter((row) => params.status !== '429' || row.status === 429) : [];

  const columns: Column<RequestLogRow>[] = [
    { id: 'time', header: 'Time', primary: true, cell: (row) => <Instant value={row.at} /> },
    { id: 'method', header: 'Method', cell: (row) => row.method },
    { id: 'route', header: 'Route', cell: (row) => <span className="font-mono text-xs break-all">{row.route}</span> },
    { id: 'status', header: 'Status', cell: (row) => <span className={row.status >= 500 ? 'text-destructive' : ''}>{row.status}</span> },
    { id: 'duration', header: 'Duration', cell: (row) => `${row.durationMs} ms` },
    {
      id: 'version',
      header: 'Version',
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          {row.version}
          {row.deprecated && <Badge variant="outline">Deprecated</Badge>}
        </span>
      ),
    },
    { id: 'key', header: 'Key', cell: (row) => keyName(row.keyId) },
    { id: 'mode', header: 'Mode', cell: (row) => (row.livemode ? 'Live' : 'Test') },
    { id: 'error', header: 'Error', cell: (row) => row.errorCode ?? '—' },
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Request logs</h1>
        <p className="text-sm text-muted-foreground">API requests from the last 30 days, newest first.</p>
      </div>

      <LogFilters key={searchParams.toString()} params={params} keyItems={keyItems} errors={fieldErrors.byField} onApply={(query) => router.push(query ? `${pathname}?${query}` : pathname)} onClear={() => router.push(pathname)} />

      <div role="region" aria-label="Requests">
        {problem && !(problem.code === 'validation_failed' && !fieldErrors.alert) ? (
          <SectionError error={logs.error} onRetry={() => void logs.refetch()} firstPageHref={pathname} />
        ) : problem ? null : !data ? (
          <RowsSkeleton name="logs" rows={6} />
        ) : rows.length === 0 && !busy ? (
          <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
            <p>{params.cursor && data.items.length === 0 ? 'No requests on this page.' : 'No matching requests.'}</p>
            {params.cursor && (
              <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
                <Link href={hrefFor()}>First page</Link>
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <ResponsiveTable
              caption="API requests, newest first"
              captionHidden
              columns={columns}
              rows={rows}
              rowKey={(row) => `${row.requestId}-${row.at}`}
              busy={busy}
              actions={(row) => (
                <Button type="button" variant="ghost" size="sm" aria-label={`Details for ${row.requestId}`} className="min-h-11 sm:min-h-8" onClick={() => setSelected(row)}>
                  Details
                </Button>
              )}
            />
            {!busy && <PageLinks firstHref={params.cursor ? hrefFor() : undefined} nextHref={data.nextCursor ? hrefFor(data.nextCursor) : null} />}
          </div>
        )}
      </div>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request details</DialogTitle>
            <DialogDescription>Share the request ID with support so they can find this request.</DialogDescription>
          </DialogHeader>
          {selected && (
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Request ID</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <span className="font-mono break-all">{selected.requestId}</span>
                <CopyButton text={selected.requestId} label="Copy request ID" showLabel />
              </dd>
              {selected.clientRequestId && (
                <>
                  <dt className="text-muted-foreground">Client request ID</dt>
                  <dd className="font-mono break-all">{selected.clientRequestId}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Status</dt>
              <dd>{selected.status}</dd>
              {selected.errorCode && (
                <>
                  <dt className="text-muted-foreground">Error code</dt>
                  <dd className="font-mono">{selected.errorCode}</dd>
                </>
              )}
            </dl>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LogFilters({
  params,
  keyItems,
  errors,
  onApply,
  onClear,
}: {
  params: LogsParams;
  keyItems: { id: string; name: string }[];
  errors: Record<string, string>;
  onApply: (query: string) => void;
  onClear: () => void;
}) {
  const [requestId, setRequestId] = useState(params.requestId);
  const [status, setStatus] = useState<string>(params.status);
  const [route, setRoute] = useState(params.route);
  const [keyId, setKeyId] = useState(params.keyId ?? '');
  const [mode, setMode] = useState(params.livemode === undefined ? '' : String(params.livemode));
  const [from, setFrom] = useState(params.from ?? '');
  const [to, setTo] = useState(params.to ?? '');
  const [bounds] = useState(() => ({ min: isoDay(Date.now() - LOG_WINDOW_DAYS * DAY_MS), max: isoDay(Date.now()) }));

  function submit(event: FormEvent) {
    event.preventDefault();
    onApply(buildQuery({ requestId: requestId.trim(), status, route: route.trim(), keyId, livemode: mode, from, to }, { status: 'any' }));
  }

  const describe = (field: string) => (errors[field] ? `log-${field}-error` : undefined);
  const keyOptions = keyId && !keyItems.some((item) => item.id === keyId) ? [...keyItems, { id: keyId, name: `${keyId.slice(0, 8)}…` }] : keyItems;

  return (
    <form noValidate onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="grid gap-1.5">
        <Label htmlFor="log-request-id">Request ID</Label>
        <Input id="log-request-id" value={requestId} maxLength={128} autoComplete="off" aria-invalid={errors.requestId ? true : undefined} aria-describedby={describe('requestId')} onChange={(event) => setRequestId(event.target.value)} />
        <FieldError id="log-requestId-error">{errors.requestId}</FieldError>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="log-status">Status</Label>
        <NativeSelect id="log-status" value={status} aria-describedby={describe('status')} onChange={(event) => setStatus(event.target.value)}>
          {LOG_STATUSES.map((option) => (
            <option key={option} value={option}>
              {option === 'any' ? 'Any' : option}
            </option>
          ))}
        </NativeSelect>
        <FieldError id="log-status-error">{errors.status}</FieldError>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="log-route">Route</Label>
        <Input id="log-route" value={route} maxLength={200} autoComplete="off" aria-invalid={errors.route ? true : undefined} aria-describedby={describe('route')} onChange={(event) => setRoute(event.target.value)} />
        <FieldError id="log-route-error">{errors.route}</FieldError>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="log-key">Key</Label>
        <NativeSelect id="log-key" value={keyId} aria-describedby={describe('keyId')} onChange={(event) => setKeyId(event.target.value)}>
          <option value="">Any</option>
          {keyOptions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </NativeSelect>
        <FieldError id="log-keyId-error">{errors.keyId}</FieldError>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="log-mode">Mode</Label>
        <NativeSelect id="log-mode" value={mode} aria-describedby={describe('livemode')} onChange={(event) => setMode(event.target.value)}>
          <option value="">Any</option>
          <option value="true">Live</option>
          <option value="false">Test</option>
        </NativeSelect>
        <FieldError id="log-livemode-error">{errors.livemode}</FieldError>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="log-from">From</Label>
        <Input id="log-from" type="date" min={bounds.min} max={to && to < bounds.max ? to : bounds.max} value={from} aria-describedby={describe('from')} onChange={(event) => setFrom(event.target.value)} />
        <FieldError id="log-from-error">{errors.from}</FieldError>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="log-to">To</Label>
        <Input id="log-to" type="date" min={from && from > bounds.min ? from : bounds.min} max={bounds.max} value={to} aria-describedby={describe('to')} onChange={(event) => setTo(event.target.value)} />
        <FieldError id="log-to-error">{errors.to}</FieldError>
      </div>
      <div className="flex items-end gap-2">
        <Button type="submit" className="min-h-11 sm:min-h-8">
          Apply
        </Button>
        <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" onClick={onClear}>
          Clear filters
        </Button>
      </div>
    </form>
  );
}
