import type { Provider } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { DEFAULT_QUEUE_MAX_LENGTH } from '@app/common/config/launch-events-config';
import { AdmissionService } from './application/admission.service';
import { BookingQueryService } from './application/booking-query.service';
import { ConfirmService } from './application/confirm.service';
import { EventGateService } from './application/event-gate.service';
import { HoldLifecycleService } from './application/hold-lifecycle.service';
import { HoldService } from './application/hold.service';
import { LaunchEventOutbox } from './application/launch-event-outbox';
import { LaunchEventService } from './application/launch-event.service';
import { LaunchLimits } from './application/launch-limits';
import { ReconcileService } from './application/reconcile.service';
import { SeatMapService } from './application/seat-map.service';
import { WaitingRoomService } from './application/waiting-room.service';
import {
  ADMISSION_TOKEN_PORT,
  BOOKING_REPOSITORY,
  EVENT_GATE,
  EVENT_REPOSITORY,
  HOLD_LEDGER,
  HUMAN_VERIFIER,
  LAUNCH_EVENTS_CONFIG,
  LAUNCH_RANDOM,
  QUEUE_STORE,
  QUOTA_STORE,
  SEAT_LOCK_STORE,
  SEAT_MAP_STORE,
  type LaunchEventsSettings,
} from './domain/ports';
import { PurposeAdmissionTokens } from './infra/admission-token.adapter';
import { DynamoHoldLedger } from './infra/dynamo-hold.ledger';
import { HttpHumanVerifier } from './infra/human-verifier.adapter';
import { RedisEventGate } from './infra/redis/redis-event-gate';
import { RedisQuotaStore } from './infra/redis/redis-quota.store';
import { RedisQueueStore } from './infra/redis/redis-queue.store';
import { RedisSeatLockStore } from './infra/redis/redis-seat-lock.store';
import { RedisSeatMapStore } from './infra/redis/redis-seat-map.store';
import { SequelizeBookingRepository } from './infra/sequelize-booking.repository';
import { SequelizeEventRepository } from './infra/sequelize-event.repository';

/** The adapters of the ports (D-6): the application layer injects the tokens, never these classes. */
export const LAUNCH_ADAPTERS: Provider[] = [
  { provide: EVENT_REPOSITORY, useClass: SequelizeEventRepository },
  { provide: BOOKING_REPOSITORY, useClass: SequelizeBookingRepository },
  { provide: HOLD_LEDGER, useClass: DynamoHoldLedger },
  { provide: SEAT_LOCK_STORE, useClass: RedisSeatLockStore },
  { provide: SEAT_MAP_STORE, useClass: RedisSeatMapStore },
  { provide: QUOTA_STORE, useClass: RedisQuotaStore },
  { provide: EVENT_GATE, useClass: RedisEventGate },
  { provide: QUEUE_STORE, useClass: RedisQueueStore },
  { provide: HUMAN_VERIFIER, useClass: HttpHumanVerifier },
  { provide: ADMISSION_TOKEN_PORT, useClass: PurposeAdmissionTokens },
  { provide: LAUNCH_RANDOM, useValue: Math.random },
  {
    provide: LAUNCH_EVENTS_CONFIG,
    inject: [ApiConfigService],
    // Validated at start (a value outside 1 … 50,000,000 fails the config schema); unset takes the default.
    useFactory: (config: ApiConfigService): LaunchEventsSettings => ({
      queueMaxLength:
        config.get('launch_queue_max_length') ?? DEFAULT_QUEUE_MAX_LENGTH,
    }),
  },
];

/** The application services both the core and the worker module need. */
export const LAUNCH_SERVICES: Provider[] = [
  LaunchLimits,
  LaunchEventOutbox,
  EventGateService,
  SeatMapService,
  HoldLifecycleService,
  LaunchEventService,
  WaitingRoomService,
  AdmissionService,
  HoldService,
  ConfirmService,
  BookingQueryService,
  ReconcileService,
];
