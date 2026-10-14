import { Inject, Injectable } from '@nestjs/common';
import type { ChatOfflineNotifyBody } from '@marketplace-sandbox/contracts';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import {
  PermanentError,
  TransientError,
} from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ChatMessagePosted } from '../application/events/chat-events';
import { CHAT_OFFLINE_QUEUE } from '../domain/chat.constants';
import { CHAT_SETTINGS } from '../domain/chat-settings.token';
import type { ChatSettings } from '../domain/config';
import {
  PORTS,
  type ChannelRepository,
  type MembershipRepository,
} from '../domain/ports';

/**
 * Step 1 (apps/projector): every posted message, whoever wrote it (Rust or NestJS: it comes from the insert trigger's
 * outbox row), schedules a check for each recipient `offlineCheckDelayS` later through a queue delay. No timers in
 * memory, nothing lost on restart.
 *
 * The identity of a check is `(eventId, recipientId)`, carried in its body. It is not a queue `dedupeId`: that option is
 * for FIFO queues only and this queue is a standard one (L-001). A repeated schedule repeats a delayed check, and the
 * check notifies once per recipient and window, so the repeat costs nothing (`natural` idempotency).
 */
@Injectable()
export class ChatOfflineScheduler implements Projector {
  readonly name = 'chat-offline-scheduler';
  readonly topics = [ChatMessagePosted.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly handles: HandledEvent[] = [{ event: ChatMessagePosted }];

  constructor(
    @Inject(PORTS.ChannelRepository)
    private readonly channels: ChannelRepository,
    @Inject(PORTS.MembershipRepository)
    private readonly members: MembershipRepository,
    @Inject(CHAT_SETTINGS) private readonly settings: ChatSettings,
    private readonly queue: TaskQueue,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const event of events) {
      if (event.type !== ChatMessagePosted.type) continue;
      let posted;
      try {
        posted = ChatMessagePosted.match(event);
      } catch (error) {
        throw new PermanentError(
          `invalid chat.message_posted payload: ${(error as Error).message}`,
        );
      }
      // a version this code does not know can never be applied
      if (!posted)
        throw new PermanentError(
          `unsupported chat.message_posted version ${event.version}`,
        );
      await this.schedule(event.eventId, posted.payload);
    }
  }

  private async schedule(
    eventId: string,
    m: {
      channelId: string;
      messageId: string;
      seq: number;
      authorId: string;
      preview: string;
    },
  ): Promise<void> {
    const channel = await this.channels.findById(m.channelId);
    // a channel that is gone has no one to tell; a big public channel behaves like a forum: no push per message (FR-038)
    if (
      !channel ||
      channel.activeMemberCount > this.settings.hugeChannelThreshold
    )
      return;
    const recipients = await this.members.activeMembers(
      m.channelId,
      m.authorId,
      this.settings.hugeChannelThreshold,
    );
    if (recipients.length === 0) return;
    const { failed } = await this.queue.enqueueBatch<ChatOfflineNotifyBody>(
      CHAT_OFFLINE_QUEUE,
      recipients.map((recipientId) => ({
        body: { eventId, ...m, recipientId },
        options: { delaySeconds: this.settings.offlineCheckDelayS },
      })),
    );
    if (failed.length) {
      throw new TransientError(
        `offline-check enqueue rejected ${failed.length} entries: ${failed[0].reason}`,
      );
    }
  }
}
