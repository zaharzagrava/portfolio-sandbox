'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import { parseProductPageView, productViewParams, type DiscussionSort, type DiscussionWindow } from '@/lib/product/page-view';
import { loginHref } from '@/lib/auth/return-to';

export type DiscussionsView = { sort: DiscussionSort; window?: DiscussionWindow; post?: string };
type Change = { sort?: DiscussionSort; window?: DiscussionWindow | null; post?: string | null };

/**
 * The discussions' view state as the address says it (W02 FR-081, FR-090): `sort`, `window` (only with `top`) and the
 * expanded `post`. Changes are written through the history API, like the tabs do, and keep every other parameter. Also
 * gives the sign-in link that returns to this very view (FR-088).
 */
export function useDiscussionsView() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const text = searchParams.toString();

  const view = useMemo<DiscussionsView>(() => {
    const parsed = parseProductPageView(new URLSearchParams(text));
    return { sort: parsed.sort, ...(parsed.window ? { window: parsed.window } : {}), ...(parsed.post ? { post: parsed.post } : {}) };
  }, [text]);

  const returnTo = useMemo(() => {
    const parsed = parseProductPageView(new URLSearchParams(text));
    const query = productViewParams({ ...parsed, tab: 'discussions' }).toString();
    return `${pathname}?${query}`;
  }, [text, pathname]);

  const change = useCallback(
    (patch: Change, mode: 'push' | 'replace' = 'push') => {
      const params = new URLSearchParams(window.location.search);
      if (patch.sort !== undefined) {
        if (patch.sort === 'hot') params.delete('sort');
        else params.set('sort', patch.sort);
        if (patch.sort !== 'top') params.delete('window');
      }
      if (patch.window !== undefined) {
        if (patch.window === null) params.delete('window');
        else params.set('window', patch.window);
      }
      if (patch.post !== undefined) {
        if (patch.post === null) params.delete('post');
        else params.set('post', patch.post);
      }
      const query = params.toString();
      const href = query ? `${window.location.pathname}?${query}` : window.location.pathname;
      if (mode === 'replace') window.history.replaceState(null, '', href);
      else window.history.pushState(null, '', href);
    },
    [],
  );

  return { view, change, returnTo, signInHref: loginHref(returnTo) };
}
