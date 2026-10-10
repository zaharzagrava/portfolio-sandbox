import { paymentEventSchemas } from '@marketplace-sandbox/contracts';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';
import { lazy, sharedEvent } from './shared-event';

/**
 * `payments.events` v1 (specs/domains/S13-payment-intents/contracts/events.md): key = `paymentId`, money fields end
 * in `Minor`, payloads are built field by field (never the payment method, the client secret, provider objects or
 * errors). Orders defines the same three contracts to consume them; `sharedEvent` keeps one definition per process.
 */
export const PAYMENTS_AGGREGATE: TopicRegistration = {
  aggregateType: 'payments',
  retention: 'full-history',
};

export const paymentEvents = lazy(() => ({
  succeeded: sharedEvent(
    'payments.payment_succeeded',
    'payments',
    1,
    paymentEventSchemas['payments.payment_succeeded'],
  ),
  failed: sharedEvent(
    'payments.payment_failed',
    'payments',
    1,
    paymentEventSchemas['payments.payment_failed'],
  ),
  refunded: sharedEvent(
    'payments.payment_refunded',
    'payments',
    1,
    paymentEventSchemas['payments.payment_refunded'],
  ),
}));
