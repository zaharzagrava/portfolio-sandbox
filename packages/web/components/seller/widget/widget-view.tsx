'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PlusIcon } from 'lucide-react';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { ForbiddenPanel } from '@/components/seller/forbidden-panel';
import { TableRowsSkeleton } from '@/components/seller/page-skeletons';
import { ProblemPanel, SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { RevealSecretDialog } from '@/components/seller/secret-reveal-dialog';
import { RowMenu } from '@/components/seller/row-menu';
import { DialogProblem, Instant, NativeSelect, PageLinks } from '@/components/seller/developers/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useShop } from '@/lib/api/seller';
import { useInventory } from '@/lib/api/seller-products';
import { useDeleteWidgetSite, useExpirePreviousWidgetSecret, useRotateWidgetSecret, useSetKillSwitch, useWidgetSites, type WidgetSite } from '@/lib/api/seller-widget';
import { formatInstant } from '@/lib/seller/format-date';
import { shopCan, useShopWritable } from '@/lib/seller/permissions';
import { sellerProblemCopy } from '@/lib/seller/problem-copy';
import { buildQuery, readCursor } from '@/lib/seller/search-params';
import { SiteFormDialog } from './site-form';

type Revealed = { secret: string; note?: string };
type Action = { kind: 'edit' | 'kill' | 'rotate' | 'expire' | 'delete'; site: WidgetSite };

const OVERLAPS = [
  { hours: 0, label: 'Not at all' },
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '24 hours' },
  { hours: 48, label: '48 hours' },
  { hours: 72, label: '72 hours' },
] as const;
const ACTIVE_PRODUCTS = { q: '', status: 'ACTIVE', inStock: undefined, cursor: undefined } as const;

/**
 * Storefront widget sites (W04 US10, S44): every site with its public key and allowed origins, add and edit (with
 * `expectedVersion`), the kill switch, identity-secret rotation and delete. Every route needs `widget.manage`; a member
 * without it gets the access panel and no request is made. The identity secret is shown once in the reveal dialog.
 */
export function WidgetView({ shopId }: { shopId: string }) {
  const shop = useShop(shopId).data;
  if (!shop) return <TableRowsSkeleton name="widget" />;
  if (!shopCan(shop, 'widget.manage')) return <ForbiddenPanel shopId={shopId} role={shop.myRole} />;
  return <Sites shopId={shopId} shop={shop} />;
}

