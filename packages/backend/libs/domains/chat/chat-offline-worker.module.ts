import { Module } from '@nestjs/common';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { ChatJobsModule } from './chat-jobs.module';
import { ChatOfflineModule } from './chat-offline.module';
import { ChatOfflineWorker } from './infra/chat-offline.worker';

/**
 * Background side (apps/worker): the partition job, and the consumer of the delayed offline checks. An unread message
 * for an offline recipient becomes the event `chat.message_escalated` (S28 notifies; chat never calls it).
 */
@Module({
  imports: [ChatJobsModule, ChatOfflineModule, SqsModule],
  providers: [ChatOfflineWorker],
})
export class ChatOfflineWorkerModule {}
