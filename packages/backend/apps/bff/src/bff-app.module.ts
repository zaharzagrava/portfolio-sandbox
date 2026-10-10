import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { OpenTelemetryModule } from 'nestjs-otel';
import { ApiConfigModule } from '@app/common/config';
import { StatelessPlatformModule } from '@app/infrastructure/platform';
import { AllExceptionsFilter } from '@app/common/exceptions-filter';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { BffModule } from '@app/composition/bff';

/**
 * SD-04 Backend-for-Frontend. Stateless apart from Redis (session store, shaped-response cache, rate limits); no
 * database connection on purpose: everything else comes from the domain APIs over HTTP, so the BFF can't grow business
 * rules that bypass the domain services (S48, constitution X.8).
 */
@Module({
  imports: [
    ApiConfigModule,
    StatelessPlatformModule,
    ErrorUtilsModule,
    RedisModule,
    RateLimitModule.forRoot(),
    BffModule,
    OpenTelemetryModule.forRoot({ metrics: { hostMetrics: true } }),
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class BffAppModule {}
