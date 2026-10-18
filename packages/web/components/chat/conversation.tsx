'use client';

import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { ChatChannel, ChatInboxPage, ChatMessage } from '@marketplace-sandbox/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import { ChatNotice } from '@/components/chat/chat-notice';
import { Composer } from '@/components/chat/composer';
import { FIRST_ITEM_BASE, MessageList, type ListContext } from '@/components/chat/message-list';
import { JumpPill } from '@/components/chat/jump-pill';
import { PresenceBadge } from '@/components/chat/presence-badge';
import { UnavailableChat } from '@/components/chat/unavailable-chat';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useClock } from '@/hooks/use-clock';
import { useDeadlinePassed } from '@/hooks/use-deadline';
import { useAuth } from '@/hooks/use-auth';
import { usePresence } from '@/hooks/use-presence';
import { useReadTracker } from '@/hooks/use-read-tracker';
import { useReconnected } from '@/hooks/use-reconnected';
import { useSendMessages } from '@/hooks/use-send-messages';
import { chatApi, chatProblem } from '@/lib/api/chat';
import { composerState } from '@/lib/chat/composer-rules';
import { loadCopy, type SendCopy } from '@/lib/chat/errors-copy';
import { inboxItems } from '@/lib/chat/inbox';
import { chatHref } from '@/lib/chat/links';
import { messagesOf, unreadDividerId } from '@/lib/chat/message-cache';
import { preview } from '@/lib/chat/message-rules';
import { positionsFromReceipts, seenUnder } from '@/lib/chat/receipts';
import { buildRows } from '@/lib/chat/rows';
import { authorLabel } from '@/lib/chat/time-format';
import { queryKeys } from '@/lib/query-keys';
import { productHref } from '@/lib/routes';

const PAGE = 50;

/** Where focus goes when the conversation opens: the field (after Chat with seller), the heading (from the inbox on a phone), or nowhere. */
export type ConversationEntry = 'composer' | 'heading' | 'none';

/**
 * The open chat (W05 AS-12..AS-22, FR-011..FR-013). The chat's own fields and the history are TanStack Query entries; the
 * list is derived from that entry only. Pending bubbles, the reply target, the draft and the composer's reasons are local
 * state of this component and die with it (AS-40). The unread separator is placed once, from the inbox number at open time.
 */
