import { Module } from '@nestjs/common';
import { JobsModule } from '@app/infrastructure/jobs';
import { AuthModule } from './auth.module';
import { JobsAdminController } from './api/jobs-admin.controller';

/**
 * Operator routes (ADMIN only) over the S49 job system. A separate module so that apps which only verify tokens
 * (`sse-gateway`, `public-api`) do not carry admin routes; `core` imports it.
 */
@Module({
  imports: [AuthModule, JobsModule],
  controllers: [JobsAdminController],
})
export class IdentityOpsModule {}
