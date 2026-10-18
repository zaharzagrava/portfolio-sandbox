'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useOnline } from '@/hooks/use-online';
import { queryKeys } from '@/lib/query-keys';

export const ADMIN_OFFLINE_TEXT = "You're offline. Changes can't be saved.";

/**
 * A polite status region that is always mounted, so its changes are announced (W06 AS-52). Writes stay possible for
 * drafting; a write attempt shows its own alert. When the browser comes back, the console queries on screen refetch once.
 */
export function AdminOfflineBanner() {
  const online = useOnline();
  const queryClient = useQueryClient();
  const wasOffline = useRef(false);

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      return;
    }
    if (wasOffline.current) {
      wasOffline.current = false;
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.flags.all });
    }
  }, [online, queryClient]);

  return (
    <div role="status" className="empty:hidden">
      {!online && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">{ADMIN_OFFLINE_TEXT}</p>
      )}
    </div>
  );
}
