import { z } from 'zod';
import { orderEventSchemas } from '../orders/order-events.ts';
import { paymentEventSchemas } from '../payments/payment-events.ts';

/**
 * Consumer-side schemas of the events S28 reads (specs/domains/S28-notifications/contracts/events.md). They list the
 * fields S28 renders or routes on, not everything a producer sends; unknown fields are stripped. A producer that ships
 * its own contract file replaces the matching entry (the fields stay the same). Payloads here never hold a secret
 * other than the two single-consumer messages marked below.
 */
const id = z.string().min(1);
const minor = z.number().int().nonnegative();
const version = z.number().int().nonnegative();

// ---- identity (S01, S02): `identity.events`, key = userId ------------------------------------------------------------
export const identityConsumedSchemas = {
  'identity.user_registered': z.object({ userId: id }),
  'identity.registration_duplicate_attempted': z.object({ userId: id }),
  'identity.password_changed': z.object({ userId: id }),
  'identity.mfa_enabled': z.object({ userId: id }),
  'identity.mfa_disabled': z.object({ userId: id, reason: z.string() }),
  'identity.mfa_recovery_code_used': z.object({
    userId: id,
    remaining: z.number().int().min(0),
  }),
  'identity.mfa_recovery_codes_regenerated': z.object({ userId: id }),
  'identity.federated_identity_linked': z.object({
    userId: id,
    provider: z.string(),
    linkMethod: z.string(),
    passwordInvalidated: z.boolean(),
    mfaReset: z.boolean(),
  }),
  'identity.federated_identity_unlinked': z.object({
    userId: id,
    provider: z.string(),
  }),
} as const;

// ---- tenancy (S03) ---------------------------------------------------------------------------------------------------
/** Single-consumer message on queue `tenancy-invite-requested`: carries the invite token, never logged or dead-lettered with its body. */
export const TENANCY_INVITE_QUEUE = 'tenancy-invite-requested';
export const inviteRequestedConsumedSchema = z.object({
  inviteId: id,
  shopId: id,
  shopName: z.string(),
  email: z.string(),
  role: z.string(),
  token: z.string().min(1),
  expiresAt: z.string(),
  invitedBy: id,
});
export type InviteRequestedMessage = z.infer<
  typeof inviteRequestedConsumedSchema
>;

export const tenancyConsumedSchemas = {
  'tenancy.shop_offboarding_started': z.object({
    shopId: id,
    purgeAt: z.string(),
    shopVersion: version,
  }),
  'tenancy.shop_offboarding_cancelled': z.object({
    shopId: id,
    shopVersion: version.optional(),
  }),
  /** Consumed and recorded as ignored (`reason=not_mapped`): owners cannot be resolved after the purge. */
  'tenancy.shop_deleted': z.object({
    shopId: id,
    shopVersion: version.optional(),
  }),
} as const;

// ---- shop onboarding (S04) -------------------------------------------------------------------------------------------
export const shopOnboardingConsumedSchemas = {
  'shop.verified': z.object({ shopId: id }),
  'shop.rejected': z.object({ shopId: id, reasonCode: z.string() }),
  'shop.onboarding_document_rejected': z.object({
    shopId: id,
    kind: z.string(),
    reason: z.string(),
  }),
} as const;

// ---- delivery (S20), auctions (S21) ----------------------------------------------------------------------------------
export const deliveryConsumedSchemas = {
  'delivery.status_changed': z.object({
    buyerId: id,
    orderId: id,
    status: z.string(),
    deliveryVersion: version,
  }),
} as const;

