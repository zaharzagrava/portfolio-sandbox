'use client';

import { Search, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { SearchBox } from '@/components/search/search-box';
import { Button } from '@/components/ui/button';

/**
 * Mobile search: a button in the header that opens a full-width row under it holding the same search box.
 * Absent on `/` and `/search`, where the page has its own box. Escape and "Close search" return focus to the button.
 */
export function SearchRow() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(pathname);
  const button = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLDivElement>(null);

  // Opened on another page than the current one: the route changed, close.
  if (open && openedAt !== pathname) setOpen(false);

  useEffect(() => {
    if (open) row.current?.querySelector<HTMLElement>('input')?.focus();
  }, [open]);

  if (pathname === '/' || pathname === '/search') return null;

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };

  return (
    <>
      <Button
        ref={button}
        variant="ghost"
        size="icon-lg"
        className="size-11"
        aria-label="Search"
        aria-expanded={open}
        onClick={() => {
          setOpenedAt(pathname);
          setOpen(true);
        }}
      >
        <Search aria-hidden="true" className="h-5 w-5" />
      </Button>
      {open && (
        // Absolute to the sticky header: full width, directly under it.
        <div ref={row} onKeyDown={onKeyDown} className="absolute inset-x-0 top-full flex items-center gap-2 border-b bg-background p-2">
          <div className="flex-1">
            <SearchBox variant="navbar" />
          </div>
          <Button variant="ghost" size="icon-lg" className="size-11" aria-label="Close search" onClick={close}>
            <X aria-hidden="true" className="h-5 w-5" />
          </Button>
        </div>
      )}
    </>
  );
}
