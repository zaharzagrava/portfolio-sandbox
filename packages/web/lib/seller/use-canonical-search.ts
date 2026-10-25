'use client';

import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { canonicalSearch } from './search-params';

/**
 * Rewrites the address of a list page to its canonical form once (history `replace`, no new entry): an unsupported or repeated
 * value of one of `keys` is dropped and a default is left out (W04 R-10). `canonical` is `buildQuery` of the values the page
 * read from the address, so the page shown and the address always agree.
 */
export function useCanonicalSearch(keys: readonly string[], canonical: string) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const next = canonicalSearch(search, keys, canonical);
  useEffect(() => {
    if (next !== null) router.replace(next ? `${pathname}?${next}` : pathname);
  }, [next, pathname, router]);
}
