'use client';

import { useId } from 'react';
import type { SearchView, SearchViewSort } from '@/lib/search/search-view';

const ORDERS: { value: SearchViewSort; label: string }[] = [
  { value: 'price-asc', label: 'Price: low to high' },
  { value: 'price-desc', label: 'Price: high to low' },
  { value: 'newest', label: 'Newest' },
];

/**
 * "Sort by" (W02 FR-026): the default is Relevance with a query and Featured without one; the default is never written
 * to the address (`onChange(undefined)`).
 */
export function SortControl({ view, onChange, disabled }: { view: SearchView; onChange: (sort: SearchViewSort | undefined) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm text-muted-foreground">
        Sort by
      </label>
      <select
        id={id}
        value={view.sort ?? ''}
        disabled={disabled}
        onChange={(event) => onChange((event.target.value || undefined) as SearchViewSort | undefined)}
        className="h-9 rounded-md border bg-background px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring max-sm:h-11"
      >
        <option value="">{view.q ? 'Relevance' : 'Featured'}</option>
        {ORDERS.map((order) => (
          <option key={order.value} value={order.value}>
            {order.label}
          </option>
        ))}
      </select>
    </div>
  );
}
