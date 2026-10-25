'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PlusIcon } from 'lucide-react';
import type { CreatedWebhookEndpoint, WebhookEndpointDto } from '@marketplace-sandbox/contracts';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { ProblemPanel, SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { RevealSecretDialog } from '@/components/seller/secret-reveal-dialog';
import { RowMenu } from '@/components/seller/row-menu';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useShop } from '@/lib/api/seller';
import {
  useDeleteWebhook,
  useExpirePreviousSecret,
  usePingWebhook,
  useRotateWebhookSecret,
  useSetWebhookEnabled,
  useWebhooks,
} from '@/lib/api/seller-developers';
import { formatInstant } from '@/lib/seller/format-date';
import { shopCan, useShopWritable } from '@/lib/seller/permissions';
import { buildQuery, readCursor } from '@/lib/seller/search-params';
import { problemDetailOf, sellerProblemCopy } from '@/lib/seller/problem-copy';
import { RowsSkeleton } from './developers-skeleton';
import { EndpointFormDialog } from './endpoint-form';
import { EndpointStatus } from './endpoint-status';
import { DialogProblem, Instant, NativeSelect, PageLinks } from './shared';

type WebhookPage = { items: WebhookEndpointDto[]; nextCursor: string | null };
type Revealed = { secret: string; note?: string };
type Action = { kind: 'edit' | 'rotate' | 'enable' | 'expire' | 'delete'; endpoint: WebhookEndpointDto };
type Shown = { problem: Problem; detail?: string; subject?: 'test events' };

const SECRET_OVERLAPS = [
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '24 hours' },
  { hours: 48, label: '48 hours' },
  { hours: 72, label: '72 hours' },
] as const;

/**
 * The webhook endpoints page (W04 US5, FR-035..FR-037): every endpoint with its health, add, edit, enable and disable,
 * secret rotation, delete and a test event. The signing secret is shown once in the reveal dialog and nowhere else.
 */
