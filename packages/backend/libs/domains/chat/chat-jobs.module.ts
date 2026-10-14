import { Module } from '@nestjs/common';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { ChatCoreModule } from './chat-core.module';
import { ChatJobs } from './infra/chat.jobs';

/**
 * The job handlers (S24 contracts/events.md "Jobs"). The e2e specs load this module and call the handlers directly,
 * so no queue consumer starts in a spec; `apps/worker` gets it through `ChatOfflineWorkerModule`.
 */
@Module({
  imports: [JobsModule, ChatCoreModule],
  providers: [ChatJobs],
  exports: [ChatJobs],
})
export class ChatJobsModule {}
