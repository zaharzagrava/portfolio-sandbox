'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { PlusIcon } from 'lucide-react';
import { AD_CAMPAIGN_STATUSES, type AdCampaign } from '@marketplace-sandbox/contracts';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { TableRowsSkeleton } from '@/components/seller/page-skeletons';
import { ProblemPanel, SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { RowMenu } from '@/components/seller/row-menu';
import { DialogProblem, Instant, NativeSelect, PageLinks } from '@/components/seller/developers/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useShop } from '@/lib/api/seller';
import { useCampaignAction, useCampaigns } from '@/lib/api/seller-ads';
import { useInventory } from '@/lib/api/seller-products';
import { shopCan, useShopWritable } from '@/lib/seller/permissions';
import { sellerProblemCopy } from '@/lib/seller/problem-copy';
import { buildQuery, readCursor } from '@/lib/seller/search-params';
import { formatMoney } from '@/lib/utils';
import { CreateCampaignDialog } from './create-campaign-dialog';
import { StatementDialog } from './statement-dialog';

const STATUS_LABEL: Record<AdCampaign['status'], string> = { ACTIVE: 'Active', PAUSED: 'Paused', ENDED: 'Ended' };
const STATUS_VARIANT: Record<AdCampaign['status'], 'default' | 'secondary' | 'outline'> = { ACTIVE: 'default', PAUSED: 'secondary', ENDED: 'outline' };
const REASON_LABEL = { seller: 'Paused by you', product_unavailable: 'The product is unavailable' } as const;

/** The products offered by the create form and named in the list: the shop's active products (first page). */
const ACTIVE_PRODUCTS = { q: '', status: 'ACTIVE', inStock: undefined, cursor: undefined } as const;

/**
 * Sponsored-listing campaigns of a shop (W04 US10, S36): the list with status and the reason behind a pause, create, pause,
 * resume, end and the hourly statement. Anyone with `products.read` sees the list; changes need `shop.manage`, the
 * statement `payouts.read`. The API decides on every call; a refusal is shown in words and the list is refetched.
 */
export function CampaignsView({ shopId }: { shopId: string }) {
  const router = useRouter();
  const pathname = usePathname() ?? `/dashboard/seller/${shopId}/campaigns`;
  const searchParams = useSearchParams();
  const rawStatus = searchParams.get('status') ?? undefined;
  const status = AD_CAMPAIGN_STATUSES.find((value) => value === rawStatus);
  const cursor = readCursor(searchParams.get('cursor') ?? undefined);
  const shop = useShop(shopId).data;
  const { writable, reason } = useShopWritable(shop);
  const canManage = shopCan(shop, 'shop.manage');
  const canStatement = shopCan(shop, 'payouts.read');
  const list = useCampaigns(shopId, { status, cursor });
  const products = useInventory(shopId, ACTIVE_PRODUCTS).data?.items ?? [];
  const act = useCampaignAction(shopId);

  const [creating, setCreating] = useState(false);
  const [ending, setEnding] = useState<AdCampaign | null>(null);
  const [statement, setStatement] = useState<AdCampaign | null>(null);
  const [shown, setShown] = useState<Problem | null>(null);
  const [endProblem, setEndProblem] = useState<Problem | null>(null);

  const titleOf = (campaign: AdCampaign) => products.find((product) => product.id === campaign.productId)?.title ?? `Product ${campaign.productId.slice(0, 8)}`;
  const hrefFor = (nextStatus: string | undefined, nextCursor?: string) => {
    const query = buildQuery({ status: nextStatus, cursor: nextCursor });
    return query ? `${pathname}?${query}` : pathname;
  };

  async function run(campaign: AdCampaign, action: 'pause' | 'resume') {
    setShown(null);
    try {
      await act.mutateAsync({ campaignId: campaign.id, action });
    } catch (error) {
      const problem = problemFromError(error);
      if (!sellerProblemCopy(problem, { resource: 'campaign' }).silent) setShown(problem);
    }
  }

  async function end() {
    if (!ending) return;
    setEndProblem(null);
    try {
      await act.mutateAsync({ campaignId: ending.id, action: 'end' });
      setEnding(null);
    } catch (error) {
      setEndProblem(problemFromError(error));
      throw error;
    }
  }

  if (!shop) return <TableRowsSkeleton name="campaigns" />;

  const data = list.data;
  const busy = list.isPlaceholderData;

  const columns: Column<AdCampaign>[] = [
    { id: 'product', header: 'Product', primary: true, cell: (row) => <span className="break-words">{titleOf(row)}</span> },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <span className="flex flex-col items-start gap-1">
          <Badge variant={STATUS_VARIANT[row.status]}>{STATUS_LABEL[row.status]}</Badge>
          {row.statusReason && <span className="text-xs text-muted-foreground">{REASON_LABEL[row.statusReason]}</span>}
        </span>
      ),
    },
    { id: 'cpc', header: 'Cost per click', cell: (row) => formatMoney(row.cpcMinor, row.currency) },
    { id: 'budget', header: 'Daily budget', cell: (row) => formatMoney(row.dailyBudgetMinor, row.currency) },
    { id: 'created', header: 'Created', cell: (row) => <Instant value={row.createdAt} time={false} /> },
  ];

  function menuFor(row: AdCampaign) {
    const open = row.status !== 'ENDED';
    return [
      { id: 'pause', label: 'Pause', hidden: !canManage || row.status !== 'ACTIVE', disabled: !writable, onSelect: () => void run(row, 'pause') },
      { id: 'resume', label: 'Resume', hidden: !canManage || row.status !== 'PAUSED', disabled: !writable, onSelect: () => void run(row, 'resume') },
      { id: 'end', label: 'End campaign', hidden: !canManage || !open, disabled: !writable, destructive: true, onSelect: () => (setEndProblem(null), setEnding(row)) },
      { id: 'statement', label: 'Statement', hidden: !canStatement, onSelect: () => setStatement(row) },
    ];
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Campaigns</h1>
          <p className="text-sm text-muted-foreground">Sponsor products of {shop.name}. You pay per click, up to a daily budget.</p>
        </div>
        {canManage && (
          <div className="flex flex-col items-end gap-1">
            <Button type="button" className="min-h-11 sm:min-h-8" disabled={!writable} aria-describedby={!writable ? 'campaigns-create-note' : undefined} onClick={() => setCreating(true)}>
              <PlusIcon aria-hidden="true" />
              Create campaign
            </Button>
            {!writable && (
              <p id="campaigns-create-note" className="max-w-xs text-right text-xs text-muted-foreground">
                {reason}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="campaigns-status" className="text-sm font-medium">
          Status
        </label>
        <NativeSelect id="campaigns-status" className="w-auto" value={status ?? ''} onChange={(event) => router.push(hrefFor(event.target.value || undefined))}>
          <option value="">All statuses</option>
          {AD_CAMPAIGN_STATUSES.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABEL[value]}
            </option>
          ))}
        </NativeSelect>
      </div>

      {shown && <ProblemPanel problem={shown} context={{ place: 'dialog', resource: 'campaign' }} />}

      <div role="region" aria-label="Campaigns">
        {list.isError ? (
          <SectionError error={list.error} onRetry={() => void list.refetch()} firstPageHref={pathname} />
        ) : !data ? (
          <TableRowsSkeleton name="campaigns" />
        ) : data.items.length === 0 && !busy ? (
          <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
            {cursor ? (
              <>
                <p>No campaigns on this page.</p>
                <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
                  <Link href={hrefFor(status)}>First page</Link>
                </Button>
              </>
            ) : status ? (
              <p>No campaigns match this status.</p>
            ) : (
              <>
                <p>No campaigns yet.</p>
                {canManage && <p className="text-sm text-muted-foreground">Create one to sponsor a product.</p>}
              </>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <ResponsiveTable
              caption={`Campaigns of ${shop.name}`}
              captionHidden
              columns={columns}
              rows={data.items}
              rowKey={(row) => row.id}
              busy={busy}
              actions={(row) => <RowMenu label={titleOf(row)} items={menuFor(row)} />}
            />
            {!busy && <PageLinks firstHref={cursor ? hrefFor(status) : undefined} nextHref={data.nextCursor ? hrefFor(status, data.nextCursor) : null} />}
          </div>
        )}
      </div>

      <CreateCampaignDialog shopId={shopId} open={creating} onOpenChange={setCreating} products={products} />
      <StatementDialog shopId={shopId} campaign={statement} title={statement ? titleOf(statement) : ''} onClose={() => setStatement(null)} />
      <ConfirmDialog
        open={ending !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEnding(null);
            setEndProblem(null);
          }
        }}
        title="End this campaign?"
        description="An ended campaign can't be started again. You would create a new one."
        confirmLabel="End campaign"
        destructive
        error={endProblem ? <DialogProblem problem={endProblem} resource="campaign" /> : undefined}
        onConfirm={end}
      />
    </div>
  );
}
