import { Inject, Injectable } from '@nestjs/common';
import type { ChatReceipts, ChatUnreadPage } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  chatPushFailedCounter,
  chatReceiptsSuppressedCounter,
} from '../domain/chat-metrics';
import { CHAT_SETTINGS } from '../domain/chat-settings.token';
import type { ChatSettings } from '../domain/config';
import { channelNotFound, ChatValidationError } from '../domain/errors';
import {
  decodeUnreadCursor,
  encodeUnreadCursor,
} from '../domain/history-cursor';
import { advanceReadPosition, unreadCount } from '../domain/read-position';
import {
  PORTS,
  type ChannelRepository,
  type ReadStateRepository,
  type RealtimeHub,
} from '../domain/ports';

/** Unread counts and read receipts (S24 US4). */
@Injectable()
export class ChatReadStateService {
  constructor(
    @Inject(PORTS.ReadStateRepository)
    private readonly state: ReadStateRepository,
    @Inject(PORTS.ChannelRepository)
    private readonly channels: ChannelRepository,
    @Inject(PORTS.RealtimeHub) private readonly hub: RealtimeHub,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CHAT_SETTINGS) private readonly settings: ChatSettings,
  ) {}

  /**
   * The caller's channels by most recent activity, with unread counts (never counting their own messages: posting
   * advances the author's position). Keyset pages; archived channels and channels the caller is banned from are not
   * listed.
   */
  async unread(
    userId: string,
    query: { limit: number; cursor?: string },
  ): Promise<ChatUnreadPage> {
    let after: { at: string; channelId: string } | null = null;
    if (query.cursor !== undefined) {
      after = decodeUnreadCursor(query.cursor);
      if (!after) throw new ChatValidationError(['cursor']);
    }
    const rows = await this.state.unreadPage(userId, query.limit + 1, after);
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items: items.map(({ channelId, unread, lastSeq }) => ({
        channelId,
        unread,
        lastSeq,
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeUnreadCursor(last.activityAt, last.channelId)
          : null,
    };
  }

  /**
   * Where the other members have read up to ("Seen by"). Members only (a stranger gets the unknown-channel answer); in a
   * channel above the huge-channel threshold nothing is listed, as nothing is published (G-22).
   */
  async receipts(
    userId: string,
    channelId: string,
  ): Promise<ChatReceipts> {
    const found = await this.channels.findForMember(channelId, userId);
    if (!found) throw channelNotFound();
    if (found.channel.activeMemberCount > this.settings.hugeChannelThreshold)
      return { items: [], suppressed: true };
    return { items: await this.state.receipts(channelId), suppressed: false };
  }

  /**
   * Monotonic and capped at the channel's last sequence. An advance, and only an advance, publishes `read {userId, seq}`
   * after the commit; a hub that is down never fails the call (it is counted); channels with more than the huge-channel
   * threshold of active members publish nothing (G-22, G-23).
   */
  async markRead(
    userId: string,
    channelId: string,
    seq: number,
  ): Promise<{ lastReadSeq: number; unread: number }> {
    const position = await this.state.advance(
      channelId,
      userId,
      seq,
      this.clock.now(),
    );
    if (!position) throw channelNotFound();
    const lastReadSeq = advanceReadPosition(
      position.lastReadSeq,
      position.lastReadSeq,
      position.lastSeq,
    );
    if (position.advanced) {
      if (position.activeMemberCount > this.settings.hugeChannelThreshold) {
        chatReceiptsSuppressedCounter.add(1, { kind: 'receipt' });
      } else if (
        !(await this.hub.publish(channelId, 'read', {
          userId,
          seq: lastReadSeq,
        }))
      ) {
        chatPushFailedCounter.add(1, { kind: 'receipt' });
      }
    }
    return { lastReadSeq, unread: unreadCount(position.lastSeq, lastReadSeq) };
  }
}