export const auctionConsumedSchemas = {
  'auction.leader_changed': z.object({
    auctionId: id,
    productId: id.optional(),
    previousLeaderId: id,
    leaderId: id.optional(),
    priceMinor: minor,
    currency: z.string(),
    auctionVersion: version,
  }),
  'auction.closed': z.object({
    auctionId: id,
    shopId: id,
    productId: id.optional(),
    winnerId: id.nullable(),
    finalPriceMinor: minor.nullable(),
    currency: z.string(),
    auctionVersion: version,
  }),
  'auction.second_chance_offered': z.object({
    auctionId: id,
    offeredToId: id,
    priceMinor: minor,
    currency: z.string(),
    expiresAt: z.string(),
    auctionVersion: version,
  }),
  'auction.sold': z.object({
    auctionId: id,
    shopId: id,
    finalPriceMinor: minor,
    currency: z.string(),
    auctionVersion: version,
  }),
} as const;

// ---- billing (S17), payouts (S15) ------------------------------------------------------------------------------------
export const billingConsumedSchemas = {
  'billing.invoice_payment_failed': z.object({
    subjectType: z.enum(['USER', 'SHOP']),
    subjectId: id,
    attempt: z.number().int().positive(),
    nextAttemptAt: z.string().nullable(),
    reason: z.string().optional(),
  }),
  'billing.invoice_paid': z.object({
    subjectType: z.enum(['USER', 'SHOP']),
    subjectId: id,
    totalMinor: minor,
    currency: z.string(),
  }),
} as const;

export const payoutConsumedSchemas = {
  'payout.paid': z.object({
    payoutId: id,
    shopId: id,
    amountMinor: minor,
    currency: z.string(),
    payoutVersion: version,
  }),
  'payout.failed': z.object({
    payoutId: id,
    shopId: id,
    amountMinor: minor,
    currency: z.string(),
    payoutVersion: version,
  }),
} as const;

// ---- launch events (S22), chat (S24), discussions (S25) --------------------------------------------------------------
export const launchEventConsumedSchemas = {
  'launch_events.booking_confirmed': z.object({
    userId: id,
    /**
     * The seats the buyer holds: S22 emits the seat numbers (J03 G-05); a bare count is still accepted. Either way the
     * notice shows how many.
     */
    seats: z.union([
      z.number().int().positive(),
      z.array(z.number().int()).min(1),
    ]),
    launchEventId: id,
  }),
} as const;

// ---- flash sales (S11): `orders.events`, key = saleId; the shop owners are told (J03 G-26) ------------------------------
export const flashSaleConsumedSchemas = {
  'flash_sale.sold_out': z.object({
    saleId: id,
    shopId: id,
    productId: id,
  }),
  'flash_sale.start_failed': z.object({
    saleId: id,
    shopId: id,
    productId: id,
    reason: z.string(),
  }),
} as const;

export const chatConsumedSchemas = {
  /** Dedupe on `dedupeKey` (the chat capability's own key), not the event id. */
  'chat.message_escalated': z.object({
    recipientId: id,
    channelId: id,
    channelTitle: z.string(),
    preview: z.string(),
    dedupeKey: id,
  }),
} as const;

export const discussionConsumedSchemas = {
  'discussion.comment_created': z.object({
    postId: id,
    authorId: id,
    parentAuthorId: id.nullable().optional(),
    postAuthorId: id,
    preview: z.string(),
  }),
} as const;

// ---- seller insights (S41), developer platform (S43), feed (S26) -----------------------------------------------------
export const sellerInsightsConsumedSchemas = {
  'seller_insights.competitor_price_dropped': z.object({
    watchId: id,
    shopId: id,
    productId: id,
    productTitle: z.string(),
    host: z.string(),
    competitorPriceMinor: minor,
    yourPriceMinor: minor,
    currency: z.string(),
    ownerId: id,
  }),
} as const;

export const developerPlatformConsumedSchemas = {
  'developer_platform.webhook_endpoint_disabled': z.object({
    endpointId: id,
    shopId: id,
    host: z.string(),
    failingSince: z.string(),
  }),
} as const;

