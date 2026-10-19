import {
  CONSUMED_EVENT_ALIASES,
  EVENT_TYPE_PATTERN,
  consumedEventSchemas,
} from '@marketplace-sandbox/contracts';
import type { ConsumedEventType } from '@marketplace-sandbox/contracts';
import { CATEGORIES, NOTIFICATION_TYPES } from './catalog';
import type { NotificationType } from './catalog';
import { mapEvent, mapInviteRequested } from './event-mapping';
import type { MappedRecipient } from './event-mapping';

const ORDER = '0c1f3a52-7d6e-4b8e-9d1a-6a2f6f4f0001';
const meta = {
  eventId: 'E1',
  occurredAt: '2026-10-13T10:00:00.000Z',
  aggregateId: 'AGG-1',
};

const user = (userId: string): MappedRecipient => ({ kind: 'user', userId });
const owners = (shopId: string): MappedRecipient => ({
  kind: 'shopOwners',
  shopId,
});

type Row = {
  name: string;
  type: ConsumedEventType;
  payload: Record<string, unknown>;
  /** One entry per expected request, in order. `data` is a subset match. */
  requests: Array<{
    type: NotificationType;
    recipient: MappedRecipient;
    data?: Record<string, string>;
    sourceId?: string;
  }>;
};

const orderPaid = {
  orderId: ORDER,
  userId: 'B',
  orderVersion: 3,
  totalMinor: 129_900,
  currency: 'USD',
  paymentRef: 'pay_1',
  paidAt: '2026-10-13T09:59:00.000Z',
  lines: [],
  shopOrders: [
    { shopOrderId: 'SO1', shopId: 'S1', subtotalMinor: 100_000 },
    { shopOrderId: 'SO2', shopId: 'S2', subtotalMinor: 29_900 },
    { shopOrderId: 'SO3', shopId: null, subtotalMinor: 0 },
  ],
};

