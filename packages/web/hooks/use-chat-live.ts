'use client';

import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { chatHubEventSchema, type ChatChannel, type ChatInboxItem, type ChatInboxPage, type ChatReceipts } from '@marketplace-sandbox/contracts';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useOnline } from '@/hooks/use-online';
import { useVisible } from '@/hooks/use-visible';
import { chatApi, chatProblem } from '@/lib/api/chat';
import { backoffDelay, STABLE_CONNECTION_MS } from '@/lib/chat/backoff';
import { createCatchUp, type CatchUpDeps } from '@/lib/chat/catch-up';
import { addMessages, highestSeq, markDeleted, type MessagesData } from '@/lib/chat/message-cache';
import { applyReadEvent } from '@/lib/chat/receipts';
import { queryKeys } from '@/lib/query-keys';
import { channelOfTopic, selectTopics } from '@/lib/realtime/chat-topics';
import { getUserStreamSnapshot, SERVER_USER_STREAM_SNAPSHOT, subscribeTopic, subscribeUserStreamState, type TopicEvent } from '@/lib/realtime/user-stream';

export type ChatBanner = 'reconnecting' | 'offline' | null;

/** Event types asked of the hub for every chat topic. */
const EVENT_TYPES = ['message', 'message_deleted', 'channel_archived', 'read', 'presence'];
const SAFETY_SYNC_MS = 15_000;
const POLL_WHILE_DOWN_MS = 5_000;
const BANNER_DELAY_MS = 3_000;

/** The catch-up (W05 FR-041) over the query cache: what is held, how to merge, how to start again, how to re-read the inbox. */
function catchUpDeps(queryClient: QueryClient): CatchUpDeps {
  return {
    cursors: () => {
      const cursors: Record<string, number> = {};
      for (const query of queryClient.getQueryCache().findAll({ queryKey: queryKeys.chat.all })) {
        const [, kind, channelId] = query.queryKey;
        if (kind === 'messages' && typeof channelId === 'string' && query.state.data) cursors[channelId] = highestSeq(query.state.data as MessagesData);
      }
      return cursors;
    },
    sync: (cursors) => chatApi.sync(cursors),
    apply: ({ channelId, messages }) => {
      queryClient.setQueryData<MessagesData>(queryKeys.chat.messages(channelId), (held) => addMessages(held, messages));
    },
    // The server is behind what the page holds (AS-30): drop it and read the newest page again.
    reset: async (channelId) => {
      await queryClient.resetQueries({ queryKey: queryKeys.chat.messages(channelId) });
    },
    refreshInbox: () => queryClient.invalidateQueries({ queryKey: queryKeys.chat.inbox() }),
  };
}

function removeFromInbox(queryClient: QueryClient, channelId: string) {
  queryClient.setQueryData<InfiniteData<ChatInboxPage>>(queryKeys.chat.inbox(), (held) =>
    held ? { ...held, pages: held.pages.map((page) => ({ ...page, items: page.items.filter((item) => item.id !== channelId) })) } : held,
  );
}

/**
 * The live side of the chat page (W05 FR-040..FR-043, AS-23..AS-30). It listens to the open chat and the latest others on the
 * page's one shared connection (`subscribeTopic`), treats every event as a hint, and runs the single catch-up routine: after
 * a hint, `online`, a visible tab, `resync`, a reopened connection and on the polling intervals (15 s with a healthy
 * connection, 5 s while it is down, nothing while offline or hidden). The banner says honestly what is going on and goes
 * only after a full catch-up. A connection closed for good is recreated with jittered back-off.
 */
