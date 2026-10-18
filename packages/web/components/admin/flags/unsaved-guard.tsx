'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { DANGER_BUTTON } from './danger';

/**
 * Unsaved-changes protection (W06 AS-25, FR-023, R-06): while the draft is dirty the browser's `beforeunload` prompt guards
 * closing and reloading, and a capture-phase click handler turns any same-origin link click that would leave the page into the
 * "Discard unsaved changes?" dialog. Modified clicks, new-tab links, downloads and links to the same address (an in-page
 * `#field` link) pass. The mechanism is internal; the outcome is the spec's.
 */
export function UnsavedGuard({ dirty }: { dirty: boolean }) {
  const router = useRouter();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const intercept = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      setTarget(`${url.pathname}${url.search}${url.hash}`);
    };
    document.addEventListener('click', intercept, true);
    return () => document.removeEventListener('click', intercept, true);
  }, [dirty]);

  if (!target) return null;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && setTarget(null)}
      title="Discard unsaved changes?"
      description="You have edits that are not saved. They are lost if you leave this page."
      cancelLabel="Keep editing"
      confirmLabel="Discard changes"
      destructive
      confirmClassName={DANGER_BUTTON}
      onConfirm={() => {
        const to = target;
        setTarget(null);
        router.push(to);
      }}
    />
  );
}