function Sites({ shopId, shop }: { shopId: string; shop: NonNullable<ReturnType<typeof useShop>['data']> }) {
  const pathname = usePathname() ?? `/dashboard/seller/${shopId}/widget`;
  const cursor = readCursor(useSearchParams().get('cursor') ?? undefined);
  const { writable, reason } = useShopWritable(shop);
  const sites = useWidgetSites(shopId, { cursor });
  const products = useInventory(shopId, ACTIVE_PRODUCTS).data?.items ?? [];
  const killSwitch = useSetKillSwitch(shopId);

  const [adding, setAdding] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [shown, setShown] = useState<Problem | null>(null);

  const data = sites.data;
  const busy = sites.isPlaceholderData;
  const current = action?.site;
  const close = () => setAction(null);
  const latest = current ? data?.items.find((item) => item.id === current.id) : undefined;

  async function turnOn(site: WidgetSite) {
    setShown(null);
    try {
      await killSwitch.mutateAsync({ siteId: site.id, on: false });
    } catch (error) {
      const problem = problemFromError(error);
      if (!sellerProblemCopy(problem).silent) setShown(problem);
    }
  }

  const columns: Column<WidgetSite>[] = [
    { id: 'name', header: 'Name', primary: true, cell: (row) => <span className="break-words">{row.name}</span> },
    { id: 'key', header: 'Public key', cell: (row) => <code className="break-all text-xs">{row.publishableKey}</code> },
    {
      id: 'origins',
      header: 'Allowed origins',
      cell: (row) => (
        <span className="break-all">
          {row.allowedOrigins[0]}
          {row.allowedOrigins.length > 1 && <span className="text-muted-foreground"> +{row.allowedOrigins.length - 1} more</span>}
        </span>
      ),
    },
    { id: 'status', header: 'Status', cell: (row) => <Badge variant={row.killSwitch ? 'secondary' : 'default'}>{row.killSwitch ? 'Off' : 'Live'}</Badge> },
    { id: 'updated', header: 'Updated', cell: (row) => <Instant value={row.updatedAt} time={false} /> },
  ];

  function menuFor(row: WidgetSite) {
    return [
      { id: 'edit', label: 'Edit', onSelect: () => setAction({ kind: 'edit', site: row }) },
      row.killSwitch
        ? { id: 'on', label: 'Turn on widget', onSelect: () => void turnOn(row) }
        : { id: 'off', label: 'Turn off widget', onSelect: () => setAction({ kind: 'kill', site: row }) },
      { id: 'rotate', label: 'Rotate identity secret', onSelect: () => setAction({ kind: 'rotate', site: row }) },
      { id: 'expire', label: 'End old secret now', hidden: !row.hasPreviousSecret, onSelect: () => setAction({ kind: 'expire', site: row }) },
      { id: 'delete', label: 'Delete', destructive: true, onSelect: () => setAction({ kind: 'delete', site: row }) },
    ];
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Storefront widget</h1>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">Sell {shop.name} on your own website. Each site has its own key and allowed addresses.</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button type="button" className="min-h-11 sm:min-h-8" disabled={!writable} aria-describedby={!writable ? 'widget-add-note' : undefined} onClick={() => setAdding(true)}>
            <PlusIcon aria-hidden="true" />
            Add site
          </Button>
          {!writable && (
            <p id="widget-add-note" className="max-w-xs text-right text-xs text-muted-foreground">
              {reason}
            </p>
          )}
        </div>
      </div>

      {shown && <ProblemPanel problem={shown} context={{ place: 'dialog' }} />}

      <div role="region" aria-label="Sites">
        {sites.isError ? (
          <SectionError error={sites.error} onRetry={() => void sites.refetch()} firstPageHref={pathname} />
        ) : !data ? (
          <TableRowsSkeleton name="widget" />
        ) : data.items.length === 0 && !busy ? (
          <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
            {cursor ? (
              <>
                <p>No sites on this page.</p>
                <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
                  <Link href={pathname}>First page</Link>
                </Button>
              </>
            ) : (
              <p>No widget sites yet.</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <ResponsiveTable
              caption={`Widget sites of ${shop.name}`}
              captionHidden
              columns={columns}
              rows={data.items}
              rowKey={(row) => row.id}
              busy={busy}
              actions={(row) => <RowMenu label={row.name} items={menuFor(row)} disabledReason={writable ? null : reason} />}
            />
            {!busy && <PageLinks firstHref={cursor ? pathname : undefined} nextHref={data.nextCursor ? `${pathname}?${buildQuery({ cursor: data.nextCursor })}` : null} />}
          </div>
        )}
      </div>

      <SiteFormDialog shopId={shopId} open={adding} onOpenChange={setAdding} products={products} onReveal={(created) => setRevealed({ secret: created.identitySecret })} />
      <SiteFormDialog
        key={current?.id ?? 'none'}
        shopId={shopId}
        open={action?.kind === 'edit'}
        onOpenChange={(open) => !open && close()}
        site={action?.kind === 'edit' ? current : undefined}
        latest={latest}
        products={products}
        onReveal={() => undefined}
      />
      <KillSwitchDialog shopId={shopId} site={action?.kind === 'kill' ? current : undefined} onClose={close} />
      <RotateDialog
        key={`rotate-${current?.id ?? 'none'}`}
        shopId={shopId}
        site={action?.kind === 'rotate' ? current : undefined}
        onClose={close}
        onEndOld={(site) => setAction({ kind: 'expire', site })}
        onReveal={(secret, until) => setRevealed({ secret, note: until ? `The old secret stays valid until ${formatInstant(until).text}.` : 'The old secret stopped working now.' })}
      />
      <ExpireDialog shopId={shopId} site={action?.kind === 'expire' ? current : undefined} onClose={close} />
      <DeleteDialog shopId={shopId} site={action?.kind === 'delete' ? current : undefined} onClose={close} />
      <RevealSecretDialog
        title="Widget identity secret"
        description="Use this secret on your server to sign the tokens that identify your visitors. It is shown only once."
        secret={revealed?.secret ?? null}
        note={revealed?.note}
        onDone={() => setRevealed(null)}
      />
    </div>
  );
}

/** Runs `work` for a confirm dialog: a refusal stays in the dialog, a toast-only refusal (already gone) closes it. */
function useConfirmRun(onClose: () => void) {
  const [problem, setProblem] = useState<Problem | null>(null);
  async function run(work: () => Promise<unknown>, done?: string) {
    setProblem(null);
    try {
      await work();
      if (done) toast.success(done);
      onClose();
    } catch (error) {
      const failed = problemFromError(error);
      const copy = sellerProblemCopy(failed, { place: 'dialog' });
      if (copy.silent || copy.form === 'toast') {
        if (copy.message) toast.error(copy.message);
        return onClose();
      }
      setProblem(failed);
      throw error;
    }
  }
  const reset = () => setProblem(null);
  return { problem, run, reset };
}

function KillSwitchDialog({ shopId, site, onClose }: { shopId: string; site?: WidgetSite; onClose: () => void }) {
  const set = useSetKillSwitch(shopId);
  const { problem, run, reset } = useConfirmRun(onClose);
  return (
    <ConfirmDialog
      open={site !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
      title="Turn off this widget?"
      description="The widget stops showing on every page that embeds it until you turn it on again."
      confirmLabel="Turn off widget"
      destructive
      error={problem ? <DialogProblem problem={problem} /> : undefined}
      onConfirm={() => run(() => set.mutateAsync({ siteId: site?.id ?? '', on: true }), 'Widget turned off')}
    />
  );
}

function RotateDialog({
  shopId,
  site,
  onClose,
  onEndOld,
  onReveal,
}: {
  shopId: string;
  site?: WidgetSite;
  onClose: () => void;
  onEndOld: (site: WidgetSite) => void;
  onReveal: (secret: string, previousSecretExpiresAt: string | null | undefined) => void;
}) {
  const rotate = useRotateWidgetSecret(shopId);
  const [overlapHours, setOverlapHours] = useState(24);
  const { problem, run, reset } = useConfirmRun(onClose);
  return (
    <ConfirmDialog
      open={site !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
      title="Rotate the identity secret?"
      description="A new secret is created and shown once. The old secret stays valid for the time you choose."
      confirmLabel="Rotate secret"
      error={problem ? <DialogProblem problem={problem} onEndOldSecret={site ? () => onEndOld(site) : undefined} /> : undefined}
      onConfirm={() => run(() => rotate.mutateAsync({ siteId: site?.id ?? '', overlapHours, reveal: (rotated) => onReveal(rotated.identitySecret, rotated.previousSecretExpiresAt) }))}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="widget-rotate-overlap">Keep the old secret valid for</Label>
        <NativeSelect id="widget-rotate-overlap" value={String(overlapHours)} onChange={(event) => setOverlapHours(Number(event.target.value))}>
          {OVERLAPS.map((option) => (
            <option key={option.hours} value={option.hours}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      </div>
    </ConfirmDialog>
  );
}

function ExpireDialog({ shopId, site, onClose }: { shopId: string; site?: WidgetSite; onClose: () => void }) {
  const expire = useExpirePreviousWidgetSecret(shopId);
  const { problem, run, reset } = useConfirmRun(onClose);
  return (
    <ConfirmDialog
      open={site !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
      title="End the old secret now?"
      description="The old secret stops working right away. Only the new secret identifies visitors."
      confirmLabel="End old secret now"
      destructive
      error={problem ? <DialogProblem problem={problem} /> : undefined}
      onConfirm={() => run(() => expire.mutateAsync(site?.id ?? ''), 'Old secret ended')}
    />
  );
}

function DeleteDialog({ shopId, site, onClose }: { shopId: string; site?: WidgetSite; onClose: () => void }) {
  const remove = useDeleteWidgetSite(shopId);
  const { problem, run, reset } = useConfirmRun(onClose);
  return (
    <ConfirmDialog
      open={site !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
      title="Delete this site?"
      description="The widget stops working on this site and its key and history are removed."
      confirmLabel="Delete site"
      destructive
      error={problem ? <DialogProblem problem={problem} /> : undefined}
      onConfirm={() => run(() => remove.mutateAsync(site?.id ?? ''), 'Site deleted')}
    />
  );
}
