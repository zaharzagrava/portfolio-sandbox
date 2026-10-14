'use client';

import { useSyncExternalStore } from 'react';

const DESKTOP = '(min-width: 1024px)';

const subscribe = (notify: () => void) => {
  const query = window.matchMedia(DESKTOP);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};

/** True from 1024 px up (the layout switch of W01 FR-051); `false` on the server and until hydration. */
export const useDesktop = (): boolean => useSyncExternalStore(subscribe, () => window.matchMedia(DESKTOP).matches, () => false);
