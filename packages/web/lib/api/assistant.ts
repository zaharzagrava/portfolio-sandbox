import { apiClient } from './client';

/** Shopping assistant (SD-42): conversations are per user; a turn streams meta → text… → done over SSE. */
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

export const assistantApi = {
  async createConversation(title?: string): Promise<Conversation> {
    return (await apiClient.post('/api/assistant/conversations', title ? { title } : {})).data;
  },

  async getHistory(conversationId: string): Promise<AssistantHistoryMessage[]> {
    return (await apiClient.get(`/api/assistant/conversations/${conversationId}/messages`)).data.messages;
  },

  async cancelGeneration(messageId: string): Promise<void> {
    await apiClient.post(`/api/assistant/messages/${messageId}/cancel`, {});
  },

  turnUrl(conversationId: string): string {
    return `/api/assistant/conversations/${conversationId}/messages`;
  },
};
