'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useDeadlinePassed } from '@/hooks/use-deadline';
import { useVisible } from '@/hooks/use-visible';
import { chatApi, chatProblem } from '@/lib/api/chat';
import { queryKeys } from '@/lib/query-keys';

const BEAT_MS = 30_000;
const READ_MS = 30_000;
const DEFAULT_PAUSE_S = 60;

const pauseMs = (error: unknown): number => (chatProblem(error).retryAfterSeconds ?? DEFAULT_PAUSE_S) * 1000;

/**
 * Presence for one conversation (W05 AS-34, AS-35, FR-046). While the tab is visible: a heartbeat when the chat opens and
 * every 30 s (well inside the 6-a-minute limit), and, for a member who is not the seller, a read of the seller's presence every
 * 30 s. Both are best effort: any failure removes the indicator, says nothing, and pauses that call for `Retry-After` seconds
 * (60 when the server gave none). Returns whether to show "Seller online".
 */
export function usePresence({ sellerId, selfId }: { sellerId: string | null; selfId: string | null }): boolean {
  const visible = useVisible();

  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const beat = async () => {
      let next = BEAT_MS;
      try {
        await chatApi.heartbeat();
      } catch (error) {
        const { status } = chatProblem(error);
        if (status === 429 || status === 503) next = pauseMs(error);
      }
      if (!stopped) timer = setTimeout(() => void beat(), next);
    };
    void beat();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [visible]);

  const [pausedUntil, setPausedUntil] = useState<number | null>(null);
  const resumed = useDeadlinePassed(pausedUntil);
  const isOtherMember = Boolean(sellerId) && sellerId !== selfId;
  const presence = useQuery({
    queryKey: queryKeys.chat.presence(sellerId ?? ''),
    queryFn: async () => {
      try {
        const answer = await chatApi.presence([sellerId!]);
        return answer[sellerId!] ?? { online: false, lastSeenAt: null };
      } catch (error) {
        setPausedUntil(Date.now() + pauseMs(error));
        throw error;
      }
    },
    enabled: isOtherMember && visible && resumed,
    refetchInterval: READ_MS,
    retry: false,
  });
  return isOtherMember && presence.data?.online === true && !presence.isError;
}
