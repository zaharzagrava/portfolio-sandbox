'use client';

import { useState } from 'react';
import type { AdBillingItem, AdCampaign } from '@marketplace-sandbox/contracts';
import { SectionError } from '@/components/seller/problem-states';
import { TableRowsSkeleton } from '@/components/seller/page-skeletons';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { Instant } from '@/components/seller/developers/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useCampaignBilling, useCampaignDetail } from '@/lib/api/seller-ads';
import { formatMoney } from '@/lib/utils';

/**
 * The statement of one campaign (S36 `GET …/billing`, `payouts.read`): what was billed today and, hour by hour for the last
 * 7 days, the charge, the adjustments posted afterwards and the net amount. Amounts are never estimates.
 */
export function StatementDialog({ shopId, campaign, title, onClose }: { shopId: string; campaign: AdCampaign | null; title: string; onClose: () => void }) {
  return (
    <Dialog open={campaign !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        {campaign && <Statement key={campaign.id} shopId={shopId} campaign={campaign} title={title} />}
      </DialogContent>
    </Dialog>
  );
}

function Statement({ shopId, campaign, title }: { shopId: string; campaign: AdCampaign; title: string }) {
  const [cursor, setCursor] = useState<string | undefined>();
  const detail = useCampaignDetail(shopId, campaign.id);
  const billing = useCampaignBilling(shopId, campaign.id, { cursor });
  const money = (minor: number) => formatMoney(minor, campaign.currency);

  const columns: Column<AdBillingItem>[] = [
    { id: 'hour', header: 'Hour', primary: true, cell: (row) => <Instant value={row.hour} /> },
    { id: 'state', header: 'Status', cell: (row) => <Badge variant={row.state === 'CHARGED' ? 'default' : 'secondary'}>{row.state === 'CHARGED' ? 'Charged' : 'Pending'}</Badge> },
    { id: 'clicks', header: 'Billable clicks', cell: (row) => `${row.billableClicks} of ${row.clicks}` },
    { id: 'amount', header: 'Charge', cell: (row) => money(row.amountMinor) },
    { id: 'adjust', header: 'Adjustments', cell: (row) => (row.adjustments.length ? money(row.adjustments.reduce((sum, item) => sum + item.deltaMinor, 0)) : 'None') },
    { id: 'net', header: 'Net', cell: (row) => <strong>{money(row.netAmountMinor)}</strong> },
  ];
  const context = { kind: 'read', place: 'dialog' } as const;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Statement: {title}</DialogTitle>
        <DialogDescription>Charges by hour for the last 7 days. Adjustments are posted after the hour closes.</DialogDescription>
      </DialogHeader>
      {detail.isError && !billing.isError ? (
        <SectionError error={detail.error} context={context} onRetry={() => void detail.refetch()} />
      ) : detail.data ? (
        <p className="text-sm">
          Billed today <strong className="ml-1 text-base">{money(detail.data.billedTodayMinor)}</strong>
        </p>
      ) : null}
      {billing.isError ? (
        <SectionError error={billing.error} context={context} onRetry={() => void billing.refetch()} />
      ) : !billing.data ? (
        <TableRowsSkeleton name="statement" rows={4} />
      ) : billing.data.items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center">No charges in this period.</p>
      ) : (
        <div className="space-y-3">
          <ResponsiveTable caption={`Hourly charges for ${title}`} captionHidden columns={columns} rows={billing.data.items} rowKey={(row) => row.hour} busy={billing.isPlaceholderData} />
          <div className="flex items-center justify-between gap-3">
            {cursor ? (
              <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => setCursor(undefined)}>
                First page
              </Button>
            ) : (
              <span />
            )}
            {billing.data.nextCursor && (
              <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => setCursor(billing.data.nextCursor ?? undefined)}>
                Next page
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
