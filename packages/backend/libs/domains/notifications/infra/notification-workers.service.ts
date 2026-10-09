import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  TaskQueue,
  TaskMessage,
} from '@app/infrastructure/sqs/task-queue.port';
import { RateLimiterService } from '@app/infrastructure/rate-limit/rate-limiter.service';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { SuppressionService } from '../application/suppression.service';
import { DeliveryLogService } from './delivery-log.service';
import { NotificationPreferencesService } from '../application/preferences.service';
import { ChannelSender } from './providers/channel-sender';
import {
  EMAIL_PROVIDERS,
  PUSH_PROVIDERS,
  SMS_PROVIDERS,
  ChannelProvider,
} from '../domain/provider-ports';
import {
  DeliveryMessage,
  NOTIFICATION_QUEUES,
  PermanentDeliveryError,
} from '../domain/types';

const sentKey = (deliveryId: string) => `notif:sent:${deliveryId}`;

/**
 * SQS consumers, one per channel queue + the marketing queue (drained with low
 * concurrency so a 20k/s campaign never starves "your order shipped").
 * Scale signal: queue depth (ASG / Lambda event source mapping).
 *
 * Per message: dedupe → suppression → provider rate limit → send with
 * failover → record. Transient failures throw → SQS redelivers after the
 * visibility timeout → DLQ after maxReceiveCount.
 */
@Injectable()
export class NotificationWorkers
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationWorkers.name);
  private readonly senders: Record<DeliveryMessage['channel'], ChannelSender>;
  private stops: (() => Promise<void>)[] = [];

  constructor(
    private readonly queue: TaskQueue,
    private readonly redis: RedisService,
    private readonly rateLimiter: RateLimiterService,
    private readonly suppression: SuppressionService,
    private readonly deliveryLog: DeliveryLogService,
    private readonly preferences: NotificationPreferencesService,
    @Inject(EMAIL_PROVIDERS) email: ChannelProvider[],
    @Inject(SMS_PROVIDERS) sms: ChannelProvider[],
    @Inject(PUSH_PROVIDERS) push: ChannelProvider[],
  ) {
    this.senders = {
      email: new ChannelSender(email),
      sms: new ChannelSender(sms),
      push: new ChannelSender(push),
    };
  }

  onApplicationBootstrap() {
    const consume = (queue: string, concurrency: number) =>
      this.queue.consume<DeliveryMessage>(
        queue,
        (msg) => this.process(queue, msg),
        { concurrency, visibilityTimeoutSec: 60 },
      );
    this.stops = [
      consume(NOTIFICATION_QUEUES.email, 20),
      consume(NOTIFICATION_QUEUES.sms, 10),
      consume(NOTIFICATION_QUEUES.push, 50),
      consume(NOTIFICATION_QUEUES.marketing, 5),
    ];
  }

  async onModuleDestroy() {
    await Promise.all(this.stops.map((stop) => stop()));
  }

  async process(
    queue: string,
    { body: m }: Pick<TaskMessage<DeliveryMessage>, 'body'>,
  ): Promise<void> {
    if (await this.redis.client.exists(sentKey(m.deliveryId))) return;
    const log = {
      deliveryId: m.deliveryId,
      userId: m.userId,
      channel: m.channel,
      type: m.type,
    };

    const to: string[] = [];
    for (const address of m.to)
      if (!(await this.suppression.isSuppressed(m.channel, address)))
        to.push(address);
    if (to.length === 0) {
      await this.deliveryLog.record({ ...log, status: 'suppressed' });
      return;
    }

    const decision = await this.rateLimiter.check(
      `notify.${m.channel}`,
      'provider',
    );
    if (!decision.allowed) {
      // Over the provider's send rate: put it back with a delay instead of burning a receive (and a DLQ strike).
      await this.queue.enqueue(queue, m, {
        delaySeconds: Math.min(
          Math.ceil(decision.retryAfterMs / 1000) || 1,
          900,
        ),
      });
      return;
    }

    try {
      const result = await this.senders[m.channel].send({ ...m, to });
      if (result.invalidTokens?.length)
        await this.preferences.removeDevices(result.invalidTokens);
      await this.redis.client.set(sentKey(m.deliveryId), '1', 'EX', 7 * 86_400);
      await this.deliveryLog.record({
        ...log,
        status: 'sent',
        provider: result.provider,
        providerMessageId: result.providerMessageId,
      });
    } catch (error) {
      if (error instanceof PermanentDeliveryError) {
        if (m.channel === 'push')
          await this.preferences.removeDevices(error.suppress);
        else if (error.suppress.length)
          await this.suppression.suppress(
            m.channel,
            error.suppress,
            'provider-permanent',
          );
        await this.deliveryLog.record({
          ...log,
          status: 'failed',
          detail: error.message,
        });
        return;
      }
      this.logger.warn(
        `${m.channel} delivery ${m.deliveryId} failed, will retry: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /** Quiet-hours delays beyond SQS's 15 minutes come back through the job scheduler. */
  @JobHandler('notifications.deliver', { concurrency: 20 })
  async deliverLater({
    queue,
    message,
  }: {
    queue: string;
    message: DeliveryMessage;
  }) {
    await this.queue.enqueue(queue, message);
  }
}
