/**
 * Public entry point of the `billing` domain (constitution X.4). Code outside this domain imports only from
 * `@app/domains/billing`: the modules, the events, the policies, S17's basis service and the S18 items that other
 * capabilities already use (entitlements and usage), which stay here until S18 moves them. No model leaves the
 * domain (IX.4, debt D-7 closed).
 */
export { BillingModule } from './billing.module';
export { BillingWorkerModule } from './billing-worker.module';
export { BillingConsumerModule } from './billing-consumer.module';
export { billingRatePolicies } from './rate-limit-policies';
export {
  SubscriptionBasisService,
  type SubscriptionBasis,
} from './application/subscription-basis.service';
export {
  USAGE_LINES_PROVIDER,
  type UsageInvoiceLinesProvider,
  type UsageLine,
} from './domain/ports';
export {
  InvoicePaid,
  InvoicePaymentFailed,
  SubscriptionPlanChanged,
  SubscriptionStatusChanged,
} from './application/events/billing-events';

// S18 (usage and entitlements): unchanged exports, used by auctions, the assistant and the developer platform.
export {
  EntitlementsService,
  RequiresShopEntitlement,
} from './application/entitlements.service';
export type { QuotaKey, QuotaStatus } from './application/entitlements.service';
export { UsageRecorded, UsageService } from './application/usage.service';
export { UsageProjector } from './infra/usage.projector';
