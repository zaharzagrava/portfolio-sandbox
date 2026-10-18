import {
  chatChannelSchema,
  chatChannelSyncSchema,
  chatInboxPageSchema,
  chatMarkReadResponseSchema,
  chatMessagePageSchema,
  chatReceiptsSchema,
  chatUnreadPageSchema,
  presenceResponseSchema,
  sendMessageResponseSchema,
  type ChatChannel,
  type ChatChannelSync,
  type ChatInboxPage,
  type ChatMessagePage,
  type ChatReceipts,
  type ChatUnreadPage,
  type PresenceResponse,
  type SendMessageResponse,
} from '@marketplace-sandbox/contracts';
import { z } from 'zod';
import { apiClient } from './client';
import { problemFromError, type Problem } from './errors';
import { parseBody } from './parse';

/**
 * Product chat over HTTP (S24; W05 FR-072). Same-origin relative URLs, the session cookie travels by itself and the shared
 * client adds the CSRF proof on every write (W01); there is no token and no credential header of our own. Every body is parsed
 * with its `packages/contracts` schema (a mismatch is the unexpected error of FR-062). Lists are pages `{ items, nextCursor }`.
 * `send` never creates the `clientMessageId`: the caller makes one per user action and reuses it on every retry (FR-026).
 */

const BASE = '/api/chat';

/** The problem of a failed chat call: W01's `Problem` plus the chat extension members read from the raw body (gap M7). */
export type ChatProblem = Problem & {
  /** `403 muted`: when the mute ends (an ISO instant). */
  mutedUntil?: string;
};

const extensionSchema = z.object({ mutedUntil: z.string().min(1).optional() });

export function chatProblem(error: unknown): ChatProblem {
  const problem = problemFromError(error);
  const data = (error as { response?: { data?: unknown } } | null)?.response?.data;
  const extension = extensionSchema.safeParse(data && typeof data === 'object' ? { mutedUntil: (data as Record<string, unknown>).mutedUntil } : {});
  return extension.success && extension.data.mutedUntil ? { ...problem, mutedUntil: extension.data.mutedUntil } : problem;
}

type PageParams = { limit?: number; cursor?: string };
const pageQuery = ({ limit, cursor }: PageParams) => ({ ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) });

export const chatApi = {
  /** `GET /chat/channels/mine`: the member's chats with `unread`, `lastSeq`, `lastMessageAt` in one call (FR-010). */
  async inbox(params: PageParams = {}): Promise<ChatInboxPage> {
    const { data } = await apiClient.get<unknown>(`${BASE}/channels/mine`, { params: pageQuery(params) });
    return parseBody(chatInboxPageSchema, data);
  },

  /** `GET /chat/unread`: per-chat unread counts (the inbox already carries them; kept for the fallback). */
  async unreadPage(params: PageParams = {}): Promise<ChatUnreadPage> {
    const { data } = await apiClient.get<unknown>(`${BASE}/unread`, { params: pageQuery(params) });
    return parseBody(chatUnreadPageSchema, data);
  },

  async channel(channelId: string): Promise<ChatChannel> {
    const { data } = await apiClient.get<unknown>(`${BASE}/channels/${encodeURIComponent(channelId)}`);
    return parseBody(chatChannelSchema, data);
  },

  /** The chat of a product; `myRole` is null for a visitor who has not joined. `404 channel_not_found` when there is none. */
  async byProduct(productId: string): Promise<ChatChannel> {
    const { data } = await apiClient.get<unknown>(`${BASE}/channels/by-product/${encodeURIComponent(productId)}`);
    return parseBody(chatChannelSchema, data);
  },

  /** Shop staff open the chat of a product (the explicit button of AS-04). */
  async create(productId: string): Promise<ChatChannel> {
    const { data } = await apiClient.post<unknown>(`${BASE}/channels`, { productId });
    return parseBody(chatChannelSchema, data);
  },

  async join(channelId: string): Promise<ChatChannel> {
    const { data } = await apiClient.post<unknown>(`${BASE}/channels/${encodeURIComponent(channelId)}/join`, {});
    return parseBody(chatChannelSchema, data);
  },

  /** A history page, newest first; `cursor` is the previous page's `nextCursor`. */
  async history(channelId: string, params: PageParams = {}): Promise<ChatMessagePage> {
    const { data } = await apiClient.get<unknown>(`${BASE}/channels/${encodeURIComponent(channelId)}/messages`, { params: pageQuery(params) });
    return parseBody(chatMessagePageSchema, data);
  },

  /** `201` for a new message, `200 duplicate: true` for a replay of the same `clientMessageId`. */
  async send(request: { channelId: string; clientMessageId: string; body: string; replyToId?: string | null }): Promise<SendMessageResponse> {
    const { channelId, clientMessageId, body, replyToId } = request;
    const { data } = await apiClient.post<unknown>(`${BASE}/channels/${encodeURIComponent(channelId)}/messages`, {
      clientMessageId,
      body,
      ...(replyToId ? { replyToId } : {}),
    });
    return parseBody(sendMessageResponseSchema, data);
  },

  /** `POST /chat/sync`: one result per cursor; `hasMore` means call again from `lastSeq`. */
  async sync(cursors: Record<string, number>): Promise<ChatChannelSync[]> {
    const { data } = await apiClient.post<unknown>(`${BASE}/sync`, { cursors });
    return parseBody(z.array(chatChannelSyncSchema), data);
  },

  /** The response carries the new `unread`: the badge is set from it, never guessed (FR-031). */
  async markRead(channelId: string, seq: number): Promise<{ lastReadSeq: number; unread: number }> {
    const { data } = await apiClient.post<unknown>(`${BASE}/channels/${encodeURIComponent(channelId)}/read`, { seq });
    return parseBody(chatMarkReadResponseSchema, data);
  },

  /** `204`; a message that is already gone answers `404 message_not_found`, which the caller treats as done. */
  async remove(channelId: string, messageId: string): Promise<void> {
    await apiClient.delete(`${BASE}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`);
  },

  async receipts(channelId: string): Promise<ChatReceipts> {
    const { data } = await apiClient.get<unknown>(`${BASE}/channels/${encodeURIComponent(channelId)}/receipts`);
    return parseBody(chatReceiptsSchema, data);
  },

  /** `204`; best effort, a failure never shows (AS-35). */
  async heartbeat(): Promise<void> {
    await apiClient.post(`${BASE}/presence/heartbeat`, {});
  },

  async presence(userIds: string[]): Promise<PresenceResponse> {
    const { data } = await apiClient.get<unknown>(`${BASE}/presence`, { params: { userIds: userIds.join(',') } });
    return parseBody(presenceResponseSchema, data);
  },
};
