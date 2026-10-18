'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { useArchiveFlag, useKillFlag, useRefetchFlag, useRestoreFlag } from '@/hooks/use-admin-flags';
import { readFlagProblem, type FlagProblem } from '@/lib/api/admin-flags';
import { flagProblemCopy } from '@/lib/admin/flags/copy';
import type { LifecycleAction } from '@/lib/admin/flags/transitions';
import { DANGER_BUTTON } from './danger';
import { FlagProblemAlert } from './flag-problem';

type Copy = { title: string; description: string; confirm: string; busy: string; done: string };

function copyFor(action: LifecycleAction, key: string, offVariant: string): Copy {
  switch (action) {
    case 'kill':
      return {
        title: `Kill ${key}?`,
        description: `Every evaluation will serve the off variant (${offVariant}) regardless of targeting. Rules and rollouts are kept. The change reaches services within seconds and browsers on their next fetch. Restoring is a separate step.`,
        confirm: 'Kill flag',
        busy: 'Killing…',
        done: `Flag ${key} killed.`,
      };
    case 'restore':
      return {
        title: `Restore ${key}?`,
        description: 'It becomes disabled: still off for everyone. You can enable it afterwards by saving.',
        confirm: 'Restore flag',
        busy: 'Restoring…',
        done: `Flag ${key} restored. It is disabled.`,
      };
    default:
      return {
        title: `Archive ${key}?`,
        description:
          'It leaves the active list and stops evaluating (services get their fallback). Its key can never be reused. Its history stays readable.',
        confirm: 'Archive flag',
        busy: 'Archiving…',
        done: `Flag ${key} archived.`,
      };
  }
}

/**
 * The confirmation of kill, restore and archive (W06 AS-32, AS-36, AS-37, FR-030), shared by the editor header and the row menu.
 * Focus starts on Cancel, one press sends one request, the state changes only from the refetch after the `204`. A failure
 * keeps the dialog open with the catalogue's alert (AS-38, AS-39). Mount it while an action is chosen; `onClose` unmounts it.
 */
export function LifecycleDialog({ flagKey, action, offVariant, onClose }: { flagKey: string; action: LifecycleAction; offVariant: string; onClose: () => void }) {
  const kill = useKillFlag(flagKey);
  const restore = useRestoreFlag(flagKey);
  const archive = useArchiveFlag(flagKey);
  const refetch = useRefetchFlag(flagKey);
  const mutation = action === 'kill' ? kill : action === 'restore' ? restore : archive;
  const [problem, setProblem] = useState<FlagProblem | null>(null);
  const copy = copyFor(action, flagKey, offVariant);

  async function confirm() {
    setProblem(null);
    try {
      await mutation.mutateAsync();
    } catch (error) {
      const read = readFlagProblem(error);
      setProblem(read);
      if (flagProblemCopy(read, { op: action, key: flagKey }).refetch) void refetch();
      throw error;
    }
    toast(copy.done);
    onClose();
  }

  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={copy.title}
      description={copy.description}
      confirmLabel={mutation.isPending ? copy.busy : copy.confirm}
      destructive={action !== 'restore'}
      confirmClassName={action !== 'restore' ? DANGER_BUTTON : undefined}
      error={problem ? <FlagProblemAlert problem={problem} op={action} flagKey={flagKey} onRetry={() => void confirm().catch(() => undefined)} /> : undefined}
      onConfirm={confirm}
    />
  );
}
