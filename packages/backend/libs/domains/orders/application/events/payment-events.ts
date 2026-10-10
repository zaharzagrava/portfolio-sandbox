import { paymentEventSchemas } from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';

/**
 * `payments.events` as consumed by orders (S10 contracts/events.md). The payments capability (S13) publishes them;
 * until it is built nothing does, and the schemas live in `packages/contracts` so S13 can adopt them unchanged.
 */
export const PaymentSucceeded = defineEvent(
  'payments.payment_succeeded',
  'payments',
  1,
  paymentEventSchemas['payments.payment_succeeded'],
);
export const PaymentFailed = defineEvent(
  'payments.payment_failed',
  'payments',
  1,
  paymentEventSchemas['payments.payment_failed'],
);
export const PaymentRefunded = defineEvent(
  'payments.payment_refunded',
  'payments',
  1,
  paymentEventSchemas['payments.payment_refunded'],
);
