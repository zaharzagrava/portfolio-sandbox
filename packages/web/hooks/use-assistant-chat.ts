'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { assistantApi, assistantProblem } from '@/lib/api/assistant';
import { clearActive, clearAssistantStorage, clearForConversation, loadActive, saveActive } from '@/lib/assistant/active-store';
import { driveReply, requestStop, type ReplySession } from '@/lib/assistant/drive-reply';
import { allowanceView, refusalCopy, replyEndCopy, sendProblemCopy, type AllowanceView, type SendProblemCopy } from '@/lib/assistant/problem-copy';
import { idempotencyKeyFor, initialReply, replyReducer, type ReplyState, type ToolChip } from '@/lib/assistant/reply-reducer';
import { endSession } from '@/lib/auth/session-ended';
import { subscribeAuth } from '@/lib/auth/session-sync';
import { assistantHistoryStaleTime } from '@/lib/query-defaults';
import { queryKeys } from '@/lib/query-keys';

/** One bubble of the transcript: a history message or the live reply. `live` is set on the assistant bubble of a running reply. */
export type TranscriptMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tools: ToolChip[];
  live?: 'thinking' | 'streaming' | 'reconnecting' | 'stopping';
};

/** The inline message under the transcript (always `role="alert"`): why a send or a reply did not work, and what to do next. */
export type Notice = {
  text: string;
  /** "Try again": `ask` puts the question back in the field; `reattach` reads the reply again. */
  tryAgain?: 'ask' | 'reattach';
  /** Offer **New chat** (a full conversation). */
  newChat?: boolean;
  /** `Reference: <id>` for an unexpected server error. */
  reference?: string;
};

export type Lock = { kind: 'wait' | 'quota' | 'full'; text: string; until?: number };

const RUNNING = ['sending', 'streaming', 'reconnecting', 'stopping'];
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Runs `fire` at the instant `until` (ms), re-arming in slices because a timer cannot wait longer than ~24 days. */
function armAt(until: number, fire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    const left = until - Date.now();
    if (left <= 0) fire();
    else timer = setTimeout(arm, Math.min(left, MAX_TIMEOUT_MS));
  };
  arm();
  return () => clearTimeout(timer);
}

type SendOptions = { lat?: number; lng?: number };

/**
 * One assistant conversation as seen by the sheet (W05 FR-050..FR-063). The server data - history, conversation list, allowance -
 * lives in TanStack Query under `queryKeys.assistant.*`; the live reply is a pure reducer (`replyReducer`) driven by
 * `lib/assistant/drive-reply.ts` (the stream, the resume, the stop). Every send carries one `Idempotency-Key` per user action.
 * No toast is used anywhere: every message is returned for the sheet to show inline.
 */
