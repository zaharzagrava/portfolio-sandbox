import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { ProductModule } from './product.module';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { DraftStore } from './infra/draft-store';
import { CollabInstanceRegistry } from './infra/instance-registry';
import { DraftsService } from './application/drafts.service';
import { DraftsController } from './api/drafts.controller';

/** SD-16 HTTP side (core): drafts, routing + tickets, versions, publish. The editing itself runs in apps/collab. */
@Module({
  imports: [
    AuthModule,
    StorageModule,
    DynamoModule,
    ProductModule,
    OutboxModule,
  ],
  providers: [DraftStore, CollabInstanceRegistry, DraftsService],
  exports: [DraftsService, DraftStore],
  controllers: [DraftsController],
})
export class DraftsModule {}