export function WebhooksView({ shopId, serverParams, initialData }: { shopId: string; serverParams: { cursor?: string }; initialData?: WebhookPage }) {
  const pathname = usePathname() ?? `/dashboard/seller/${shopId}/developers/webhooks`;
  const searchParams = useSearchParams();
  const cursor = readCursor(searchParams.get('cursor') ?? undefined);
  const shop = useShop(shopId).data;
  const { writable, reason } = useShopWritable(shop);
  const canManage = shopCan(shop, 'webhooks.manage');
  const hooks = useWebhooks(shopId, { cursor }, cursor === serverParams.cursor ? initialData : undefined);
  const setEnabled = useSetWebhookEnabled(shopId);
  const ping = usePingWebhook(shopId);

  const [adding, setAdding] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);

  const reveal = (created: CreatedWebhookEndpoint) => setRevealed({ secret: created.secret });

  /** A direct action (no confirmation): its refusal is shown at the top of the page. */
  async function run(work: () => Promise<unknown>, subject?: Shown['subject']) {
    setShown(null);
    try {
      await work();
    } catch (error) {
      const problem = problemFromError(error);
      if (sellerProblemCopy(problem).silent) return;
      setShown({ problem, detail: problemDetailOf(error), subject });
    }
  }

  function enable(endpoint: WebhookEndpointDto) {
    if (endpoint.disabledReason === 'auto_failing') setAction({ kind: 'enable', endpoint });
    else void run(() => setEnabled.mutateAsync({ endpointId: endpoint.id, enabled: true }));
  }

  if (!shop) return <RowsSkeleton name="webhooks" />;

  const data = hooks.data;
  const busy = hooks.isPlaceholderData;
  const addNote = !writable ? reason : null;

  const columns: Column<WebhookEndpointDto>[] = [
    {
      id: 'url',
      header: 'URL',
      primary: true,
      cell: (row) => (
        <Link href={`/dashboard/seller/${encodeURIComponent(shopId)}/developers/webhooks/${encodeURIComponent(row.id)}`} className="break-all underline underline-offset-4">
          {row.url}
        </Link>
      ),
    },
    {
      id: 'events',
      header: 'Events',
      cell: (row) => (
        <span className="break-words">
          {row.events.slice(0, 3).join(', ')}
          {row.events.length > 3 && <span className="text-muted-foreground"> +{row.events.length - 3} more</span>}
        </span>
      ),
    },
    { id: 'version', header: 'API version', cell: (row) => row.apiVersion },
    { id: 'status', header: 'Status', cell: (row) => <EndpointStatus endpoint={row} /> },
    { id: 'created', header: 'Created', cell: (row) => <Instant value={row.createdAt} time={false} /> },
  ];

  function menuFor(row: WebhookEndpointDto) {
    const enabled = row.status === 'enabled';
    return [
      { id: 'edit', label: 'Edit', hidden: !canManage, onSelect: () => setAction({ kind: 'edit', endpoint: row }) },
      { id: 'disable', label: 'Disable', hidden: !canManage || !enabled, onSelect: () => void run(() => setEnabled.mutateAsync({ endpointId: row.id, enabled: false })) },
      { id: 'enable', label: 'Enable', hidden: !canManage || enabled, onSelect: () => enable(row) },
      { id: 'test', label: 'Send test event', hidden: !canManage || !enabled, onSelect: () => void run(async () => (await ping.mutateAsync(row.id), toast.success('Test event queued')), 'test events') },
      { id: 'rotate', label: 'Rotate secret', hidden: !canManage, onSelect: () => setAction({ kind: 'rotate', endpoint: row }) },
      { id: 'expire', label: 'End old secret now', hidden: !canManage || !row.hasPreviousSecret, onSelect: () => setAction({ kind: 'expire', endpoint: row }) },
      { id: 'delete', label: 'Delete', hidden: !canManage, destructive: true, onSelect: () => setAction({ kind: 'delete', endpoint: row }) },
    ];
  }

  const close = () => setAction(null);
  const current = action?.endpoint;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Webhooks</h1>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">We send events from {shop.name} to the addresses you add here.</p>
        </div>
        {canManage && (
          <div className="flex flex-col items-end gap-1">
            <Button type="button" className="min-h-11 sm:min-h-8" disabled={!writable} aria-describedby={addNote ? 'hooks-add-note' : undefined} onClick={() => setAdding(true)}>
              <PlusIcon aria-hidden="true" />
              Add endpoint
            </Button>
            {addNote && (
              <p id="hooks-add-note" className="max-w-xs text-right text-xs text-muted-foreground">
                {addNote}
              </p>
            )}
          </div>
        )}
      </div>

      {shown && <ProblemPanel problem={shown.problem} context={{ place: 'dialog', detail: shown.detail }} subject={shown.subject} />}

      <div role="region" aria-label="Endpoints">
        {hooks.isError ? (
          <SectionError error={hooks.error} onRetry={() => void hooks.refetch()} firstPageHref={pathname} />
        ) : !data ? (
          <RowsSkeleton name="webhooks" />
        ) : data.items.length === 0 && !busy ? (
          <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
            {cursor ? (
              <>
                <p>No endpoints on this page.</p>
                <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
                  <Link href={pathname}>First page</Link>
                </Button>
              </>
            ) : (
              <p>No webhook endpoints yet. Add one to receive events.</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <ResponsiveTable
              caption={`Webhook endpoints of ${shop.name}`}
              captionHidden
              columns={columns}
              rows={data.items}
              rowKey={(row) => row.id}
              busy={busy}
              actions={(row) => <RowMenu label={row.url} items={menuFor(row)} disabledReason={writable ? null : reason} />}
            />
            {!busy && <PageLinks firstHref={cursor ? pathname : undefined} nextHref={data.nextCursor ? `${pathname}?${buildQuery({ cursor: data.nextCursor })}` : null} />}
          </div>
        )}
      </div>

      <EndpointFormDialog shopId={shopId} open={adding} onOpenChange={setAdding} onReveal={reveal} />
      <EndpointFormDialog key={current?.id ?? 'none'} shopId={shopId} open={action?.kind === 'edit'} onOpenChange={(open) => !open && close()} endpoint={action?.kind === 'edit' ? current : undefined} onReveal={reveal} />
      <RotateSecretDialog
        key={`rotate-${current?.id ?? 'none'}`}
        shopId={shopId}
        endpoint={action?.kind === 'rotate' ? current : undefined}
        onClose={close}
        onEndOld={(endpoint) => setAction({ kind: 'expire', endpoint })}
        onReveal={(secret, until) => setRevealed({ secret, note: `The old secret stays valid until ${formatInstant(until).text}.` })}
      />
      <ExpireSecretDialog shopId={shopId} endpoint={action?.kind === 'expire' ? current : undefined} onClose={close} />
      <EnableDialog shopId={shopId} endpoint={action?.kind === 'enable' ? current : undefined} onClose={close} />
      <DeleteDialog shopId={shopId} endpoint={action?.kind === 'delete' ? current : undefined} onClose={close} />
      <RevealSecretDialog
        title="Webhook signing secret"
        description="Use this secret to check that events really come from us. It is shown only once."
        secret={revealed?.secret ?? null}
        note={revealed?.note}
        onDone={() => setRevealed(null)}
      />
    </div>
  );
}

