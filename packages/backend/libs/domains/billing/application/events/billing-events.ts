import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

export const InvoicePaymentFailed = defineEvent(
  'billing.invoice_payment_failed',
  'billing',
  1,
  z.object({
    subscriptionId: z.string(),
    subjectType: z.string(),
    subjectId: z.string(),
    attempt: z.number().int(),
    nextAttemptAt: z.string().nullable(),
  }),
);

export const SubscriptionStatusChanged = defineEvent(
  'billing.subscription_status_changed',
  'billing',
  1,
  z.object({
    subjectType: z.string(),
    subjectId: z.string(),
    status: z.string(),
  }),
);
