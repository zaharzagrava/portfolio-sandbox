'use client';

import { useState } from 'react';
import type { ApiKeyListItem, CreatedApiKey } from '@marketplace-sandbox/contracts';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { Label } from '@/components/ui/label';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useRotateKey, type Reveal } from '@/lib/api/seller-developers';
import { DialogProblem, NativeSelect } from './shared';

/** The old key keeps working this long after a rotation (W04 AS-51); 24 hours is the default. */
export const KEY_OVERLAPS = [
  { hours: 0, label: 'Expire immediately' },
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '72 hours' },
  { hours: 168, label: '7 days' },
] as const;

/**
 * "Rotate" a live key (W04 AS-51, AS-52): the overlap is chosen and confirmed, the new key goes to `onReveal`. Illegal
 * rotations and `mfa_required` are explained inside the dialog, which stays open. Mount it with `key={keyRow.id}` so the
 * choice starts at 24 hours for every key.
 */
export function RotateKeyDialog({
  shopId,
  keyRow,
  onClose,
  onReveal,
  returnTo,
}: {
  shopId: string;
  keyRow: ApiKeyListItem | null;
  onClose: () => void;
  onReveal: Reveal<CreatedApiKey>;
  returnTo: string;
}) {
  const rotate = useRotateKey(shopId);
  const [overlapHours, setOverlapHours] = useState(24);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function confirm() {
    if (!keyRow) return;
    setProblem(null);
    try {
      await rotate.mutateAsync({ keyId: keyRow.id, overlapHours, reveal: onReveal });
      onClose();
    } catch (error) {
      setProblem(problemFromError(error));
      throw error;
    }
  }

  return (
    <ConfirmDialog
      open={keyRow !== null}
      onOpenChange={(open) => {
        if (!open) {
          setProblem(null);
          onClose();
        }
      }}
      title="Rotate this key?"
      description={`A new key replaces ${keyRow?.name ?? 'this key'}. The old key keeps working for the time you choose, then stops.`}
      confirmLabel="Rotate key"
      error={problem ? <DialogProblem problem={problem} returnTo={returnTo} /> : undefined}
      onConfirm={confirm}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="rotate-overlap">Keep the old key working for</Label>
        <NativeSelect id="rotate-overlap" value={String(overlapHours)} onChange={(event) => setOverlapHours(Number(event.target.value))}>
          {KEY_OVERLAPS.map((option) => (
            <option key={option.hours} value={option.hours}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      </div>
    </ConfirmDialog>
  );
}