export function useChatLive({ openId, items }: { openId: string | null; items: ChatInboxItem[] }): { banner: ChatBanner } {
  const queryClient = useQueryClient();
  const online = useOnline();
  const visible = useVisible();
  const { status } = useAuth();
  const stream = useSyncExternalStore(subscribeUserStreamState, getUserStreamSnapshot, () => SERVER_USER_STREAM_SNAPSHOT);
  const [catchUp] = useState(() => createCatchUp(catchUpDeps(queryClient)));
  const [shown, setShown] = useState(false);
  const [generation, setGeneration] = useState(0);

  const topicKey = selectTopics(openId, items).join(' ');
  const watching = topicKey !== '';
  const down = !online || (watching && stream.health !== 'connected');

  const latest = useRef({ openId, down });
  useEffect(() => {
    latest.current = { openId, down };
  });

  /** One catch-up; the banner is cleared when it completes while the connection is up. A failure keeps the banner (a later run clears it). */
  const recover = useMemo(
    () => () =>
      catchUp.run().then(
        () => {
          if (!latest.current.down) setShown(false);
        },
        () => undefined,
      ),
    [catchUp],
  );

  // --- subscriptions: one effect diffs the topic list; unchanged topics are never released (R-03) -------------------------
  const held = useRef(new Map<string, () => void>());
  const resubscribed = useRef(new Set<string>());
  const gone = useRef(new Set<string>());
  const appliedGeneration = useRef(0);
  const resyncQueued = useRef(false);

  useEffect(() => {
    const subscribe = (topic: string) => {
      held.current.set(topic, subscribeTopic(topic, (event) => onEvent(topic, event), EVENT_TYPES));
    };

    // Every held topic reports the same resync: handle it once per tick (AS-26).
    const onResync = () => {
      if (resyncQueued.current) return;
      resyncQueued.current = true;
      queueMicrotask(() => {
        resyncQueued.current = false;
        const open = latest.current.openId;
        if (open) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.chat.messages(open) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.chat.receipts(open) });
        }
        void recover();
      });
    };

    // The hub dropped a topic (the member may have been removed): read the chat; unavailable, or listen again once (AS-27).
    const onRevoked = async (topic: string) => {
      held.current.delete(topic);
      const channelId = channelOfTopic(topic);
      if (!channelId) return;
      try {
        await chatApi.channel(channelId);
        if (!resubscribed.current.has(channelId)) {
          resubscribed.current.add(channelId);
          if (!held.current.has(topic)) subscribe(topic);
        }
      } catch (error) {
        const code = chatProblem(error).status;
        if (code === 403 || code === 404) {
          gone.current.add(topic);
          removeFromInbox(queryClient, channelId);
          void queryClient.invalidateQueries({ queryKey: queryKeys.chat.channel(channelId) });
        }
      }
    };

    function onEvent(topic: string, event: TopicEvent) {
      if (event.type === 'resync') return onResync();
      if (event.type === 'revoked') return void onRevoked(topic);
      // A hub event is a hint: nothing in its payload is ever rendered (FR-043).
      const parsed = chatHubEventSchema.safeParse({ type: event.type, data: event.data });
      if (!parsed.success) return;
      const hub = parsed.data;
      switch (hub.type) {
        case 'message':
          void recover();
          return;
        case 'message_deleted':
          queryClient.setQueryData<MessagesData>(queryKeys.chat.messages(hub.data.channelId), (current) => markDeleted(current, hub.data.messageId));
          return;
        case 'channel_archived':
          queryClient.setQueryData<ChatChannel>(queryKeys.chat.channel(hub.data.channelId), (current) => (current ? { ...current, isArchived: true } : current));
          void queryClient.invalidateQueries({ queryKey: queryKeys.chat.inbox() });
          return;
        case 'read': {
          const channelId = channelOfTopic(topic);
          if (!channelId) return;
          queryClient.setQueryData<ChatReceipts>(queryKeys.chat.receipts(channelId), (current) => {
            const positions = Object.fromEntries((current?.items ?? []).map((item) => [item.userId, item.lastReadSeq]));
            const next = applyReadEvent(positions, hub.data);
            if (next === positions && current) return current;
            return { suppressed: current?.suppressed ?? false, items: Object.entries(next).map(([userId, lastReadSeq]) => ({ userId, lastReadSeq })) };
          });
          return;
        }
        case 'presence':
          queryClient.setQueryData(queryKeys.chat.presence(hub.data.userId), { online: hub.data.online, lastSeenAt: Date.now() });
          return;
      }
    }

    // A new `generation` means the connection was closed for good: release everything and listen again.
    if (appliedGeneration.current !== generation) {
      appliedGeneration.current = generation;
      for (const release of held.current.values()) release();
      held.current.clear();
    }
    const wanted = new Set(topicKey === '' ? [] : topicKey.split(' ').filter((topic) => !gone.current.has(topic)));
    for (const [topic, release] of [...held.current]) {
      if (wanted.has(topic)) continue;
      release();
      held.current.delete(topic);
    }
    for (const topic of wanted) if (!held.current.has(topic)) subscribe(topic);
  }, [topicKey, generation, queryClient, recover]);

  useEffect(() => {
    const subscriptions = held.current;
    return () => {
      for (const release of subscriptions.values()) release();
      subscriptions.clear();
    };
  }, []);

  // --- a connection closed for good is recreated with back-off (AS-28, FR-042) --------------------------------------------
  const attempts = useRef(0);
  const openedAt = useRef<number | null>(null);
  const closedForGood = watching && online && stream.health === 'closed' && status === 'authenticated';
  useEffect(() => {
    if (stream.health === 'connected') {
      openedAt.current = Date.now();
      return;
    }
    // A connection that stayed open long enough earns a fresh start of the schedule.
    if (openedAt.current !== null && Date.now() - openedAt.current >= STABLE_CONNECTION_MS) attempts.current = 0;
    openedAt.current = null;
  }, [stream.health]);
  useEffect(() => {
    if (!closedForGood) return;
    const timer = setTimeout(() => {
      attempts.current += 1;
      setGeneration((count) => count + 1);
    }, backoffDelay(attempts.current));
    return () => clearTimeout(timer);
  }, [closedForGood, generation]);

  // --- the banner ----------------------------------------------------------------------------------------------------------
  useEffect(() => {
    if (!down) return;
    const timer = setTimeout(() => setShown(true), online ? BANNER_DELAY_MS : 0);
    return () => clearTimeout(timer);
  }, [down, online]);
  // The connection is open again after it was lost: catch up in full; the banner goes when that run completes (see `recover`).
  const wasOpen = useRef(false);
  const lostAt = useRef<'open' | 'lost'>('open');
  useEffect(() => {
    if (stream.health === 'connected') {
      if (wasOpen.current && lostAt.current === 'lost') void recover();
      wasOpen.current = true;
      lostAt.current = 'open';
    } else if (wasOpen.current) {
      lostAt.current = 'lost';
    }
  }, [stream.health, recover]);

  // --- polling: 15 s with a healthy connection, 5 s while it is down, nothing offline or hidden ---------------------------
  useEffect(() => {
    if (!openId || !online || !visible) return;
    const timer = setInterval(() => void recover(), stream.health === 'connected' ? SAFETY_SYNC_MS : POLL_WHILE_DOWN_MS);
    return () => clearInterval(timer);
  }, [openId, online, visible, stream.health, recover]);

  // --- coming back: `online` and a visible tab catch up at once ----------------------------------------------------------
  useEffect(() => {
    const onOnline = () => void recover();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void recover();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [recover]);

  return { banner: shown ? (online ? 'reconnecting' : 'offline') : null };
}
