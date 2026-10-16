import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of the delivery capability (S20 FR-047, AS-57). Labels are fixed enums or the `city` slug
 * (`^[a-z0-9-]{2,40}$`, bounded by the cities that have couriers): never a delivery, courier, shop, coordinate,
 * address or token (A27).
 */
export const OFFER_OUTCOMES = [
  'offered',
  'accepted',
  'declined',
  'expired',
  'withdrawn',
] as const;
export type OfferOutcome = (typeof OFFER_OUTCOMES)[number];

export const LOCATION_RESULTS = [
  'applied',
  'late',
  'stale',
  'future',
  'off_shift',
] as const;
export type LocationResult = (typeof LOCATION_RESULTS)[number];

export const WRITE_BACK_RESULTS = [
  'applied',
  'already_reached',
  'retried',
  'dead_lettered',
  'skipped_multi_shop',
] as const;
export type WriteBackResult = (typeof WRITE_BACK_RESULTS)[number];

const CITY_SLUG = /^[a-z0-9-]{2,40}$/;
/** A city as a metric label: the registered slug, or `invalid` for anything else (the label set stays bounded). */
export const cityLabel = (city: string): string =>
  CITY_SLUG.test(city) ? city : 'invalid';

export const DeliveryMetrics = {
  offers: MetricsRegistry.counter({
    name: 'delivery_offers_total',
    help: 'Offers by outcome (offered, accepted, declined, expired, withdrawn)',
    labels: ['outcome'],
  }),
  dispatchAttempts: MetricsRegistry.counter({
    name: 'delivery_dispatch_attempts_total',
    help: 'Dispatch attempts by city and result (offered, no_candidate, lost_race)',
    labels: ['city', 'result'],
  }),
  giveUps: MetricsRegistry.counter({
    name: 'delivery_give_ups_total',
    help: 'Deliveries cancelled with no_courier_available after the last attempt',
    labels: ['city'],
  }),
  requestToAssignment: MetricsRegistry.histogram({
    name: 'delivery_request_to_assignment_seconds',
    help: 'Seconds from the delivery request to the accepted offer',
    labels: [],
    buckets: [1, 5, 15, 30, 60, 120, 300, 600],
  }),
  locationPoints: MetricsRegistry.counter({
    name: 'courier_location_points_total',
    help: 'Reported points by result (applied, late, stale, future, off_shift)',
    labels: ['result'],
  }),
  historyFailures: MetricsRegistry.counter({
    name: 'courier_history_failures_total',
    help: 'History messages that could not be produced or stored, by stage (produce, store)',
    labels: ['stage'],
  }),
  recoveredTimers: MetricsRegistry.counter({
    name: 'delivery_recovered_timers_total',
    help: 'Overdue offers and retries acted on by the recovery job, by kind (offer_expiry, dispatch_retry)',
    labels: ['kind'],
  }),
  orderWriteBack: MetricsRegistry.counter({
    name: 'delivery_order_write_back_total',
    help: 'Order lifecycle write-backs by result',
    labels: ['result'],
  }),
  handBacks: MetricsRegistry.counter({
    name: 'delivery_hand_backs_total',
    help: 'Timer messages handed back to the owning dispatcher instance, by city',
    labels: ['city'],
  }),
  dispatchFailures: MetricsRegistry.counter({
    name: 'delivery_dispatch_failures_total',
    help: 'Dispatch operations that failed, by city',
    labels: ['city'],
  }),
  pushFailures: MetricsRegistry.counter({
    name: 'delivery_push_failures_total',
    help: 'Realtime pushes that failed after a commit (best effort), by topic kind (delivery, user)',
    labels: ['topic'],
  }),
  doubleAssignments: MetricsRegistry.counter({
    name: 'fulfilment_double_assignments_total',
    help: 'Couriers found with more than one live offer or active assignment (must stay 0)',
    labels: [],
  }),
};
