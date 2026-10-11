'use client';

import { useEffect, useState } from 'react';

type Connection = 'online' | 'offline' | 'back-online';

const BACK_ONLINE_MS = 3_000;

/**
 * The one offline notice of the app: driven by the browser's `online`/`offline` events (no polling). The status region is
 * always mounted so screen readers announce its changes. Re-fetching failed data on reconnect is the query client's job.
 */
export function OfflineNotice() {
  const [state, setState] = useState<Connection>('online');

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => timer !== undefined && clearTimeout(timer);
    const goOffline = () => {
      clear();
      setState('offline');
    };
    const goOnline = () => {
      clear();
      setState('back-online');
      timer = setTimeout(() => setState('online'), BACK_ONLINE_MS);
    };
    if (!navigator.onLine) goOffline();
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      clear();
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  return (
    // Fixed under the 3.5 rem header: appearing never moves the header or the page.
    <div role="status" className="fixed inset-x-0 top-14 z-40 empty:hidden">
      {state !== 'online' && (
        <p className={`px-4 py-2 text-center text-sm ${state === 'offline' ? 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-50' : 'bg-green-100 text-green-950 dark:bg-green-950 dark:text-green-50'}`}>
          {state === 'offline' ? "You're offline. Some things may not load or save until you're back online." : 'Back online.'}
        </p>
      )}
    </div>
  );
}
