import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { TransactionModule } from '@app/infrastructure/context/transaction.module';
import ProcessedWebhookEvent from './inbox.model';
import { InboxPurgeService } from './inbox-purge.service';
import { InboxService } from './inbox.service';

/** `InboxService` for the apps that handle webhooks and inbox consumers; the purge job runs where the job worker does. */
@Module({
  imports: [
    SequelizeModule.forFeature([ProcessedWebhookEvent]),
    TransactionModule,
  ],
  providers: [InboxService, InboxPurgeService],
  exports: [InboxService, InboxPurgeService],
})
export class InboxModule {}