export const FEED_NOTIFIED_KINDS = [
  'drop_announced',
  'auction_started',
] as const;
export const feedConsumedSchemas = {
  'feed.item_published': z.object({
    itemId: id,
    authorId: id,
    kind: z.string(),
    createdAt: z.string(),
  }),
} as const;

/**
 * Every consumed type with the payload version the consumer understands. Orders and payments reuse the producers'
 * own schemas (S10 `orderEventSchemas`, S13 `paymentEventSchemas`). A known type with another version is dead-lettered
 * as `unsupported_version`; a type missing here is ignored (`not_mapped`).
 */
const canonicalConsumedEventSchemas = {
  ...identityConsumedSchemas,
  ...tenancyConsumedSchemas,
  ...shopOnboardingConsumedSchemas,
  'order.paid': orderEventSchemas['order.paid'],
  'order.cancelled': orderEventSchemas['order.cancelled'],
  'order.refunded': orderEventSchemas['order.refunded'],
  'order.fulfilment_changed': orderEventSchemas['order.fulfilment_changed'],
  'payments.payment_failed': paymentEventSchemas['payments.payment_failed'],
  ...deliveryConsumedSchemas,
  ...auctionConsumedSchemas,
  ...billingConsumedSchemas,
  ...payoutConsumedSchemas,
  ...launchEventConsumedSchemas,
  ...flashSaleConsumedSchemas,
  ...chatConsumedSchemas,
  ...discussionConsumedSchemas,
  ...sellerInsightsConsumedSchemas,
  ...developerPlatformConsumedSchemas,
  ...feedConsumedSchemas,
} as const;

/**
 * The spec'd names of three event families (`launch_events.`, `seller_insights.`, `developer_platform.`) cannot be
 * produced: the S53 envelope pattern and the `Outbox` CHECK allow no `_` in the first segment of a type. Their
 * producers can emit the same event only under the name with that segment's underscores dropped, so S28 consumes
 * both: the alias is the name that works today, the canonical one is what the specs say (gaps.md "Sibling-spec
 * follow-ups": S53, S22, S41, S43). One mapping, one payload contract, two names.
 */
export const CONSUMED_EVENT_ALIASES = {
  'launchevents.booking_confirmed': 'launch_events.booking_confirmed',
  'flashsale.sold_out': 'flash_sale.sold_out',
  'flashsale.start_failed': 'flash_sale.start_failed',
  'sellerinsights.competitor_price_dropped':
    'seller_insights.competitor_price_dropped',
  'developerplatform.webhook_endpoint_disabled':
    'developer_platform.webhook_endpoint_disabled',
} as const satisfies Record<string, keyof typeof canonicalConsumedEventSchemas>;

export const consumedEventSchemas = {
  ...canonicalConsumedEventSchemas,
  'launchevents.booking_confirmed':
    canonicalConsumedEventSchemas['launch_events.booking_confirmed'],
  'flashsale.sold_out': canonicalConsumedEventSchemas['flash_sale.sold_out'],
  'flashsale.start_failed':
    canonicalConsumedEventSchemas['flash_sale.start_failed'],
  'sellerinsights.competitor_price_dropped':
    canonicalConsumedEventSchemas['seller_insights.competitor_price_dropped'],
  'developerplatform.webhook_endpoint_disabled':
    canonicalConsumedEventSchemas[
      'developer_platform.webhook_endpoint_disabled'
    ],
} as const;
/** The types the catalog mapping is written for. */
export type CanonicalConsumedEventType =
  keyof typeof canonicalConsumedEventSchemas;
export type ConsumedEventType = keyof typeof consumedEventSchemas;
/** The canonical type of a consumed type (an alias resolves to the spec'd name). */
export const canonicalConsumedType = (
  type: ConsumedEventType,
): CanonicalConsumedEventType =>
  (CONSUMED_EVENT_ALIASES as Record<string, CanonicalConsumedEventType>)[
    type
  ] ?? (type as CanonicalConsumedEventType);
export const CONSUMED_EVENT_VERSION = 1;
