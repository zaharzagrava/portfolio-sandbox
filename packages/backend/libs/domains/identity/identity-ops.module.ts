import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { JobsModule } from '@app/infrastructure/jobs';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { ConsumerAdminModule } from '@app/infrastructure/projections/consumer-admin.module';
import { AuthModule } from './auth.module';
import {
  ClockAdminController,
  ClockControlEnabledGuard,
} from './api/clock-admin.controller';
import { ConsumersAdminController } from './api/consumers-admin.controller';
import { JobsAdminController } from './api/jobs-admin.controller';
import {
  EventTapEnabledGuard,
  TopicsAdminController,
} from './api/topics-admin.controller';
import { TopicTapService } from '@app/infrastructure/kafka/topic-tap.service';

/**
 * Operator routes (ADMIN only) over the S49 job system, the S53 consumers and the S54 clock. A separate module so that
 * apps which only verify tokens (`sse-gateway`, `public-api`) do not carry admin routes; `core` imports it. The clock
 * routes answer 404 unless `CLOCK_CONTROL=enabled`.
 */
@Module({
  imports: [
    AuthModule,
    ApiConfigModule,
    ClockModule,
    JobsModule,
    IdempotencyModule,
    ConsumerAdminModule,
  ],
  controllers: [
    JobsAdminController,
    ConsumersAdminController,
    ClockAdminController,
    TopicsAdminController,
  ],
  providers: [ClockControlEnabledGuard, EventTapEnabledGuard, TopicTapService],
})
export class IdentityOpsModule {}
