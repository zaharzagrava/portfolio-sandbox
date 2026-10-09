import { Global, Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { JobsAdminService } from './jobs-admin.service';

/** Enqueue side - imported by any app that schedules work (core, public-api, ...). */
@Global()
@Module({
  providers: [JobsService, JobsAdminService],
  exports: [JobsService, JobsAdminService],
})
export class JobsModule {}
