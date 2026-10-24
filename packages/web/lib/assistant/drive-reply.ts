import type { QueryClient } from '@tanstack/react-query';
import { assistantApi, assistantProblem, AssistantRejected, type AssistantStreamEvent, type AssistantUsage } from '@/lib/api/assistant';
import { ApiParseError } from '@/lib/api/parse';
import { endSession } from '@/lib/auth/session-ended';
import { queryKeys } from '@/lib/query-keys';
import { clearReply, saveActive } from './active-store';
import type { ReplyAction } from './reply-reducer';
import { resumeWait } from './resume-schedule';

/**
 * The IO of one assistant reply (W05 FR-051..FR-055): reads the stream, re-attaches after a drop with `Last-Event-ID`, falls back
 * to the history when a reply cannot be resumed, stops a reply. It only dispatches to the pure reply reducer; nothing here
 * renders, and nothing here shows a toast. The hook creates one `ReplySession` per reply and keeps it for `requestStop`.
 */
export type ReplySession = {
  conversationId: string;
  abort: AbortController;
  /** Known after `meta` (or from the start for an attach). */
  messageId?: string;
  stopping: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
};

type Dispatch = (action: ReplyAction) => void;

/** How long a stop waits for the server's terminal `CANCELLED` before the local read is aborted (AS-52). */
export const STOP_LOCAL_ABORT_MS = 5_000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** Reads the conversation history for a reply that cannot be resumed: the finished answer if the server saved it, else "interrupted". */
export async function readFinishedAnswer(queryClient: QueryClient, dispatch: Dispatch, conversationId: string, messageId: string): Promise<boolean> {
  try {
    const history = await queryClient.fetchQuery({
      queryKey: queryKeys.assistant.history(conversationId),
      queryFn: () => assistantApi.history(conversationId),
      staleTime: 0,
    });
    const answer = history.messages.find((message) => (message.turnId === messageId || message.id === messageId) && message.role === 'assistant');
    if (answer) {
      dispatch({ type: 'fromHistory', text: answer.text, tools: answer.tools.map((name, at) => ({ id: `${answer.id}:${at}`, name, status: 'done' as const })) });
      return true;
    }
  } catch (error) {
    if (assistantProblem(error).status === 401) endSession();
  }
  dispatch({ type: 'lost', reason: 'interrupted' });
  return false;
}

export type DriveInput = {
  session: ReplySession;
  dispatch: Dispatch;
  queryClient: QueryClient;
  question: string;
  key: string;
  start: { kind: 'send'; options: { lat?: number; lng?: number } } | { kind: 'attach'; messageId: string };
  /**
   * A send the server refused before any stream (or an unexpected body). Returns the id of the reply to attach to when the same
   * key is still being answered (`409 idempotency_in_flight`); otherwise it has dealt with the refusal and returns `undefined`.
   */
  refuse: (error: unknown) => string | undefined;
};

