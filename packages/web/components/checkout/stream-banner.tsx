'use client';

import { useStreamBanner } from '@/hooks/use-user-stream';

/**
 * "Live updates paused. Reconnecting…" (W03 AS-45): shown while the shared stream is reconnecting, by the one component on
 * the page that owns the banner (the page's first claimant), so two screens never repeat it. Polling covers the gap.
 */
export function StreamBanner() {
  const show = useStreamBanner();
  if (!show) return null;
  return (
    <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100">
      Live updates paused. Reconnecting…
    </div>
  );
}
