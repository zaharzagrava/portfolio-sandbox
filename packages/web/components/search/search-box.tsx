'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useId, useRef, useState, type ChangeEvent, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSuggestions } from '@/hooks/use-suggestions';
import { parseSearchView } from '@/lib/search/search-view';
import { SEARCH_TEXT_MAX, normaliseQuery, submitHref } from '@/lib/search/submit';

type Variant = 'hero' | 'page' | 'navbar';

const FIELD_HEIGHT: Record<Variant, string> = { hero: 'h-12 text-base', page: 'h-11 text-base', navbar: 'h-9 text-sm' };

/**
 * The search box of every page (W02 FR-010..FR-017): a combobox with suggestions. `hero` is Home's, `page` is the search
 * page's, `navbar` is W07's and renders nothing where the page has its own box. State is local to the box, so typing never
 * re-renders the page around it.
 */
export function SearchBox({ variant }: { variant: Variant }) {
  const pathname = usePathname();
  if (variant === 'navbar' && (pathname === '/' || pathname === '/search')) return null;
  return (
    <Suspense fallback={<div aria-hidden="true" className={cn('w-full rounded-md border bg-background', FIELD_HEIGHT[variant])} />}>
      <SearchBoxField variant={variant} onSearchPage={pathname === '/search'} />
    </Suspense>
  );
}

function SearchBoxField({ variant, onSearchPage }: { variant: Variant; onSearchPage: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const addressQuery = onSearchPage ? (parseSearchView(searchParams).view.q ?? '') : '';

  const [text, setText] = useState(addressQuery);
  // The box follows the address (back/forward): adjust state while rendering, no effect needed.
  const [seenAddressQuery, setSeenAddressQuery] = useState(addressQuery);
  if (seenAddressQuery !== addressQuery) {
    setSeenAddressQuery(addressQuery);
    setText(addressQuery);
  }

  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [limitHint, setLimitHint] = useState(false);
  const pasteOverflow = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const hintId = `${baseId}-hint`;

  const { items, status, announce } = useSuggestions(text);
  const open = focused && !dismissed && items.length > 0;
  const activeId = open && activeIndex >= 0 ? `${baseId}-option-${activeIndex}` : undefined;

  const go = (value: string) => {
    const href = submitHref(onSearchPage, searchParams, value);
    setDismissed(true);
    setActiveIndex(-1);
    if (onSearchPage) window.history.pushState(null, '', href);
    else router.push(href);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    go(activeIndex >= 0 && open ? (items[activeIndex] ?? text) : text);
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    setText(event.target.value);
    setDismissed(false);
    setActiveIndex(-1);
    setLimitHint(pasteOverflow.current);
    pasteOverflow.current = false;
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const pasted = Array.from(event.clipboardData.getData('text')).length;
    const kept = Array.from(input.value).length - Math.abs((input.selectionEnd ?? 0) - (input.selectionStart ?? 0));
    pasteOverflow.current = kept + pasted > SEARCH_TEXT_MAX;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (items.length === 0) return;
      event.preventDefault();
      if (!open) {
        setDismissed(false);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => (index < 0 ? (step === 1 ? 0 : items.length - 1) : (index + step + items.length) % items.length));
    } else if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        setDismissed(true);
        setActiveIndex(-1);
      } else if (text !== '') {
        event.preventDefault();
        setText('');
        setLimitHint(false);
      }
    } else if (event.key === 'Tab') {
      setDismissed(true);
      setActiveIndex(-1);
    }
  };

  const clear = () => {
    setText('');
    setDismissed(true);
    setActiveIndex(-1);
    setLimitHint(false);
    inputRef.current?.focus();
  };

  const trimmed = normaliseQuery(text);

  return (
    <form role="search" onSubmit={onSubmit} data-variant={variant} className="relative w-full" aria-label="Search">
      <div className="relative flex w-full items-center">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          name="q"
          role="combobox"
          aria-label="Search products"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-describedby={limitHint ? hintId : undefined}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
          maxLength={SEARCH_TEXT_MAX}
          placeholder="Search products…"
          value={text}
          onChange={onChange}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className={cn(
            'w-full rounded-md border bg-background pl-9 pr-24 outline-none focus-visible:ring-2 focus-visible:ring-ring',
            FIELD_HEIGHT[variant],
          )}
        />
        <div className="absolute right-1 flex items-center gap-1">
          {text !== '' ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={clear}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring max-sm:size-11"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          ) : null}
          <button
            type="submit"
            aria-label="Search"
            className="flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring max-sm:h-11"
          >
            Search
          </button>
        </div>
      </div>

      {limitHint ? (
        <p id={hintId} className="mt-1 text-xs text-muted-foreground">
          Search is limited to 100 characters.
        </p>
      ) : null}

      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>

      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Search suggestions"
          className="absolute z-30 mt-1 max-h-80 w-full overflow-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
        >
          {items.map((item, index) => (
            // The API sends no duplicate suggestions (W02 FR-013).
            <li
              key={item}
              id={`${baseId}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              // Keeps focus in the input while the pointer selects.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => go(item)}
              className={cn('cursor-pointer px-3 py-2 text-sm hover:bg-accent', index === activeIndex && 'bg-accent')}
            >
              {item}
            </li>
          ))}
        </ul>
      ) : status === 'empty' && focused && trimmed !== '' ? (
        <p className="absolute z-30 mt-1 w-full rounded-md border bg-popover px-3 py-2 text-sm text-muted-foreground shadow-md">No suggestions</p>
      ) : null}
    </form>
  );
}
