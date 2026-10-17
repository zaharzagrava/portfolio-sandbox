import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { AllExceptionsFilter } from '@app/common/exceptions-filter';
import { PlatformModule } from '@app/infrastructure/platform';
import { DatabaseModule } from '@app/infrastructure/database';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { CollabModule } from '@app/domains/catalog';
import { OpenTelemetryModule } from 'nestjs-otel';

import { TenancyModule } from '@app/domains/tenancy';

/**
 * S06 collaborative editing instances. Stateful (in-memory rooms), so its own deployable: scaled on rooms/connections per
 * instance, and every instance joins the consistent-hash ring once its server listens (leaves on shutdown).
 *
 * It boots alone (L-018): `CollabModule` brings the draft repositories (the database connection of `DatabaseModule`),
 * the log and snapshot stores (DynamoDB, object storage), the ring and the backplane (Redis) and membership reads
 * (`TenancyModule`); the platform supplies the clock, the transaction runner, health and the shutdown order, and the error
 * filter answers the internal owner endpoints with problem documents.
 */
@Module({
  imports: [
    ApiConfigModule,
    ErrorUtilsModule,
    PlatformModule,
    TenancyModule,
    DatabaseModule,
    RedisModule,
    CollabModule,
    OpenTelemetryModule.forRoot({ metrics: { hostMetrics: true } }),
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class CollabAppModule {}
