import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { TaskQueue, TaskMessage } from '@app/infrastructure/sqs/task-queue.port';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { NotificationRouter } from '@app/domains/notifications';
import { ChatMessagePosted } from '../application/events/chat-events';
import { ChatSyncService } from '../application/chat-sync.service';

export const CHAT_OFFLINE_QUEUE = 'chat-offline-notify';
const GRACE_SEC = 30;
/** Big public product channels behave like forums: no per-message push to everyone. */
const MAX_RECIPIENTS = 50;
const COALESCE_SEC = 300;

interface OfflineCheck {
  channelId: string;
  messageId: string;
  seq: number;
  authorId: string;
  recipientId: string;
  preview: string;
}

/**
 * Step 1 (apps/projector): every posted message (Rust or NestJS - it comes from
 * the INSERT trigger's outbox row) schedules a check for each recipient
 * 30 s later via an SQS delay. No timers in memory, nothing lost on restart.
 */
@Injectable()
export class ChatOfflineScheduler implements Projector {
  readonly name = 'chat-offline-scheduler';
  readonly topics = [ChatMessagePosted.topic];

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly queue: TaskQueue,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const posted = events.map((e) => ChatMessagePosted.match(e)).filter((e): e is NonNullable<typeof e> => !!e);
    for (const { payload: m } of posted) {
      const recipients = await this.sequelize.query<{ userId: string }>(
        `SELECT "userId" FROM "ChatChannelMember" WHERE "channelId" = :channelId AND status = 'ACTIVE' AND "userId" <> :authorId LIMIT :limit`,
        { type: QueryTypes.SELECT, replacements: { channelId: m.channelId, authorId: m.authorId, limit: MAX_RECIPIENTS + 1 } },
      );
      if (recipients.length > MAX_RECIPIENTS) continue;
      await this.queue.enqueueBatch<OfflineCheck>(
        CHAT_OFFLINE_QUEUE,
        recipients.map(({ userId }) => ({ body: { ...m, recipientId: userId }, options: { delaySeconds: GRACE_SEC } })),
      );
    }
  }
}

/**
 * Step 2 (apps/worker): after the grace period, notify only if the recipient
 * still hasn't read up to this seq AND isn't online (an online user saw it in
 * the open chat). Coalesced to one push per (recipient, channel) per 5 min -
 * a 20-message burst is one notification, not twenty.
 */
@Injectable()
export class ChatOfflineWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ChatOfflineWorker.name);
  private stop?: () => Promise<void>;

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly queue: TaskQueue,
    private readonly redis: RedisService,
    private readonly chat: ChatSyncService,
    private readonly router: NotificationRouter,
  ) {}

  onApplicationBootstrap() {
    this.stop = this.queue.consume<OfflineCheck>(CHAT_OFFLINE_QUEUE, async (msg) => void (await this.check(msg)), { concurrency: 20 });
  }

  async onModuleDestroy() {
    await this.stop?.();
  }

  async check({ body: m }: Pick<TaskMessage<OfflineCheck>, 'body'>): Promise<'notified' | 'read' | 'online' | 'coalesced'> {
    const [state] = await this.sequelize.query<{ lastReadSeq: number; title: string; sender: string }>(
      `SELECT mem."lastReadSeq"::int AS "lastReadSeq", c.title, split_part(u.email, '@', 1) AS sender
       FROM "ChatChannelMember" mem JOIN "ChatChannel" c ON c.id = mem."channelId" JOIN "User" u ON u.id = :authorId
       WHERE mem."channelId" = :channelId AND mem."userId" = :recipientId`,
      { type: QueryTypes.SELECT, replacements: { channelId: m.channelId, recipientId: m.recipientId, authorId: m.authorId } },
    );
    if (!state || state.lastReadSeq >= m.seq) return 'read';
    if (await this.chat.isOnline(m.recipientId)) return 'online';
    if (!(await this.redis.client.set(`chat:notified:{${m.recipientId}}:${m.channelId}`, '1', 'EX', COALESCE_SEC, 'NX'))) return 'coalesced';

    await this.router.dispatch([
      {
        type: 'chat.message',
        userId: m.recipientId,
        dedupeKey: `chat:${m.messageId}`,
        data: { sender: state.sender, preview: m.preview, channelId: m.channelId, channelTitle: state.title },
      },
    ]);
    return 'notified';
  }
}
