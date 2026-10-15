'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { captureRef } from '@/lib/api/attribution';
import { isValidRefCode } from '@/lib/attribution/ref-code';

/**
 * The referral capture of a product page (W02 AS-63): when the address carries a valid `?ref=`, the code is handed to the
 * web app's endpoint once per page view, which sets the `HttpOnly` `__Host-ref` cookie. Nothing is shown and nothing can
 * go wrong visibly. The code is not kept anywhere in the browser.
 */
export function RefCapture() {
  const pathname = usePathname();
  const code = useSearchParams().get('ref');
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (!isValidRefCode(code)) return;
    const pageView = `${pathname}?ref=${code}`;
    if (last.current === pageView) return; // development mounts effects twice
    last.current = pageView;
    void captureRef(code);
  }, [pathname, code]);

  return null;
}
