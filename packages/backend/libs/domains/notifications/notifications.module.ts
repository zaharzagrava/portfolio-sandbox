import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { NotificationsCoreModule } from './notifications-core.module';
import { NotificationsController } from './api/notifications.controller';
import { NotificationWebhooksController } from './api/notification-webhooks.controller';
import { SnsVerifier } from './api/sns-verifier';
import { DevMailboxController } from './api/dev-mailbox.controller';
import { TransactionalMailModule } from './transactional-mail.module';

/** SD-17 HTTP side (core): inbox, preferences, devices, unsubscribe, provider webhooks. */
@Module({
  imports: [AuthModule, NotificationsCoreModule, TransactionalMailModule],
  providers: [SnsVerifier],
  controllers: [
    NotificationsController,
    NotificationWebhooksController,
    DevMailboxController,
  ],
})
export class NotificationsModule {}
