'use client';

import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/** Whether the tab is visible. Assumed visible on the server and before hydration. A hidden tab polls and pings nothing (W05 AS-29). */
export function useVisible(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.visibilityState !== 'hidden',
    () => true,
  );
}
