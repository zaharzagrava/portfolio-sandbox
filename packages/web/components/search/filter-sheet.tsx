'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

/**
 * The filter panel as a bottom sheet below 1024 px (W02 FR-181): a **Filters** button with the active count, the panel,
 * and a footer with **Show {n} results** and **Clear all** that stays reachable without scrolling.
 */
export function FilterSheet({
  activeCount,
  resultLabel,
  onClearAll,
  children,
}: {
  activeCount: number;
  /** The number on the "Show … results" button, as the page shows it. */
  resultLabel: string;
  onClearAll: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="outline" className="min-h-11 lg:hidden">
          <SlidersHorizontal aria-hidden="true" className="mr-2 size-4" />
          Filters
          {activeCount > 0 ? (
            <span className="ml-2 rounded-full bg-primary px-2 text-xs text-primary-foreground" aria-label={`${activeCount} active`}>
              {activeCount}
            </span>
          ) : null}
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[85dvh]">
        <SheetHeader>
          <SheetTitle>Filters</SheetTitle>
          <SheetDescription className="sr-only">Narrow the search results.</SheetDescription>
        </SheetHeader>
        <div className="overflow-y-auto px-4">{children}</div>
        <SheetFooter className="flex-row border-t bg-popover">
          <Button type="button" variant="outline" className="min-h-11 flex-1" onClick={onClearAll}>
            Clear all
          </Button>
          <Button type="button" className="min-h-11 flex-1" onClick={() => setOpen(false)}>
            {`Show ${resultLabel}`}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
