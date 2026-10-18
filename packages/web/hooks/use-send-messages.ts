'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { chatApi, chatProblem } from '@/lib/api/chat';
import { sendCopy, sendFailureKind, type SendCopy } from '@/lib/chat/errors-copy';
import { addMessages, highestSeq, type MessagesData } from '@/lib/chat/message-cache';
import { autoRetryIds, initialPending, newClientMessageId, pendingReducer, type PendingMessage } from '@/lib/chat/pending-messages';
import { queryKeys } from '@/lib/query-keys';

/**
 * Sending in one conversation (W05 FR-026, FR-027, AS-14..AS-19). One `clientMessageId` is made per user action and every
 * retry, manual or automatic, reuses it, so a request that had in fact succeeded comes back `200 duplicate: true` and is shown
 * once. Pending bubbles live here, in this conversation's `useReducer`, in memory only; a confirmed message goes to the
 * query cache. What the chat says about the member (banned, muted, archived, gone) is reported to `onRefusal`.
 */
export function useSendMessages(options: {
  channelId: string;
  /** A message was stored: the conversation announces "Message sent". */
  onSent: () => void;
  /** The chat refused a send in a way that changes the whole conversation (AS-18, AS-19). */
  onRefusal: (copy: SendCopy) => void;
}) {
  const { channelId, onSent, onRefusal } = options;
  const queryClient = useQueryClient();
  const [pending, dispatch] = useReducer(pendingReducer, initialPending);
  const [afterSeq] = useState(() => new Map<string, number>());
  const inFlight = useRef(new Set<string>());
  const latest = useRef(pending);
  useEffect(() => {
    latest.current = pending;
  });

  const attempt = useCallback(
    async (item: Pick<PendingMessage, 'clientMessageId' | 'body' | 'replyToId'>) => {
      const { clientMessageId } = item;
      if (inFlight.current.has(clientMessageId)) return;
      inFlight.current.add(clientMessageId);
      try {
        const sent = await chatApi.send({ channelId, clientMessageId, body: item.body, replyToId: item.replyToId });
        queryClient.setQueryData<MessagesData>(queryKeys.chat.messages(channelId), (held) => addMessages(held, [sent.message]));
        dispatch({ type: 'confirmed', clientMessageId });
        onSent();
        void queryClient.invalidateQueries({ queryKey: queryKeys.chat.inbox() });
      } catch (error) {
        const problem = chatProblem(error);
        const copy = sendCopy(problem);
        if (sendFailureKind(problem) === 'network') {
          dispatch({ type: 'failed', clientMessageId, failure: 'network' });
          return;
        }
        const retryAfterAt = copy.retryAfterSeconds !== undefined ? Date.now() + copy.retryAfterSeconds * 1000 : undefined;
        dispatch({ type: 'refused', clientMessageId, reason: problem.code ?? 'refused', ...(retryAfterAt !== undefined ? { retryAfterAt } : {}) });
        onRefusal(copy);
      } finally {
        inFlight.current.delete(clientMessageId);
      }
    },
    [channelId, onRefusal, onSent, queryClient],
  );

  const submit = useCallback(
    (body: string, replyToId: string | null) => {
      const clientMessageId = newClientMessageId();
      afterSeq.set(clientMessageId, highestSeq(queryClient.getQueryData<MessagesData>(queryKeys.chat.messages(channelId))));
      dispatch({ type: 'submit', clientMessageId, body, replyToId });
      void attempt({ clientMessageId, body, replyToId });
    },
    [afterSeq, attempt, channelId, queryClient],
  );

  /** Retry re-sends the same `clientMessageId`, body and reply reference. After `reply_target_invalid` it is a new action without the reference. */
  const retry = useCallback(
    (clientMessageId: string): Promise<void> => {
      const item = latest.current.items.find((candidate) => candidate.clientMessageId === clientMessageId);
      if (!item || item.state !== 'failed') return Promise.resolve();
      if (item.reason === 'reply_target_invalid') {
        const fresh = newClientMessageId();
        afterSeq.set(fresh, highestSeq(queryClient.getQueryData<MessagesData>(queryKeys.chat.messages(channelId))));
        dispatch({ type: 'retryWithoutReply', clientMessageId, newClientMessageId: fresh });
        return attempt({ clientMessageId: fresh, body: item.body, replyToId: null });
      }
      dispatch({ type: 'retry', clientMessageId, now: Date.now() });
      return attempt(item);
    },
    [afterSeq, attempt, channelId, queryClient],
  );

  const discard = useCallback((clientMessageId: string) => dispatch({ type: 'discard', clientMessageId }), []);

  /** On `online` or a reopened connection: every network failure is retried once, oldest first (AS-17). 4xx refusals never. */
  const retryNetworkFailures = useCallback(async () => {
    for (const clientMessageId of autoRetryIds(latest.current)) await retry(clientMessageId);
  }, [retry]);

  /** The session ended: drafts and bubbles hold no data worth keeping (AS-40). */
  const clear = useCallback(() => dispatch({ type: 'clear' }), []);

  return { pending, afterSeq, submit, retry, discard, retryNetworkFailures, clear };
}
