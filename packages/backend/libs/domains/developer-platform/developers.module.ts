import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ApiKeysController } from './api/api-keys.controller';
import { ApiVersionController } from './api/api-version.controller';
import { DashboardOpenApiController } from './api/dashboard-openapi.controller';
import { LogsUsageController } from './api/logs-usage.controller';
import { DeveloperPlatformCoreModule } from './developer-platform-core.module';

/** The dashboard side (apps/core): keys, version pin, request logs, usage. Sessions only, never an API key. */
@Module({
  imports: [AuthModule, DeveloperPlatformCoreModule],
  controllers: [
    ApiKeysController,
    ApiVersionController,
    LogsUsageController,
    DashboardOpenApiController,
  ],
})
export class DevelopersModule {}
