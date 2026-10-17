'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { Instant } from '@/components/seller/developers/shared';
import { ProblemPanel } from '@/components/seller/problem-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useShop } from '@/lib/api/seller';
import { useDisconnect, useIntegration, usePauseResume, useReconcileNow, useSyncNow } from '@/lib/api/seller-integrations';
import { shopCan, useShopWritable } from '@/lib/seller/permissions';
import { ConflictsPanel } from './conflicts-panel';
import { lagLabel, providerLabel, statusLabel, statusVariant } from './labels';
import { detailHref, readDetailParams, type IntegrationTab } from './params';
import { QuarantinePanel } from './quarantine-panel';
import { ReconciliationsPanel } from './reconciliations-panel';

const NOTICE = {
  started: 'Sync started.',
  breaker: 'Syncing is paused after repeated errors. It will try again on its own.',
  queued: 'A sync is already queued.',
  reconciling: 'Reconciliation started.',
  reconcileRunning: 'A reconciliation is already running.',
} as const;

/**
 * One connected store (W04 F3, S08): its state, the actions the API offers (sync now, full resync, reconcile, pause, resume,
 * disconnect) and the quarantine, stock conflicts and reconciliations behind it, one section at a time (`?tab=`). Everything is
 * read and written through the HTTP routes; nothing is subscribed (R-14).
 */
