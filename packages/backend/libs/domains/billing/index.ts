/**
 * Public entry point of the `billing` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/billing`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { default as InvoiceLineModel } from './infra/models/invoice-line.model';
export { default as InvoiceModel } from './infra/models/invoice.model';
export { default as PlanModel } from './infra/models/plan.model';
export { default as PriceModel } from './infra/models/price.model';
export { default as SubscriptionModel } from './infra/models/subscription.model';
export { BillingWorkerModule } from './billing-worker.module';
export { BillingModule } from './billing.module';
export {
  EntitlementsService,
  RequiresShopEntitlement,
} from './application/entitlements.service';
export { InvoicePaymentFailed } from './application/events/billing-events';
export { UsageService } from './application/usage.service';
export { UsageProjector } from './infra/usage.projector';
