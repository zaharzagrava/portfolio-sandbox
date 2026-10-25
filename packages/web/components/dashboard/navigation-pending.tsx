'use client';

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';

/**
 * The content area shows a skeleton from the click on a sidebar entry until the next page arrives (W04 AS-91, FR-002).
 * `next dev` does not prefetch, and a page that was not prefetched has no `loading.tsx` to show until the server answers, so
 * the old page would stay on screen (and look frozen) for the whole render. The sidebar frame stays where it is. The state
 * is set by the click (the phone drawer closes on click, so a link-level status would be gone) and cleared when the path
 * changes; a navigation that never lands clears itself after `GIVE_UP_MS`.
 */
const GIVE_UP_MS = 15_000;
let waiting = false;
let target = '';
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function set(next: boolean) {
  clearTimeout(timer);
  if (next) timer = setTimeout(() => set(false), GIVE_UP_MS);
  if (waiting === next) return;
  waiting = next;
  emit();
}

/** Called by a sidebar link's click when it leads to another page. */
export function beginNavigation(href = '') {
  target = href;
  set(true);
}

/** The page body, or the skeleton while a sidebar navigation is pending. */
export function PendingContent({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const pending = useSyncExternalStore(subscribe, () => waiting, () => false);
  useEffect(() => set(false), [pathname]);
  useEffect(() => () => set(false), []); // leaving the dashboard (Account links) unmounts the shell
  if (!pending) return children;
  // the orders page has one select in its toolbar and no heading action: its skeleton is shaped like it (W04 AS-91)
  return /\/orders\/?(\?|$)/.test(target) ? <ListPageSkeleton action={false} selectOnly /> : <ListPageSkeleton />;
}

/**
 * A paging link or filter of a list was pressed and the next page has not arrived yet (W04 R-26). The address only changes when
 * the server has answered, so the list cannot tell by itself that it is waiting: the press says so, and the new address clears it.
 */
let listWaiting = false;
let listTimer: ReturnType<typeof setTimeout> | undefined;
const listListeners = new Set<() => void>();
const emitList = () => listListeners.forEach((listener) => listener());
const subscribeList = (listener: () => void) => {
  listListeners.add(listener);
  return () => {
    listListeners.delete(listener);
  };
};

function setList(next: boolean) {
  clearTimeout(listTimer);
  if (next) listTimer = setTimeout(() => setList(false), GIVE_UP_MS);
  if (listWaiting === next) return;
  listWaiting = next;
  emitList();
}

/** Called by a paging link's click or a filter's change. */
export function beginListNavigation() {
  setList(true);
}

/** `true` from the press until the list's address changes; the list dims its rows and sets `aria-busy`. */
export function useListNavigationPending(): boolean {
  const search = useSearchParams()?.toString() ?? '';
  const pending = useSyncExternalStore(subscribeList, () => listWaiting, () => false);
  useEffect(() => setList(false), [search]);
  useEffect(() => () => setList(false), []);
  return pending;
}
