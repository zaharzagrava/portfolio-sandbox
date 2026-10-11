'use client';

import { X } from 'lucide-react';
import { formatMoney } from '@/lib/utils';
import { currencyDigits } from '@/lib/search/price-input';
import { hasActiveFilters, type SearchView } from '@/lib/search/search-view';
import type { FilterPatch } from '@/components/search/filter-panel';

type Chip = { key: string; label: string; patch: FilterPatch };

/** "$10" for a whole amount, "$10.50" otherwise. */
function chipMoney(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  const whole = minor % 10 ** digits === 0;
  return whole
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 10 ** digits)
    : formatMoney(minor, currency);
}

function priceLabel(view: SearchView, currency: string): string | undefined {
  const { minPriceMinor: min, maxPriceMinor: max } = view;
  if (min !== undefined && max !== undefined) return `Price: ${chipMoney(min, currency)} – ${chipMoney(max, currency)}`;
  if (min !== undefined) return `Price: from ${chipMoney(min, currency)}`;
  if (max !== undefined) return `Price: up to ${chipMoney(max, currency)}`;
  return undefined;
}

/** The active filters as removable chips above the grid (W02 AS-15); `q`, `sort` and `semantic` are not filters. */
export function chipsOf(view: SearchView, currency: string): Chip[] {
  const chips: Chip[] = [];
  if (view.category) chips.push({ key: 'category', label: `Category: ${view.category}`, patch: { category: undefined } });
  if (view.brand) chips.push({ key: 'brand', label: `Brand: ${view.brand}`, patch: { brand: undefined } });
  const price = priceLabel(view, currency);
  if (price) chips.push({ key: 'price', label: price, patch: { minPriceMinor: undefined, maxPriceMinor: undefined } });
  if (view.minRating !== undefined) {
    chips.push({ key: 'rating', label: `${view.minRating} ${view.minRating === 1 ? 'star' : 'stars'} & up`, patch: { minRating: undefined } });
  }
  if (view.inStock) chips.push({ key: 'stock', label: 'In stock', patch: { inStock: undefined } });
  return chips;
}

export function FilterChips({
  view,
  currency,
  onRemove,
  onClearAll,
}: {
  view: SearchView;
  currency: string;
  onRemove: (patch: FilterPatch) => void;
  onClearAll: () => void;
}) {
  const chips = chipsOf(view, currency);
  if (chips.length === 0) return null;
  return (
    <ul className="flex gap-2 overflow-x-auto pb-1 lg:flex-wrap lg:overflow-visible" aria-label="Active filters">
      {chips.map((chip) => (
        <li key={chip.key} className="shrink-0">
          <span className="inline-flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pl-3 pr-1 text-sm">
            {chip.label}
            <button
              type="button"
              aria-label={`Remove filter ${chip.label}`}
              onClick={() => onRemove(chip.patch)}
              className="flex size-7 items-center justify-center rounded-full hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring max-sm:size-11"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </span>
        </li>
      ))}
      {hasActiveFilters(view) ? (
        <li className="shrink-0">
          <button
            type="button"
            onClick={onClearAll}
            className="inline-flex min-h-8 items-center rounded-full px-3 text-sm underline underline-offset-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring max-sm:min-h-11"
          >
            Clear all filters
          </button>
        </li>
      ) : null}
    </ul>
  );
}
