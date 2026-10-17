'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeftIcon } from 'lucide-react';
import type { WebhookAttemptDto, WebhookEndpointDto } from '@marketplace-sandbox/contracts';
import { ProblemPanel, RateLimitNotice, SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useShop } from '@/lib/api/seller';
import { PING_REFETCH_TOTAL_MS, usePingWebhook, useWebhook, useWebhookAttempts } from '@/lib/api/seller-developers';
import { shopCan, useShopWritable } from '@/lib/seller/permissions';
import { sellerProblemCopy } from '@/lib/seller/problem-copy';
import { buildQuery, readWebhookAttemptsParams, type WebhookAttemptsParams } from '@/lib/seller/search-params';
import { RowsSkeleton } from './developers-skeleton';
import { EndpointStatus } from './endpoint-status';
import { EventPanel } from './event-panel';
import { Instant, PageLinks } from './shared';

type AttemptPage = { items: WebhookAttemptDto[]; nextCursor: string | null };

/**
 * One endpoint with its delivery log (W04 US5, FR-038): the summary, "Send test event" (the log refetches every 5 s for 30 s
 * after one), the "Failed only" filter and cursor in the URL, and the event panel (`event` in the URL) with Replay.
 */
export function WebhookDetailView({
  shopId,
  endpointId,
  serverParams,
  initialEndpoint,
  initialAttempts,
}: {
  shopId: string;
  endpointId: string;
  serverParams: WebhookAttemptsParams;
  initialEndpoint?: WebhookEndpointDto;
  initialAttempts?: AttemptPage;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? `/dashboard/seller/${shopId}/developers/webhooks/${endpointId}`;
  const searchParams = useSearchParams();
  const params = readWebhookAttemptsParams(Object.fromEntries(searchParams.entries()));
  const shop = useShop(shopId).data;
  const { writable } = useShopWritable(shop);
  const canManage = shopCan(shop, 'webhooks.manage');
  const endpointQuery = useWebhook(shopId, endpointId, initialEndpoint);
  const [pinging, setPinging] = useState(false);
  const attempts = useWebhookAttempts(shopId, endpointId, params, {
    refetchWindow: pinging,
    initialData: params.ok === serverParams.ok && params.cursor === serverParams.cursor ? initialAttempts : undefined,
  });
  const ping = usePingWebhook(shopId);
  const [pingProblem, setPingProblem] = useState<Problem | null>(null);
  const [limited, setLimited] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const hrefFor = (next: { ok?: boolean; event?: string; cursor?: string }) => {
    const query = buildQuery({ ok: next.ok, event: next.event, cursor: next.cursor });
    return query ? `${pathname}?${query}` : pathname;
  };

  async function sendTest() {
    setPingProblem(null);
    setLimited(false);
    try {
      await ping.mutateAsync(endpointId);
      toast.success('Test event queued');
      clearTimeout(timer.current);
      setPinging(true);
      timer.current = setTimeout(() => setPinging(false), PING_REFETCH_TOTAL_MS);
    } catch (error) {
      setPingProblem(problemFromError(error));
    }
  }

  const endpoint = endpointQuery.data;
  if (endpointQuery.isError) {
    return (
      <div className="space-y-4">
        <BackLink shopId={shopId} />
        <SectionError error={endpointQuery.error} onRetry={() => void endpointQuery.refetch()} />
      </div>
    );
  }
  if (!endpoint || !shop) return <RowsSkeleton name="webhook" rows={5} heading />;

  const data = attempts.data;
  const busy = attempts.isPlaceholderData;
  const pingCopy = pingProblem ? sellerProblemCopy(pingProblem, { subject: 'test events' }) : null;

  const columns: Column<WebhookAttemptDto>[] = [
    { id: 'time', header: 'Time', primary: true, cell: (row) => <Instant value={row.startedAt} /> },
    {
      id: 'event',
      header: 'Event',
      cell: (row) => (
        <span className="break-all">
          {row.type}
          <span className="block font-mono text-xs text-muted-foreground">{row.eventId}</span>
        </span>
      ),
    },
    { id: 'attempt', header: 'Attempt', cell: (row) => row.attempt },
    {
      id: 'result',
      header: 'Result',
      cell: (row) => (
        <span className="block">
          <span className={row.ok ? '' : 'text-destructive'}>{row.status ?? row.error ?? 'No response'}</span>
          {row.status !== null && row.error && <span className="ml-1 text-muted-foreground">{row.error}</span>}
          {row.responseSnippet && (
            <details className="mt-1 text-xs">
              <summary className="cursor-pointer text-muted-foreground">Response</summary>
              <p className="mt-1 break-all whitespace-pre-wrap">{row.responseSnippet}</p>
            </details>
          )}
        </span>
      ),
    },
    { id: 'duration', header: 'Duration', cell: (row) => `${row.durationMs} ms` },
    { id: 'replay', header: 'Replay', cell: (row) => (row.replay ? 'Replay' : 'No') },
  ];

  return (
    <div className="space-y-6">
      <BackLink shopId={shopId} />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <h1 className="text-xl font-bold tracking-tight break-all sm:text-2xl">{endpoint.url}</h1>
          <EndpointStatus endpoint={endpoint} />
          <p className="text-sm text-muted-foreground">
            API version {endpoint.apiVersion}. Events: {endpoint.events.join(', ')}.
          </p>
        </div>
        {canManage && endpoint.status === 'enabled' && (
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={!writable || limited || ping.isPending} onClick={() => void sendTest()}>
            Send test event
          </Button>
        )}
      </div>

      {pingProblem &&
        pingCopy &&
        (pingCopy.form === 'countdown' ? (
          <RateLimitNotice seconds={pingCopy.retryAfterSeconds} subject="test events" token={pingProblem} onActiveChange={setLimited} />
        ) : (
          <ProblemPanel problem={pingProblem} context={{ place: 'dialog' }} />
        ))}

      <div className="flex items-center gap-2">
        <Checkbox id="failed-only" checked={params.ok === false} onCheckedChange={(next) => router.push(hrefFor({ ok: next === true ? false : undefined }))} />
        <Label htmlFor="failed-only" className="min-h-11 sm:min-h-0">
          Failed only
        </Label>
      </div>

      <div role="region" aria-label="Deliveries">
        {attempts.isError ? (
          <SectionError error={attempts.error} onRetry={() => void attempts.refetch()} firstPageHref={hrefFor({ ok: params.ok })} />
        ) : !data ? (
          <RowsSkeleton name="deliveries" rows={5} />
        ) : data.items.length === 0 && !busy ? (
          <div className="rounded-lg border border-dashed p-6 text-center">
            <p>No deliveries in the last 30 days.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <ResponsiveTable
              caption="Deliveries, newest first"
              captionHidden
              columns={columns}
              rows={data.items}
              rowKey={(row) => row.attemptId}
              busy={busy}
              actions={(row) => (
                <Button type="button" variant="ghost" size="sm" aria-label={`View event ${row.eventId}`} className="min-h-11 sm:min-h-8" onClick={() => router.replace(hrefFor({ ok: params.ok, event: row.eventId, cursor: params.cursor }))}>
                  View event
                </Button>
              )}
            />
            {!busy && <PageLinks firstHref={params.cursor ? hrefFor({ ok: params.ok }) : undefined} nextHref={data.nextCursor ? hrefFor({ ok: params.ok, cursor: data.nextCursor }) : null} />}
          </div>
        )}
      </div>

      {params.event && (
        <EventPanel
          key={params.event}
          shopId={shopId}
          endpointId={endpointId}
          eventId={params.event}
          canReplay={canManage && writable}
          onClose={() => router.replace(hrefFor({ ok: params.ok, cursor: params.cursor }))}
        />
      )}
    </div>
  );
}

function BackLink({ shopId }: { shopId: string }) {
  return (
    <Link href={`/dashboard/seller/${encodeURIComponent(shopId)}/developers/webhooks`} className="inline-flex min-h-11 items-center gap-1 text-sm underline underline-offset-4 sm:min-h-0">
      <ArrowLeftIcon className="size-4" aria-hidden="true" />
      Webhooks
    </Link>
  );
}
