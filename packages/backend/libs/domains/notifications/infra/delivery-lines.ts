import type { DeliveryLine, DeliveryMessage } from '../domain/types';
import { deadLetterQueueOf, lineQueueOf } from './notifications.topics';

export interface DeliveryLineSpec {
  queue: string;
  deadLetterQueue: string;
  channel: DeliveryMessage['channel'];
  line: DeliveryLine;
}

const CHANNELS = ['email', 'sms', 'push'] as const;

/**
 * The six delivery lines: a transactional and a marketing queue per channel, each with its own dead-letter queue. A
 * line has its own consumer and concurrency, so a backlog or an outage on one never takes capacity from another
 * (FR-027, AS-40, AS-41).
 */
export const DELIVERY_LINES: readonly DeliveryLineSpec[] = (
  ['transactional', 'marketing'] as const
).flatMap((line) =>
  CHANNELS.map((channel) => {
    const queue = lineQueueOf(line, channel);
    return { queue, deadLetterQueue: deadLetterQueueOf(queue), channel, line };
  }),
);

/** Consumers per line: marketing lines are drained at a lower rate than transactional ones (10 and 3 by default). */
export const concurrencyOf = (
  spec: DeliveryLineSpec,
  settings: { txConcurrency: number; marketingConcurrency: number },
): number =>
  spec.line === 'transactional'
    ? settings.txConcurrency
    : settings.marketingConcurrency;
