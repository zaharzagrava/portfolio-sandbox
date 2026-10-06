import { Module } from '@nestjs/common';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { NotificationsCoreModule } from './notifications-core.module';
import { NotificationWorkers } from './infra/notification-workers.service';
import { NOTIFICATION_PROVIDERS } from './infra/notification-providers';

/** SD-17 channel workers (apps/worker): SQS consumers + provider chains. */
@Module({
  imports: [NotificationsCoreModule, RateLimitModule],
  providers: [NotificationWorkers, ...NOTIFICATION_PROVIDERS],
  exports: [NotificationWorkers],
})
export class NotificationsWorkerModule {}
