import type { ChatChannel, ChatMessage } from '@marketplace-sandbox/contracts';
import type { ChannelRecord, MessageRecord } from '../domain/ports';

/** The wire shape of a channel; `myRole` is the caller's active role or null. */
export function toChannelView(
  channel: ChannelRecord,
  myRole: ChatChannel['myRole'],
): ChatChannel {
  return {
    id: channel.id,
    productId: channel.productId,
    shopId: channel.shopId,
    sellerId: channel.sellerId,
    title: channel.title,
    isArchived: channel.isArchived,
    archivedAt: channel.archivedAt ? channel.archivedAt.toISOString() : null,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
    myRole,
  };
}

/** A stored message as clients see it: a deleted one is a tombstone that keeps its sequence and has no body. */
export function toMessageView(message: MessageRecord): ChatMessage {
  const deleted = message.deletedAt !== null;
  return {
    id: message.id,
    seq: message.seq,
    authorId: message.authorId,
    body: deleted ? null : message.body,
    replyToId: message.replyToId,
    createdAt: message.createdAt.toISOString(),
    deleted,
  };
}
