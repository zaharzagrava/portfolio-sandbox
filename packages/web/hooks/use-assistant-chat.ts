import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { assistantApi, AssistantRejected, newIdempotencyKey, type AssistantStreamEvent } from '@/lib/api/assistant';
import { problemFromError } from '@/lib/api/errors';
import { problemCopy } from '@/lib/api/problem-copy';

export interface ToolCall {
  name: string;
  status: 'pending' | 'success' | 'error';
}

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolCall[];
}

const TOOL_STATUS = { running: 'pending', done: 'success', failed: 'error' } as const;
const RESUME_ATTEMPTS = 4;
const REMOVED = 'This answer was removed.';

const ERROR_TEXT: Record<string, string | null> = {
  CANCELLED: null,
  PROVIDER_UNAVAILABLE: 'The assistant is unavailable right now. Try again later.',
  MODERATION_UNAVAILABLE: 'The assistant is unavailable right now. Try again later.',
  TURN_TIMEOUT: 'That took too long. Try again.',
  GENERATION_LOST: 'The answer was interrupted. Try again.',
  SHUTTING_DOWN: 'The answer was interrupted. Try again.',
};
const GENERIC_ERROR = 'The assistant could not answer that.';

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(new DOMException('aborted', 'AbortError'))), { once: true });
  });

/** The text for a send the server refused before a reply started (S46 problem codes). */
function rejectionText(error: AssistantRejected): string {
  const { data } = error.response;
  if (data.code === 'input_rejected' && data.category === 'sensitive_data') return "Please don't share card numbers or passwords.";
  if (data.code === 'quota_exceeded' && typeof data.resetsAt === 'string') {
    const date = new Date(data.resetsAt);
    if (!Number.isNaN(date.getTime())) return `You've used this month's assistant allowance. It resets on ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}.`;
  }
  return problemCopy('assistant', problemFromError(error)).text;
}

/**
 * One assistant conversation, created once on the first message (S46). Every message is sent with its own
 * `Idempotency-Key`, kept for retries; a reply that is cut is continued from the last event id, so the text neither
 * repeats nor skips.
 */
export function useAssistantChat() {
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const conversationRef = useRef<Promise<string> | null>(null);
  const currentMessageIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const patchAssistant = (id: string, patch: (m: ChatTurn) => ChatTurn) => setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));

  /** Single flight: two quick messages (or a double render) never create two conversations. */
  const ensureConversation = () => {
    conversationRef.current ??= assistantApi.createConversation().then(
      (conversation) => conversation.id,
      (error) => {
        conversationRef.current = null;
        throw error;
      },
    );
    return conversationRef.current;
  };

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setInput('');
    setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', content: text }]);
    setIsStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const key = newIdempotencyKey();
    let assistantId = '';
    let lastEventId: string | undefined;

    const onEvent = (event: AssistantStreamEvent, id: string | undefined) => {
      if (id) lastEventId = id;
      switch (event.event) {
        case 'meta':
          if (assistantId) return;
          assistantId = event.messageId;
          currentMessageIdRef.current = assistantId;
          setMessages((prev) => [...prev, { id: assistantId, role: 'assistant', content: '', tools: [] }]);
          break;
        case 'text':
          patchAssistant(assistantId, (m) => ({ ...m, content: m.content + event.t }));
          break;
        case 'tool':
          patchAssistant(assistantId, (m) => {
            const tools = (m.tools ?? []).filter((t) => t.name !== event.name);
            return { ...m, tools: [...tools, { name: event.name, status: TOOL_STATUS[event.status] }] };
          });
          break;
        case 'refusal':
          // The server withheld the answer: what was already shown is replaced by the notice.
          patchAssistant(assistantId, (m) => ({ ...m, content: event.source === 'moderation' ? REMOVED : "I can't help with that." }));
          break;
        case 'error': {
          const copy = event.code in ERROR_TEXT ? ERROR_TEXT[event.code] : GENERIC_ERROR;
          if (copy) toast.error(copy);
          break;
        }
        default:
      }
    };

    try {
      const conversationId = await ensureConversation();
      for (let attempt = 0; ; attempt++) {
        try {
          const result = assistantId
            ? await assistantApi.resume(assistantId, lastEventId, { signal: controller.signal, onEvent })
            : await assistantApi.send(conversationId, { text, key }, { signal: controller.signal, onEvent });
          if (result.terminal) break;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          if (error instanceof AssistantRejected) {
            // The same key is still being answered: attach to that reply instead of starting another.
            const inFlight = error.response.data.code === 'idempotency_in_flight' ? error.response.data.messageId : undefined;
            if (typeof inFlight !== 'string') throw error;
            assistantId = inFlight;
            currentMessageIdRef.current = inFlight;
            setMessages((prev) => (prev.some((m) => m.id === inFlight) ? prev : [...prev, { id: inFlight, role: 'assistant', content: '', tools: [] }]));
          }
          // anything else is a dropped connection: continue below
        }
        if (attempt >= RESUME_ATTEMPTS) {
          toast.error('The connection was lost. Try again.');
          break;
        }
        await wait(Math.min(500 * 2 ** attempt, 4_000), controller.signal);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      if (err instanceof AssistantRejected) {
        toast.error(rejectionText(err));
        // A message the server refused is not part of the conversation: give the text back.
        if (!assistantId) {
          setMessages((prev) => prev.slice(0, -1));
          setInput(text);
        }
      } else toast.error((err as Error).message || 'An error occurred while sending your message');
    } finally {
      setIsStreaming(false);
      currentMessageIdRef.current = null;
    }
  }, []);

  const stopGeneration = useCallback(async () => {
    const messageId = currentMessageIdRef.current;
    if (messageId) await assistantApi.cancelGeneration(messageId).catch(() => undefined);
    abortRef.current?.abort();
    setIsStreaming(false);
  }, []);

  return { messages, input, setInput, sendMessage, isStreaming, stopGeneration };
}
