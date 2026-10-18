import { vi } from 'vitest';
import type { AssistantConversationList, AssistantHistory, AssistantStreamEvent, AssistantUsage, StreamResult } from '@/lib/api/assistant';

/**
 * W05 test support (UA2, UA5, UA7): a scripted stand-in for `assistantApi`. Every `send`/`resume` call becomes a `FakeCall` the
 * test drives by hand (emit events, end the stream, cut it, reject it); REST calls are `vi.fn`s with sensible defaults. Use with
 * `vi.mock('@/lib/api/assistant', async (original) => ({ ...(await original()), assistantApi: fake.api }))`.
 */
export type FakeCall = {
  kind: 'send' | 'resume';
  /** `send`: `[conversationId, message]`; `resume`: `[messageId, lastEventId]`. */
  args: unknown[];
  signal: AbortSignal | undefined;
  emit: (event: AssistantStreamEvent, id?: string) => void;
  /** The server ends the stream (or the connection is cut when `terminal` is false). */
  end: (result?: Partial<StreamResult>) => void;
  /** The request fails (a refusal or a network error). */
  fail: (error: unknown) => void;
  aborted: () => boolean;
};

export const META = (messageId = 'm1', conversationId = 'c1'): AssistantStreamEvent => ({ event: 'meta', messageId, conversationId });
export const TEXT = (t: string): AssistantStreamEvent => ({ event: 'text', t });
export const TOOL = (id: string, name: string, status: 'running' | 'done' | 'failed'): AssistantStreamEvent => ({ event: 'tool', id, name, status });
export const DONE = (used = 10, limit = 100): AssistantStreamEvent => ({
  event: 'done',
  stopReason: 'end_turn',
  truncated: false,
  usage: { inputTokens: 1, outputTokens: 1 },
  allowance: { used, limit },
});
export const ERROR = (code: 'CANCELLED' | 'PROVIDER_UNAVAILABLE' | 'TURN_TIMEOUT' | 'GENERATION_LOST' | 'MODERATION_UNAVAILABLE' | 'INTERNAL', retryAfterMs?: number): AssistantStreamEvent => ({
  event: 'error',
  code,
  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});

export const CONVERSATION_ID = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

export function createFakeAssistant() {
  const calls: FakeCall[] = [];

  function connect(kind: FakeCall['kind'], args: unknown[], handlers: { signal?: AbortSignal; onEvent: (event: AssistantStreamEvent, id: string | undefined) => void }): Promise<StreamResult> {
    return new Promise<StreamResult>((resolve, reject) => {
      let last: string | undefined;
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (handlers.signal?.aborted) onAbort();
      else handlers.signal?.addEventListener('abort', onAbort, { once: true });
      calls.push({
        kind,
        args,
        signal: handlers.signal,
        emit: (event, id) => {
          if (aborted) return;
          if (id) last = id;
          handlers.onEvent(event, id);
        },
        end: (result = {}) => {
          if (aborted) return;
          resolve({ terminal: false, lastEventId: last, ...result });
        },
        fail: (error) => {
          if (!aborted) reject(error);
        },
        aborted: () => aborted,
      });
    });
  }

  const emptyList: AssistantConversationList = { items: [], nextCursor: null };
  const emptyHistory = (id: string): AssistantHistory => ({ conversation: { id, title: 'New chat', updatedAt: '2026-10-17T10:00:00.000Z' }, messages: [] });
  const usage: AssistantUsage = { used: 12_000, limit: 100_000, resetsAt: '2026-11-01T00:00:00.000Z' };

  type Handlers = Parameters<typeof connect>[2];
  const defaults = {
    listConversations: async (): Promise<AssistantConversationList> => emptyList,
    createConversation: async () => ({ id: CONVERSATION_ID, title: 'New chat', updatedAt: '2026-10-17T10:00:00.000Z', messageCount: 0 }),
    deleteConversation: async (): Promise<void> => undefined,
    history: async (id: string): Promise<AssistantHistory> => emptyHistory(id),
    usage: async (): Promise<AssistantUsage> => usage,
    cancel: async (): Promise<void> => undefined,
    send: (conversationId: string, message: unknown, handlers: Handlers) => connect('send', [conversationId, message], handlers),
    resume: (messageId: string, lastEventId: string | undefined, handlers: Handlers) => connect('resume', [messageId, lastEventId], handlers),
  };
  const api = {
    listConversations: vi.fn(defaults.listConversations),
    createConversation: vi.fn(defaults.createConversation),
    deleteConversation: vi.fn(defaults.deleteConversation),
    history: vi.fn(defaults.history),
    usage: vi.fn(defaults.usage),
    cancel: vi.fn(defaults.cancel),
    send: vi.fn(defaults.send),
    resume: vi.fn(defaults.resume),
  };

  return {
    api,
    calls,
    /** The `n`-th stream request (0-based), once it was made. */
    call: async (n: number): Promise<FakeCall> => {
      await vi.waitFor(() => {
        if (!calls[n]) throw new Error(`stream request ${n} not made yet (${calls.length} so far)`);
      });
      return calls[n];
    },
    reset() {
      calls.length = 0;
      api.listConversations.mockReset().mockImplementation(defaults.listConversations);
      api.createConversation.mockReset().mockImplementation(defaults.createConversation);
      api.deleteConversation.mockReset().mockImplementation(defaults.deleteConversation);
      api.history.mockReset().mockImplementation(defaults.history);
      api.usage.mockReset().mockImplementation(defaults.usage);
      api.cancel.mockReset().mockImplementation(defaults.cancel);
      api.send.mockReset().mockImplementation(defaults.send);
      api.resume.mockReset().mockImplementation(defaults.resume);
    },
  };
}
