import { Module } from '@nestjs/common';
import { ProblemCatalogModule } from '@app/common/errors';
import { AuthModule } from '@app/domains/identity';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { NOTIFICATION_PROBLEMS } from './domain/errors';
import { notificationsRatePolicies } from './rate-limit-policies';
import { NotificationsCoreModule } from './notifications-core.module';
import { NotificationsController } from './api/notifications.controller';
import { PreferencesController } from './api/preferences.controller';
import { DevicesController } from './api/devices.controller';
import { UnsubscribeController } from './api/unsubscribe.controller';
import { NotificationWebhooksController } from './api/notification-webhooks.controller';
import { SnsVerifier } from './api/sns-verifier';
import { DevMailboxController } from './api/dev-mailbox.controller';
import { TransactionalMailModule } from './transactional-mail.module';

/** SD-17 HTTP side (core): inbox, preferences, devices, unsubscribe, provider webhooks. */
@Module({
  imports: [
    AuthModule,
    NotificationsCoreModule,
    TransactionalMailModule,
    ProblemCatalogModule.forFeature(NOTIFICATION_PROBLEMS),
    RateLimitModule.forFeature(notificationsRatePolicies),
  ],
  providers: [SnsVerifier],
  controllers: [
    NotificationsController,
    PreferencesController,
    DevicesController,
    UnsubscribeController,
    NotificationWebhooksController,
    DevMailboxController,
  ],
})
export class NotificationsModule {}