export function Conversation({ channelId, drafts, entry = 'none' }: { channelId: string; drafts: Map<string, string>; entry?: ConversationEntry }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const selfId = user?.id ?? null;
  const now = useClock();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const channelQuery = useQuery({ queryKey: queryKeys.chat.channel(channelId), queryFn: () => chatApi.channel(channelId) });
  const history = useInfiniteQuery({
    queryKey: queryKeys.chat.messages(channelId),
    queryFn: ({ pageParam }) => chatApi.history(channelId, { limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const channel: ChatChannel | undefined = channelQuery.data;
  const confirmed = useMemo(() => messagesOf(history.data), [history.data]);
  const byId = useMemo(() => new Map(confirmed.map((message) => [message.id, message])), [confirmed]);

  // What the chat tells the member about themselves, local to this visit.
  const [banned, setBanned] = useState(false);
  const [mutedUntil, setMutedUntil] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [rate, setRate] = useState<{ text: string; until: number } | null>(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const muteOver = useDeadlinePassed(mutedUntil ? Date.parse(mutedUntil) : null);
  const rateOver = useDeadlinePassed(rate?.until ?? null);

  const onSent = useCallback(() => setAnnouncement('Message sent'), []);
  const onRefusal = useCallback(
    (copy: SendCopy) => {
      if (copy.effect === 'banned') setBanned(true);
      else if (copy.effect === 'muted') setMutedUntil(copy.mutedUntil ?? new Date(Date.now() + 60_000).toISOString());
      else if (copy.effect === 'archived') queryClient.setQueryData<ChatChannel>(queryKeys.chat.channel(channelId), (held) => (held ? { ...held, isArchived: true } : held));
      else if (copy.effect === 'unavailable') setGone(true);
      else if (copy.effect === 'wait') setRate({ text: copy.text, until: Date.now() + (copy.retryAfterSeconds ?? 0) * 1000 });
    },
    [channelId, queryClient],
  );
  const send = useSendMessages({ channelId, onSent, onRefusal });

  // The unread separator and the opening position are fixed once, when the first page arrives; the first message ever held
  // anchors the list so older pages can be added in front without moving what the reader looks at.
  const [unreadAtOpen] = useState(() => inboxItems(queryClient.getQueryData<InfiniteData<ChatInboxPage>>(queryKeys.chat.inbox())).find((item) => item.id === channelId)?.unread ?? 0);
  const [opening, setOpening] = useState<{ dividerId: string | null; initialIndex: number } | null>(null);
  if (!opening && history.isSuccess) {
    const dividerId = unreadDividerId(confirmed, selfId, unreadAtOpen);
    setOpening({ dividerId, initialIndex: Math.max(dividerId ? confirmed.findIndex((message) => message.id === dividerId) : confirmed.length - 1, 0) });
  }
  const [anchorId, setAnchorId] = useState<string | null>(null);
  if (anchorId === null && confirmed[0]) setAnchorId(confirmed[0].id);
  const prepended = anchorId ? Math.max(confirmed.findIndex((message) => message.id === anchorId), 0) : 0;

  // A message from another member that arrives while the chat is open is announced politely, never more than one a second:
  // the ones that came meanwhile are spoken together (AS-23). The reader's own messages and older pages are never announced.
  const [spokenSeq, setSpokenSeq] = useState<number | null>(null);
  const [incoming, setIncoming] = useState<ChatMessage[]>([]);
  if (history.isSuccess) {
    const newest = confirmed.at(-1)?.seq ?? 0;
    if (spokenSeq === null) setSpokenSeq(newest);
    else if (newest > spokenSeq) {
      setSpokenSeq(newest);
      const fresh = confirmed.filter((message) => message.seq > spokenSeq && message.authorId !== selfId && !message.deleted);
      if (fresh.length > 0) setIncoming((queued) => [...queued, ...fresh]);
    }
  }
  const lastSpokenAt = useRef(0);
  const sellerId = channel?.sellerId ?? '';
  useEffect(() => {
    const last = incoming.at(-1);
    if (!last) return;
    const timer = setTimeout(() => {
      lastSpokenAt.current = Date.now();
      const text = `${authorLabel(last.authorId, { selfId, sellerId })}: ${preview(last.body ?? '', 100)}`;
      setAnnouncement(incoming.length > 1 ? `${incoming.length} new messages. ${text}` : text);
      setIncoming([]);
    }, Math.max(0, lastSpokenAt.current + 1000 - Date.now()));
    return () => clearTimeout(timer);
  }, [incoming, selfId, sellerId]);

  // Back online, or the live connection open again: "Not sent" bubbles that failed for lack of a network are retried once (AS-17).
  useReconnected(() => void send.retryNetworkFailures());

  // Read marking, "Seen by", presence and the jump pill (AS-31..AS-35).
  const { observe } = useReadTracker(channelId);
  const sellerOnline = usePresence({ sellerId: channel?.sellerId ?? null, selfId });
  const receipts = useQuery({ queryKey: queryKeys.chat.receipts(channelId), queryFn: () => chatApi.receipts(channelId), retry: false });
  const seen = useMemo(() => {
    if (!selfId) return null;
    const { positions, suppressed } = positionsFromReceipts(receipts.data, selfId);
    return seenUnder(confirmed, positions, selfId, suppressed);
  }, [confirmed, receipts.data, selfId]);

  const listRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const newestSeq = confirmed.at(-1)?.seq ?? 0;
  const [bottomSeq, setBottomSeq] = useState(newestSeq);
  if (atBottom && bottomSeq !== newestSeq) setBottomSeq(newestSeq);
  const waiting = atBottom ? 0 : confirmed.filter((message) => message.seq > bottomSeq && message.authorId !== selfId && !message.deleted).length;
  const jumpToLatest = () => listRef.current?.scrollToIndex({ index: 'LAST', align: 'end' });

  const rows = useMemo(
    () => buildRows({ confirmed, pending: send.pending.items, afterSeq: send.afterSeq, selfId, dividerId: opening?.dividerId ?? null, unread: unreadAtOpen, now }),
    [confirmed, send.pending.items, send.afterSeq, selfId, opening?.dividerId, unreadAtOpen, now],
  );

  const channelProblem = channelQuery.error ? loadCopy(chatProblem(channelQuery.error)) : null;
  const historyProblem = history.error && !history.data ? loadCopy(chatProblem(history.error)) : null;
  if (gone || channelProblem?.effect === 'unavailable' || historyProblem?.effect === 'unavailable') return <UnavailableChat />;
  const failed = channelProblem ?? historyProblem;

  const focusHeading = (element: HTMLHeadingElement | null) => {
    if (element && entry === 'heading') element.focus();
  };

  const state = composerState({
    now: 0,
    isArchived: channel?.isArchived ?? false,
    banned,
    mutedUntil: muteOver ? null : mutedUntil,
    loadFailed: !channel || history.isPending || history.isError || Boolean(failed),
  });

  const earlierState = history.isFetchNextPageError ? 'failed' : history.isFetchingNextPage ? 'loading' : history.hasNextPage ? 'more' : 'start';
  const context: ListContext | null = channel
    ? {
        channelId,
        title: channel.title,
        selfId,
        sellerId: channel.sellerId,
        myRole: channel.myRole,
        byId,
        onReply: (message) => {
          setReplyTo(message);
          inputRef.current?.focus();
        },
        onRetry: (id) => void send.retry(id),
        onDiscard: send.discard,
        seen,
        observe,
        earlier: { state: earlierState, onLoad: () => void history.fetchNextPage() },
      }
    : null;

  const retryLoad = () => {
    void channelQuery.refetch();
    void history.refetch();
  };

  return (
    <section aria-labelledby={`chat-heading-${channelId}`} className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2">
        <Link href={chatHref({})} replace className="inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium underline underline-offset-4 hover:bg-accent lg:hidden">
          Back to all chats
        </Link>
        <h1 ref={focusHeading} id={`chat-heading-${channelId}`} tabIndex={-1} data-testid="chat-title" className="min-w-0 flex-1 truncate text-lg font-semibold outline-none">
          {channel?.title ?? <Skeleton className="inline-block h-5 w-40 align-middle motion-reduce:animate-none" />}
        </h1>
        {sellerOnline && <PresenceBadge />}
        {channel && (
          <Link href={productHref(channel.productId)} className="inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium underline underline-offset-4 hover:bg-accent sm:min-h-8">
            View product
          </Link>
        )}
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {failed ? (
          <div className="p-4">
            <ChatNotice text={failed.text} {...(failed.reference ? { reference: failed.reference } : {})}>
              <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" onClick={retryLoad}>
                Try again
              </Button>
            </ChatNotice>
          </div>
        ) : history.isPending || !channel || !context || !opening ? (
          <div className="space-y-3 p-4">
            <p role="status" className="sr-only">
              Loading messages…
            </p>
            <div aria-hidden="true" className="space-y-3">
              {['a', 'b', 'c'].map((key) => (
                <Skeleton key={key} className="h-10 w-2/3 rounded-xl motion-reduce:animate-none" />
              ))}
            </div>
          </div>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No messages yet. Say hello!</p>
        ) : (
          <MessageList rows={rows} context={context} firstItemIndex={FIRST_ITEM_BASE - prepended} initialIndex={opening.initialIndex} onAtBottomChange={setAtBottom} listRef={listRef} />
        )}
        {waiting > 0 && <JumpPill count={waiting} onJump={jumpToLatest} />}
      </div>

      <p role="status" className="sr-only">
        {announcement}
      </p>

      <Composer
        channelId={channelId}
        drafts={drafts}
        state={state}
        waitLine={rate && !rateOver ? rate.text : null}
        replyTo={replyTo ? { author: authorLabel(replyTo.authorId, { selfId, sellerId: channel?.sellerId ?? '' }), preview: preview(replyTo.body ?? '') } : null}
        onCancelReply={() => setReplyTo(null)}
        onSubmit={(body) => {
          send.submit(body, replyTo?.id ?? null);
          setReplyTo(null);
          // The member's own message is always shown, wherever they were reading.
          requestAnimationFrame(jumpToLatest);
        }}
        inputRef={inputRef}
        autoFocus={entry === 'composer'}
      />
    </section>
  );
}
