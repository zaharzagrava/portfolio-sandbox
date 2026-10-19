/**
 * Canonical consumer-group names of the journeys (S53 R-21). Some are the real Kafka group ids; the others are
 * aliases over one or several real groups, so no group was renamed (renaming would drop committed offsets). Buy to payout:
 *  - `statements-facts` is `statements-sales`, `statements-payouts` and `statements-ledger`;
 *  - `notification-router` is every `notifications-<family>` group.
 * Pausing, replaying or reading an alias acts on all of its member groups.
 */
export type CanonicalGroup =
  | {
      readonly groups: readonly string[];
      /** A queue consumer (not Kafka): its lag is the number of messages waiting in this queue. */
      readonly queue?: string;
    }
  | { readonly prefix: string };

export const CANONICAL_CONSUMER_GROUPS: Readonly<
  Record<string, CanonicalGroup>
> = {
  'payments-order-copy': { groups: ['payments-order-copy'] },
  'orders-payment-results': { groups: ['orders-payment-results'] },
  'ledger-settlement': { groups: ['ledger-settlement'] },
  'ledger-balances': { groups: ['ledger-balances'] },
  'statements-facts': {
    groups: ['statements-sales', 'statements-payouts', 'statements-ledger'],
  },
  'notification-router': { prefix: 'notifications-' },
  // The seller journey (J02). Aliases again, for the same reason: a renamed group would start from the first offset.
  'identity-seller-promotion': { groups: ['identity-shop-owner-promotion'] },
  'tenancy-shop-lifecycle': {
    groups: ['tenancy-verification', 'tenancy-shop-plan'],
  },
  'entitlements-invalidation': { groups: ['billing-entitlement-invalidation'] },
  'search-product-index': {
    groups: ['search-indexer', 'search-shop-state'],
  },
  // `webhook-router-orders`, `-products` and `-payouts` (the shop-deleted purge, `webhook-shop-deleted`, is not a router)
  'webhook-router': { prefix: 'webhook-router-' },
  leaderboards: {
    groups: [
      'seller-insights-boards',
      'seller-insights-shops',
      'seller-insights-products',
    ],
  },
  'product-cache-invalidator': { groups: ['product-cache-invalidator'] },
  // The document extractor is a queue worker, not a Kafka group: the name only carries the operator's hold (pause/resume).
  'document-extractor': { groups: ['document-extractor'] },
  // Catalog sync to search (J04). Aliases over the real groups of S08, S09 and S19; no group was renamed.
  'integrations-stock-push': {
    groups: [
      'catalog-sync-product-events',
      'catalog-sync-shop-offboarding',
      'catalog-sync-shop-deleted',
    ],
  },
  'offline-sync-feed': { groups: ['catalog-sync-offline-feed'] },
  'pickup-availability': {
    groups: [
      'pickup-index-stock',
      'pickup-index-shop',
      'pickup-index-product',
      'pickup-index-point',
    ],
  },
  // Launch day (J03). The voucher consumer is an SQS consumer of orders: pause is the Redis flag, lag the visible messages.
  'orders-booking-voucher': {
    groups: ['orders-booking-voucher'],
    queue: 'orders-booking-voucher-requested',
  },
};

/** The queue behind a canonical queue consumer, or null when the name is a Kafka group. */
export function queueOf(canonical: string): string | null {
  const def = CANONICAL_CONSUMER_GROUPS[canonical];
  return def && 'queue' in def && def.queue ? def.queue : null;
}

/** The canonical aliases a real group answers to besides its own name (a runner checks all their pause flags). */
export function aliasesOf(group: string): string[] {
  return Object.entries(CANONICAL_CONSUMER_GROUPS)
    .filter(([name, def]) =>
      name === group
        ? false
        : 'groups' in def
          ? def.groups.includes(group)
          : group.startsWith(def.prefix),
    )
    .map(([name]) => name);
}

/** The real groups a canonical name stands for, given the groups known to be declared. */
export function membersOf(
  canonical: string,
  declared: readonly string[],
): string[] | null {
  const def = CANONICAL_CONSUMER_GROUPS[canonical];
  if (!def) return null;
  return 'groups' in def
    ? [...def.groups]
    : declared.filter((g) => g.startsWith(def.prefix));
}
