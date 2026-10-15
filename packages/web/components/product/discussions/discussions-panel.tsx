'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import type { PostView } from '@marketplace-sandbox/contracts';
import { Button } from '@/components/ui/button';
import { useAuth, useHydrated } from '@/hooks/use-auth';
import { DiscussionComposer } from './discussion-composer';
import { DiscussionList } from './discussion-list';
import { useDiscussionsView } from './use-discussions-view';

/**
 * The **Discussions** tab (W02 AS-45..AS-53): the heading, **Start a discussion** (or **Log in to discuss** for a visitor),
 * the composer as a form inside the panel at every width, one polite status line for the outcome of writes ("Your
 * discussion was posted.", "Post deleted.", "That post is no longer available."), and the list. Mounted when the tab is
 * first opened, so nothing is requested before.
 */
export function DiscussionsPanel({ productId }: { productId: string }) {
  const client = useQueryClient();
  // The tab can be the first thing the server renders; what it knows of the session is not what the browser's cache holds
  // (W01 AS-18), so until hydration the control is left out and the first client render equals the server's markup.
  const auth = useAuth();
  const status = useHydrated() ? auth.status : 'loading';
  const { view, change, signInHref } = useDiscussionsView();
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState('');
  const [focusPostId, setFocusPostId] = useState<string | undefined>();
  const startButton = useRef<HTMLButtonElement>(null);
  const announce = useCallback((text: string) => setMessage(text), []);
  const clearFocus = useCallback(() => setFocusPostId(undefined), []);

  const posted = (post: PostView) => {
    setComposing(false);
    setFocusPostId(post.postId);
    setMessage('Your discussion was posted.');
    void client.invalidateQueries({ queryKey: ['discussions', 'board', productId] });
    // The new post is the newest: a hot or top list could hide it.
    if (view.sort !== 'new') change({ sort: 'new', post: null });
  };

  return (
    <section aria-labelledby={`discussions-${productId}`} className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`discussions-${productId}`} className="text-lg font-medium">
          Community discussions
        </h2>
        {status === 'authenticated' ? (
          <Button
            ref={startButton}
            type="button"
            variant="outline"
            className="min-h-9 max-sm:min-h-11"
            aria-expanded={composing}
            onClick={() => {
              setComposing((open) => !open);
              setMessage('');
            }}
          >
            Start a discussion
          </Button>
        ) : status === 'loading' ? null : (
          <Button variant="outline" className="min-h-9 max-sm:min-h-11" asChild>
            <Link href={signInHref}>Log in to discuss</Link>
          </Button>
        )}
      </div>

      <p role="status" aria-live="polite" className="min-h-5 text-sm">
        {message}
      </p>

      {composing ? (
        <DiscussionComposer
          productId={productId}
          onPosted={posted}
          onCancel={() => {
            setComposing(false);
            startButton.current?.focus();
          }}
        />
      ) : null}

      <DiscussionList productId={productId} announce={announce} focusPostId={focusPostId} onFocused={clearFocus} />
    </section>
  );
}
