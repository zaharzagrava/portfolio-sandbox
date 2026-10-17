import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { TenancyModule } from '@app/domains/tenancy';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { DraftTicketService } from './application/draft-ticket.service';
import {
  COLLAB_BACKPLANE,
  DOC_STORE,
  DRAFT_MEMBERSHIP,
  DRAFT_REPOSITORY,
  RING_REGISTRY,
  SNAPSHOT_STORE,
  SUPERSEDED_REGISTRY,
  TICKET_ID_STORE,
  VERSION_REPOSITORY,
} from './domain/draft-ports';
import { RedisBackplane } from './infra/collab-backplane';
import { RedisTicketIdStore } from './infra/collab-ticket';
import { SequelizeDraftRepository } from './infra/draft.repository';
import { SequelizeVersionRepository } from './infra/draft-version.repository';
import { TenancyDraftMembership } from './infra/draft-membership';
import {
  DraftStore,
  DynamoSupersededRegistry,
  S3SnapshotStore,
} from './infra/draft-store';
import { RedisRingRegistry } from './infra/instance-registry';
import ListingDraft from './infra/models/listing-draft.model';
import ListingDraftVersion from './infra/models/listing-draft-version.model';

/**
 * The adapters behind the draft ports (S06 D-6), bound by token and shared by the HTTP side (`DraftsModule`), the editing
 * instances (`CollabModule`) and the consumers and jobs (`DraftsProjectorModule`). Internal: nothing outside the catalog
 * imports it. Redis, the clock and the transaction runner are global.
 */
@Module({
  imports: [
    SequelizeModule.forFeature([ListingDraft, ListingDraftVersion]),
    TenancyModule,
    StorageModule,
    DynamoModule,
  ],
  providers: [
    { provide: DRAFT_REPOSITORY, useClass: SequelizeDraftRepository },
    { provide: VERSION_REPOSITORY, useClass: SequelizeVersionRepository },
    { provide: SNAPSHOT_STORE, useClass: S3SnapshotStore },
    { provide: SUPERSEDED_REGISTRY, useClass: DynamoSupersededRegistry },
    { provide: DOC_STORE, useClass: DraftStore },
    { provide: RING_REGISTRY, useClass: RedisRingRegistry },
    { provide: COLLAB_BACKPLANE, useClass: RedisBackplane },
    { provide: DRAFT_MEMBERSHIP, useClass: TenancyDraftMembership },
    { provide: TICKET_ID_STORE, useClass: RedisTicketIdStore },
    DraftTicketService,
  ],
  exports: [
    DRAFT_REPOSITORY,
    VERSION_REPOSITORY,
    SNAPSHOT_STORE,
    SUPERSEDED_REGISTRY,
    DOC_STORE,
    RING_REGISTRY,
    COLLAB_BACKPLANE,
    DRAFT_MEMBERSHIP,
    TICKET_ID_STORE,
    DraftTicketService,
  ],
})
export class DraftPersistenceModule {}
