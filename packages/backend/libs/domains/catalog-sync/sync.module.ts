import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { SyncService } from './application/sync.service';
import { SyncController } from './api/sync.controller';

/** SD-06 offline sync (core). */
@Module({
  imports: [AuthModule, OutboxModule],
  providers: [SyncService],
  exports: [SyncService],
  controllers: [SyncController],
})
export class OfflineSyncModule {}