/** One row per catalog row of contracts/events.md that produces requests. */
const MAPPED: Row[] = [
  {
    name: 'identity.user_registered',
    type: 'identity.user_registered',
    payload: { userId: 'U1' },
    requests: [{ type: 'account.welcome', recipient: user('U1') }],
  },
  {
    name: 'identity.registration_duplicate_attempted notifies the account owner and never carries the attempted address',
    type: 'identity.registration_duplicate_attempted',
    payload: { userId: 'U1', email: 'attacker@example.com' },
    requests: [
      { type: 'security.registration_attempt', recipient: user('U1') },
    ],
  },
  {
    name: 'identity.password_changed',
    type: 'identity.password_changed',
    payload: { userId: 'U1' },
    requests: [{ type: 'security.password_changed', recipient: user('U1') }],
  },
  {
    name: 'identity.mfa_enabled',
    type: 'identity.mfa_enabled',
    payload: { userId: 'U1' },
    requests: [{ type: 'security.mfa_enabled', recipient: user('U1') }],
  },
  {
    name: 'identity.mfa_disabled',
    type: 'identity.mfa_disabled',
    payload: { userId: 'U1', reason: 'user_request' },
    requests: [
      {
        type: 'security.mfa_disabled',
        recipient: user('U1'),
        data: { reason: 'user_request' },
      },
    ],
  },
  {
    name: 'identity.mfa_recovery_code_used',
    type: 'identity.mfa_recovery_code_used',
    payload: { userId: 'U1', remaining: 4 },
    requests: [
      {
        type: 'security.recovery_code_used',
        recipient: user('U1'),
        data: { remaining: '4' },
      },
    ],
  },
  {
    name: 'identity.mfa_recovery_codes_regenerated',
    type: 'identity.mfa_recovery_codes_regenerated',
    payload: { userId: 'U1' },
    requests: [
      { type: 'security.recovery_codes_regenerated', recipient: user('U1') },
    ],
  },
  {
    name: 'identity.federated_identity_linked passes the flags as text',
    type: 'identity.federated_identity_linked',
    payload: {
      userId: 'U1',
      provider: 'google',
      linkMethod: 'login',
      passwordInvalidated: true,
      mfaReset: false,
    },
    requests: [
      {
        type: 'security.sign_in_method_added',
        recipient: user('U1'),
        data: {
          provider: 'google',
          passwordInvalidated: 'true',
          mfaReset: 'false',
        },
      },
    ],
  },
  {
    name: 'identity.federated_identity_unlinked',
    type: 'identity.federated_identity_unlinked',
    payload: { userId: 'U1', provider: 'google' },
    requests: [
      {
        type: 'security.sign_in_method_removed',
        recipient: user('U1'),
        data: { provider: 'google' },
      },
    ],
  },
  {
    name: 'tenancy.shop_offboarding_started goes to the shop owners',
    type: 'tenancy.shop_offboarding_started',
    payload: {
      shopId: 'S1',
      purgeAt: '2026-11-01T00:00:00.000Z',
      shopVersion: 4,
    },
    requests: [
      {
        type: 'shop.offboarding_started',
        recipient: owners('S1'),
        data: { purgeAt: '2026-11-01T00:00:00.000Z' },
      },
    ],
  },
  {
    name: 'tenancy.shop_offboarding_cancelled',
    type: 'tenancy.shop_offboarding_cancelled',
    payload: { shopId: 'S1' },
    requests: [{ type: 'shop.offboarding_cancelled', recipient: owners('S1') }],
  },
  {
    name: 'shop.verified',
    type: 'shop.verified',
    payload: { shopId: 'S1' },
    requests: [{ type: 'shop.verified', recipient: owners('S1') }],
  },
  {
    name: 'shop.rejected',
    type: 'shop.rejected',
    payload: { shopId: 'S1', reasonCode: 'docs_unreadable' },
    requests: [
      {
        type: 'shop.rejected',
        recipient: owners('S1'),
        data: { reasonCode: 'docs_unreadable' },
      },
    ],
  },
  {
    name: 'shop.onboarding_document_rejected',
    type: 'shop.onboarding_document_rejected',
    payload: { shopId: 'S1', kind: 'passport', reason: 'blurry' },
    requests: [
      {
        type: 'shop.document_rejected',
        recipient: owners('S1'),
        data: { kind: 'passport', reason: 'blurry' },
      },
    ],
  },
  {
    name: 'order.paid: one order.confirmed for the buyer and one shop.order_received per shop order with a shop',
    type: 'order.paid',
    payload: orderPaid,
    requests: [
      {
        type: 'order.confirmed',
        recipient: user('B'),
        sourceId: 'E1',
        data: {
          orderId: ORDER,
          orderShort: '0C1F3A52',
          totalMinor: '129900',
          currency: 'USD',
        },
      },
      {
        type: 'shop.order_received',
        recipient: owners('S1'),
        sourceId: 'E1:S1',
        data: {
          orderId: ORDER,
          shopId: 'S1',
          subtotalMinor: '100000',
          currency: 'USD',
        },
      },
      {
        type: 'shop.order_received',
        recipient: owners('S2'),
        sourceId: 'E1:S2',
        data: { shopId: 'S2', subtotalMinor: '29900' },
      },
    ],
  },
  {
    name: 'order.cancelled out_of_stock',
    type: 'order.cancelled',
    payload: {
      orderId: ORDER,
      userId: 'B',
      orderVersion: 4,
      reason: 'out_of_stock',
      previousStatus: 'RESERVED',
    },
    requests: [
      {
        type: 'order.cancelled',
        recipient: user('B'),
        data: { orderId: ORDER, reason: 'out_of_stock' },
      },
    ],
  },
  {
    name: 'order.cancelled hold_expired',
    type: 'order.cancelled',
    payload: {
      orderId: ORDER,
      userId: 'B',
      orderVersion: 4,
      reason: 'hold_expired',
      previousStatus: 'RESERVED',
    },
    requests: [
      {
        type: 'order.cancelled',
        recipient: user('B'),
        data: { reason: 'hold_expired' },
      },
    ],
  },
  {
    name: 'order.refunded',
    type: 'order.refunded',
    payload: {
      orderId: ORDER,
      userId: 'B',
      orderVersion: 5,
      amountMinor: 5000,
      currency: 'USD',
      reason: 'customer_request',
    },
    requests: [
      {
        type: 'order.refunded',
        recipient: user('B'),
        data: { orderId: ORDER, amountMinor: '5000', currency: 'USD' },
      },
    ],
  },
  {
    name: 'order.fulfilment_changed SHIPPED carries the tracking code',
    type: 'order.fulfilment_changed',
    payload: {
      orderId: ORDER,
      userId: 'B',
      orderVersion: 6,
      status: 'SHIPPED',
      trackingCode: 'TRK-1',
    },
    requests: [
      {
        type: 'order.shipped',
        recipient: user('B'),
        data: { orderId: ORDER, trackingCode: 'TRK-1' },
      },
    ],
  },
  {
    name: 'order.fulfilment_changed DELIVERED',
    type: 'order.fulfilment_changed',
    payload: {
      orderId: ORDER,
      userId: 'B',
      orderVersion: 7,
      status: 'DELIVERED',
    },
    requests: [
      {
        type: 'order.delivered',
        recipient: user('B'),
        data: { orderId: ORDER },
      },
    ],
  },
  {
    name: 'payments.payment_failed',
    type: 'payments.payment_failed',
    payload: {
      paymentId: 'P1',
      orderId: ORDER,
      userId: 'B',
      amountMinor: 2500,
      currency: 'EUR',
      occurredAt: '2026-10-13T09:00:00.000Z',
      paymentRef: null,
      reasonCode: 'card_declined',
      paymentVersion: 2,
    },
    requests: [
      {
        type: 'payment.failed',
        recipient: user('B'),
        data: {
          orderId: ORDER,
          amountMinor: '2500',
          currency: 'EUR',
          reasonCode: 'card_declined',
        },
      },
    ],
  },
  {
    name: 'delivery.status_changed PICKED_UP goes to the buyer',
    type: 'delivery.status_changed',
    payload: {
      buyerId: 'B',
      orderId: ORDER,
      status: 'PICKED_UP',
      deliveryVersion: 3,
    },
    requests: [
      {
        type: 'delivery.picked_up',
        recipient: user('B'),
        data: { orderId: ORDER },
      },
    ],
  },
  {
    name: 'delivery.status_changed CANCELLED',
    type: 'delivery.status_changed',
    payload: {
      buyerId: 'B',
      orderId: ORDER,
      status: 'CANCELLED',
      deliveryVersion: 3,
    },
    requests: [{ type: 'delivery.cancelled', recipient: user('B') }],
  },
  {
    name: 'auction.leader_changed notifies the previous leader',
    type: 'auction.leader_changed',
    payload: {
      auctionId: 'A1',
      previousLeaderId: 'L',
      leaderId: 'N',
      priceMinor: 50_000,
      currency: 'USD',
      auctionVersion: 6,
    },
    requests: [
      {
        type: 'auction.outbid',
        recipient: user('L'),
        data: { auctionId: 'A1', priceMinor: '50000', currency: 'USD' },
      },
    ],
  },
  {
    name: 'auction.closed with a winner',
    type: 'auction.closed',
    payload: {
      auctionId: 'A1',
      shopId: 'S1',
      winnerId: 'W',
      finalPriceMinor: 70_000,
      currency: 'USD',
      auctionVersion: 7,
    },
    requests: [
      {
        type: 'auction.won',
        recipient: user('W'),
        data: { auctionId: 'A1', priceMinor: '70000', currency: 'USD' },
      },
    ],
  },
  {
    name: 'auction.second_chance_offered',
    type: 'auction.second_chance_offered',
    payload: {
      auctionId: 'A1',
      offeredToId: 'R',
      priceMinor: 60_000,
      currency: 'USD',
      expiresAt: '2026-10-14T10:00:00.000Z',
      auctionVersion: 8,
    },
    requests: [
      {
        type: 'auction.second_chance',
        recipient: user('R'),
        data: { expiresAt: '2026-10-14T10:00:00.000Z', priceMinor: '60000' },
      },
    ],
  },
  {
    name: 'auction.sold goes to the shop owners',
    type: 'auction.sold',
    payload: {
      auctionId: 'A1',
      shopId: 'S1',
      finalPriceMinor: 70_000,
      currency: 'USD',
      auctionVersion: 9,
    },
    requests: [
      {
        type: 'auction.sold',
        recipient: owners('S1'),
        data: { priceMinor: '70000' },
      },
    ],
  },
  {
    name: 'billing.invoice_payment_failed for a user with a next attempt',
    type: 'billing.invoice_payment_failed',
    payload: {
      subjectType: 'USER',
      subjectId: 'U1',
      attempt: 2,
      nextAttemptAt: '2026-10-16T10:00:00.000Z',
      reason: 'authentication_required',
    },
    requests: [
      {
        type: 'billing.payment_failed',
        recipient: user('U1'),
        data: { attempt: '2', reason: 'authentication_required' },
      },
    ],
  },
  {
    name: 'billing.invoice_payment_failed for a shop goes to the owners',
    type: 'billing.invoice_payment_failed',
    payload: {
      subjectType: 'SHOP',
      subjectId: 'S1',
      attempt: 1,
      nextAttemptAt: '2026-10-16T10:00:00.000Z',
    },
    requests: [
      {
        type: 'billing.payment_failed',
        recipient: owners('S1'),
        data: { attempt: '1', reason: '' },
      },
    ],
  },
  {
    name: 'billing.invoice_payment_failed with nextAttemptAt null is access_withdrawn',
    type: 'billing.invoice_payment_failed',
    payload: {
      subjectType: 'USER',
      subjectId: 'U1',
      attempt: 4,
      nextAttemptAt: null,
    },
    requests: [{ type: 'billing.access_withdrawn', recipient: user('U1') }],
  },
  {
    name: 'billing.invoice_paid',
    type: 'billing.invoice_paid',
    payload: {
      subjectType: 'SHOP',
      subjectId: 'S1',
      totalMinor: 4900,
      currency: 'USD',
    },
    requests: [
      {
        type: 'billing.receipt',
        recipient: owners('S1'),
        data: { totalMinor: '4900', currency: 'USD' },
      },
    ],
  },
  {
    name: 'payout.paid',
    type: 'payout.paid',
    payload: {
      payoutId: 'PO1',
      shopId: 'S1',
      amountMinor: 120_000,
      currency: 'USD',
      payoutVersion: 2,
    },
    requests: [
      {
        type: 'payout.paid',
        recipient: owners('S1'),
        data: { payoutId: 'PO1', amountMinor: '120000', currency: 'USD' },
      },
    ],
  },
  {
    name: 'payout.failed',
    type: 'payout.failed',
    payload: {
      payoutId: 'PO1',
      shopId: 'S1',
      amountMinor: 120_000,
      currency: 'USD',
      payoutVersion: 3,
    },
    requests: [{ type: 'payout.failed', recipient: owners('S1') }],
  },
  {
    name: 'launch_events.booking_confirmed shows the seat count',
    type: 'launch_events.booking_confirmed',
    payload: { userId: 'U1', seats: 3, launchEventId: 'LE1' },
    requests: [
      {
        type: 'booking.confirmed',
        recipient: user('U1'),
        data: { seats: '3', launchEventId: 'LE1' },
      },
    ],
  },
  {
    name: 'chat.message_escalated dedupes on the chat key and carries no sender',
    type: 'chat.message_escalated',
    payload: {
      recipientId: 'U2',
      channelId: 'CH1',
      channelTitle: 'Order help',
      preview: 'Hello there',
      dedupeKey: 'chat-key-1',
    },
    requests: [
      {
        type: 'chat.message',
        recipient: user('U2'),
        sourceId: 'chat-key-1',
        data: {
          channelId: 'CH1',
          channelTitle: 'Order help',
          preview: 'Hello there',
        },
      },
    ],
  },
  {
    name: 'discussion.comment_created: a reply notifies the parent author',
    type: 'discussion.comment_created',
    payload: {
      postId: 'PST',
      authorId: 'C',
      parentAuthorId: 'PA',
      postAuthorId: 'OWN',
      preview: 'nice',
    },
    requests: [
      {
        type: 'discussion.reply',
        recipient: user('PA'),
        data: { postId: 'PST', preview: 'nice' },
      },
    ],
  },
  {
    name: 'discussion.comment_created: a parent author who also owns the post is notified once',
    type: 'discussion.comment_created',
    payload: {
      postId: 'PST',
      authorId: 'C',
      parentAuthorId: 'OWN',
      postAuthorId: 'OWN',
      preview: 'nice',
    },
    requests: [{ type: 'discussion.reply', recipient: user('OWN') }],
  },
  {
    name: 'discussion.comment_created: a top-level comment notifies the post author',
    type: 'discussion.comment_created',
    payload: {
      postId: 'PST',
      authorId: 'C',
      parentAuthorId: null,
      postAuthorId: 'OWN',
      preview: 'nice',
    },
    requests: [{ type: 'discussion.comment', recipient: user('OWN') }],
  },
  {
    name: 'flash_sale.sold_out tells the shop owners, once per sale',
    type: 'flash_sale.sold_out',
    payload: { saleId: 'SALE1', shopId: 'S1', productId: 'PR1' },
    requests: [
      {
        type: 'shop.flash_sale_sold_out',
        recipient: owners('S1'),
        sourceId: 'SALE1',
        data: { shopId: 'S1', saleId: 'SALE1' },
      },
    ],
  },
  {
    name: 'flash_sale.start_failed tells the shop owners why',
    type: 'flash_sale.start_failed',
    payload: {
      saleId: 'SALE1',
      shopId: 'S1',
      productId: 'PR1',
      reason: 'stock_changed',
    },
    requests: [
      {
        type: 'shop.flash_sale_start_failed',
        recipient: owners('S1'),
        sourceId: 'SALE1',
        data: { shopId: 'S1', saleId: 'SALE1', reason: 'stock_changed' },
      },
    ],
  },
  {
    name: 'seller_insights.competitor_price_dropped goes to the owner',
    type: 'seller_insights.competitor_price_dropped',
    payload: {
      watchId: 'W1',
      shopId: 'S1',
      productId: 'PR1',
      productTitle: 'Lamp',
      host: 'rival.example',
      competitorPriceMinor: 900,
      yourPriceMinor: 1200,
      currency: 'USD',
      ownerId: 'OW',
    },
    requests: [
      {
        type: 'insights.competitor_price_drop',
        recipient: user('OW'),
        data: {
          product: 'Lamp',
          host: 'rival.example',
          competitorPriceMinor: '900',
          yourPriceMinor: '1200',
          currency: 'USD',
          shopId: 'S1',
          productId: 'PR1',
        },
      },
    ],
  },
  {
    name: 'developer_platform.webhook_endpoint_disabled shows the host only',
    type: 'developer_platform.webhook_endpoint_disabled',
    payload: {
      endpointId: 'EP1',
      shopId: 'S1',
      host: 'hooks.example',
      failingSince: '2026-10-10T00:00:00.000Z',
    },
    requests: [
      {
        type: 'developers.webhook_endpoint_disabled',
        recipient: owners('S1'),
        data: { host: 'hooks.example', endpointId: 'EP1', shopId: 'S1' },
      },
    ],
  },
  {
    name: 'feed.item_published drop_announced fans out to the followers of the author',
    type: 'feed.item_published',
    payload: {
      itemId: 'I1',
      authorId: 'SHOPACC',
      kind: 'drop_announced',
      createdAt: '2026-10-13T09:00:00.000Z',
    },
    requests: [
      {
        type: 'marketing.followed_shop_update',
        recipient: { kind: 'followers', accountId: 'SHOPACC' },
        data: { itemId: 'I1', kind: 'drop_announced' },
      },
    ],
  },
  {
    name: 'feed.item_published auction_started',
    type: 'feed.item_published',
    payload: {
      itemId: 'I2',
      authorId: 'SHOPACC',
      kind: 'auction_started',
      createdAt: '2026-10-13T09:00:00.000Z',
    },
    requests: [
      {
        type: 'marketing.followed_shop_update',
        recipient: { kind: 'followers', accountId: 'SHOPACC' },
      },
    ],
  },
];

