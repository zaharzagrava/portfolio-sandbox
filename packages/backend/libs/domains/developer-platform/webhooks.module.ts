import { AuthModule } from '@app/domains/identity';
import { Module } from '@nestjs/common';
import { WebhooksCoreModule } from './webhooks-core.module';
import { WebhooksController } from './api/webhooks.controller';

/** SD-30 dashboard (core). */
@Module({
  imports: [AuthModule, WebhooksCoreModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
