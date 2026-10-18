'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ChatNotice } from '@/components/chat/chat-notice';
import { Button } from '@/components/ui/button';
import { useDeadlinePassed } from '@/hooks/use-deadline';
import { useAuth } from '@/hooks/use-auth';
import { chatApi, chatProblem, type ChatProblem } from '@/lib/api/chat';
import { NO_CHAT_YET_TEXT, resolveCopy } from '@/lib/chat/errors-copy';
import { chatHref } from '@/lib/chat/links';
import { queryKeys } from '@/lib/query-keys';
import { productHref, searchHref } from '@/lib/routes';

const TOUCH = 'min-h-11 sm:min-h-8';
const LINK = `inline-flex ${TOUCH} items-center rounded-md border px-3 text-sm font-medium hover:bg-accent`;

/**
 * `/chat?product=<id>` (W05 FR-014, AS-01..AS-05): look the chat up by product, join it when the visitor is not a member, open
 * it. Shop staff (role SELLER or ADMIN) may create it with the explicit button; nobody else is ever offered that. The role
 * comes from the session, so there is no catalogue call. The address is *replaced* by `?channel=` so Back leaves the chat.
 */
export function ProductChatResolver({ productId, onResolved }: { productId: string; onResolved: (channelId: string) => void }) {
  const router = useRouter();
  const { user } = useAuth();
  const isStaff = user?.role === 'SELLER' || user?.role === 'ADMIN';
  const handled = useRef<number | null>(null);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);

  const lookup = useQuery({
    queryKey: queryKeys.chat.byProduct(productId),
    queryFn: () => chatApi.byProduct(productId),
    retry: false,
    gcTime: 0,
  });

  const open = (channelId: string) => {
    onResolved(channelId);
    router.replace(chatHref({ channel: channelId }));
  };
  const remember = (error: unknown) => {
    const problem = chatProblem(error);
    setWaitUntil(problem.retryAfterSeconds !== undefined && problem.status === 429 ? Date.now() + problem.retryAfterSeconds * 1000 : null);
  };

  const join = useMutation({ mutationFn: (channelId: string) => chatApi.join(channelId), onSuccess: (channel) => open(channel.id), onError: remember });
  const create = useMutation({
    mutationFn: () => chatApi.create(productId),
    onSuccess: (channel) => open(channel.id),
    onError: (error) => {
      // Someone created it first: look it up again and open that one (AS-04).
      if (chatProblem(error).code === 'channel_exists') void lookup.refetch();
      else remember(error);
    },
  });

  const found = lookup.data;
  const foundAt = lookup.dataUpdatedAt;
  const { mutate: joinChannel } = join;
  useEffect(() => {
    if (!found || handled.current === foundAt) return;
    handled.current = foundAt;
    if (found.myRole) {
      onResolved(found.id);
      router.replace(chatHref({ channel: found.id }));
    } else {
      joinChannel(found.id);
    }
    // `router` and `onResolved` are called once per answer of the lookup (guarded by `handled`), never re-run for their identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found, foundAt, joinChannel]);

  const lookupProblem: ChatProblem | null = lookup.error ? chatProblem(lookup.error) : null;
  const noChatYet = lookupProblem?.code === 'channel_not_found';
  const problem: ChatProblem | null = (noChatYet ? null : lookupProblem) ?? (join.error ? chatProblem(join.error) : null) ?? (create.error && chatProblem(create.error).code !== 'channel_exists' ? chatProblem(create.error) : null);
  const copy = problem ? resolveCopy(problem) : null;
  const lookupWait = lookupProblem?.status === 429 && lookupProblem.retryAfterSeconds !== undefined ? lookup.errorUpdatedAt + lookupProblem.retryAfterSeconds * 1000 : null;
  const waitOver = useDeadlinePassed(waitUntil ?? lookupWait);

  const tryAgain = () => {
    setWaitUntil(null);
    if (join.isError && found) join.mutate(found.id);
    else void lookup.refetch();
  };

  if (lookup.isFetching || join.isPending || (!problem && !noChatYet)) {
    return (
      <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />
        Opening chat…
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-4 p-6">
      {noChatYet && <p className="text-base">{NO_CHAT_YET_TEXT}</p>}
      {copy && (
        <ChatNotice text={copy.text} {...(copy.reference ? { reference: copy.reference } : {})} className="w-full max-w-lg">
          {copy.action === 'browse-products' && (
            <Link href={searchHref()} className={LINK}>
              Browse products
            </Link>
          )}
          {copy.action === 'back-to-product' && (
            <Link href={productHref(productId)} className={LINK}>
              Back to product
            </Link>
          )}
          {copy.action === 'try-again' && (
            <Button type="button" variant="outline" className={TOUCH} disabled={!waitOver} onClick={tryAgain}>
              Try again
            </Button>
          )}
        </ChatNotice>
      )}
      {noChatYet && (
        <div className="flex flex-wrap items-center gap-2">
          <Link href={productHref(productId)} className={LINK}>
            Back to product
          </Link>
          {isStaff && (
            <Button type="button" className={TOUCH} disabled={create.isPending} aria-busy={create.isPending} onClick={() => create.mutate()}>
              {create.isPending && <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />}
              Open chat for this product
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
