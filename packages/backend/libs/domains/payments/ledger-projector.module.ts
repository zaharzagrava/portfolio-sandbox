import { Module } from '@nestjs/common';
import { LedgerModule } from './ledger.module';
import { BalanceProjector } from './infra/balance.projector';

/** The balance read-model projector (`apps/projector`): `ledger.journal_posted` v2 -> hot and durable stores. */
@Module({
  imports: [LedgerModule],
  providers: [BalanceProjector],
  exports: [BalanceProjector],
})
export class LedgerProjectorModule {}
