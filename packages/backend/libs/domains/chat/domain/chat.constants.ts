/**
 * Redis pub/sub topology shared with the Rust chat-gateway
 * (packages/hft-platform/src/redis_bus.rs). Keep these in sync manually -
 * there's no shared package between the two runtimes.
 *
 * - `chat:channel:{channelId}` - per-channel event bus. The gateway
 *   subscribes to it only while it has at least one local connection
 *   subscribed to that channel (ref-counted), and publishes new messages to
 *   it itself. NestJS publishes to it too, for events it originates
 *   (message moderation deletes, channel archival).
 * - `chat:moderation` - global control bus, low volume. Every gateway
 *   instance subscribes for the lifetime of the process so bans/mutes take
 *   effect immediately even for channels it has no local subscribers for
 *   yet.
 */
export const chatChannelRedisTopic = (channelId: string): string =>
  `chat:channel:${channelId}`;

export const CHAT_MODERATION_REDIS_TOPIC = 'chat:moderation';

export enum ChatModerationEventType {
  BAN = 'ban',
  UNBAN = 'unban',
  MUTE = 'mute',
  UNMUTE = 'unmute',
  PROMOTE = 'promote',
  DEMOTE = 'demote',
}

export interface ChatModerationEvent {
  type: ChatModerationEventType;
  channelId: string;
  userId: string;
  mutedUntil?: string;
}

export enum ChatChannelEventType {
  MESSAGE_DELETED = 'message_deleted',
  CHANNEL_ARCHIVED = 'channel_archived',
}

export interface ChatChannelEvent {
  type: ChatChannelEventType;
  channelId: string;
  messageId?: string;
}

/** Claim `typ` distinguishing short-lived WS tickets from normal access JWTs. */
export const CHAT_WS_TICKET_TYPE = 'ws';
export const CHAT_WS_TICKET_TTL_SECONDS = 60;
