import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { TenancyModule } from '@app/domains/tenancy';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { DraftsController } from './api/drafts.controller';
import { DraftPublishService } from './application/draft-publish.service';
import { DraftVersionsService } from './application/draft-versions.service';
import { DraftsService } from './application/drafts.service';
import { DRAFTS_AGGREGATE } from './application/events/draft-events';
import { COLLAB_CONTROL, PRODUCT_GATEWAY } from './domain/draft-ports';
import { DraftPersistenceModule } from './draft-persistence.module';
import { HttpCollabControl } from './infra/collab-control';
import { CommandProductGateway } from './infra/product-gateway';
import { ProductModule } from './product.module';
import { catalogRatePolicies } from './rate-limit-policies';

/**
 * Listing drafts, HTTP side (core app, S06): create, list, archive, connect, versions and publish. The editing itself
 * runs in `CollabModule` (apps/collab); the two meet only through Redis, the document store and the ring. Product content
 * is read and written through the exported product command service (R1), membership through tenancy's services.
 */
@Module({
  imports: [
    AuthModule,
    TenancyModule,
    ProductModule,
    DraftPersistenceModule,
    IdempotencyModule,
    EventsModule.forAggregates([DRAFTS_AGGREGATE]),
    RateLimitModule.forFeature(catalogRatePolicies),
  ],
  providers: [
    DraftsService,
    DraftVersionsService,
    DraftPublishService,
    { provide: PRODUCT_GATEWAY, useClass: CommandProductGateway },
    { provide: COLLAB_CONTROL, useClass: HttpCollabControl },
  ],
  controllers: [DraftsController],
})
export class DraftsModule {}
