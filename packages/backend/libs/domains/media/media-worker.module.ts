import { Module } from '@nestjs/common';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { MaintenanceService } from './application/maintenance.service';
import { MediaStore } from './domain/ports';
import { SequelizeMediaStore } from './infra/media-store';
import { MediaMaintenanceJobs } from './media-maintenance.jobs';

/**
 * Photos, worker side (apps/worker): the expire, re-drive and purge jobs of S29, scheduled through the jobs toolkit
 * (S49). The photo processing is not here: it is the `media-processing` Lambda.
 */
@Module({
  imports: [JobsModule, StorageModule, SqsModule],
  providers: [
    { provide: MediaStore, useClass: SequelizeMediaStore },
    MaintenanceService,
    MediaMaintenanceJobs,
  ],
})
export class MediaWorkerModule {}
