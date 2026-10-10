import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { DbUtilsModule } from '@app/infrastructure/database/db-utils/db-utils.module';
import { LedgerService } from './application/ledger.service';
import LedgerEntry from './infra/models/ledger-entry.model';
import { EventsModule } from '@app/infrastructure/events/events.module';

@Module({
  imports: [
    SequelizeModule.forFeature([LedgerEntry]),
    ApiConfigModule,
    DbUtilsModule,
    AuthModule,
    EventsModule.forAggregates([
      { aggregateType: 'ledger', retention: 'full-history' },
    ]),
  ],
  providers: [LedgerService],
  exports: [LedgerService],
  controllers: [],
})
export class LedgerModule {}
