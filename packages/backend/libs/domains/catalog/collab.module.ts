import { Module } from '@nestjs/common';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { DraftStore } from './infra/draft-store';
import { CollabInstanceRegistry } from './infra/instance-registry';
import { RoomManager } from './application/room-manager.service';
import { CollabServer } from './api/collab-server.service';

/** SD-16 realtime side (apps/collab): rooms + WebSocket server + ring membership. */
@Module({
  imports: [StorageModule, DynamoModule],
  providers: [DraftStore, CollabInstanceRegistry, RoomManager, CollabServer],
  exports: [RoomManager, CollabServer, DraftStore],
})
export class CollabModule {}
