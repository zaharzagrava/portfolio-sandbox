import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { OpenTelemetryModule } from 'nestjs-otel';
import { ApiConfigModule } from '@app/common/config';
import { StatelessPlatformModule } from '@app/infrastructure/platform';
import { AllExceptionsFilter } from '@app/common/exceptions-filter';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { BffModule } from '@app/composition/bff/bff.module';

/**
 * SD-04 Backend-for-Frontend. Stateless; no database connection on purpose:
 * everything comes from core over HTTP, so the BFF can't grow business rules
 * that bypass the domain services.
 */
@Module({
  imports: [
    ApiConfigModule,
    StatelessPlatformModule,
    ErrorUtilsModule,
    BffModule,
    OpenTelemetryModule.forRoot({ metrics: { hostMetrics: true } }),
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class BffAppModule {}
