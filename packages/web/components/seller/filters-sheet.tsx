'use client';

import { useState, type ReactNode } from 'react';
import { SlidersHorizontalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

/**
 * The filter bar of a list page (W04 AS-97). From 641 px up the filters sit inline; at 640 px and below a "Filters" button
 * opens them in a full-height sheet (a dialog: focus moves in, Tab stays in, Escape closes, focus returns to the button).
 * The filters render twice while the sheet is open; the inline copy is `inert` then, so a field never exists twice for
 * assistive technology or the keyboard. Filter state belongs in the URL, not here.
 */
export function FiltersSheet({
  children,
  activeCount = 0,
  onClear,
  title = 'Filters',
}: {
  /** The filters. A function receives `inlineSheetOpen`: `true` for the inline copy while the sheet is open, so a control can give its twin another id (B-066). */
  children: ReactNode | ((copy: { inlineWhileSheetOpen: boolean }) => ReactNode);
  /** How many filters differ from their defaults; shown on the button. */
  activeCount?: number;
  onClear?: () => void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div data-filters-inline="" inert={open} className="hidden flex-wrap items-end gap-3 min-[641px]:flex">
        {typeof children === 'function' ? children({ inlineWhileSheetOpen: open }) : children}
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button type="button" variant="outline" className="min-h-11 w-full min-[641px]:hidden">
            <SlidersHorizontalIcon aria-hidden="true" />
            {activeCount > 0 ? `${title} (${activeCount} on)` : title}
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom" showCloseButton={false} className="h-full max-h-dvh overflow-y-auto sm:max-w-none">
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription className="sr-only">Narrow the list. The page address keeps your choices.</SheetDescription>
          </SheetHeader>
          <div className="grid gap-4 px-4">{typeof children === 'function' ? children({ inlineWhileSheetOpen: false }) : children}</div>
          <SheetFooter>
            {onClear && (
              <Button type="button" variant="outline" onClick={onClear}>
                Clear filters
              </Button>
            )}
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