function RotateSecretDialog({
  shopId,
  endpoint,
  onClose,
  onEndOld,
  onReveal,
}: {
  shopId: string;
  endpoint?: WebhookEndpointDto;
  onClose: () => void;
  onEndOld: (endpoint: WebhookEndpointDto) => void;
  onReveal: (secret: string, previousSecretExpiresAt: string) => void;
}) {
  const rotate = useRotateWebhookSecret(shopId);
  const [overlapHours, setOverlapHours] = useState(24);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function confirm() {
    if (!endpoint) return;
    setProblem(null);
    try {
      await rotate.mutateAsync({ endpointId: endpoint.id, overlapHours, reveal: (rotated) => onReveal(rotated.secret, rotated.previousSecretExpiresAt) });
      onClose();
    } catch (error) {
      setProblem(problemFromError(error));
      throw error;
    }
  }

  return (
    <ConfirmDialog
      open={endpoint !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          setProblem(null);
          onClose();
        }
      }}
      title="Rotate the signing secret?"
      description="A new secret is created and shown once. The old secret stays valid for the time you choose."
      confirmLabel="Rotate secret"
      error={problem ? <DialogProblem problem={problem} onEndOldSecret={endpoint ? () => onEndOld(endpoint) : undefined} /> : undefined}
      onConfirm={confirm}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="rotate-secret-overlap">Keep the old secret valid for</Label>
        <NativeSelect id="rotate-secret-overlap" value={String(overlapHours)} onChange={(event) => setOverlapHours(Number(event.target.value))}>
          {SECRET_OVERLAPS.map((option) => (
            <option key={option.hours} value={option.hours}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      </div>
    </ConfirmDialog>
  );
}

function ExpireSecretDialog({ shopId, endpoint, onClose }: { shopId: string; endpoint?: WebhookEndpointDto; onClose: () => void }) {
  const expire = useExpirePreviousSecret(shopId);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function confirm() {
    if (!endpoint) return;
    setProblem(null);
    try {
      await expire.mutateAsync(endpoint.id);
      toast.success('Old secret ended');
      onClose();
    } catch (error) {
      const failed = problemFromError(error);
      if (sellerProblemCopy(failed).silent) return onClose();
      setProblem(failed);
      throw error;
    }
  }

  return (
    <ConfirmDialog
      open={endpoint !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          setProblem(null);
          onClose();
        }
      }}
      title="End the old secret now?"
      description="The old secret stops working right away. Only the new secret signs events."
      confirmLabel="End old secret now"
      destructive
      error={problem ? <DialogProblem problem={problem} /> : undefined}
      onConfirm={confirm}
    />
  );
}

function EnableDialog({ shopId, endpoint, onClose }: { shopId: string; endpoint?: WebhookEndpointDto; onClose: () => void }) {
  const setEnabled = useSetWebhookEnabled(shopId);
  const [failure, setFailure] = useState<{ problem: Problem; detail?: string } | null>(null);

  async function confirm() {
    if (!endpoint) return;
    setFailure(null);
    try {
      await setEnabled.mutateAsync({ endpointId: endpoint.id, enabled: true });
      onClose();
    } catch (error) {
      setFailure({ problem: problemFromError(error), detail: problemDetailOf(error) });
      throw error;
    }
  }

  return (
    <ConfirmDialog
      open={endpoint !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          setFailure(null);
          onClose();
        }
      }}
      title="Enable this endpoint?"
      description="Enabling clears the failure history and starts deliveries again."
      confirmLabel="Enable endpoint"
      error={failure ? <DialogProblem problem={failure.problem} detail={failure.detail} /> : undefined}
      onConfirm={confirm}
    />
  );
}

function DeleteDialog({ shopId, endpoint, onClose }: { shopId: string; endpoint?: WebhookEndpointDto; onClose: () => void }) {
  const remove = useDeleteWebhook(shopId);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function confirm() {
    if (!endpoint) return;
    setProblem(null);
    try {
      await remove.mutateAsync(endpoint.id);
      toast.success('Endpoint deleted');
      onClose();
    } catch (error) {
      const failed = problemFromError(error);
      const copy = sellerProblemCopy(failed, { place: 'dialog' });
      if (copy.form === 'toast') {
        toast.error(copy.message);
        return onClose();
      }
      setProblem(failed);
      throw error;
    }
  }

  return (
    <ConfirmDialog
      open={endpoint !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          setProblem(null);
          onClose();
        }
      }}
      title="Delete this endpoint?"
      description="Pending deliveries are cancelled."
      confirmLabel="Delete endpoint"
      destructive
      error={problem ? <DialogProblem problem={problem} /> : undefined}
      onConfirm={confirm}
    />
  );
}
