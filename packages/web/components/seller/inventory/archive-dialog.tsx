'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { ProblemPanel } from '@/components/seller/problem-states';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { fetchProduct, useArchiveProduct, type InventoryRow } from '@/lib/api/seller-products';
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

  async function confirm() {
    if (!row) return;
    setProblem(null);
    try {
      const expectedVersion = row.version ?? (await fetchProduct(shopId, row.id)).version;
      await archive.mutateAsync({ productId: row.id, expectedVersion });
      toast.success('Product archived');
      onClose();
    } catch (error) {
      const failure = problemFromError(error);
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
          onClose();
        }
      }}
      title="Archive product?"
      description="It disappears from the storefront and search. You can restore it."
      confirmLabel="Archive product"
      error={problem ? <ProblemPanel problem={problem} context={{ place: 'dialog' }} /> : undefined}
      onConfirm={confirm}
    />
  );
}
