/**
 * Public entry point of the `payments` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/payments`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { default as LedgerEntryModel } from './infra/models/ledger-entry.model';
export {
  default as PaymentModel,
  PaymentStatus,
} from './infra/models/payment.model';
export { default as PayoutModel } from './infra/models/payout.model';
export { LEDGER_ACCOUNTS, shopAccount } from './domain/accounts';
export { FinanceWorkerModule } from './finance-worker.module';
export { FinanceModule } from './finance.module';
export { LedgerModule } from './ledger.module';
export { PaymentDtoModule } from './payment-dto.module';
export { PaymentModule } from './payment.module';
export { CreateLedgerEntryDto, SystemAccount } from './api/ledger.dto';
export type { LedgerAccountId } from './api/ledger.dto';
export { CreatePaymentDto } from './api/payment.dto';
export { LedgerService } from './application/ledger.service';
export {
  PaymentProcessed,
  PAYMENTS_AGGREGATE,
} from './application/events/payment-events';
export { BalanceProjector } from './infra/balance.projector';
export { PaymentDtoService } from './infra/payment-dto.service';
