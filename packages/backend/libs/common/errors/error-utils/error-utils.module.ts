import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ErrorUtilsService } from './error-utils.service';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { RouteTable } from '@app/common/routing/route-table';
import { ERROR_TRACKER, SentryErrorTracker } from './error-tracker';

@Module({
  imports: [ApiConfigModule, DiscoveryModule],
  providers: [
    ErrorUtilsService,
    RouteTable,
    { provide: ERROR_TRACKER, useClass: SentryErrorTracker },
  ],
  exports: [ErrorUtilsService, ERROR_TRACKER, RouteTable],
})
export class ErrorUtilsModule {}