export function useAssistantChat({ active }: { active: boolean }) {
  const queryClient = useQueryClient();
  const { user, status } = useAuth();
  const member = status === 'authenticated' && user !== null;
  const userId = user?.id ?? null;

  const [openId, setConversationId] = useState<string | null>(() => loadActive()?.conversationId ?? null);
  const [reply, dispatch] = useReducer(replyReducer, initialReply);
  const [replyConversationId, setReplyConversationId] = useState<string | null>(null);
  const [input, setInputState] = useState('');
  const [problem, setProblem] = useState<SendProblemCopy | null>(null);
  const [lock, setLock] = useState<Lock | null>(null);

  const busy = useRef(false);
  const creating = useRef<Promise<string> | null>(null);
  const session = useRef<ReplySession | null>(null);
  const lastSent = useRef<{ text: string; key: string; refused?: boolean } | undefined>(undefined);
  const viewing = useRef<string | null>(openId);

  const running = RUNNING.includes(reply.phase);

  // --- server data ------------------------------------------------------------------------------------------------------------

  const historyQuery = useQuery({
    queryKey: queryKeys.assistant.history(openId ?? ''),
    queryFn: async () => {
      try {
        return await assistantApi.history(openId as string);
      } catch (error) {
        if (assistantProblem(error).status === 401) endSession();
        throw error;
      }
    },
    enabled: member && active && openId !== null,
    staleTime: assistantHistoryStaleTime(running),
    retry: false,
  });
  const usageQuery = useQuery({
    queryKey: queryKeys.assistant.usage(),
    queryFn: async () => {
      try {
        return await assistantApi.usage();
      } catch (error) {
        if (assistantProblem(error).status === 401) endSession();
        throw error;
      }
    },
    enabled: member && active,
    retry: false,
  });
  const usage: AllowanceView | null = allowanceView(usageQuery.data);

  // A conversation that no longer exists falls back to the empty state, silently (AS-48).
  const historyGone = historyQuery.isError && assistantProblem(historyQuery.error).status === 404;
  const conversationId = historyGone ? null : openId;
  useEffect(() => {
    viewing.current = conversationId;
  }, [conversationId]);
  useEffect(() => {
    if (historyGone && openId) clearForConversation(openId);
  }, [historyGone, openId]);

  // --- what the member sees ---------------------------------------------------------------------------------------------------

  const showReply = reply.phase !== 'idle' && replyConversationId === conversationId;
  const saved = historyQuery.data?.messages ?? [];
  // A reply on screen that is already in the history is shown once, from the live state.
  const savedTurn = showReply && reply.messageId ? saved.find((m) => m.id === reply.messageId)?.turnId : undefined;
  const items: TranscriptMessage[] = saved
    .filter((m) => savedTurn === undefined || m.turnId !== savedTurn)
    .map((m) => ({ id: m.id, role: m.role, content: m.text, tools: m.tools.map((name, at) => ({ id: `${m.id}:${at}`, name, status: 'done' as const })) }));
  if (showReply) {
    if (reply.question) items.push({ id: `question:${reply.idempotencyKey}`, role: 'user', content: reply.question, tools: [] });
    const refused = reply.outcome === 'refused';
    const content = refused ? refusalCopy().text : reply.text;
    if (running || reply.outcome === 'done' || refused || content !== '' || reply.tools.length > 0) {
      const live: TranscriptMessage['live'] =
        reply.phase === 'reconnecting' ? 'reconnecting' : reply.phase === 'stopping' ? 'stopping' : running ? (content === '' ? 'thinking' : 'streaming') : undefined;
      items.push({ id: reply.messageId ?? `answer:${reply.idempotencyKey}`, role: 'assistant', content, tools: reply.tools, ...(live ? { live } : {}) });
    }
  }

  let notice: Notice | null = null;
  if (problem && problem.text) {
    notice = { text: problem.text, ...(problem.effect === 'new-chat' ? { newChat: true } : {}), ...(problem.reference ? { reference: problem.reference } : {}) };
  } else if (showReply && reply.phase === 'ended' && reply.outcome) {
    if (reply.outcome === 'refused') notice = { text: refusalCopy().note };
    else if (reply.outcome !== 'done') {
      const copy = replyEndCopy({ outcome: reply.outcome, errorCode: reply.errorCode, retryAfterMs: reply.retryAfterMs, lostReason: reply.lostReason });
      notice = { text: copy.text, tryAgain: copy.reattach ? 'reattach' : 'ask' };
    }
  }

  const announce = {
    start: showReply && running ? 'The assistant is answering…' : '',
    end: showReply && reply.phase === 'ended' ? (reply.outcome === 'done' ? 'Answer ready' : (notice?.text ?? '')) : '',
  };

  // --- the composer is locked by a wait, a used-up allowance or a full chat -----------------------------------------------------

  const quotaFromUsage = usage?.usedUp ? usage : null;
  const quotaUntil = lock?.kind === 'quota' ? lock.until : quotaFromUsage ? Date.parse(quotaFromUsage.resetsAt) : undefined;
  const quotaText = lock?.kind === 'quota' ? lock.text : quotaFromUsage ? sendProblemCopy({ status: 429, code: 'quota_exceeded', errors: [], resetsAt: quotaFromUsage.resetsAt }).text : '';
  const effectiveLock: Lock | null = lock && lock.kind !== 'quota' ? lock : quotaFromUsage || lock?.kind === 'quota' ? { kind: 'quota', text: quotaText, until: quotaUntil } : null;
  const locked = effectiveLock !== null;

  useEffect(() => {
    if (lock?.kind !== 'wait' || lock.until === undefined) return;
    return armAt(lock.until, () => {
      setLock(null);
      setProblem(null);
    });
  }, [lock]);
  useEffect(() => {
    if (quotaUntil === undefined || !Number.isFinite(quotaUntil)) return;
    return armAt(quotaUntil, () => {
      setLock((current) => (current?.kind === 'quota' ? null : current));
      void queryClient.invalidateQueries({ queryKey: queryKeys.assistant.usage() });
    });
  }, [quotaUntil, queryClient]);

  // --- the stream -------------------------------------------------------------------------------------------------------------

  const ensureConversation = useCallback(() => {
    creating.current ??= assistantApi.createConversation().then(
      (conversation) => {
        creating.current = null;
        return conversation.id;
      },
      (error) => {
        creating.current = null;
        throw error;
      },
    );
    return creating.current;
  }, []);

  /** Runs one reply (a send, or an attach to a reply that already runs) to its end; `busy` stays set meanwhile. */
  const run = useCallback(
    async (input: {
      conversationId: string;
      question: string;
      key: string;
      start: { kind: 'send'; options: SendOptions } | { kind: 'attach'; messageId: string };
      refuse: (error: unknown) => string | undefined;
    }) => {
      const current: ReplySession = { conversationId: input.conversationId, abort: new AbortController(), stopping: false };
      session.current = current;
      setReplyConversationId(input.conversationId);
      try {
        await driveReply({ session: current, dispatch, queryClient, question: input.question, key: input.key, start: input.start, refuse: input.refuse });
      } finally {
        if (session.current === current) session.current = null;
        busy.current = false;
      }
    },
    [queryClient],
  );

  const startAgain = useRef<((text: string, options: SendOptions) => void) | null>(null);
  const startSend = useCallback(
    (text: string, options: SendOptions) => {
      if (busy.current || !text || !member || locked) return;
      busy.current = true;
      const key = idempotencyKeyFor(lastSent.current, text);
      lastSent.current = { text, key };
      setProblem(null);
      setInputState('');
      dispatch({ type: 'send', question: text, idempotencyKey: key });

      const giveBack = (copy: SendProblemCopy) => {
        dispatch({ type: 'reset' });
        setInputState(text);
        setProblem(copy);
        busy.current = false;
      };
      /** A send refused before a stream (the problem codes of AS-56) or an unexpected answer. */
      const refuse = (error: unknown): string | undefined => {
        const copy = sendProblemCopy(assistantProblem(error));
        if (copy.effect === 'attach') return copy.messageId;
        if (copy.effect === 'session-ended') {
          endSession();
          dispatch({ type: 'reset' });
          setInputState(text);
          busy.current = false;
          return undefined;
        }
        if (copy.effect === 'new-key') {
          // The key was used for another text: start again with a new key (AS-54).
          lastSent.current = { text, key, refused: true };
          dispatch({ type: 'reset' });
          busy.current = false;
          startAgain.current?.(text, options);
          return undefined;
        }
        if (copy.effect === 'reset-conversation') {
          clearForConversation(viewing.current ?? '');
          setConversationId(null);
        }
        if (copy.effect === 'wait' && copy.waitSeconds !== undefined) setLock({ kind: 'wait', text: copy.text, until: Date.now() + copy.waitSeconds * 1000 });
        if (copy.effect === 'quota') setLock({ kind: 'quota', text: copy.text, until: copy.resetsAt ? Date.parse(copy.resetsAt) : undefined });
        if (copy.effect === 'new-chat') setLock({ kind: 'full', text: 'This chat is full.' });
        giveBack(copy);
        return undefined;
      };

      void (async () => {
        let id = viewing.current;
        if (id === null) {
          try {
            id = await ensureConversation();
          } catch (error) {
            if (assistantProblem(error).status === 401) endSession();
            giveBack(sendProblemCopy(assistantProblem(error)));
            return;
          }
          viewing.current = id;
          setConversationId(id);
          saveActive({ conversationId: id });
          void queryClient.invalidateQueries({ queryKey: queryKeys.assistant.conversations() });
        }
        await run({ conversationId: id, question: text, key, start: { kind: 'send', options }, refuse });
      })();
    },
    [member, locked, ensureConversation, queryClient, run],
  );
  useEffect(() => {
    startAgain.current = startSend;
  }, [startSend]);

  const send = useCallback((options: SendOptions = {}) => startSend(input.trim(), options), [startSend, input]);

  /** Reads a reply that is already running (a reload, or **Try again** after "We couldn't reconnect"); replays from `meta`. */
  const attach = useCallback(
    (target: { conversationId: string; messageId: string; question: string; key: string }) => {
      if (busy.current) return;
      busy.current = true;
      dispatch({ type: 'attach', messageId: target.messageId, question: target.question, idempotencyKey: target.key });
      void run({ ...target, start: { kind: 'attach', messageId: target.messageId }, refuse: () => undefined });
    },
    [run],
  );

  const recovered = useRef(false);
  useEffect(() => {
    if (!member || recovered.current) return;
    const pointer = loadActive();
    if (!pointer?.messageId) return;
    recovered.current = true;
    const { conversationId: id, messageId } = pointer;
    void Promise.resolve().then(() => attach({ conversationId: id, messageId, question: pointer.pendingText ?? '', key: pointer.idempotencyKey ?? 'reload' }));
  }, [member, attach]);

  const reattach = useCallback(() => {
    if (!reply.messageId || replyConversationId === null) return;
    attach({ conversationId: replyConversationId, messageId: reply.messageId, question: reply.question, key: reply.idempotencyKey });
  }, [attach, reply.messageId, reply.question, reply.idempotencyKey, replyConversationId]);

  const stop = useCallback(() => {
    if (session.current) requestStop({ session: session.current, dispatch, queryClient });
  }, [queryClient]);

  const tryAgain = useCallback(() => {
    // The question goes back into the field; it is never sent again by itself. A reply that never started keeps its key.
    if (reply.question) {
      setInputState(reply.question);
      if (reply.messageId) lastSent.current = undefined;
    }
    dispatch({ type: 'reset' });
  }, [reply.question, reply.messageId]);

  // --- conversations ----------------------------------------------------------------------------------------------------------

  const leaveConversation = useCallback((next: string | null) => {
    setProblem(null);
    setLock((current) => (current?.kind === 'full' ? null : current));
    setConversationId(next);
    viewing.current = next;
    if (!busy.current) {
      dispatch({ type: 'reset' });
      if (next) saveActive({ conversationId: next });
      else clearActive();
    }
  }, []);

  const newChat = useCallback(() => leaveConversation(null), [leaveConversation]);
  const selectConversation = useCallback((id: string) => leaveConversation(id), [leaveConversation]);
  /** A conversation was deleted: when it is the open one the sheet shows the empty state. */
  const conversationDeleted = useCallback(
    (id: string) => {
      clearForConversation(id);
      queryClient.removeQueries({ queryKey: queryKeys.assistant.history(id) });
      if (viewing.current === id) leaveConversation(null);
    },
    [leaveConversation, queryClient],
  );

  // --- the session ends (here or in another tab): forget everything (AS-55) ---------------------------------------------------

  const forget = useCallback(() => {
    session.current?.abort.abort();
    session.current = null;
    busy.current = false;
    creating.current = null;
    lastSent.current = undefined;
    clearAssistantStorage();
    queryClient.removeQueries({ queryKey: queryKeys.assistant.all });
    dispatch({ type: 'reset' });
    setReplyConversationId(null);
    setConversationId(null);
    viewing.current = null;
    setInputState('');
    setProblem(null);
    setLock(null);
  }, [queryClient]);

  useEffect(() => subscribeAuth((type) => type === 'signed-out' && forget()), [forget]);

  // A different member in the same tab never sees the previous member's conversation.
  const [seenUser, setSeenUser] = useState<string | null>(userId);
  if (seenUser !== userId) {
    setSeenUser(userId);
    if (seenUser !== null) {
      dispatch({ type: 'reset' });
      setConversationId(null);
      setReplyConversationId(null);
      setInputState('');
    }
  }
  const lastUser = useRef(userId);
  useEffect(() => {
    const previous = lastUser.current;
    lastUser.current = userId;
    if (previous !== null && previous !== userId) {
      session.current?.abort.abort();
      clearAssistantStorage();
      queryClient.removeQueries({ queryKey: queryKeys.assistant.all });
    }
  }, [userId, queryClient]);

  const historyState: 'idle' | 'loading' | 'ready' | 'error' = conversationId === null ? 'idle' : historyQuery.isError ? 'error' : historyQuery.data ? 'ready' : 'loading';

  return {
    conversationId,
    runningConversationId: running ? replyConversationId : null,
    items,
    historyState,
    refetchHistory: historyQuery.refetch,
    reply: showReply ? reply : initialReply,
    running,
    input,
    setInput: setInputState,
    canSend: member && !running && !locked && input.trim().length > 0,
    send,
    stop,
    tryAgain,
    reattach,
    notice,
    lock: effectiveLock,
    announce,
    usage,
    newChat,
    selectConversation,
    conversationDeleted,
    canStartNew: conversationId !== null || items.length > 0,
  };
}

export type AssistantChat = ReturnType<typeof useAssistantChat>;
export type { ReplyState };
