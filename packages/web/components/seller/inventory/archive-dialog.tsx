'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { ProblemPanel } from '@/components/seller/problem-states';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { Button } from '@/components/ui/button';
import { ARCHIVED_ELSEWHERE, fetchProduct, isArchivedNow, useArchiveProduct, type InventoryRow } from '@/lib/api/seller-products';
import { STALE_ROW_CODES } from './stock-popover';

/**
 * "Archive product" confirmation (W04 AS-40, AS-41, AS-94): focus starts on Cancel. It archives against the version the row
 * carried (a search row carries none, so the member view is read first). A row that is already out of date closes the dialog
 * and is explained by the page (`onStale`); any other refusal stays in the dialog for another try.
 */
export function ArchiveDialog({
  shopId,
  row,
  onClose,
  onStale,
}: {
  shopId: string;
  row: InventoryRow | null;
  onClose: () => void;
  onStale: (problem: Problem) => void;
}) {
  const archive = useArchiveProduct(shopId);
  const [problem, setProblem] = useState<Problem | null>(null);
  // The version after "Load latest"; the row on screen still carries the old one.
  const [latest, setLatest] = useState<{ id: string; version: number } | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(false);
  // A rate-limit countdown is running: the confirm button stays disabled until it ends (B-098).
  const [counting, setCounting] = useState(false);

  async function loadLatest() {
    if (!row) return;
    setLoadingLatest(true);
    try {
      const product = await fetchProduct(shopId, row.id);
      if (product.status === 'ARCHIVED') {
        onStale(ARCHIVED_ELSEWHERE);
        onClose();
        return;
      }
      setLatest({ id: row.id, version: product.version });
      setProblem(null);
    } catch (error) {
      setProblem(problemFromError(error));
    } finally {
      setLoadingLatest(false);
    }
  }

  async function confirm() {
    if (!row) return;
    setProblem(null);
    try {
      const expectedVersion = (latest?.id === row.id ? latest.version : undefined) ?? row.version ?? (await fetchProduct(shopId, row.id)).version;
      await archive.mutateAsync({ productId: row.id, expectedVersion });
      toast.success('Product archived');
      onClose();
    } catch (error) {
      const failure = problemFromError(error);
      // a list row that is stale because the product was archived elsewhere is an archive, not "changed"
      if (failure.code === 'version_conflict' && (await isArchivedNow(shopId, row.id))) {
        onStale(ARCHIVED_ELSEWHERE);
        onClose();
        return;
      }
      if (failure.code && STALE_ROW_CODES.includes(failure.code)) {
        onStale(failure);
        onClose();
        return;
      }
      setProblem(failure);
      throw error;
    }
  }

  return (
    <ConfirmDialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) {
          setProblem(null);
          setLatest(null);
          onClose();
        }
      }}
      title="Archive product?"
      description="It disappears from the storefront and search. You can restore it."
      confirmLabel="Archive product"
      confirmDisabled={counting && problem !== null}
      error={
        problem ? (
          <div className="grid justify-items-start gap-2">
            <ProblemPanel problem={problem} context={{ place: 'dialog' }} className="w-full" onActiveChange={setCounting} />
            {problem.code === 'version_conflict' && (
              <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-7" disabled={loadingLatest} onClick={() => void loadLatest()}>
                Load latest
              </Button>
            )}
          </div>
        ) : undefined
      }
      onConfirm={confirm}
    />
  );
}
