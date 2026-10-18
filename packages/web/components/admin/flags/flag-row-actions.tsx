'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Flag } from '@marketplace-sandbox/contracts';
import { RowMenu } from '@/components/seller/row-menu';
import { useFlagWriteBusy } from '@/hooks/use-admin-flags';
import { flagHref } from '@/lib/admin/flags/params';
import { availableActions, type LifecycleAction } from '@/lib/admin/flags/transitions';
import { LifecycleDialog } from './lifecycle-dialogs';

const LABEL: Record<LifecycleAction, string> = { kill: 'Kill switch', restore: 'Restore', archive: 'Archive' };

/**
 * The action menu of one row (W06 AS-08): Open, and the lifecycle actions that status allows, each through the same dialog
 * as the editor. The trigger is named "Actions for {key}"; focus returns to it when the menu closes. While a write is in
 * flight the lifecycle items are disabled (AS-39).
 */
export function FlagRowActions({ flag }: { flag: Pick<Flag, 'key' | 'status' | 'offVariant'> }) {
  const router = useRouter();
  const busy = useFlagWriteBusy();
  const [chosen, setChosen] = useState<LifecycleAction | null>(null);
  const allowed = availableActions(flag.status);
  return (
    <>
      <RowMenu
        label={flag.key}
        items={[
          { id: 'open', label: 'Open', onSelect: () => router.push(flagHref(flag.key)) },
          ...(['kill', 'restore', 'archive'] as const).map((action) => ({
            id: action,
            label: LABEL[action],
            destructive: action === 'kill',
            hidden: !allowed.includes(action),
            disabled: busy,
            onSelect: () => setChosen(action),
          })),
        ]}
      />
      {chosen && <LifecycleDialog flagKey={flag.key} action={chosen} offVariant={flag.offVariant} onClose={() => setChosen(null)} />}
    </>
  );
}
