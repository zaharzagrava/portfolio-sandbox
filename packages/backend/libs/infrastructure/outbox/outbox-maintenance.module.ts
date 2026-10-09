import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { TransactionModule } from '@app/infrastructure/context/transaction.module';
import { OutboxPurgeService } from './outbox-purge.service';

/**
 * Background maintenance of the outbox table (apps/worker): the `outbox.purge-published` job. Needs the job system
 * (`JobsModule`/`JobsWorkerModule`) in the host app to run; without it the handler is only a service.
 */
@Module({
  imports: [ApiConfigModule, TransactionModule],
  providers: [OutboxPurgeService],
  exports: [OutboxPurgeService],
})
export class OutboxMaintenanceModule {}
