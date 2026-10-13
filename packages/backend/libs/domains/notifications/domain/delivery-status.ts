import type { DeliveryStatus } from './types';

/**
 * Rank of each timeline status (data-model.md "Delivery status"). A status moves only forward: the incoming status
 * wins when its rank is higher, an equal rank keeps the first. `complained` outranks `bounced`; the pre-send
 * terminals and `failed` share rank 4 with `bounced`. The full precedence rule and its property test come with the
 * callbacks story (AS-71); this table is what the timeline store compares in its conditional update.
 */
export const DELIVERY_STATUS_RANK: Record<DeliveryStatus, number> = {
  queued: 0,
  delayed: 1,
  sent: 2,
  delivered: 3,
  bounced: 4,
  failed: 4,
  suppressed: 4,
  capped: 4,
  skipped: 4,
  expired: 4,
  complained: 5,
};

export const rankOf = (status: DeliveryStatus): number =>
  DELIVERY_STATUS_RANK[status];

const PRE_SEND_TERMINALS: ReadonlySet<DeliveryStatus> = new Set([
  'suppressed',
  'capped',
  'skipped',
  'expired',
]);

/**
 * The summary row accepts `status` only while its stored rank is below this: its own rank, except for a pre-send
 * terminal, which is accepted only before anything was sent (stored rank below `sent`). The store's `IF status_rank < ?`.
 */
export const acceptBelowRank = (status: DeliveryStatus): number =>
  PRE_SEND_TERMINALS.has(status) ? rankOf('sent') : rankOf(status);

/**
 * The status that stands after `incoming` meets `current` (data-model.md "Delivery status", AS-71): the higher rank
 * wins and an equal rank keeps the first, so `complained` outranks `bounced` and `delivered`, and `delivered` never
 * overwrites `bounced`, `failed` or `complained`. A pre-send terminal (`suppressed|capped|skipped|expired`) is
 * reachable only from `queued` or `delayed`: once a provider has been called, "nothing was sent" is no longer true.
 */
export function nextStatus(
  current: DeliveryStatus,
  incoming: DeliveryStatus,
): DeliveryStatus {
  if (PRE_SEND_TERMINALS.has(incoming) && rankOf(current) >= rankOf('sent'))
    return current;
  return rankOf(incoming) > rankOf(current) ? incoming : current;
}
