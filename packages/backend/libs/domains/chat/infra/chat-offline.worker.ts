import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  chatOfflineNotifyBodySchema,
  type ChatOfflineNotifyBody,
} from '@marketplace-sandbox/contracts';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ChatOfflineCheckService } from '../application/chat-offline-check.service';
import { CHAT_OFFLINE_QUEUE } from '../domain/chat.constants';

/**
 * Step 2 (apps/worker): the queue consumer. A body that does not parse goes to the dead-letter queue at once; a check
 * that throws (the outbox refused) is retried by the queue with its visibility timeout, and dead-lettered after the
 * queue's max receive count (5; `elasticmq.conf`, the stack). The consumer never blocks the queue.
 */
@Injectable()
export class ChatOfflineWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private stop?: () => Promise<void>;

  constructor(
    private readonly queue: TaskQueue,
    private readonly check: ChatOfflineCheckService,
  ) {}

  onApplicationBootstrap(): void {
    this.stop = this.queue.consume<ChatOfflineNotifyBody>(
      CHAT_OFFLINE_QUEUE,
      async (msg) => void (await this.check.run(msg.body)),
      { concurrency: 20, bodySchema: chatOfflineNotifyBodySchema },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop?.();
  }
}
