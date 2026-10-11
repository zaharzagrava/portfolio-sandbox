'use client';

import { useSearchParams } from 'next/navigation';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { parseProductPageView, productViewParams, type ProductTab } from '@/lib/product/page-view';

type TabSpec = { id: ProductTab; label: string };

/**
 * The tabs of the product page (W02 FR-059, AS-40): the ARIA tab pattern with roving focus (Left/Right/Home/End move the
 * focus, Enter or Space selects), the selected tab in the address (`tab`, `details` omitted) with a history entry per
 * change, and lazy panels: a panel's content is rendered when its tab is first opened and kept (hidden) afterwards, so
 * nothing for Ask or Discussions is requested by the first page view and their state survives a tab switch.
 */
export function ProductTabs({ tabs, panels }: { tabs: readonly TabSpec[]; panels: Partial<Record<ProductTab, ReactNode>> }) {
  const searchParams = useSearchParams();
  const base = useId();
  const requested = parseProductPageView(searchParams).tab;
  const active: ProductTab = tabs.some((tab) => tab.id === requested) ? requested : 'details';

  const [mounted, setMounted] = useState<ReadonlySet<ProductTab>>(new Set([active]));
  if (!mounted.has(active)) setMounted(new Set([...mounted, active]));

  const [focused, setFocused] = useState<ProductTab | null>(null);
  const refs = useRef(new Map<ProductTab, HTMLButtonElement>());
  const rovingStop = focused ?? active;

  const select = (id: ProductTab) => {
    const params = new URLSearchParams(searchParams.toString());
    const next = productViewParams({ tab: id });
    if (id === 'details') params.delete('tab');
    else params.set('tab', next.get('tab') ?? id);
    const query = params.toString();
    window.history.pushState(null, '', query ? `?${query}` : window.location.pathname);
  };

  const move = (event: KeyboardEvent, from: number) => {
    let to: number | undefined;
    if (event.key === 'ArrowRight') to = (from + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') to = (from - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = tabs.length - 1;
    if (to === undefined) return;
    event.preventDefault();
    const target = tabs[to]!;
    setFocused(target.id);
    refs.current.get(target.id)?.focus();
  };

  return (
    <div>
      <div
        role="tablist"
        aria-label="Product information"
        className="flex overflow-x-auto border-b"
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                if (node) refs.current.set(tab.id, node);
                else refs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${tab.id}`}
              tabIndex={tab.id === rovingStop ? 0 : -1}
              onClick={() => {
                setFocused(tab.id);
                select(tab.id);
              }}
              onFocus={() => setFocused(tab.id)}
              onKeyDown={(event) => move(event, index)}
              className={cn(
                'min-h-11 shrink-0 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring',
                selected ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <div
            key={tab.id}
            role="tabpanel"
            id={`${base}-panel-${tab.id}`}
            aria-labelledby={`${base}-tab-${tab.id}`}
            hidden={!selected}
            tabIndex={0}
            className="py-6 focus-visible:outline-2 focus-visible:outline-ring"
          >
            {mounted.has(tab.id) ? panels[tab.id] : null}
          </div>
        );
      })}
    </div>
  );
}
