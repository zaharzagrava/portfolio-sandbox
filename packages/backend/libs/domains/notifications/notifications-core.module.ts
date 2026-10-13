import { Module, type Provider } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { CassandraModule } from '@app/infrastructure/cassandra/cassandra.module';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { AuthModule } from '@app/domains/identity';
import { TenancyModule } from '@app/domains/tenancy';
import { PreferencesService } from './application/preferences.service';
import { SettingsService } from './application/settings.service';
import { DeviceService } from './application/device.service';
import { UnsubscribeService } from './application/unsubscribe.service';
import { SuppressionService } from './application/suppression.service';
import { CallbackIntakeService } from './application/callback-intake.service';
import { InboxService } from './application/inbox.service';
import { NotificationRouterService } from './application/notification-router.service';
import { EventRoutingService } from './application/event-routing.service';
import { RecipientViewService } from './application/recipient-view.service';
import {
  CALLBACK_QUEUE,
  CAP_STORE,
  CLAIM_STORE,
  COUNTER_STORE,
  DEAD_LETTER_SINK,
  DEDUPE_STORE,
  DELIVERY_LINE_PRODUCER,
  DELIVERY_TIMELINE_STORE,
  DEVICE_REPOSITORY,
  FOLLOWER_AUDIENCE,
  HELD_DELIVERY_STORE,
  INBOX_STORE,
  OTP_STORE,
  PREFERENCE_REPOSITORY,
  REALTIME_NOTIFIER,
  RECIPIENT_DIRECTORY,
  SETTINGS_REPOSITORY,
  SUPPRESSION_REPOSITORY,
  VERSION_GUARD_STORE,
  WAKE_SCHEDULER,
} from './domain/ports';
import NotificationPreference from './infra/models/notification-preference.model';
import NotificationSettings from './infra/models/notification-settings.model';
import NotificationSuppression from './infra/models/notification-suppression.model';
import PushDevice from './infra/models/push-device.model';
import { PgDeviceRepository } from './infra/repositories/device.repository';
import { PgPreferenceRepository } from './infra/repositories/preference.repository';
import { PgSettingsRepository } from './infra/repositories/settings.repository';
import { PgSuppressionRepository } from './infra/repositories/suppression.repository';
import { CassandraInboxStore } from './infra/inbox.store';
import { CassandraDeliveryTimelineStore } from './infra/delivery-timeline.store';
import {
  RedisCapStore,
  RedisClaimStore,
  RedisCounterStore,
  RedisDeadLetterSink,
  RedisDedupeStore,
  RedisHeldDeliveryStore,
  RedisOtpStore,
  RedisVersionGuardStore,
} from './infra/redis-stores';
import { RecipientDirectoryAdapter } from './infra/recipient-directory.adapter';
import { FollowerAudienceAdapter } from './infra/follower-audience.adapter';
import { RealtimeNotifierAdapter } from './infra/realtime.adapter';
import { SqsDeliveryLineProducer } from './infra/delivery-line.producer';
import { JobsWakeScheduler } from './infra/wake-scheduler';
import { SqsCallbackQueue } from './infra/callback-queue';

/** The ports of `domain/ports.ts` bound to their adapters. */
const PORTS: Array<{
  provide: symbol;
  useClass: new (...args: never[]) => unknown;
}> = [
  { provide: PREFERENCE_REPOSITORY, useClass: PgPreferenceRepository },
  { provide: SETTINGS_REPOSITORY, useClass: PgSettingsRepository },
  { provide: DEVICE_REPOSITORY, useClass: PgDeviceRepository },
  { provide: SUPPRESSION_REPOSITORY, useClass: PgSuppressionRepository },
  { provide: INBOX_STORE, useClass: CassandraInboxStore },
  {
    provide: DELIVERY_TIMELINE_STORE,
    useClass: CassandraDeliveryTimelineStore,
  },
  { provide: COUNTER_STORE, useClass: RedisCounterStore },
  { provide: CAP_STORE, useClass: RedisCapStore },
  { provide: DEDUPE_STORE, useClass: RedisDedupeStore },
  { provide: VERSION_GUARD_STORE, useClass: RedisVersionGuardStore },
  { provide: CLAIM_STORE, useClass: RedisClaimStore },
  { provide: OTP_STORE, useClass: RedisOtpStore },
  { provide: RECIPIENT_DIRECTORY, useClass: RecipientDirectoryAdapter },
  { provide: FOLLOWER_AUDIENCE, useClass: FollowerAudienceAdapter },
  { provide: REALTIME_NOTIFIER, useClass: RealtimeNotifierAdapter },
  { provide: DELIVERY_LINE_PRODUCER, useClass: SqsDeliveryLineProducer },
  { provide: CALLBACK_QUEUE, useClass: SqsCallbackQueue },
  { provide: DEAD_LETTER_SINK, useClass: RedisDeadLetterSink },
  { provide: HELD_DELIVERY_STORE, useClass: RedisHeldDeliveryStore },
  { provide: WAKE_SCHEDULER, useClass: JobsWakeScheduler },
];
const PORT_PROVIDERS: Provider[] = PORTS;

/**
 * Shared SD-17 services (core HTTP, projector, worker channels) and the ports of S28 with their adapters. Needs the
 * app's global Redis. Internal: the public entry point exports only the three app modules (X.4).
 */
@Module({
  imports: [
    SequelizeModule.forFeature([
      NotificationPreference,
      NotificationSettings,
      NotificationSuppression,
      PushDevice,
    ]),
    CassandraModule,
    RealtimeModule,
    CacheModule,
    SqsModule,
    JobsModule,
    AuthModule,
    TenancyModule,
  ],
  providers: [
    ...PORT_PROVIDERS,
    PreferencesService,
    SettingsService,
    DeviceService,
    UnsubscribeService,
    SuppressionService,
    CallbackIntakeService,
    InboxService,
    RecipientViewService,
    NotificationRouterService,
    EventRoutingService,
  ],
  exports: [
    ...PORTS.map((p) => p.provide),
    PreferencesService,
    SettingsService,
    DeviceService,
    UnsubscribeService,
    SuppressionService,
    CallbackIntakeService,
    InboxService,
    RecipientViewService,
    NotificationRouterService,
    EventRoutingService,
  ],
})
export class NotificationsCoreModule {}
