import {
  assistantConversationSchema,
  assistantHistorySchema,
  assistantStreamEventSchema,
  assistantUsageSchema,
  type AssistantStreamEvent,
} from '@marketplace-sandbox/contracts';
import { apiClient } from './client';
import { streamSse } from './sse-reader';

export type { AssistantStreamEvent };
export { newIdempotencyKey } from './idempotency';

/** Shopping assistant (S46): conversations are per user; a turn streams meta → text… → one terminal event over SSE. */
export interface Conversation {
  id: string;
  title: string | null;
}

export interface AssistantHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools: string[];
}

export interface AssistantUsage {
  used: number;
  limit: number;
  resetsAt: string;
}

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

export interface StreamResult {
  /** True when the server ended the reply with `done`, `refusal` or `error`; false when the connection was cut. */
  terminal: boolean;
  /** The id of the last event received: the resume cursor (`Last-Event-ID`). */
  lastEventId?: string;
}

/**
 * Reads one reply stream and delivers validated events in order. An event whose data breaks the contract schema ends
 * the reading as a cut stream (the caller resumes or gives up); an unknown event name is ignored; a request refused
 * before a stream opens rejects with `AssistantRejected`.
 */
async function readStream(
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal },
  onEvent: (event: AssistantStreamEvent, id: string | undefined) => void,
): Promise<StreamResult> {
  let terminal = false;
  let lastEventId = init.headers?.['Last-Event-ID'];
  const ours = new AbortController();
  const forward = () => ours.abort();
  if (init.signal?.aborted) ours.abort();
  else init.signal?.addEventListener('abort', forward, { once: true });
  let broken = false;
  try {
    const response = await streamSse(url, { ...init, signal: ours.signal }, (raw) => {
      if (terminal || broken || !KNOWN_EVENTS.has(raw.event)) return;
      let data: unknown;
      try {
        data = JSON.parse(raw.data);
      } catch {
        broken = true;
        ours.abort();
        return;
      }
      const parsed = assistantStreamEventSchema.safeParse({ ...(data as object), event: raw.event });
      if (!parsed.success) {
        broken = true;
        ours.abort();
        return;
      }
      if (raw.id) lastEventId = raw.id;
      if (TERMINAL_EVENTS.has(parsed.data.event)) terminal = true;
      onEvent(parsed.data, raw.id);
    });
    if (!response.ok) throw await rejectionOf(response);
  } catch (error) {
    // Our own close after an unusable event is a cut stream, not a failure of the call.
    if (!(broken && !init.signal?.aborted)) throw error;
  } finally {
    init.signal?.removeEventListener('abort', forward);
  }
  return { terminal, lastEventId };
}

export const assistantApi = {
  async createConversation(title?: string): Promise<Conversation> {
    return assistantConversationSchema.parse((await apiClient.post('/api/assistant/conversations', title ? { title } : {})).data);
  },

  async getHistory(conversationId: string): Promise<AssistantHistoryMessage[]> {
    return assistantHistorySchema.parse((await apiClient.get(`/api/assistant/conversations/${conversationId}/messages`)).data).messages;
  },

  async getUsage(): Promise<AssistantUsage> {
    return assistantUsageSchema.parse((await apiClient.get('/api/assistant/usage')).data);
  },

  async deleteConversation(conversationId: string): Promise<void> {
    await apiClient.delete(`/api/assistant/conversations/${conversationId}`);
  },

  async cancelGeneration(messageId: string): Promise<void> {
    await apiClient.post(`/api/assistant/messages/${messageId}/cancel`, {});
  },

  /** Sends a message. The `Idempotency-Key` stays the same for every retry of this message (the server replays, never repeats). */
  send(
    conversationId: string,
    message: { text: string; key: string; lat?: number; lng?: number },
    handlers: { signal?: AbortSignal; onEvent: (event: AssistantStreamEvent, id: string | undefined) => void },
  ): Promise<StreamResult> {
    const { key, ...body } = message;
    return readStream(
      `/api/assistant/conversations/${conversationId}/messages`,
      { method: 'POST', body, headers: { 'Idempotency-Key': key }, signal: handlers.signal },
      handlers.onEvent,
    );
  },

  /** Continues a reply after the id of the last event received (`Last-Event-ID`); without one it replays from `meta`. */
  resume(
    messageId: string,
    lastEventId: string | undefined,
    handlers: { signal?: AbortSignal; onEvent: (event: AssistantStreamEvent, id: string | undefined) => void },
  ): Promise<StreamResult> {
    return readStream(
      `/api/assistant/messages/${messageId}/stream`,
      { method: 'GET', headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {}, signal: handlers.signal },
      handlers.onEvent,
    );
  },
};
