'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAuth } from '@/hooks/use-auth';
import {
  SERVER_USER_STREAM_SNAPSHOT,
  claimStreamBanner,
  getUserStreamSnapshot,
  subscribeUserEvents,
  subscribeUserStreamState,
  watchStreamSilence,
  type PollState,
  type UserEventHandler,
  type UserHealth,
} from '@/lib/realtime/user-stream';

export type { UserEventHandler, UserHealth, PollState };

/** The stream's health and polling state (module state read through `useSyncExternalStore`). */
export function useUserStream(): { health: UserHealth; poll: PollState } {
  const { health, poll } = useSyncExternalStore(subscribeUserStreamState, getUserStreamSnapshot, () => SERVER_USER_STREAM_SNAPSHOT);
  return { health, poll };
}

/**
 * Receive live events for the signed-in member. Every caller on the page shares one connection. The latest `handler` is
 * always used; changing it does not reconnect. Anonymous visitors open nothing.
 */
export function useUserEvents(handler: UserEventHandler): void {
  const { user } = useAuth();
  const userId = user?.id;
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!userId) return;
    return subscribeUserEvents(
      {
        onEvent: (event) => latest.current.onEvent?.(event),
        onResync: () => latest.current.onResync?.(),
        onRevoked: (topic) => latest.current.onRevoked?.(topic),
        onTopicEvent: (topic, type, data) => latest.current.onTopicEvent?.(topic, type, data),
      },
      userId,
    );
  }, [userId]);
}

/** True for the one component on the page that should render "Live updates paused. Reconnecting…" (AS-45). */
export function useStreamBanner(): boolean {
  const { bannerOwner, showBanner } = useSyncExternalStore(subscribeUserStreamState, getUserStreamSnapshot, () => SERVER_USER_STREAM_SNAPSHOT);
  const [token] = useState<object>(() => ({}));
  useEffect(() => claimStreamBanner(token), [token]);
  return showBanner && bannerOwner === token;
}

/**
 * While `active`, poll with `poll` whenever the stream has been silent for 10 s, on the schedule of AS-39. `state` is
 * `stopped` when the schedule ended (show the "taking longer" text and a Check again button wired to `checkAgain`).
 */
export function useStreamFallback(poll: () => void | Promise<void>, active: boolean): { state: PollState; checkAgain: () => void } {
  const { poll: state } = useUserStream();
  const latest = useRef(poll);
  useEffect(() => {
    latest.current = poll;
  });
  const watch = useRef<ReturnType<typeof watchStreamSilence> | null>(null);
  useEffect(() => {
    if (!active) return;
    const current = watchStreamSilence(() => latest.current());
    watch.current = current;
    return () => {
      current.stop();
      watch.current = null;
    };
  }, [active]);
  const checkAgain = useCallback(() => watch.current?.checkAgain(), []);
  return { state: active ? state : 'idle', checkAgain };
}
