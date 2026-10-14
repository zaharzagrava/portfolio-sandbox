'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { track } from '@/lib/analytics/track';
import { pageNameFor } from '@/lib/routes/page-name';

/**
 * One `page_view` per navigation (AS-35), named by route template: the address, its query and its fragment are never
 * sent. `track()` applies the privacy rule itself (Global Privacy Control, Do Not Track). Renders nothing.
 */
export function PageView() {
  const pathname = usePathname();
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (last.current === pathname) return; // development mounts effects twice
    last.current = pathname;
    track({ name: 'page_view', page: pageNameFor(pathname) });
  }, [pathname]);

  return null;
}
