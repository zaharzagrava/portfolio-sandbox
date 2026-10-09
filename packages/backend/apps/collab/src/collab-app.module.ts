import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { PlatformModule } from '@app/infrastructure/platform';
import { DatabaseModule } from '@app/infrastructure/database';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { CollabModule } from '@app/domains/catalog';
import { OpenTelemetryModule } from 'nestjs-otel';

import { TenancyModule } from '@app/domains/tenancy';

/**
 * SD-16 collaborative editing instances. Stateful (in-memory rooms), so its
 * own deployable: scaled on rooms/connections per instance, and every
 * instance joins the consistent-hash ring on boot (leaves on shutdown).
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    TenancyModule,
    DatabaseModule,
    RedisModule,
    CollabModule,
    OpenTelemetryModule.forRoot({ metrics: { hostMetrics: true } }),
  ],
})
export class CollabAppModule {}
