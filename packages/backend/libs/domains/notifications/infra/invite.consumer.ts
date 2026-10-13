import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { EventRoutingService } from '../application/event-routing.service';
import { INVITE_REQUESTED_QUEUE } from './notifications.topics';

/**
 * The single consumer of queue `tenancy-invite-requested` (S03, research R-2): one message per invitation, carrying
 * the invite token. It goes through the same validation, dead-letter and dedupe path as an event, but nothing of its
 * body is logged or kept (FR-014). A failure rethrows so the queue redelivers it (dead-lettered by the queue after the
 * fifth receive).
 */
@Injectable()
export class InviteRequestedConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private stop: (() => Promise<void>) | null = null;

  constructor(
    private readonly queue: TaskQueue,
    private readonly routing: EventRoutingService,
  ) {}

  onApplicationBootstrap(): void {
    this.stop = this.queue.consume<unknown>(
      INVITE_REQUESTED_QUEUE,
      (message) => this.handle(message.id, message.body),
      { concurrency: 5, visibilityTimeoutSec: 5 },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop?.();
  }

  handle(messageId: string, body: unknown): Promise<void> {
    return this.routing.consumeInvite(messageId, body);
  }
}
