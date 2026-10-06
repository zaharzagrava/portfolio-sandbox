import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { assistantApi } from '@/lib/api/assistant';
import { streamSse } from '@/lib/api/sse-reader';

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

/** One assistant conversation, created on the first message (SD-42). */
export function useAssistantChat() {
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const conversationIdRef = useRef<string | null>(null);
  const currentMessageIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const patchAssistant = (id: string, patch: (m: ChatTurn) => ChatTurn) => setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setInput('');
    setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', content: text }]);
    setIsStreaming(true);
    abortRef.current = new AbortController();
    let assistantId = '';

    try {
      conversationIdRef.current ??= (await assistantApi.createConversation()).id;
      const res = await streamSse(assistantApi.turnUrl(conversationIdRef.current), { body: { text }, signal: abortRef.current.signal }, (event) => {
        const data = event.data ? JSON.parse(event.data) : {};
        if (event.event === 'meta') {
          assistantId = data.messageId;
          currentMessageIdRef.current = assistantId;
          setMessages((prev) => [...prev, { id: assistantId, role: 'assistant', content: '', tools: [] }]);
        } else if (event.event === 'text') {
          patchAssistant(assistantId, (m) => ({ ...m, content: m.content + data.t }));
        } else if (event.event === 'tool') {
          patchAssistant(assistantId, (m) => {
            const tools = (m.tools ?? []).filter((t) => t.name !== data.name);
            return { ...m, tools: [...tools, { name: data.name, status: data.status }] };
          });
        } else if (event.event === 'refusal' || event.event === 'error') {
          toast.error(data.message ?? 'The assistant could not answer that.');
        }
      });
      if (!res.ok) toast.error(res.status === 429 ? 'Rate limit exceeded. Please try again later.' : res.status === 401 ? 'Log in to use the assistant.' : 'The assistant is unavailable.');
    } catch (err) {
      if ((err as Error).name !== 'AbortError') toast.error((err as Error).message || 'An error occurred while sending your message');
    } finally {
      setIsStreaming(false);
      currentMessageIdRef.current = null;
    }
  }, []);

  const stopGeneration = useCallback(async () => {
    const messageId = currentMessageIdRef.current;
    abortRef.current?.abort();
    if (messageId) await assistantApi.cancelGeneration(messageId).catch(() => undefined);
    setIsStreaming(false);
  }, []);

  return { messages, input, setInput, sendMessage, isStreaming, stopGeneration };
}
