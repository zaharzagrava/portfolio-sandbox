/**
 * Public entry point of the `payments` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/payments`. No model is exported (S13 AS-64);
 * payments e2e specs reach the models through `@app/domains/payments/testing`.
 */
export { LEDGER_ACCOUNTS, shopAccount } from './domain/accounts';
export { FinanceWorkerModule } from './finance-worker.module';
export { FinanceModule } from './finance.module';
export { LedgerModule } from './ledger.module';
export { PaymentModule } from './payment.module';
export { PaymentProcessorModule } from './payment-processor.module';
export { PaymentQueryModule } from './payment-query.module';
export { PaymentQueryService } from './application/payment-query.service';
export type { PaymentStatusView } from './application/payment-query.service';
export { paymentsRatePolicies } from './rate-limit-policies';
export { CreateLedgerEntryDto, SystemAccount } from './api/ledger.dto';
export type { LedgerAccountId } from './api/ledger.dto';
export { CreatePaymentDto } from './api/payment.dto';
export { LedgerService } from './application/ledger.service';
export { paymentsProjectors } from './payments-projectors';
