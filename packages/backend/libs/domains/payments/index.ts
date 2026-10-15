/**
 * Public entry point of the `payments` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/payments`. No model is exported (S13 AS-64, S14 FR-047);
 * payments e2e specs reach the models through `@app/domains/payments/testing`.
 */
export { LEDGER_ACCOUNTS, shopAccount } from './domain/account';
export type { JournalKind as LedgerJournalKind } from './domain/journal';
export { JournalPosted } from './application/events/ledger-events';
export { LedgerModule } from './ledger.module';
export { LedgerWorkerModule } from './ledger-worker.module';
export { PayoutsModule } from './payouts.module';
export { PayoutsWorkerModule } from './payouts-worker.module';
export { LedgerProjectorModule } from './ledger-projector.module';
export { PaymentModule } from './payment.module';
export { PaymentProcessorModule } from './payment-processor.module';
export { PaymentQueryModule } from './payment-query.module';
export { PaymentQueryService } from './application/payment-query.service';
export type { PaymentStatusView } from './application/payment-query.service';
export { paymentsRatePolicies } from './rate-limit-policies';
export { CreatePaymentDto } from './api/payment.dto';
export { LedgerService } from './application/ledger.service';
export { paymentsProjectors } from './payments-projectors';
