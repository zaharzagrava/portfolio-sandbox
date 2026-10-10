import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { OpenTelemetryModule } from 'nestjs-otel';
import { ApiConfigModule } from '@app/common/config';
import { PlatformModule } from '@app/infrastructure/platform';
import { DatabaseModule } from '@app/infrastructure/database';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { AllExceptionsFilter } from '@app/common/exceptions-filter';
import { PublicApiModule } from '@app/domains/developer-platform';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { TenancyModule } from '@app/domains/tenancy';

/**
 * SD-07 public API as its own deployable: different auth (API keys only, no
 * cookies/JWT), different limits (per key, per plan), different scaling and
 * blast radius - an ERP hammering /v1/stock/bulk can't slow the storefront.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    TenancyModule,
    DatabaseModule,
    RedisModule,
    RateLimitModule.forRoot(),
    PublicApiModule,
    ErrorUtilsModule,
    OpenTelemetryModule.forRoot({ metrics: { hostMetrics: true } }),
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class PublicApiAppModule {}
