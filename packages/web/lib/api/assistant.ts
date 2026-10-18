import {
  assistantCancelResponseSchema,
  assistantConversationListSchema,
  assistantConversationSchema,
  assistantHistorySchema,
  assistantLastEventIdSchema,
  assistantStreamEventSchema,
  assistantUsageSchema,
  type AssistantConversation,
  type AssistantConversationList,
  type AssistantHistory,
  type AssistantHistoryMessage,
  type AssistantStreamEvent,
  type AssistantUsage,
} from '@marketplace-sandbox/contracts';
import { apiClient } from './client';
import { problemFromError, type Problem } from './errors';
import { ApiParseError, parseBody } from './parse';
import { streamSse } from './sse-reader';

export type { AssistantConversation, AssistantConversationList, AssistantHistory, AssistantHistoryMessage, AssistantStreamEvent, AssistantUsage };
export { newIdempotencyKey } from './idempotency';

/**
 * Shopping assistant (S46; W05 FR-050..FR-058, FR-072). Same-origin relative URLs; the session cookie travels by itself and
 * the CSRF proof is added to every write; there is no token and no credential header of our own. REST bodies and every stream
 * frame are parsed with the `packages/contracts` schemas. A turn streams `meta` → `text`/`tool`… → one terminal event
 * (`done`, `refusal` or `error`).
 */

const BASE = '/api/assistant';

const KNOWN_EVENTS = new Set<string>(assistantStreamEventSchema.options.map((option) => option.shape.event.value));
const TERMINAL_EVENTS = new Set<string>(['done', 'refusal', 'error']);

/** A refusal before a stream opens, shaped like an axios error so `problemFromError` reads it (status, `code`, `Retry-After`). */
export class AssistantRejected extends Error {
  readonly response: { status: number; data: Record<string, unknown>; headers: Record<string, string> };
  constructor(status: number, data: Record<string, unknown>, headers: Record<string, string>) {
    super(`assistant rejected: ${status}`);
    this.name = 'AssistantRejected';
    this.response = { status, data, headers };
  }
}

async function rejectionOf(response: Response): Promise<AssistantRejected> {
  const parsed: unknown = await response.json().catch(() => null);
  const data = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const retryAfter = response.headers.get('retry-after');
  return new AssistantRejected(response.status, data, retryAfter === null ? {} : { 'retry-after': retryAfter });
}

/** The problem of a failed assistant call: W01's `Problem` plus the extension members read from the raw body (gap M7). */
export type AssistantProblem = Problem & {
  /** `input_rejected`: why the text was refused (`sensitive_data`, ...). */
  category?: string;
  /** `quota_exceeded`: tokens used and the plan's limit this month. */
  used?: number;
  limit?: number;
  /** `quota_exceeded`: when the allowance resets (an ISO instant). */
  resetsAt?: string;
  /** `idempotency_in_flight`: the reply to attach to. */
  messageId?: string;
};

/** Works for an axios error (REST calls) and for `AssistantRejected` (stream calls): both carry `response.data`. */
export function assistantProblem(error: unknown): AssistantProblem {
  const problem = problemFromError(error);
  const data = (error as { response?: { data?: unknown } } | null)?.response?.data;
  if (!data || typeof data !== 'object') return problem;
  const body = data as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : undefined);
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const extras = { category: text(body.category), used: count(body.used), limit: count(body.limit), resetsAt: text(body.resetsAt), messageId: text(body.messageId) };
  return { ...problem, ...Object.fromEntries(Object.entries(extras).filter(([, value]) => value !== undefined)) };
}

export interface StreamResult {
  /** True when the server ended the reply with `done`, `refusal` or `error`; false when the connection was cut. */
  terminal: boolean;
  /** The id of the last event received: the resume cursor (`Last-Event-ID`). */
  lastEventId?: string;
  /** True when the server answered a retry of a finished turn from its stored events (`Idempotent-Replay`). */
  replayed?: boolean;
}

type EventHandlers = { signal?: AbortSignal; onEvent: (event: AssistantStreamEvent, id: string | undefined) => void };

/** `<ms>-<seq>` as a comparable pair; null for an id of another shape. */
function parseEventId(id: string | undefined): [number, number] | null {
  if (!id || !assistantLastEventIdSchema.safeParse(id).success) return null;
  const [ms, seq] = id.split('-').map(Number);
  return [ms, seq];
}

const isAfter = (next: [number, number], last: [number, number]) => next[0] > last[0] || (next[0] === last[0] && next[1] > last[1]);

/**
 * Reads one reply stream and delivers validated events in order. Skipped without a trace (AS-70): an unknown event name, a
 * `data` that is not JSON, heartbeat comments (the parser drops them), an event whose id does not increase, anything after
 * the terminal event. A known event whose data breaks the contract schema rejects with `ApiParseError` (the unexpected
 * error). A request refused before a stream opens rejects with `AssistantRejected`; a connection cut mid-stream resolves
 * with `terminal: false`.
 */
