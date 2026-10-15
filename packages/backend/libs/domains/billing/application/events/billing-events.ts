import { billingEventSchemas } from '@marketplace-sandbox/contracts';
import { SubscriptionPlanChanged } from '@app/domains/tenancy';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/**
 * `billing.events` v1 (specs/domains/S17-subscriptions/contracts/events.md), written through the outbox in the
 * transaction of the change and keyed by `subjectId`. Schemas come from `packages/contracts`, shared with the
 * consumers (S03, S18, S28). Ids, plan codes and amounts only: never a payment-method reference.
 */
export const BILLING_AGGREGATE: TopicRegistration = {
  aggregateType: 'billing',
  retention: 'full-history',
};

export const SubscriptionStatusChanged = defineEvent(
  'billing.subscription_status_changed',
  'billing',
  1,
  billingEventSchemas['billing.subscription_status_changed'],
);

export const InvoicePaymentFailed = defineEvent(
  'billing.invoice_payment_failed',
  'billing',
  1,
  billingEventSchemas['billing.invoice_payment_failed'],
);

export const InvoicePaid = defineEvent(
  'billing.invoice_paid',
  'billing',
  1,
  billingEventSchemas['billing.invoice_paid'],
);

/**
 * `billing.subscription_plan_changed {shopId, plan, version}`: tenancy registered the definition first (its consumer,
 * S03) and `defineEvent` refuses a second one for the same type, so billing produces through that one. Same payload
 * as `billingEventSchemas['billing.subscription_plan_changed']`.
 */
export { SubscriptionPlanChanged };
