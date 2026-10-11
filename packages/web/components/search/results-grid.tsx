'use client';

import type { MouseEvent } from 'react';
import type { ProductSearchItem } from '@marketplace-sandbox/contracts';
import { ProductCard } from '@/components/product/product-card';
import { logSearchClick } from '@/lib/api/search';
import { searchItemToCard } from '@/lib/product/cards';

/** An item that came twice (the index moved between fetches) is shown once per page. */
function unique(items: ProductSearchItem[]): ProductSearchItem[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

/**
 * The cards in the order the API gave them (sponsored ones included, never moved). The first activation of a result link
 * (click, Enter, middle click) sends one click record with the API's position and the `searchId` of the response that
 * produced the card (W02 FR-035); the record never delays the navigation.
 */
export function ResultsGrid({ items, searchId }: { items: ProductSearchItem[]; searchId: string }) {
  const record = (item: ProductSearchItem, event: MouseEvent) => {
    if (!(event.target instanceof Element) || !event.target.closest('a')) return;
    logSearchClick({ searchId, productId: item.id, position: item.position });
  };
  return (
    <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4" data-testid="search-results">
      {unique(items).map((item) => (
        <li
          key={item.id}
          onClick={(event) => record(item, event)}
          onAuxClick={(event) => {
            if (event.button === 1) record(item, event);
          }}
        >
          <ProductCard {...searchItemToCard(item)} />
        </li>
      ))}
    </ul>
  );
}