async function readStream(
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal },
  onEvent: EventHandlers['onEvent'],
): Promise<StreamResult> {
  let terminal = false;
  const resumedFrom = init.headers?.['Last-Event-ID'];
  let lastEventId = resumedFrom;
  let lastParsed = parseEventId(resumedFrom);
  const ours = new AbortController();
  const forward = () => ours.abort();
  if (init.signal?.aborted) ours.abort();
  else init.signal?.addEventListener('abort', forward, { once: true });
  let mismatch = false;
  let response: Response | undefined;
  try {
    response = await streamSse(url, { ...init, signal: ours.signal }, (raw) => {
      if (terminal || mismatch || !KNOWN_EVENTS.has(raw.event)) return;
      const id = parseEventId(raw.id);
      if (id && lastParsed && !isAfter(id, lastParsed)) return;
      let data: unknown;
      try {
        data = JSON.parse(raw.data);
      } catch {
        return;
      }
      const parsed = assistantStreamEventSchema.safeParse(data !== null && typeof data === 'object' ? { ...(data as object), event: raw.event } : null);
      if (!parsed.success) {
        mismatch = true;
        ours.abort();
        return;
      }
      if (id && raw.id) {
        lastParsed = id;
        lastEventId = raw.id;
      }
      if (TERMINAL_EVENTS.has(parsed.data.event)) terminal = true;
      onEvent(parsed.data, raw.id);
    });
  } catch (error) {
    // Our own close after an unusable event is the unexpected error, not an abort by the caller.
    if (mismatch && !init.signal?.aborted) throw new ApiParseError();
    throw error;
  } finally {
    init.signal?.removeEventListener('abort', forward);
  }
  if (!response.ok) throw await rejectionOf(response);
  const replayed = response.headers.get('idempotent-replay') === 'true';
  return { terminal, lastEventId, ...(replayed ? { replayed } : {}) };
}

type PageParams = { limit?: number; cursor?: string };

export const assistantApi = {
  async listConversations(params: PageParams = {}): Promise<AssistantConversationList> {
    const query = { ...(params.limit !== undefined ? { limit: params.limit } : {}), ...(params.cursor ? { cursor: params.cursor } : {}) };
    const { data } = await apiClient.get<unknown>(`${BASE}/conversations`, { params: query });
    return parseBody(assistantConversationListSchema, data);
  },

  async createConversation(title?: string): Promise<AssistantConversation> {
    const { data } = await apiClient.post<unknown>(`${BASE}/conversations`, title ? { title } : {});
    return parseBody(assistantConversationSchema, data);
  },

  async deleteConversation(conversationId: string): Promise<void> {
    await apiClient.delete(`${BASE}/conversations/${encodeURIComponent(conversationId)}`);
  },

  /** The visible text and tool names of a conversation (S46 AS-08), oldest first. */
  async history(conversationId: string): Promise<AssistantHistory> {
    const { data } = await apiClient.get<unknown>(`${BASE}/conversations/${encodeURIComponent(conversationId)}/messages`);
    return parseBody(assistantHistorySchema, data);
  },

  async usage(): Promise<AssistantUsage> {
    const { data } = await apiClient.get<unknown>(`${BASE}/usage`);
    return parseBody(assistantUsageSchema, data);
  },

  /** `202`; the stream still delivers the terminal `CANCELLED`. `409 generation_finished` and `404 generation_not_found` reject. */
  async cancel(messageId: string): Promise<void> {
    const { data } = await apiClient.post<unknown>(`${BASE}/messages/${encodeURIComponent(messageId)}/cancel`, {});
    parseBody(assistantCancelResponseSchema, data);
  },

  /**
   * Sends a message. The `Idempotency-Key` is made once per user action by the caller and stays the same for every retry of
   * this text (the server replays, never repeats).
   */
  send(
    conversationId: string,
    message: { text: string; key: string; lat?: number; lng?: number },
    handlers: EventHandlers,
  ): Promise<StreamResult> {
    const { key, ...body } = message;
    return readStream(
      `${BASE}/conversations/${encodeURIComponent(conversationId)}/messages`,
      { method: 'POST', body, headers: { 'Idempotency-Key': key }, signal: handlers.signal },
      handlers.onEvent,
    );
  },

  /** Continues a reply after the id of the last event received (`Last-Event-ID`); without one it replays from `meta`. */
  resume(messageId: string, lastEventId: string | undefined, handlers: EventHandlers): Promise<StreamResult> {
    const valid = lastEventId !== undefined && assistantLastEventIdSchema.safeParse(lastEventId).success;
    return readStream(
      `${BASE}/messages/${encodeURIComponent(messageId)}/stream`,
      { method: 'GET', headers: valid ? { 'Last-Event-ID': lastEventId } : {}, signal: handlers.signal },
      handlers.onEvent,
    );
  },
};
