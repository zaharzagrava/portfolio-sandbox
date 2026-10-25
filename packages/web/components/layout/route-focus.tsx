'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * Next's own route announcer reads `document.title` in the same commit as the navigation, but the streamed page title often
 * arrives a moment later, so it announces nothing (B-085). Once the title has settled, the page name is written into that same
 * live region (a polite, visually hidden node in the announcer's shadow root).
 */
function announceTitleWhenSettled() {
  const before = document.title;
  let timer: number | undefined;
  const observer = new MutationObserver(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(write, 150);
  });
  const write = () => {
    observer.disconnect();
    window.clearTimeout(giveUp);
    const text = document.title || document.querySelector('h1')?.textContent || '';
    const root = document.querySelector('next-route-announcer')?.shadowRoot;
    const next = root?.getElementById('__next-route-announcer__');
    if (!root || !text || next?.textContent === text) return;
    // Never write into Next's own node: React owns it, and replacing its text crashes the next update (removeChild error).
    // A sibling node of ours, in the same shadow root, is a separate polite live region.
    let region = root.getElementById('__route-title-announcer__');
    if (!region) {
      region = document.createElement('p');
      region.id = '__route-title-announcer__';
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('role', 'status');
      region.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;padding:0';
      root.appendChild(region);
    }
    region.textContent = text;
  };
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  // A page whose title did not change (same title on both pages) still announces its name once.
  const giveUp = window.setTimeout(write, before ? 1500 : 400);
}

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

    announceTitleWhenSettled();

    const target = main.querySelector<HTMLElement>('h1') ?? main;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: false });
  }, [pathname]);

  return null;
}
