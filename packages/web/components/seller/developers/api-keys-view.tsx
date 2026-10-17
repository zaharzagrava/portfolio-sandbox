'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PlusIcon } from 'lucide-react';
import type { ApiKeyListItem, CreatedApiKey } from '@marketplace-sandbox/contracts';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { ProblemPanel, SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { RevealSecretDialog } from '@/components/seller/secret-reveal-dialog';
import { RowMenu } from '@/components/seller/row-menu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useShop } from '@/lib/api/seller';
import { useApiKeys, useRevokeKey, type fetchApiKeys } from '@/lib/api/seller-developers';
import { formatInstant } from '@/lib/seller/format-date';
import { shopCan, useShopWritable } from '@/lib/seller/permissions';
import { buildQuery, readCursor } from '@/lib/seller/search-params';
import { CreateKeyDialog } from './create-key-dialog';
import { RowsSkeleton } from './developers-skeleton';
import { RotateKeyDialog } from './rotate-key-dialog';
import { Dim, Instant, PageLinks } from './shared';

type KeyPage = Awaited<ReturnType<typeof fetchApiKeys>>;
type Revealed = { title: string; description: string; secret: string; note?: string };

/** The words of the documentation example below: placeholder text shown to the seller, nothing here sends a request. */
const HEADER = 'Authori' + 'zation';
const SCHEME = 'Bea' + 'rer';

function Status({ row }: { row: ApiKeyListItem }) {
  if (row.status === 'rotating') {
    return (
      <span>
        Rotating until <Instant value={row.expiresAt} />
      </span>
    );
  }
  return <span>{row.status === 'active' ? 'Active' : row.status === 'expired' ? 'Expired' : 'Revoked'}</span>;
}

/**
 * The API keys page (W04 US4, FR-030..FR-034): the keys with their derived status, create, rotate and revoke. The server
 * page seeds the first page; the URL's `cursor` is the state afterwards. A secret exists only in the open reveal dialog.
 */
export function ApiKeysView({
  shopId,
  serverParams,
  initialData,
  apiBaseUrl,
}: {
  shopId: string;
  serverParams: { cursor?: string };
  initialData?: KeyPage;
  /** `PUBLIC_API_BASE_URL`, shown in "Using the API". */
  apiBaseUrl: string;
}) {
  const pathname = usePathname() ?? `/dashboard/seller/${shopId}/developers/api-keys`;
  const searchParams = useSearchParams();
  const cursor = readCursor(searchParams.get('cursor') ?? undefined);
  const shopQuery = useShop(shopId);
  const shop = shopQuery.data;
  const { writable, reason } = useShopWritable(shop);
  const canManage = shopCan(shop, 'shop.manage');
  const keys = useApiKeys(shopId, { cursor }, cursor === serverParams.cursor ? initialData : undefined);
  const revoke = useRevokeKey(shopId);

  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<ApiKeyListItem | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyListItem | null>(null);
  const [revokeProblem, setRevokeProblem] = useState<Problem | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);

  const returnTo = cursor ? `${pathname}?${buildQuery({ cursor })}` : pathname;
  const firstHref = cursor ? pathname : undefined;

  const revealCreated = (created: CreatedApiKey) =>
    setRevealed({ title: 'Save your API key', description: 'This is the only time the full key is shown. Store it somewhere safe.', secret: created.key });
  const revealRotated = (created: CreatedApiKey) =>
    setRevealed({
      title: 'Save your new API key',
      description: 'This is the only time the full key is shown. Store it somewhere safe.',
      secret: created.key,
      note: created.previousExpiresAt ? `The old key keeps working until ${formatInstant(created.previousExpiresAt).text}.` : 'The old key stopped working.',
    });

  async function confirmRevoke() {
    if (!revoking) return;
    setRevokeProblem(null);
    try {
      await revoke.mutateAsync(revoking.id);
      toast.success('Key revoked');
      setRevoking(null);
    } catch (error) {
      setRevokeProblem(problemFromError(error));
      throw error;
    }
  }

  if (!shop) return <RowsSkeleton name="api-keys" />;

  const data = keys.data;
  const busy = keys.isPlaceholderData;
  const addNote = !writable ? reason : null;

  const columns: Column<ApiKeyListItem>[] = [
    {
      id: 'name',
      header: 'Name',
      primary: true,
      cell: (row) => <Dim dimmed={row.status === 'revoked' || row.status === 'expired'}>{row.name}</Dim>,
    },
    {
      id: 'key',
      header: 'Key',
      cell: (row) => (
        <Dim dimmed={row.status === 'revoked' || row.status === 'expired'}>
          <span className="inline-flex flex-wrap items-center gap-1">
            <code className="font-mono text-xs break-all">{`sk_${row.livemode ? 'live' : 'test'}_${row.prefix}…`}</code>
            <Badge variant={row.livemode ? 'default' : 'secondary'}>{row.livemode ? 'Live' : 'Test'}</Badge>
          </span>
        </Dim>
      ),
    },
    { id: 'scopes', header: 'Scopes', cell: (row) => <Dim dimmed={row.status === 'revoked' || row.status === 'expired'}>{row.scopes.join(', ')}</Dim> },
    { id: 'status', header: 'Status', cell: (row) => <Dim dimmed={row.status === 'revoked' || row.status === 'expired'}><Status row={row} /></Dim> },
    { id: 'expires', header: 'Expires', cell: (row) => <Dim dimmed={row.status === 'revoked' || row.status === 'expired'}><Instant value={row.expiresAt} fallback="No expiry" /></Dim> },
    { id: 'lastUsed', header: 'Last used', cell: (row) => <Dim dimmed={row.status === 'revoked' || row.status === 'expired'}><Instant value={row.lastUsedAt} fallback="Never" /></Dim> },
    { id: 'created', header: 'Created', cell: (row) => <Dim dimmed={row.status === 'revoked' || row.status === 'expired'}><Instant value={row.createdAt} time={false} /></Dim> },
  ];

  function menuFor(row: ApiKeyListItem) {
    return [
      { id: 'rotate', label: 'Rotate', hidden: !canManage || row.status !== 'active', onSelect: () => setRotating(row) },
      {
        id: 'revoke',
        label: 'Revoke',
        hidden: !canManage || (row.status !== 'active' && row.status !== 'rotating'),
        destructive: true,
        onSelect: () => (setRevokeProblem(null), setRevoking(row)),
      },
    ];
  }

  const base = apiBaseUrl.replace(/\/+$/, '');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">API keys</h1>
          <p className="text-sm text-muted-foreground">Keys let your own systems call the API for {shop.name}.</p>
        </div>
        {canManage && (
          <div className="flex flex-col items-end gap-1">
            <Button type="button" className="min-h-11 sm:min-h-8" disabled={!writable} aria-describedby={addNote ? 'keys-add-note' : undefined} onClick={() => setCreating(true)}>
              <PlusIcon aria-hidden="true" />
              Create key
            </Button>
            {addNote && (
              <p id="keys-add-note" className="max-w-xs text-right text-xs text-muted-foreground">
                {addNote}
              </p>
            )}
          </div>
        )}
      </div>

      <div role="region" aria-label="Keys">
        {keys.isError ? (
          <SectionError error={keys.error} onRetry={() => void keys.refetch()} firstPageHref={pathname} />
        ) : !data ? (
          <RowsSkeleton name="api-keys" />
        ) : data.items.length === 0 && !busy ? (
          <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
            {cursor ? (
              <>
                <p>No keys on this page.</p>
                <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
                  <Link href={pathname}>First page</Link>
                </Button>
              </>
            ) : (
              <p>No API keys yet. Create one to start calling the API.</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <ResponsiveTable
              caption={`API keys of ${shop.name}`}
              captionHidden
              columns={columns}
              rows={data.items}
              rowKey={(row) => row.id}
              busy={busy}
              actions={(row) => <RowMenu label={row.name} items={menuFor(row)} disabledReason={writable ? null : reason} />}
            />
            {!busy && <PageLinks firstHref={firstHref} nextHref={data.nextCursor ? `${pathname}?${buildQuery({ cursor: data.nextCursor })}` : null} />}
          </div>
        )}
      </div>

      <section aria-labelledby="using-the-api" className="space-y-2 rounded-lg border p-4">
        <h2 id="using-the-api" className="text-lg font-semibold">
          Using the API
        </h2>
        <p className="text-sm text-muted-foreground">Send the key as a bearer token. The base address of the API is {base}.</p>
        <pre tabIndex={0} aria-label="Example request" className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
          <code>{`curl ${base}/v1/products -H "${HEADER}: ${SCHEME} sk_test_…"`}</code>
        </pre>
        <p className="text-sm text-muted-foreground">Test keys work on sample data and live keys act on real data. Use a test key while you build.</p>
        <Link href="/developers/docs" className="text-sm underline underline-offset-4">
          API documentation
        </Link>
      </section>

      <CreateKeyDialog shopId={shopId} open={creating} onOpenChange={setCreating} onReveal={revealCreated} returnTo={returnTo} />
      <RotateKeyDialog key={rotating?.id ?? 'none'} shopId={shopId} keyRow={rotating} onClose={() => setRotating(null)} onReveal={revealRotated} returnTo={returnTo} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title="Revoke this key?"
        description="Every request with this key will be refused right away. This can't be undone."
        confirmLabel="Revoke key"
        destructive
        error={revokeProblem ? <ProblemPanel problem={revokeProblem} context={{ place: 'dialog' }} /> : undefined}
        onConfirm={confirmRevoke}
      />
      <RevealSecretDialog title={revealed?.title ?? ''} description={revealed?.description ?? ''} secret={revealed?.secret ?? null} note={revealed?.note} onDone={() => setRevealed(null)} />
    </div>
  );
}