export function IntegrationDetailView({ shopId, integrationId }: { shopId: string; integrationId: string }) {
  const router = useRouter();
  const pathname = usePathname() ?? `/dashboard/seller/${shopId}/integrations/${integrationId}`;
  const params = readDetailParams(useSearchParams());
  const shop = useShop(shopId).data;
  const { writable, reason } = useShopWritable(shop);
  const canManage = shopCan(shop, 'integrations.manage');
  const integration = useIntegration(shopId, integrationId);
  const sync = useSyncNow(shopId, integrationId);
  const reconcile = useReconcileNow(shopId, integrationId);
  const pauseResume = usePauseResume(shopId, integrationId);
  const disconnect = useDisconnect(shopId, integrationId);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [confirm, setConfirm] = useState<'resync' | 'disconnect' | null>(null);
  const list = `/dashboard/seller/${encodeURIComponent(shopId)}/integrations`;

  async function act(run: () => Promise<void>) {
    setNotice(null);
    setProblem(null);
    try {
      await run();
    } catch (error) {
      setProblem(problemFromError(error));
      throw error;
    }
  }

  const syncNow = (mode: 'incremental' | 'backfill') =>
    act(async () => {
      const answer = await sync.mutateAsync(mode);
      setNotice(answer.enqueued ? NOTICE.started : answer.reason === 'breaker_open' ? NOTICE.breaker : NOTICE.queued);
    }).catch(() => undefined);

  if (integration.isError && !integration.data) {
    return (
      <div className="space-y-4">
        <ProblemPanel problem={problemFromError(integration.error)} context={{ kind: 'read', place: 'page' }} onRetry={() => void integration.refetch()} />
        <Button asChild variant="outline">
          <Link href={list}>Back to integrations</Link>
        </Button>
      </div>
    );
  }
  const data = integration.data;
  if (!data) return <div role="status" aria-label="Loading integration" className="h-48 animate-pulse rounded-lg bg-muted" />;

  const editable = canManage && writable;
  const active = data.status === 'ACTIVE';
  const tabs: { id: IntegrationTab; label: string }[] = [
    { id: 'quarantine', label: `Quarantine${data.openQuarantine > 0 ? ` (${data.openQuarantine})` : ''}` },
    { id: 'conflicts', label: `Stock conflicts${data.openConflicts > 0 ? ` (${data.openConflicts})` : ''}` },
    { id: 'reconciliations', label: 'Reconciliations' },
  ];
  const statusParam = params.status ?? 'OPEN';

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href={list} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          Integrations
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="break-all text-2xl font-bold tracking-tight">{data.externalShop}</h1>
          <Badge variant={statusVariant(data.status)}>{statusLabel(data)}</Badge>
        </div>
      </div>

      {canManage && !writable && reason && (
        <p role="status" className="rounded-lg border px-3 py-2 text-sm">
          {reason}
        </p>
      )}

      <section aria-label="Status" className="space-y-2 rounded-lg border p-4 text-sm">
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Provider</dt>
            <dd>{providerLabel(data.provider)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Status</dt>
            <dd>{statusLabel(data)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last sync</dt>
            <dd>
              <Instant value={data.lastSyncAt} fallback="Never" />
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Lag</dt>
            <dd>{lagLabel(data.lagSeconds)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Linked products</dt>
            <dd>{data.linkedProducts}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Connected</dt>
            <dd>
              <Instant value={data.createdAt} time={false} />
            </dd>
          </div>
        </dl>
        {data.lastError && <p>Last error: {data.lastError}</p>}
        {data.breakerOpenUntil && (
          <p>
            Syncing is paused after repeated errors until <Instant value={data.breakerOpenUntil} />.
          </p>
        )}
        {data.status === 'NEEDS_REAUTH' && (
          <p>
            <Link href={list} className="underline underline-offset-4">
              Reconnect this store
            </Link>{' '}
            to start syncing again.
          </p>
        )}
      </section>

      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!editable || !active || sync.isPending} title={reason ?? undefined} onClick={() => void syncNow('incremental')}>
            Sync now
          </Button>
          <Button type="button" variant="outline" disabled={!editable || !active || sync.isPending} onClick={() => setConfirm('resync')}>
            Full resync
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!editable || !active || reconcile.isPending}
            onClick={() =>
              void act(async () => {
                const answer = await reconcile.mutateAsync();
                setNotice(answer.enqueued ? NOTICE.reconciling : NOTICE.reconcileRunning);
              }).catch(() => undefined)
            }
          >
            Reconcile
          </Button>
          {data.status === 'PAUSED' && data.pausedReason !== 'shop_offboarding' ? (
            <Button type="button" variant="outline" disabled={!editable || pauseResume.isPending} onClick={() => void act(async () => void (await pauseResume.mutateAsync('resume'))).catch(() => undefined)}>
              Resume
            </Button>
          ) : (
            <Button type="button" variant="outline" disabled={!editable || !active || pauseResume.isPending} onClick={() => void act(async () => void (await pauseResume.mutateAsync('pause'))).catch(() => undefined)}>
              Pause
            </Button>
          )}
          <Button type="button" variant="destructive" disabled={!editable || data.status === 'DISCONNECTED'} onClick={() => (setProblem(null), setConfirm('disconnect'))}>
            Disconnect
          </Button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {problem && <ProblemPanel problem={problem} context={{ place: 'dialog' }} subject="requests" />}

      <nav aria-label="Integration sections" className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            href={detailHref(pathname, { tab: tab.id })}
            aria-current={params.tab === tab.id ? 'page' : undefined}
            className={`min-h-11 rounded-md border px-3 py-2 text-sm sm:min-h-8 sm:py-1 ${params.tab === tab.id ? 'bg-muted font-medium' : 'hover:bg-muted/50'}`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {params.tab === 'quarantine' && <QuarantinePanel shopId={shopId} integrationId={integrationId} pathname={pathname} status={statusParam} cursor={params.cursor} canWrite={canManage} writable={writable} />}
      {params.tab === 'conflicts' && <ConflictsPanel shopId={shopId} integrationId={integrationId} pathname={pathname} status={statusParam} cursor={params.cursor} canWrite={canManage} writable={writable} />}
      {params.tab === 'reconciliations' && <ReconciliationsPanel shopId={shopId} integrationId={integrationId} pathname={pathname} cursor={params.cursor} run={params.run} />}

      <ConfirmDialog
        open={confirm === 'resync'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Run a full resync?"
        description="Every product is read from the store again. It can take a while and counts against the hourly limit."
        confirmLabel="Start full resync"
        onConfirm={async () => {
          await syncNow('backfill');
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === 'disconnect'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Disconnect this store?"
        description="Syncing stops and the store's credentials are removed. Products already imported stay in your catalogue."
        confirmLabel="Disconnect store"
        destructive
        onConfirm={async () => {
          try {
            await act(async () => void (await disconnect.mutateAsync()));
            router.push(list);
          } catch {
            setConfirm(null);
          }
        }}
      />
    </div>
  );
}