/** Valid events that must produce nothing, with the reason the counter carries. */
const IGNORED: Array<{
  name: string;
  type: ConsumedEventType;
  payload: Record<string, unknown>;
  reason: string;
}> = [
  {
    name: 'tenancy.shop_deleted is recorded and not mailed',
    type: 'tenancy.shop_deleted',
    payload: { shopId: 'S1' },
    reason: 'not_mapped',
  },
  {
    name: 'order.cancelled user_cancelled',
    type: 'order.cancelled',
    payload: {
      orderId: ORDER,
      userId: 'B',
      orderVersion: 4,
      reason: 'user_cancelled',
      previousStatus: 'RESERVED',
    },
    reason: 'filtered_reason',
  },
  {
    name: 'order.cancelled payment_failed (the payment notice covers it)',
    type: 'order.cancelled',
    payload: {
      orderId: ORDER,
      userId: 'B',
      orderVersion: 4,
      reason: 'payment_failed',
      previousStatus: 'RESERVED',
    },
    reason: 'filtered_reason',
  },
  {
    name: 'order.fulfilment_changed FULFILLING',
    type: 'order.fulfilment_changed',
    payload: {
      orderId: ORDER,
      userId: 'B',
      orderVersion: 5,
      status: 'FULFILLING',
    },
    reason: 'not_mapped',
  },
  ...(['order_not_payable', 'order_cancelled'] as const).map((reasonCode) => ({
    name: `payments.payment_failed ${reasonCode}`,
    type: 'payments.payment_failed' as const,
    payload: {
      paymentId: 'P1',
      orderId: ORDER,
      userId: 'B',
      amountMinor: 2500,
      currency: 'EUR',
      occurredAt: '2026-10-13T09:00:00.000Z',
      paymentRef: null,
      reasonCode,
      paymentVersion: 2,
    },
    reason: 'filtered_reason',
  })),
  {
    name: 'delivery.status_changed DELIVERED is covered by order.delivered',
    type: 'delivery.status_changed',
    payload: {
      buyerId: 'B',
      orderId: ORDER,
      status: 'DELIVERED',
      deliveryVersion: 4,
    },
    reason: 'not_mapped',
  },
  {
    name: 'auction.closed without a winner',
    type: 'auction.closed',
    payload: {
      auctionId: 'A1',
      shopId: 'S1',
      winnerId: null,
      finalPriceMinor: null,
      currency: 'USD',
      auctionVersion: 7,
    },
    reason: 'no_winner',
  },
  {
    name: 'discussion.comment_created by the post author on their own post',
    type: 'discussion.comment_created',
    payload: {
      postId: 'PST',
      authorId: 'OWN',
      parentAuthorId: null,
      postAuthorId: 'OWN',
      preview: 'me',
    },
    reason: 'no_recipient',
  },
  {
    name: 'discussion.comment_created replying to oneself',
    type: 'discussion.comment_created',
    payload: {
      postId: 'PST',
      authorId: 'C',
      parentAuthorId: 'C',
      postAuthorId: 'OWN',
      preview: 'me',
    },
    reason: 'no_recipient',
  },
  {
    name: 'feed.item_published of another kind',
    type: 'feed.item_published',
    payload: {
      itemId: 'I3',
      authorId: 'SHOPACC',
      kind: 'photo',
      createdAt: '2026-10-13T09:00:00.000Z',
    },
    reason: 'not_mapped',
  },
];

