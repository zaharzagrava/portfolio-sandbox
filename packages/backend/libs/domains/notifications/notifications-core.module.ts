import { Module } from '@nestjs/common';
import { CassandraModule } from '@app/infrastructure/cassandra/cassandra.module';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { NotificationPreferencesService } from './application/preferences.service';
import { SuppressionService } from './application/suppression.service';
import { DeliveryLogService } from './infra/delivery-log.service';
import { InboxService } from './application/inbox.service';
import { NotificationRouter } from './application/notification-router.service';

/** Shared SD-17 services (core HTTP, projector router, worker channels). Needs the app's global Redis. */
@Module({
  imports: [
    CassandraModule,
    RealtimeModule,
    CacheModule,
    SqsModule,
    JobsModule,
  ],
  providers: [
    NotificationPreferencesService,
    SuppressionService,
    DeliveryLogService,
    InboxService,
    NotificationRouter,
  ],
  exports: [
    NotificationPreferencesService,
    SuppressionService,
    DeliveryLogService,
    InboxService,
    NotificationRouter,
  ],
})
export class NotificationsCoreModule {}
