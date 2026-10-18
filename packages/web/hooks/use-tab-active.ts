'use client';

import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('focus', onChange);
  window.addEventListener('blur', onChange);
  document.addEventListener('visibilitychange', onChange);
  return () => {
    window.removeEventListener('focus', onChange);
    window.removeEventListener('blur', onChange);
    document.removeEventListener('visibilitychange', onChange);
  };
}

/** The reader is really here: the tab is visible and the window has focus. Messages count as read only then (W05 AS-31). */
export function useTabActive(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.visibilityState === 'visible' && document.hasFocus(),
    () => false,
  );
}
