'use client';

import { useEffect } from 'react';
import { navigateTo, useSearchView } from '@/hooks/use-search-view';
import { searchHref } from '@/lib/routes';

/**
 * Replaces the address with its canonical form when the one that was opened has unknown, legacy, repeated or invalid
 * parts (W02 AS-12). The entry is replaced, never added, and nothing is shown.
 */
export function CanonicalUrl() {
  const { view, changed } = useSearchView();
  useEffect(() => {
    if (changed) navigateTo(searchHref(view), 'replace');
  }, [changed, view]);
  return null;
}
