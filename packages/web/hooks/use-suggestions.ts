'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { fetchSuggestions, SUGGEST_MAX_LENGTH } from '@/lib/api/suggest';
import { queryKeys } from '@/lib/query-keys';

export const SUGGEST_DEBOUNCE_MS = 150;

export type SuggestionsStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

/** Lower case, whitespace collapsed: the prefix the cache and the request share (W02 FR-012). */
const normalise = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Suggestions for the text of a search box (W02 AS-07, AS-08): the request starts 150 ms after the last change, a newer
 * prefix cancels the older request (TanStack aborts the signal when the key changes), an answer is shown only for the
 * current prefix, and a prefix seen in the last 60 seconds comes from the cache. Failures are a status, never a throw.
 */
export function useSuggestions(text: string) {
  const prefix = normalise(text);
  const usable = prefix.length > 0 && Array.from(prefix).length <= SUGGEST_MAX_LENGTH;
  const [settled, setSettled] = useState(prefix);

  useEffect(() => {
    if (prefix === settled) return;
    const timer = setTimeout(() => setSettled(prefix), SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [prefix, settled]);

  const enabled = usable && settled === prefix;
  const query = useQuery({
    queryKey: queryKeys.suggest.prefix(prefix),
    queryFn: ({ signal }) => fetchSuggestions(prefix, { signal }),
    enabled,
  });

  const items = enabled && query.isSuccess ? query.data : [];
  const status: SuggestionsStatus = !usable
    ? 'idle'
    : !enabled || query.isPending
      ? 'loading'
      : query.isError
        ? 'error'
        : items.length === 0
          ? 'empty'
          : 'ready';
  const announce = status === 'ready' ? `${items.length} suggestion${items.length === 1 ? '' : 's'} available` : status === 'empty' ? 'No suggestions' : '';
  return { items, status, announce };
}
