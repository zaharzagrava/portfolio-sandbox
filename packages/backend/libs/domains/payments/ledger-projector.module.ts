import { Module } from '@nestjs/common';
import { LedgerModule } from './ledger.module';
import { BalanceProjector } from './infra/balance.projector';

/** The balance read-model projector (`apps/projector`): `ledger.journal_posted` v2 -> hot and durable stores. */
@Module({
  imports: [LedgerModule],
  providers: [BalanceProjector],
  // ProjectionsModule builds the projector class itself, so it needs the stores the projector injects (BALANCE_HOT_STORE, ...): re-export the module that provides them
  exports: [BalanceProjector, LedgerModule],
})
export class LedgerProjectorModule {}
