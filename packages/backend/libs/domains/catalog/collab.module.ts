import { Module } from '@nestjs/common';
import { InternalCollabController } from './api/internal-collab.controller';
import { CollabOrigin } from './api/collab-origin';
import { CollabServer } from './api/collab-server.service';
import { RoomManager } from './application/room-manager.service';
import { COLLAB_TIMINGS, DEFAULT_COLLAB_TIMINGS } from './domain/draft-limits';
import { DraftPersistenceModule } from './draft-persistence.module';

/** Realtime side of the drafts (apps/collab, S06): rooms, the WebSocket server, ring membership and revocation. */
@Module({
  imports: [DraftPersistenceModule],
  providers: [
    // The periods (ping, presence silence, idle unload, re-check, flush batch): specs shorten them by overriding this value.
    { provide: COLLAB_TIMINGS, useValue: DEFAULT_COLLAB_TIMINGS },
    RoomManager,
    CollabServer,
    CollabOrigin,
  ],
  controllers: [InternalCollabController],
})
export class CollabModule {}
