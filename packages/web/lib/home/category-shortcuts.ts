import { getCategoryFacets } from '@/lib/server/search.server';
import { facetLabel } from '@/lib/search/facet-label';
import { searchHref } from '@/lib/routes';

export type CategoryShortcut = { key: string; label: string; href: string };

const SHORTCUT_COUNT = 8;

/**
 * The first eight category facets of a browse search, as links to `/search?category=<key>` (W02 FR-004). Any failure
 * gives an empty list: the row is omitted without a message.
 */
export async function categoryShortcuts(): Promise<CategoryShortcut[]> {
  const result = await getCategoryFacets();
  if (!result.ok) return [];
  return (result.data.facets?.categories ?? []).slice(0, SHORTCUT_COUNT).map(({ key }) => ({
    key,
    label: facetLabel(key),
    href: searchHref({ category: key }),
  }));
}
