'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * After an in-app navigation, moves focus to the new page's `h1` (or to `<main>` when it has none) so keyboard and
 * screen-reader users land on the new content. Nothing happens on the first load, nor when only the search parameters
 * or the hash change (the path is unchanged).
 */
export function RouteFocus() {
  const pathname = usePathname();
  const previous = useRef(pathname);

  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;

    const main = document.getElementById('main-content');
    if (!main) return;
    const active = document.activeElement;
    // A field the new page focused itself (autofocus) keeps focus.
    if (active && main.contains(active) && active.matches('input, textarea, select, [contenteditable="true"]')) return;

    const target = main.querySelector<HTMLElement>('h1') ?? main;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: false });
  }, [pathname]);

  return null;
}
