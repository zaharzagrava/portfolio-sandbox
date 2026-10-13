import { Module } from '@nestjs/common';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { notificationsRatePolicies } from './rate-limit-policies';
import { NotificationsCoreModule } from './notifications-core.module';
import { DeliveryWorkerService } from './application/delivery-worker.service';
import { WakeDeliveryService } from './application/wake-delivery.service';
import { UnreadReconcileService } from './application/unread-reconcile.service';
import { CallbackWorkerService } from './application/callback-worker.service';
import { CallbackWorkers } from './infra/callback-queue';
import { NotificationWorkers } from './infra/notification-workers.service';
import { NOTIFICATION_PROVIDERS } from './infra/notification-providers';

/** SD-17 channel workers (apps/worker): SQS consumers + provider chains. */
@Module({
  imports: [
    NotificationsCoreModule,
    RateLimitModule.forFeature(notificationsRatePolicies),
  ],
  providers: [
    DeliveryWorkerService,
    NotificationWorkers,
    CallbackWorkerService,
    CallbackWorkers,
    WakeDeliveryService,
    UnreadReconcileService,
    ...NOTIFICATION_PROVIDERS,
  ],
  exports: [NotificationWorkers],
})
export class NotificationsWorkerModule {}
