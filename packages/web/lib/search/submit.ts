import { parseSearchView, withChange, type RawSearchParams } from '@/lib/search/search-view';
import { searchHref } from '@/lib/routes';

export const SEARCH_TEXT_MAX = 100;

/** Trims and cuts to 100 code points: what a search box sends (W02 AS-09). */
export function normaliseQuery(text: string): string {
  return Array.from(text.trim()).slice(0, SEARCH_TEXT_MAX).join('').trim();
}

/**
 * Where a submitted text goes (W02 FR-015): from another page `/search?q=<text>` and nothing else (an empty text goes to
 * `/search`); from `/search` the current filters and sort stay, the cursor goes, an empty text removes `q`.
 */
export function submitHref(onSearchPage: boolean, current: RawSearchParams, text: string): string {
  const q = normaliseQuery(text);
  if (!onSearchPage) return searchHref(q ? { q } : {});
  const { view } = parseSearchView(current);
  return searchHref(withChange(view, { q: q || undefined }));
}
