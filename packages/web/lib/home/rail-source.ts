import { getTrending } from '@/lib/server/trending.server';
import { getCatalogueBrowse } from '@/lib/server/search.server';
import { railItemToCard, searchItemToCard, type CardModel } from '@/lib/product/cards';

export const HOME_RAIL_SIZE = 8;

/** `trending` and `catalogue` carry cards; `empty` is the "No products yet." state. */
export type HomeRail = { kind: 'trending' | 'catalogue' | 'empty'; cards: CardModel[] };

/**
 * The home rail's fallback chain (W02 FR-003): trending items, else the first eight products of a browse search, else
 * nothing. Neither read throws; a failed one is already a value and is cached for at most five seconds by its module.
 */
export async function homeRailSource(): Promise<HomeRail> {
  const trending = await getTrending();
  if (trending.ok && trending.data.items.length > 0) {
    const items = [...trending.data.items].sort((a, b) => a.rank - b.rank).slice(0, HOME_RAIL_SIZE);
    return { kind: 'trending', cards: items.map(railItemToCard) };
  }
  const browse = await getCatalogueBrowse();
  if (browse.ok && browse.data.items.length > 0) {
    return { kind: 'catalogue', cards: browse.data.items.slice(0, HOME_RAIL_SIZE).map(searchItemToCard) };
  }
  return { kind: 'empty', cards: [] };
}
