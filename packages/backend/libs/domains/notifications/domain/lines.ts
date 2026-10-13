import type { DeliveryLine } from './types';

/**
 * Delivery lines: a transactional and a marketing queue per channel, each with a `-dlq`
 * (specs/domains/S28-notifications/contracts/events.md "Internal queues"). A backlog or an outage on one line never
 * delays another (P0618).
 */
export const DELIVERY_QUEUES = {
  email: 'notify-email',
  sms: 'notify-sms',
  push: 'notify-push',
  marketingEmail: 'notify-marketing-email',
  marketingSms: 'notify-marketing-sms',
  marketingPush: 'notify-marketing-push',
} as const;

export const deadLetterQueueOf = (queue: string) => `${queue}-dlq`;

/** The line a queue belongs to (marketing queues are the `notify-marketing-*` ones). */
export const lineOfQueue = (queue: string): DeliveryLine =>
  queue.startsWith('notify-marketing-') ? 'marketing' : 'transactional';

/** The queue of the line a delivery goes on. */
export const lineQueueOf = (
  line: DeliveryLine,
  channel: 'email' | 'sms' | 'push',
): string => {
  if (line === 'transactional') return DELIVERY_QUEUES[channel];
  const marketing = {
    email: DELIVERY_QUEUES.marketingEmail,
    sms: DELIVERY_QUEUES.marketingSms,
    push: DELIVERY_QUEUES.marketingPush,
  } as const;
  return marketing[channel];
};
