import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

export const SELLER_INSIGHTS_AGGREGATE = {
  aggregateType: 'seller_insights',
  retention: 'full-history',
} as const;

/**
 * A competitor's page now shows a price below the shop's own for a watched product. One event per owner of an
 * undercut watch (S41 FR-026): the aggregate version and `priceVersion` are the target's observation counter, the
 * event id is derived from (watch, `priceVersion`, owner), so a re-run writes no second row. Money is minor units
 * with one currency (the competitor page's), the same unit the undercut comparison uses.
 *
 * The spec'd type is `seller_insights.competitor_price_dropped`; the S53 envelope pattern allows no `_` in the first
 * segment of a type, so the event is emitted under the name that does (gaps.md of S28, "Sibling-spec follow-ups").
 */
export const CompetitorPriceDropped = defineEvent(
  'sellerinsights.competitor_price_dropped',
  'seller_insights',
  1,
  z.object({
    watchId: z.string(),
    shopId: z.string(),
    productId: z.string(),
    productTitle: z.string(),
    host: z.string(),
    competitorPriceMinor: z.number().int().nonnegative(),
    yourPriceMinor: z.number().int().nonnegative(),
    currency: z.string(),
    ownerId: z.string(),
    priceVersion: z.number().int().positive(),
  }),
);
