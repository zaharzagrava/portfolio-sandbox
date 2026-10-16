import type { Logger } from '@nestjs/common';
import { errorText, logDelivery, type DeliveryLogFields } from './delivery-log';

/**
 * Runs the effects that follow a committed transition (timer messages, pushes, cache mirrors, job enqueues). They are
 * network calls and so never run inside a transaction (FR-051); each is best effort - the stored state is already
 * right and the recovery job repairs what a failure leaves behind - so a rejection is logged (with the ids of the
 * delivery) and never rethrown.
 */
export async function afterCommit(
  logger: Logger,
  label: string,
  effects: ReadonlyArray<() => Promise<unknown>>,
  ids: Pick<DeliveryLogFields, 'deliveryId' | 'courierId' | 'city'> = {},
): Promise<void> {
  const results = await Promise.allSettled(
    effects.map(async (effect) => effect()),
  );
  for (const result of results)
    if (result.status === 'rejected')
      logDelivery(logger, 'warn', 'delivery.effect_failed', {
        ...ids,
        step: label,
        error: errorText(result.reason),
      });
}
