import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { PRODUCTS_AGGREGATE } from '@app/domains/catalog';
import { SyncService } from './application/sync.service';
import { SyncController } from './api/sync.controller';

/** SD-06 offline sync (core). */
@Module({
  imports: [AuthModule, EventsModule.forAggregates([PRODUCTS_AGGREGATE])],
  providers: [SyncService],
  exports: [SyncService],
  controllers: [SyncController],
})
export class OfflineSyncModule {}
