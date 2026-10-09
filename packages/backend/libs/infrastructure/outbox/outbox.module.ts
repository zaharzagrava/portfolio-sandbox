import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { TransactionModule } from '@app/infrastructure/context/transaction.module';
import { EventsCoreModule } from '@app/infrastructure/events/events-core.module';
import Outbox from './outbox.model';
import { OutboxService } from './outbox.service';

@Module({
  imports: [
    SequelizeModule.forFeature([Outbox]),
    EventsCoreModule,
    TransactionModule,
  ],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
