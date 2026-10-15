'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Share2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useAuth, useHydrated } from '@/hooks/use-auth';
import { problemFromError } from '@/lib/api/errors';
import { newIdempotencyKey } from '@/lib/api/idempotency';
import { createShortLinkPatiently } from '@/lib/api/share';
import { loginHref } from '@/lib/auth/return-to';
import { queryKeys } from '@/lib/query-keys';

const PHONE = '(max-width: 640px)';
const subscribePhone = (onChange: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/** Failures that a second attempt cannot fix: no **Try again** (AS-62). */
const FINAL_CODES = new Set(['link_limit_reached', 'destination_not_allowed', 'destination_blocked', 'idempotency_key_reuse', 'validation_failed']);

const TITLE = 'Share this product';

type Note = 'none' | 'copied' | 'manual';

function ShareBody({ productId, destination, requested }: { productId: string; destination: string; requested: boolean }) {
  const auth = useAuth();
  const authenticated = auth.status === 'authenticated';
  // One key per page visit: a repeat of the request (in flight, Try again) is the same operation to the server.
  const key = useRef<string | null>(null);
  const query = useQuery({
    queryKey: queryKeys.share.link(productId),
    queryFn: ({ signal }) => createShortLinkPatiently(destination, (key.current ??= newIdempotencyKey()), { signal }),
    enabled: requested && authenticated,
    retry: false,
    gcTime: Infinity,
  });
  const field = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<Note>('none');
  const link = query.data?.shortUrl;

  // The link field takes focus when the link appears.
  useEffect(() => {
    if (link) field.current?.focus();
  }, [link]);

  if (!authenticated) {
    return (
      <div className="space-y-3">
        <p>Sign in to create a share link.</p>
        <Button asChild className="min-h-11 max-sm:w-full">
          <Link href={loginHref(`${window.location.pathname}${window.location.search}`)}>Sign in</Link>
        </Button>
      </div>
    );
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setNote('copied');
    } catch {
      field.current?.select();
      setNote('manual');
    }
  }

  if (query.isError) {
    const problem = problemFromError(query.error);
    return (
      <div className="space-y-3">
        <ProblemAlert problem={problem} surface="share" />
        {problem.code && FINAL_CODES.has(problem.code) ? null : (
          <Button type="button" variant="outline" className="min-h-11 max-sm:w-full" onClick={() => void query.refetch()}>
            Try again
          </Button>
        )}
      </div>
    );
  }

  if (!link) {
    return (
      <p role="status" aria-busy="true" className="text-muted-foreground">
        Creating your link…
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <Input ref={field} readOnly aria-label="Share link" value={link} onFocus={(event) => event.currentTarget.select()} className="h-11 sm:h-9" />
      <Button type="button" className="min-h-11 max-sm:w-full" onClick={() => void copy()}>
        Copy link
      </Button>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
        {note === 'copied' ? 'Link copied.' : note === 'manual' ? 'Press Ctrl+C to copy.' : ''}
      </p>
    </div>
  );
}

/**
 * **Share** in the purchase area (W02 AS-60..AS-62, FR-120..FR-123): a popover on a wide screen and a bottom sheet on a
 * phone. A signed-in member gets one short link for the product's public address (`destination`, built on the server from
 * the site address) with one `Idempotency-Key`; the link is a query result kept for the page visit, so reopening shows the
 * same one. A visitor is asked to sign in and no request is made; while the session loads the button is disabled.
 */
export function SharePopover({ productId, destination }: { productId: string; destination: string }) {
  const { status } = useAuth();
  // The server cannot know the session, so its markup has Share disabled; the first client render must match it.
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState(false);
  const phone = useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
  const titleId = useId();

  const change = (next: boolean) => {
    setOpen(next);
    if (next) setRequested(true);
  };
  const trigger: ReactNode = (
    <Button type="button" size="lg" variant="outline" disabled={!hydrated || status === 'loading'} aria-haspopup="dialog">
      <Share2 aria-hidden="true" className="mr-2 size-4" />
      Share
    </Button>
  );
  const body = <ShareBody productId={productId} destination={destination} requested={requested} />;

  if (phone) {
    return (
      <Sheet open={open} onOpenChange={change}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent side="bottom" className="gap-3 p-4" data-testid="share-sheet">
          <SheetHeader className="p-0">
            <SheetTitle>{TITLE}</SheetTitle>
            <SheetDescription className="sr-only">Create a short link to this product and copy it.</SheetDescription>
          </SheetHeader>
          {body}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-3 p-4" aria-labelledby={titleId} data-testid="share-popover">
        <h2 id={titleId} className="font-medium">
          {TITLE}
        </h2>
        {body}
      </PopoverContent>
    </Popover>
  );
}
