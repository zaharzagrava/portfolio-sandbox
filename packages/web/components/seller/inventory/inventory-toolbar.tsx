'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FiltersSheet } from '@/components/seller/filters-sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { InventoryParams } from '@/lib/seller/search-params';

export const SEARCH_DEBOUNCE_MS = 300;
/** What the shop search accepts (the API refuses more). */
export const SEARCH_MAX = 100;

const STATUSES = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ARCHIVED', label: 'Archived' },
] as const;

/**
 * Search, status tabs and stock filter of the inventory (W04 AS-29, AS-30, AS-97). The values live in the URL: this component
 * only reports changes. The search text is reported after 300 ms of silence; while a search is active the tabs and the stock
 * filter are disabled, because the shop search covers every status.
 */
export function InventoryToolbar({
  params,
  onSearch,
  onStatus,
  onStock,
  onClear,
}: {
  params: InventoryParams;
  /** Called 300 ms after the last keystroke with the text (possibly empty). */
  onSearch: (text: string) => void;
  onStatus: (status: InventoryParams['status']) => void;
  onStock: (inStock: boolean | undefined) => void;
  onClear: () => void;
}) {
  const [text, setText] = useState(params.q);
  const [seenQ, setSeenQ] = useState(params.q);
  const [sent, setSent] = useState(params.q);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const searching = params.q.trim().length > 0 || text.trim().length > 0;

  // The address changed from outside (Clear search, Back): show it, unless it is the text this box itself just sent.
  if (params.q !== seenQ) {
    setSeenQ(params.q);
    if (params.q !== sent) {
      setText(params.q);
      setSent(params.q);
    }
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  function type(value: string) {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const next = value.trim();
      setSent(next);
      onSearch(next);
    }, SEARCH_DEBOUNCE_MS);
  }

  function key(event: KeyboardEvent<HTMLDivElement>) {
    const index = STATUSES.findIndex((status) => status.value === params.status);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % STATUSES.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + STATUSES.length) % STATUSES.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = STATUSES.length - 1;
    else return;
    event.preventDefault();
    const target = STATUSES[next];
    if (!target || next === index) return;
    tabs.current[target.value]?.focus();
    onStatus(target.value);
  }

  const activeFilters = (params.status !== 'ACTIVE' ? 1 : 0) + (params.inStock !== undefined ? 1 : 0);
  const filters = ({ inlineWhileSheetOpen }: { inlineWhileSheetOpen: boolean }) => (
    <>
      <div role="tablist" aria-label="Product status" onKeyDown={key} className="inline-flex h-9 items-center rounded-lg bg-muted p-[3px] text-muted-foreground">
        {STATUSES.map((status) => {
          const selected = params.status === status.value;
          return (
            <button
              key={status.value}
              ref={(node) => {
                tabs.current[status.value] = node;
              }}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              disabled={searching}
              onClick={() => !selected && onStatus(status.value)}
              className="inline-flex h-full min-h-11 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-foreground/70 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-selected:bg-background aria-selected:text-foreground sm:min-h-0"
            >
              {status.label}
            </button>
          );
        })}
      </div>
      <StockField id={inlineWhileSheetOpen ? 'inventory-stock-inline' : 'inventory-stock'} value={params.inStock} disabled={searching} onChange={onStock} />
    </>
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-1.5 sm:max-w-sm">
        <Label htmlFor="inventory-search">Search your products</Label>
        <Input id="inventory-search" type="search" value={text} autoComplete="off" onChange={(event) => type(event.target.value)} className="h-11 sm:h-8" />
      </div>
      <FiltersSheet activeCount={activeFilters} onClear={onClear}>
        {filters}
      </FiltersSheet>
      {searching && (
        <div className="text-sm text-muted-foreground">
          <p>Search covers all products.</p>
          <p>Search results can take a few seconds to include new products.</p>
        </div>
      )}
    </div>
  );
}

/** The Stock select. The filters render twice (inline and in the phone sheet), so each copy gets its own id for its label. */
function StockField({ id, value, disabled, onChange }: { id: string; value: boolean | undefined; disabled: boolean; onChange: (inStock: boolean | undefined) => void }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Stock</Label>
      <select
        id={id}
        value={value === undefined ? '' : String(value)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}
        className="h-11 w-full rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 md:text-sm dark:bg-input/30"
      >
        <option value="">All</option>
        <option value="true">In stock</option>
        <option value="false">Out of stock</option>
      </select>
    </div>
  );
}
