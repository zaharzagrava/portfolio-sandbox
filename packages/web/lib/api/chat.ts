import { apiClient } from './client';

/**
 * Product chat (SD-14) over HTTP: send with a client-generated id (retries are idempotent), and catch up with
 * per-channel `seq` cursors via /chat/sync - the same path an offline phone uses when it reconnects.
 * (The low-latency WebSocket path is the separate Rust gateway, not part of the local stack.)
 */
export interface ChatChannel {
  id: string;
  productId: string;
  sellerId: string;
  title: string;
  isArchived: boolean;
  myRole?: 'OWNER' | 'MODERATOR' | 'MEMBER';
}

export interface ChatMessage {
  id: string;
  seq: number;
  authorId: string;
  body: string | null;
  createdAt: string;
  deleted: boolean;
}

export interface ChannelSync {
  channelId: string;
  messages: ChatMessage[];
  lastSeq: number;
  hasMore: boolean;
}

/** Adds new messages, replaces re-delivered ones (same id), keeps `seq` order. */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

export const chatApi = {
  myChannels: async (): Promise<{ channelId: string; unread: number; lastSeq: number }[]> => (await apiClient.get('/api/chat/unread')).data,
  channel: async (channelId: string): Promise<ChatChannel> => (await apiClient.get(`/api/chat/channels/${channelId}`)).data,
  byProduct: async (productId: string): Promise<ChatChannel> => (await apiClient.get(`/api/chat/channels/by-product/${productId}`)).data,
  create: async (productId: string): Promise<ChatChannel> => (await apiClient.post('/api/chat/channels', { productId })).data,
  join: async (channelId: string): Promise<ChatChannel> => (await apiClient.post(`/api/chat/channels/${channelId}/join`, {})).data,
  sync: async (cursors: Record<string, number>): Promise<ChannelSync[]> => (await apiClient.post('/api/chat/sync', { cursors })).data,
  send: async (channelId: string, body: string): Promise<{ message: ChatMessage }> =>
    (await apiClient.post(`/api/chat/channels/${channelId}/messages`, { clientMessageId: crypto.randomUUID(), body })).data,
  markRead: async (channelId: string, seq: number): Promise<void> => {
    await apiClient.post(`/api/chat/channels/${channelId}/read`, { seq });
  },
};
