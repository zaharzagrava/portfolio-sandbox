import { Module, type Type } from '@nestjs/common';
import { ShopQueryModule } from '@app/domains/tenancy';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import type { Projector } from '@app/infrastructure/projections/projector';
import { COLLAB_CONTROL } from './domain/draft-ports';
import { DraftPersistenceModule } from './draft-persistence.module';
import { HttpCollabControl } from './infra/collab-control';
import {
  DraftMemberRemovedConsumer,
  DraftMemberRoleChangedConsumer,
  DraftShopDeletedConsumer,
  DraftShopOffboardingConsumer,
  DraftShopStatusConsumer,
} from './infra/drafts-consumers';
import { DraftsJobs } from './infra/drafts.jobs';

/**
 * The draft part of `catalog` that reacts to other domains and runs on a schedule (S06): five consumers of tenancy events
 * and the two jobs. Hosted by `apps/projector` (consumers, listed in `ProjectionsModule.forProjectors` with
 * `DraftsProjectorModule.projectors`) and by `apps/worker` (jobs); `apps/local-monolith` imports it.
 */
@Module({
  imports: [DraftPersistenceModule, ShopQueryModule, JobsModule],
  providers: [
    DraftMemberRemovedConsumer,
    DraftMemberRoleChangedConsumer,
    DraftShopStatusConsumer,
    DraftShopOffboardingConsumer,
    DraftShopDeletedConsumer,
    DraftsJobs,
    { provide: COLLAB_CONTROL, useClass: HttpCollabControl },
  ],
  exports: [
    // What the consumers inject: `ProjectionsModule` instantiates them in its own scope.
    DraftPersistenceModule,
    ShopQueryModule,
    DraftMemberRemovedConsumer,
    DraftMemberRoleChangedConsumer,
    DraftShopStatusConsumer,
    DraftShopOffboardingConsumer,
    DraftShopDeletedConsumer,
    DraftsJobs,
  ],
})
export class DraftsProjectorModule {
  static readonly projectors: Type<Projector>[] = [
    DraftMemberRemovedConsumer,
    DraftMemberRoleChangedConsumer,
    DraftShopStatusConsumer,
    DraftShopOffboardingConsumer,
    DraftShopDeletedConsumer,
  ];
}
