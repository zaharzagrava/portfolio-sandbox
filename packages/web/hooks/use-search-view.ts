'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import { searchHref } from '@/lib/routes';
import { parseSearchView, withChange, type SearchView } from '@/lib/search/search-view';

/** Moves the address without a server round trip: Next's router follows `history.pushState`/`replaceState`. */
export function navigateTo(href: string, mode: 'push' | 'replace' = 'push'): void {
  if (mode === 'replace') window.history.replaceState(null, '', href);
  else window.history.pushState(null, '', href);
}

/**
 * The view of `/search` as the address says it (W02 FR-020, FR-023): parsed on every address change, so reload, a new
 * tab and back/forward all give the same view. Changes write the address through the history API: no page fetch, no
 * reload, and any change but the cursor drops the cursor.
 */
export function useSearchView() {
  const searchParams = useSearchParams();
  const text = searchParams.toString();
  const { view, changed } = useMemo(() => parseSearchView(new URLSearchParams(text)), [text]);

  const change = useCallback(
    (patch: Partial<SearchView>, mode: 'push' | 'replace' = 'push') => navigateTo(searchHref(withChange(view, patch)), mode),
    [view],
  );
  /** Replaces the whole view (clear all, chip removal, cleaned view). */
  const set = useCallback((next: SearchView, mode: 'push' | 'replace' = 'push') => navigateTo(searchHref(next), mode), []);

  return { view, changed, change, set };
}
