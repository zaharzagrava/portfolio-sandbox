import { Module } from '@nestjs/common';
import { WebhooksCoreModule } from './webhooks-core.module';
import { WebhookWorkers } from './infra/webhook-workers';

/** SD-30 delivery workers (apps/worker). */
@Module({ imports: [WebhooksCoreModule], providers: [WebhookWorkers], exports: [WebhookWorkers] })
export class WebhooksWorkerModule {}
