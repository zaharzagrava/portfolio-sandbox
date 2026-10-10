import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { TenancyModule } from '@app/domains/tenancy';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { ProductModule } from './product.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { PRODUCTS_AGGREGATE } from './application/events/product-events';
import { DraftStore } from './infra/draft-store';
import { CollabInstanceRegistry } from './infra/instance-registry';
import { DraftsService } from './application/drafts.service';
import { DraftsController } from './api/drafts.controller';

/** SD-16 HTTP side (core): drafts, routing + tickets, versions, publish. The editing itself runs in apps/collab. */
@Module({
  imports: [
    AuthModule,
    TenancyModule,
    StorageModule,
    DynamoModule,
    ProductModule,
    EventsModule.forAggregates([PRODUCTS_AGGREGATE]),
  ],
  providers: [DraftStore, CollabInstanceRegistry, DraftsService],
  exports: [DraftsService, DraftStore],
  controllers: [DraftsController],
})
export class DraftsModule {}
