'use client';

import { useEffect, useRef } from 'react';

/**
 * First focusable element of every page; visible only while focused. The target is `main#main-content` (focusable, tabIndex -1).
 * While a dialog is open the library hides the rest of the page from assistive technology (`aria-hidden`); a hidden element
 * must not be focusable, so the link leaves the tab order for as long as it is hidden (axe `aria-hidden-focus`, B-061).
 */
export function SkipLink() {
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const element = link.current;
    if (!element) return;
    const sync = () => {
      if (element.closest('[aria-hidden="true"]')) element.tabIndex = -1;
      else element.removeAttribute('tabindex');
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ['aria-hidden'], subtree: true });
    return () => observer.disconnect();
  }, []);
  return (
    <a
      ref={link}
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-3 focus:text-primary-foreground focus:shadow-lg"
    >
      Skip to main content
    </a>
  );
}
