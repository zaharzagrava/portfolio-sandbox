import { Global, Module } from '@nestjs/common';
import { JobsService } from './jobs.service';

/** Enqueue side - imported by any app that schedules work (core, public-api, ...). */
@Global()
@Module({
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
