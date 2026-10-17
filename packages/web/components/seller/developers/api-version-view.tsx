'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { TriangleAlertIcon } from 'lucide-react';
import type { apiVersionStateSchema } from '@marketplace-sandbox/contracts';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useShop } from '@/lib/api/seller';
import { useApiVersion, usePinVersion } from '@/lib/api/seller-developers';
import { formatInstant } from '@/lib/seller/format-date';
import { shopCan, useShopWritable } from '@/lib/seller/permissions';
import { RowsSkeleton } from './developers-skeleton';
import { DialogProblem, Instant } from './shared';

type VersionState = ReturnType<typeof apiVersionStateSchema.parse>;
type Supported = VersionState['supported'][number];

/**
 * The API version page (W04 US6, AS-68, AS-69): the pinned version, the supported ones with their status, and a confirmed
 * "Pin this version". A deprecated pin is a warning with its sunset date; a retired version cannot be pinned.
 */
export function ApiVersionView({ shopId, initialData }: { shopId: string; initialData?: VersionState }) {
  const shop = useShop(shopId).data;
  const { writable, reason } = useShopWritable(shop);
  const canManage = shopCan(shop, 'shop.manage');
  const version = useApiVersion(shopId, initialData);
  const pin = usePinVersion(shopId);
  const [target, setTarget] = useState<Supported | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function confirmPin() {
    if (!target) return;
    setProblem(null);
    try {
      await pin.mutateAsync(target.version);
      toast.success('API version pinned');
      setTarget(null);
    } catch (error) {
      setProblem(problemFromError(error));
      throw error;
    }
  }

  if (version.isError) return <SectionError error={version.error} onRetry={() => void version.refetch()} />;
  const data = version.data;
  if (!data || !shop) {
    return <RowsSkeleton name="api-version" rows={2} heading />;
  }

  const pinned = data.supported.find((entry) => entry.version === data.version);
  const deprecated = pinned?.status === 'deprecated';

  const columns: Column<Supported>[] = [
    { id: 'version', header: 'Version', primary: true, cell: (row) => <span className="font-mono">{row.version}</span> },
    {
      id: 'status',
      header: 'Status',
      cell: (row) =>
        row.status === 'retired' ? (
          <Badge variant="outline">Retired</Badge>
        ) : row.status === 'deprecated' ? (
          <Badge variant="destructive" className="h-auto whitespace-normal">
            Deprecated until {formatInstant(row.sunset, { time: false }).text}
          </Badge>
        ) : (
          <Badge variant={row.version === data.latest ? 'default' : 'secondary'}>{row.version === data.latest ? 'Latest' : 'Supported'}</Badge>
        ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">API version</h1>
        <p className="text-sm text-muted-foreground">Requests without a version header use the version you pin.</p>
      </div>

      {deprecated && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            Version {data.version} is deprecated and stops working on {formatInstant(pinned?.sunset, { time: false }).text}. Pin {data.latest} after testing.
          </p>
        </div>
      )}

      <section aria-labelledby="pinned-version" className="space-y-1 rounded-lg border p-4">
        <h2 id="pinned-version" className="text-sm font-medium text-muted-foreground">
          Pinned version
        </h2>
        <p className="font-mono text-xl font-semibold">{data.version}</p>
        <p className="text-sm text-muted-foreground">{data.pinnedAt ? <>Pinned on <Instant value={data.pinnedAt} />.</> : 'Not pinned yet. The default version applies.'}</p>
      </section>

      <ResponsiveTable
        caption="Supported versions"
        columns={columns}
        rows={data.supported}
        rowKey={(row) => row.version}
        actions={(row) =>
          canManage && row.status !== 'retired' && row.version !== data.version ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 whitespace-nowrap sm:min-h-8"
              disabled={!writable}
              title={reason ?? undefined}
              onClick={() => (setProblem(null), setTarget(row))}
            >
              Pin this version
            </Button>
          ) : null
        }
      />

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={`Pin version ${target?.version ?? ''}?`}
        description={`New requests without a version header will use ${target?.version ?? ''} within a few seconds.`}
        confirmLabel="Pin version"
        error={problem ? <DialogProblem problem={problem} /> : undefined}
        onConfirm={confirmPin}
      />
    </div>
  );
}
