import { Injectable, Module, OnApplicationBootstrap } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { AssetsService } from './application/assets.service';
import { AssetsController } from './api/assets.controller';

/** SD-25 API (core). */
@Module({
  imports: [AuthModule, StorageModule],
  providers: [AssetsService],
  exports: [AssetsService],
  controllers: [AssetsController],
})
export class AssetsModule {}

@Injectable()
class AssetsGcSchedule implements OnApplicationBootstrap {
  constructor(private readonly jobs: JobsService) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({
      name: 'assets.gc-chunks',
      cron: '17 * * * *',
      jobType: 'assets.gc-chunks',
      payload: {},
    });
  }
}

/** SD-25 chunk GC (apps/worker). */
@Module({
  imports: [StorageModule, JobsModule],
  providers: [AssetsService, AssetsGcSchedule],
})
export class AssetsWorkerModule {}
