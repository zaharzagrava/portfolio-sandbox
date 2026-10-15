import { Module } from '@nestjs/common';
import {
  statementsProjectors,
  LedgerFactProjector,
  PayoutFactProjector,
  SalesFactProjector,
} from './infra/fact-projectors';
import { StatementsCoreModule } from './statements-core.module';

/**
 * The three fact consumers (apps/projector): `order.paid`, `payout.paid`, `ledger.journal_posted` v2 into the
 * statements' own store. `ProjectionsModule.forProjectors(StatementsProjectorModule.projectors, [StatementsProjectorModule])`.
 */
@Module({
  imports: [StatementsCoreModule],
  providers: [SalesFactProjector, PayoutFactProjector, LedgerFactProjector],
  // the consumer host resolves the projectors' own dependencies through these
  exports: [
    StatementsCoreModule,
    SalesFactProjector,
    PayoutFactProjector,
    LedgerFactProjector,
  ],
})
export class StatementsProjectorModule {
  static readonly projectors = statementsProjectors;
}
