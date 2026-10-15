import { Module } from '@nestjs/common';
import { WebhooksCoreModule } from './webhooks-core.module';
import { WebhookWorkers } from './infra/webhook-workers';

/** The delivery worker (apps/worker): the FIFO consumer and the retry job. */
@Module({
  imports: [WebhooksCoreModule],
  providers: [WebhookWorkers],
  exports: [WebhookWorkers],
})
export class WebhooksWorkerModule {}
