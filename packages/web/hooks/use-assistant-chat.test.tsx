import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantStreamEvent, StreamResult } from '@/lib/api/assistant';

const api = vi.hoisted(() => ({
  createConversation: vi.fn(),
  send: vi.fn(),
  resume: vi.fn(),
  cancelGeneration: vi.fn(),
}));
const toast = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/api/assistant', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api/assistant')>()), assistantApi: api }));

import { AssistantRejected } from '@/lib/api/assistant';
import { useAssistantChat } from './use-assistant-chat';

type Handlers = { onEvent: (event: AssistantStreamEvent, id: string | undefined) => void };
const meta = (h: Handlers, id = 'm1') => h.onEvent({ event: 'meta', messageId: id, conversationId: 'c1' }, '1-0');
const text = (h: Handlers, t: string, id: string) => h.onEvent({ event: 'text', t }, id);
const done = (h: Handlers, id: string) =>
  h.onEvent({ event: 'done', stopReason: 'end_turn', truncated: false, usage: { inputTokens: 1, outputTokens: 1 }, allowance: { used: 1, limit: 2 } }, id);

describe('useAssistantChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createConversation.mockResolvedValue({ id: 'c1', title: 'New chat' });
    api.cancelGeneration.mockResolvedValue(undefined);
  });

  it('streams a reply into the assistant message with one Idempotency-Key per message', async () => {
    let turn = 0;
    api.send.mockImplementation(async (_c, _m, h: Handlers): Promise<StreamResult> => {
      meta(h, `m${++turn}`);
      text(h, 'Hello ', '2-0');
      text(h, 'there', '3-0');
      done(h, '4-0');
      return { terminal: true, lastEventId: '4-0' };
    });
    const { result } = renderHook(() => useAssistantChat());
    await act(() => result.current.sendMessage('hi'));
    await act(() => result.current.sendMessage('again'));

    expect(result.current.messages.filter((m) => m.role === 'assistant')[0].content).toBe('Hello there');
    const keys = api.send.mock.calls.map(([, message]) => (message as { key: string }).key);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(keys).size).toBe(2);
    // the conversation is created once, on the first message
    expect(api.createConversation).toHaveBeenCalledTimes(1);
  });

  it('S46 AS-22: a cut stream is resumed from the last event id; nothing repeats or is skipped', async () => {
    api.send.mockImplementation(async (_c, _m, h: Handlers): Promise<StreamResult> => {
      meta(h);
      text(h, 'Hel', '2-0');
      return { terminal: false, lastEventId: '2-0' };
    });
    api.resume.mockImplementation(async (_id, last, h: Handlers): Promise<StreamResult> => {
      expect(last).toBe('2-0');
      text(h, 'lo', '3-0');
      done(h, '4-0');
      return { terminal: true, lastEventId: '4-0' };
    });
    const { result } = renderHook(() => useAssistantChat());
    await act(() => result.current.sendMessage('hi'));

    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.messages.at(-1)!.content).toBe('Hello');
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it('S46 AS-64: a send still answered under the same key attaches to that reply', async () => {
    api.send.mockRejectedValueOnce(new AssistantRejected(409, { code: 'idempotency_in_flight', messageId: 'm9' }, {}));
    api.resume.mockImplementation(async (id, _last, h: Handlers): Promise<StreamResult> => {
      expect(id).toBe('m9');
      text(h, 'attached', '2-0');
      done(h, '3-0');
      return { terminal: true };
    });
    const { result } = renderHook(() => useAssistantChat());
    await act(() => result.current.sendMessage('hi'));
    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.messages.find((m) => m.id === 'm9')!.content).toBe('attached');
  });

  it('S46 AS-54: a moderation refusal replaces the text already shown', async () => {
    api.send.mockImplementation(async (_c, _m, h: Handlers): Promise<StreamResult> => {
      meta(h);
      text(h, 'something unsafe', '2-0');
      h.onEvent({ event: 'refusal', category: 'hate', source: 'moderation' }, '3-0');
      return { terminal: true };
    });
    const { result } = renderHook(() => useAssistantChat());
    await act(() => result.current.sendMessage('hi'));
    expect(result.current.messages.at(-1)!.content).toBe('This answer was removed.');
  });

  it('S46 AS-52: a refused message gives its text back and says why', async () => {
    api.send.mockRejectedValue(new AssistantRejected(422, { code: 'input_rejected', category: 'sensitive_data' }, {}));
    const { result } = renderHook(() => useAssistantChat());
    await act(() => result.current.sendMessage('my card is 4111 1111 1111 1111'));
    expect(toast.error).toHaveBeenCalledWith("Please don't share card numbers or passwords.");
    expect(result.current.messages).toEqual([]);
    expect(result.current.input).toBe('my card is 4111 1111 1111 1111');
  });

  it('S46 AS-32: an exhausted allowance names the reset date', async () => {
    api.send.mockRejectedValue(new AssistantRejected(429, { code: 'quota_exceeded', resetsAt: '2026-11-01T00:00:00.000Z' }, { 'retry-after': '100' }));
    const { result } = renderHook(() => useAssistantChat());
    await act(() => result.current.sendMessage('hi'));
    expect(String(toast.error.mock.calls[0][0])).toMatch(/^You've used this month's assistant allowance\. It resets on /);
  });
});