export async function driveReply({ session, dispatch, queryClient, question, key, start, refuse }: DriveInput): Promise<void> {
  const { abort, conversationId } = session;
  let messageId = start.kind === 'attach' ? start.messageId : undefined;
  session.messageId = messageId;
  let lastEventId: string | undefined;
  let finished: 'done' | 'other' | undefined;
  let progress = false;

  const onEvent = (event: AssistantStreamEvent, id: string | undefined) => {
    progress = true;
    if (id) lastEventId = id;
    switch (event.event) {
      case 'meta':
        messageId = event.messageId;
        session.messageId = event.messageId;
        dispatch({ type: 'meta', messageId: event.messageId, eventId: id });
        saveActive({ conversationId, messageId: event.messageId, pendingText: question, idempotencyKey: key });
        break;
      case 'text':
        dispatch({ type: 'text', t: event.t, eventId: id });
        break;
      case 'tool':
        dispatch({ type: 'tool', id: event.id, name: event.name, status: event.status, eventId: id });
        break;
      case 'done':
        finished = 'done';
        dispatch({ type: 'done', allowance: event.allowance, eventId: id });
        queryClient.setQueryData<AssistantUsage>(queryKeys.assistant.usage(), (old) => (old ? { ...old, used: event.allowance.used, limit: event.allowance.limit } : old));
        break;
      case 'refusal':
        finished = 'other';
        dispatch({ type: 'refusal', category: event.category, source: event.source, eventId: id });
        break;
      case 'error':
        finished = 'other';
        dispatch({ type: 'error', code: event.code, retryAfterMs: event.retryAfterMs, eventId: id });
        break;
    }
  };

  let mode: 'send' | 'resume' = start.kind === 'send' ? 'send' : 'resume';
  let attempt = 0;
  let dropAt: number | undefined;

  for (;;) {
    progress = false;
    try {
      const handlers = { signal: abort.signal, onEvent };
      const result =
        mode === 'send'
          ? await assistantApi.send(conversationId, { text: question, key, ...(start.kind === 'send' && start.options.lat !== undefined && start.options.lng !== undefined ? start.options : {}) }, handlers)
          : await assistantApi.resume(messageId as string, lastEventId, handlers);
      if (result.terminal || finished) break;
    } catch (error) {
      if (abort.signal.aborted) break;
      const beforeStream = mode === 'send' && messageId === undefined;
      if (beforeStream && (error instanceof AssistantRejected || error instanceof ApiParseError)) {
        const attachTo = refuse(error);
        if (attachTo === undefined) return;
        messageId = attachTo;
        session.messageId = attachTo;
        dispatch({ type: 'attachInFlight', messageId: attachTo });
        mode = 'resume';
        continue;
      }
      if (error instanceof AssistantRejected) {
        const problem = assistantProblem(error);
        if (problem.status === 401) {
          endSession();
          dispatch({ type: 'lost', reason: 'interrupted' });
          break;
        }
        if (problem.status === 404 && messageId) {
          await readFinishedAnswer(queryClient, dispatch, conversationId, messageId);
          finished = 'other';
          break;
        }
      } else if (error instanceof ApiParseError) {
        dispatch({ type: 'lost', reason: 'interrupted' });
        break;
      }
      // anything else is a lost connection: carry on below
    }
    if (finished) break;
    if (messageId === undefined) {
      // The response was lost before the reply had an identity: nothing to attach to. The same key sent again finds it (AS-54).
      dispatch({ type: 'connectionLost' });
      break;
    }
    if (progress) {
      attempt = 0;
      dropAt = Date.now();
    } else dropAt ??= Date.now();
    dispatch({ type: 'connectionLost' });
    const wait = resumeWait(attempt, Date.now() - dropAt);
    if (wait === null) {
      dispatch({ type: 'lost', reason: 'unreachable' });
      break;
    }
    if (!(await sleep(wait, abort.signal))) break;
    attempt += 1;
    mode = 'resume';
  }

  clearTimeout(session.stopTimer);
  clearReply();
  void queryClient.invalidateQueries({ queryKey: queryKeys.assistant.conversations() });
  if (finished === 'done') void queryClient.invalidateQueries({ queryKey: queryKeys.assistant.history(conversationId), refetchType: 'none' });
}

/**
 * Stop generating (AS-52): one cancel call, the reading continues until the server's terminal `CANCELLED`; if that does not come
 * within 5 s the local read is aborted. `409 generation_finished` and `404 generation_not_found` read the history instead.
 */
export function requestStop({ session, dispatch, queryClient }: { session: ReplySession; dispatch: Dispatch; queryClient: QueryClient }): void {
  const { messageId } = session;
  if (!messageId || session.stopping) return;
  session.stopping = true;
  dispatch({ type: 'stopRequested' });
  session.stopTimer = setTimeout(() => {
    dispatch({ type: 'localStop' });
    session.abort.abort();
  }, STOP_LOCAL_ABORT_MS);
  void assistantApi.cancel(messageId).catch(async (error: unknown) => {
    const problem = assistantProblem(error);
    if (problem.status === 401) return endSession();
    if (problem.status === 409 || problem.status === 404) {
      clearTimeout(session.stopTimer);
      session.abort.abort();
      await readFinishedAnswer(queryClient, dispatch, session.conversationId, messageId);
    }
    // any other failure: the local abort after 5 s ends the reply
  });
}