describe('S28 AS-13: event mapping rules (pure)', () => {
  it.each(MAPPED)('S28 AS-13: $name', ({ type, payload, requests }) => {
    const valid = consumedEventSchemas[type].parse(payload);
    const result = mapEvent(type, valid, meta);
    expect(result).toMatchObject({ kind: 'requests' });
    if (result.kind !== 'requests') return;
    expect(result.requests).toHaveLength(requests.length);
    requests.forEach((expected, i) => {
      expect(result.requests[i]).toMatchObject({
        type: expected.type,
        recipient: expected.recipient,
        sourceId: expected.sourceId ?? 'E1',
        occurredAt: meta.occurredAt,
        ...(expected.data && { data: expected.data }),
      });
    });
  });

  it.each(Object.entries(CONSUMED_EVENT_ALIASES))(
    'S28 AS-13: %s is the same event as %s (S53 allows no "_" in the first segment of a type)',
    (alias, canonical) => {
      const row = MAPPED.find((r) => r.type === canonical)!;
      const asAlias = alias as ConsumedEventType;
      const payload = consumedEventSchemas[asAlias].parse(row.payload);
      expect(mapEvent(asAlias, payload, meta)).toEqual(
        mapEvent(row.type, payload, meta),
      );
      expect(EVENT_TYPE_PATTERN.test(alias)).toBe(true);
      expect(EVENT_TYPE_PATTERN.test(canonical)).toBe(false);
    },
  );

  it.each(IGNORED)(
    'S28 AS-13: ignored, $name ($reason)',
    ({ type, payload, reason }) => {
      const valid = consumedEventSchemas[type].parse(payload);
      expect(mapEvent(type, valid, meta)).toMatchObject({
        kind: 'ignored',
        reason,
      });
    },
  );

  it('S28 AS-13: every data value is a string and no request carries a secret field', () => {
    for (const row of MAPPED) {
      const valid = consumedEventSchemas[row.type].parse(row.payload);
      const result = mapEvent(row.type, valid, meta);
      if (result.kind !== 'requests') continue;
      for (const request of result.requests)
        for (const [key, value] of Object.entries(request.data)) {
          expect(typeof value).toBe('string');
          expect(key).not.toMatch(/^(token|resetToken|secret|password)$/i);
        }
    }
  });

  it('S28 AS-13: monotonic aggregates report their version stamp, mapped or not', () => {
    const paid = consumedEventSchemas['order.paid'].parse(orderPaid);
    expect(mapEvent('order.paid', paid, meta).version).toEqual({
      family: 'order',
      aggregateId: ORDER,
      version: 3,
    });
    const delivered = consumedEventSchemas['delivery.status_changed'].parse({
      buyerId: 'B',
      orderId: ORDER,
      status: 'DELIVERED',
      deliveryVersion: 4,
    });
    expect(mapEvent('delivery.status_changed', delivered, meta)).toMatchObject({
      kind: 'ignored',
      version: { family: 'delivery', aggregateId: ORDER, version: 4 },
    });
    const leader = consumedEventSchemas['auction.leader_changed'].parse({
      auctionId: 'A1',
      previousLeaderId: 'L',
      priceMinor: 1,
      currency: 'USD',
      auctionVersion: 6,
    });
    expect(mapEvent('auction.leader_changed', leader, meta).version).toEqual({
      family: 'auction',
      aggregateId: 'A1',
      version: 6,
    });
    const payout = consumedEventSchemas['payout.paid'].parse({
      payoutId: 'PO1',
      shopId: 'S1',
      amountMinor: 1,
      currency: 'USD',
      payoutVersion: 2,
    });
    expect(mapEvent('payout.paid', payout, meta).version).toEqual({
      family: 'payout',
      aggregateId: 'PO1',
      version: 2,
    });
    const welcome = consumedEventSchemas['identity.user_registered'].parse({
      userId: 'U1',
    });
    expect(mapEvent('identity.user_registered', welcome, meta).version).toBe(
      undefined,
    );
  });

  it('S28 AS-13: payment_failed without a payment version has no stamp; the request carries its stamp otherwise', () => {
    const base = {
      paymentId: 'P1',
      orderId: ORDER,
      userId: 'B',
      amountMinor: 2500,
      currency: 'EUR',
      occurredAt: '2026-10-13T09:00:00.000Z',
      paymentRef: null,
    };
    const without = consumedEventSchemas['payments.payment_failed'].parse(base);
    expect(
      mapEvent('payments.payment_failed', without, meta).version,
    ).toBeUndefined();
    const withVersion = consumedEventSchemas['payments.payment_failed'].parse({
      ...base,
      paymentVersion: 5,
    });
    const result = mapEvent('payments.payment_failed', withVersion, meta);
    expect(result.version).toEqual({
      family: 'payment',
      aggregateId: 'P1',
      version: 5,
    });
    if (result.kind === 'requests')
      expect(result.requests[0]).toMatchObject({
        family: 'payment',
        aggregateId: 'P1',
        sourceVersion: 5,
      });
  });

  it('S28 AS-13: the invite message maps to an address recipient, deduped on the invite id, with the token only in data', () => {
    const request = mapInviteRequested(
      {
        inviteId: 'INV1',
        shopId: 'S1',
        shopName: 'Lamps & Co',
        email: 'new@mail.com',
        role: 'STAFF',
        token: 'T',
        expiresAt: '2026-10-20T00:00:00.000Z',
        invitedBy: 'U1',
      },
      { occurredAt: meta.occurredAt },
    );
    expect(request).toMatchObject({
      type: 'shop.invite',
      recipient: { kind: 'address', email: 'new@mail.com' },
      sourceId: 'INV1',
      data: { token: 'T', shopName: 'Lamps & Co', role: 'STAFF' },
    });
  });

  it('S28 AS-13: the catalog covers 13 categories and every mapped type exists in it', () => {
    expect(new Set(CATEGORIES).size).toBe(13);
    const used = new Set(
      Object.values(NOTIFICATION_TYPES).map((def) => def.category),
    );
    expect([...used].sort()).toEqual([...CATEGORIES].sort());
    for (const row of MAPPED)
      for (const r of row.requests)
        expect(Object.keys(NOTIFICATION_TYPES)).toContain(r.type);
  });
});
