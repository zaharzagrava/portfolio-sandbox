/**
 * Subscription topics and queues of notifications, one constant per source family
 * (specs/domains/S28-notifications/contracts/events.md "Consumed"). They are the consumer's assumption: each is checked
 * against the producer's actual topic name when that producer ships, and a mismatch is a sibling follow-up in gaps.md.
 * `orders.events`, `auctions.events` and `billing.events` keep the names the previous subscriptions used.
 */
export const NOTIFICATION_SOURCE_TOPICS = {
  identity: 'identity.events',
  tenancy: 'tenancy.events',
  shopOnboarding: 'shop-onboarding',
  orders: 'orders.events',
  payments: 'payments.events',
  delivery: 'delivery.events',
  auctions: 'auctions.events',
  billing: 'billing.events',
  payouts: 'payouts.events',
  launchEvents: 'launch_events.events',
  chat: 'chat.events',
  discussions: 'discussion.events',
  // Topics are `<aggregateType>.events` and an aggregate type is `[a-z][a-z0-9_]*` (S53): no hyphens. These two now have
  // producers (seller-insights crawler, developer-platform webhook deliverer) and use their aggregate types.
  sellerInsights: 'seller_insights.events',
  developerPlatform: 'developer_platform.events',
  feed: 'feed.events',
} as const;

export type NotificationSourceFamily = keyof typeof NOTIFICATION_SOURCE_TOPICS;

const FAMILY_BY_PREFIX: ReadonlyArray<[string, NotificationSourceFamily]> = [
  ['identity.', 'identity'],
  ['tenancy.', 'tenancy'],
  ['shop.', 'shopOnboarding'],
  ['order.', 'orders'],
  // Flash sales (S11) publish on `orders.events`: the sold-out and start-failed facts tell the shop owners (J03 G-26).
  ['flash_sale.', 'orders'],
  ['flashsale.', 'orders'],
  ['payments.', 'payments'],
  ['delivery.', 'delivery'],
  ['auction.', 'auctions'],
  ['billing.', 'billing'],
  ['payout.', 'payouts'],
  ['launch_events.', 'launchEvents'],
  ['launchevents.', 'launchEvents'],
  ['chat.', 'chat'],
  ['discussion.', 'discussions'],
  ['seller_insights.', 'sellerInsights'],
  ['sellerinsights.', 'sellerInsights'],
  ['developer_platform.', 'developerPlatform'],
  ['developerplatform.', 'developerPlatform'],
  ['feed.', 'feed'],
];

/** The source family an event type belongs to (by its prefix), or null for a type no consumer subscribes to. */
export const familyOfType = (type: string): NotificationSourceFamily | null =>
  FAMILY_BY_PREFIX.find(([prefix]) => type.startsWith(prefix))?.[1] ?? null;

/** Single-consumer message carrying the invite token (S03); never fanned out, never logged. */
export const INVITE_REQUESTED_QUEUE = 'tenancy-invite-requested';

/** Delivery lines live in the domain (the router names them); re-exported for the adapters. */
export {
  DELIVERY_QUEUES,
  deadLetterQueueOf,
  lineQueueOf,
} from '../domain/lines';

/** Accepted provider callbacks (deduplication id = provider event id). */
export const CALLBACK_QUEUE_NAME = 'notifications-callbacks';

/** Realtime topic and event name of an inbox announcement. */
export const userTopic = (userId: string) => `user:${userId}`;
export const NOTIFICATION_REALTIME_EVENT = 'notification';
