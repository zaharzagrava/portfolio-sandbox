import { canonicalConsumedType } from '@marketplace-sandbox/contracts';
import type {
  CanonicalConsumedEventType,
  ConsumedEventType,
  InviteRequestedMessage,
  consumedEventSchemas,
} from '@marketplace-sandbox/contracts';
import type { z } from 'zod';
import type { NotificationType } from './catalog';

/**
 * Event -> notification requests: one typed mapping per row of the catalog in contracts/events.md. Pure: no store, no
 * clock, no I/O. Recipients come out unresolved (`shopOwners`, `followers` are expanded by the routing service, which
 * is where the batched directory lookups happen). Template data is flat text; money stays as `...Minor` + `currency`
 * and is formatted in the recipient's locale at render time (FR-009).
 */

export type MappedRecipient =
  | { kind: 'user'; userId: string }
  | { kind: 'shopOwners'; shopId: string }
  | { kind: 'address'; email: string }
  | { kind: 'followers'; accountId: string };

/** A request before its recipient is resolved; `routing` turns it into one `RoutingRequest` per resolved user. */
export interface MappedRequest {
  type: NotificationType;
  recipient: MappedRecipient;
  data: Record<string, string>;
  /** Source event id, or the owner's own dedupe key (chat). */
  sourceId: string;
  occurredAt: string;
  sourceVersion?: number;
  family?: VersionFamily;
  aggregateId?: string;
}

/** Aggregates whose events carry a monotonic version (FR-005). */
export type VersionFamily =
  'order' | 'payment' | 'delivery' | 'auction' | 'payout';

export interface VersionStamp {
  family: VersionFamily;
  aggregateId: string;
  version: number;
}

/**
 * Why a valid event produced nothing; bounded labels of `notifications_events_ignored_total`.
 * `not_mapped`: a state or type the catalog deliberately has no notification for. `filtered_reason`: a mapped type whose
 * reason says another notice covers it. `no_winner`, `no_recipient`: nobody to tell.
 */
export type IgnoredReason =
  'not_mapped' | 'filtered_reason' | 'no_winner' | 'no_recipient';

export type Mapping = { version?: VersionStamp } & (
  | { kind: 'requests'; requests: MappedRequest[] }
  | { kind: 'ignored'; reason: IgnoredReason }
);

/** What the envelope contributes to every request. */
export interface SourceMeta {
  eventId: string;
  occurredAt: string;
  aggregateId: string;
}

type Payload<T extends ConsumedEventType> = z.infer<
  (typeof consumedEventSchemas)[T]
>;

const user = (userId: string): MappedRecipient => ({ kind: 'user', userId });
const owners = (shopId: string): MappedRecipient => ({
  kind: 'shopOwners',
  shopId,
});

const short = (id: string) => id.slice(0, 8).toUpperCase();
const text = (value: string | number | boolean | null | undefined): string =>
  value === null || value === undefined ? '' : String(value);

const requests = (list: MappedRequest[], version?: VersionStamp): Mapping => ({
  kind: 'requests',
  requests: list,
  ...(version && { version }),
});
const ignored = (reason: IgnoredReason, version?: VersionStamp): Mapping => ({
  kind: 'ignored',
  reason,
  ...(version && { version }),
});

/** A request for `type` stamped with the event's identity (and version, when it has one). */
const request = (
  meta: SourceMeta,
  type: NotificationType,
  recipient: MappedRecipient,
  data: Record<string, string> = {},
  options: { sourceId?: string; version?: VersionStamp } = {},
): MappedRequest => ({
  type,
  recipient,
  data,
  sourceId: options.sourceId ?? meta.eventId,
  occurredAt: meta.occurredAt,
  ...(options.version && {
    family: options.version.family,
    aggregateId: options.version.aggregateId,
    sourceVersion: options.version.version,
  }),
});

type Mapper<T extends ConsumedEventType> = (
  payload: Payload<T>,
  meta: SourceMeta,
) => Mapping;

/** Written for the canonical (spec'd) names; an alias of the same event resolves to its canonical type first. */
const MAPPERS: { [T in CanonicalConsumedEventType]: Mapper<T> } = {
  // ---- identity (S01, S02) -----------------------------------------------------------------------------------------
  'identity.user_registered': (p, m) =>
    requests([request(m, 'account.welcome', user(p.userId))]),
  'identity.registration_duplicate_attempted': (p, m) =>
    requests([request(m, 'security.registration_attempt', user(p.userId))]),
  'identity.password_changed': (p, m) =>
    requests([request(m, 'security.password_changed', user(p.userId))]),
  'identity.mfa_enabled': (p, m) =>
    requests([request(m, 'security.mfa_enabled', user(p.userId))]),
  'identity.mfa_disabled': (p, m) =>
    requests([
      request(m, 'security.mfa_disabled', user(p.userId), { reason: p.reason }),
    ]),
  'identity.mfa_recovery_code_used': (p, m) =>
    requests([
      request(m, 'security.recovery_code_used', user(p.userId), {
        remaining: text(p.remaining),
      }),
    ]),
  'identity.mfa_recovery_codes_regenerated': (p, m) =>
    requests([
      request(m, 'security.recovery_codes_regenerated', user(p.userId)),
    ]),
  'identity.federated_identity_linked': (p, m) =>
    requests([
      request(m, 'security.sign_in_method_added', user(p.userId), {
        provider: p.provider,
        linkMethod: p.linkMethod,
        passwordInvalidated: text(p.passwordInvalidated),
        mfaReset: text(p.mfaReset),
      }),
    ]),
  'identity.federated_identity_unlinked': (p, m) =>
    requests([
      request(m, 'security.sign_in_method_removed', user(p.userId), {
        provider: p.provider,
      }),
    ]),

  // ---- tenancy (S03), shop onboarding (S04) ------------------------------------------------------------------------
  'tenancy.shop_offboarding_started': (p, m) =>
    requests([
      request(m, 'shop.offboarding_started', owners(p.shopId), {
        shopId: p.shopId,
        purgeAt: p.purgeAt,
      }),
    ]),
  'tenancy.shop_offboarding_cancelled': (p, m) =>
    requests([
      request(m, 'shop.offboarding_cancelled', owners(p.shopId), {
        shopId: p.shopId,
      }),
    ]),
  // Owners cannot be resolved after the purge (S03): recorded, not mailed.
  'tenancy.shop_deleted': () => ignored('not_mapped'),
  'shop.verified': (p, m) =>
    requests([
      request(m, 'shop.verified', owners(p.shopId), { shopId: p.shopId }),
    ]),
  'shop.rejected': (p, m) =>
    requests([
      request(m, 'shop.rejected', owners(p.shopId), {
        shopId: p.shopId,
        reasonCode: p.reasonCode,
      }),
    ]),
  'shop.onboarding_document_rejected': (p, m) =>
    requests([
      request(m, 'shop.document_rejected', owners(p.shopId), {
        shopId: p.shopId,
        kind: p.kind,
        reason: p.reason,
      }),
    ]),

  // ---- orders (S10), payments (S13), delivery (S20) ----------------------------------------------------------------
  'order.paid': (p, m) => {
    const version = orderStamp(p);
    const orderData = { orderId: p.orderId, orderShort: short(p.orderId) };
    const list = [
      request(
        m,
        'order.confirmed',
        user(p.userId),
        {
          ...orderData,
          totalMinor: text(p.totalMinor),
          currency: p.currency,
        },
        { version },
      ),
    ];
    // One notice per shop order; the shop id keeps two shops of one owner apart in the dedupe identity.
    for (const shopOrder of p.shopOrders)
      if (shopOrder.shopId)
        list.push(
          request(
            m,
            'shop.order_received',
            owners(shopOrder.shopId),
            {
              ...orderData,
              shopId: shopOrder.shopId,
              subtotalMinor: text(shopOrder.subtotalMinor),
              currency: p.currency,
            },
            { version, sourceId: `${m.eventId}:${shopOrder.shopId}` },
          ),
        );
    return requests(list, version);
  },
  'order.cancelled': (p, m) => {
    const version = orderStamp(p);
    if (p.reason !== 'out_of_stock' && p.reason !== 'hold_expired')
      return ignored('filtered_reason', version);
    return requests(
      [
        request(
          m,
          'order.cancelled',
          user(p.userId),
          {
            orderId: p.orderId,
            orderShort: short(p.orderId),
            reason: p.reason,
          },
          { version },
        ),
      ],
      version,
    );
  },
  'order.refunded': (p, m) => {
    const version = orderStamp(p);
    return requests(
      [
        request(
          m,
          'order.refunded',
          user(p.userId),
          {
            orderId: p.orderId,
            orderShort: short(p.orderId),
            amountMinor: text(p.amountMinor),
            currency: p.currency,
          },
          { version },
        ),
      ],
      version,
    );
  },
  'order.fulfilment_changed': (p, m) => {
    const version = orderStamp(p);
    if (p.status === 'FULFILLING') return ignored('not_mapped', version);
    const data = { orderId: p.orderId, orderShort: short(p.orderId) };
    return requests(
      [
        p.status === 'SHIPPED'
          ? request(
              m,
              'order.shipped',
              user(p.userId),
              { ...data, trackingCode: text(p.trackingCode) },
              { version },
            )
          : request(m, 'order.delivered', user(p.userId), data, { version }),
      ],
      version,
    );
  },
  'payments.payment_failed': (p, m) => {
    const version: VersionStamp | undefined =
      p.paymentVersion === undefined
        ? undefined
        : {
            family: 'payment',
            aggregateId: p.paymentId,
            version: p.paymentVersion,
          };
    // The order itself explains these; a second notice would only confuse.
    if (
      p.reasonCode === 'order_not_payable' ||
      p.reasonCode === 'order_cancelled'
    )
      return ignored('filtered_reason', version);
    return requests(
      [
        request(
          m,
          'payment.failed',
          user(p.userId),
          {
            orderId: p.orderId,
            orderShort: short(p.orderId),
            amountMinor: text(p.amountMinor),
            currency: p.currency,
            reasonCode: text(p.reasonCode),
          },
          { version },
        ),
      ],
      version,
    );
  },
  'delivery.status_changed': (p, m) => {
    const version: VersionStamp = {
      family: 'delivery',
      aggregateId: p.orderId,
      version: p.deliveryVersion,
    };
    // `DELIVERED` is covered by `order.delivered`; it still advances the version so a late pickup is dropped.
    const type =
      p.status === 'PICKED_UP'
        ? 'delivery.picked_up'
        : p.status === 'CANCELLED'
          ? 'delivery.cancelled'
          : null;
    if (!type) return ignored('not_mapped', version);
    return requests(
      [
        request(
          m,
          type,
          user(p.buyerId),
          { orderId: p.orderId, orderShort: short(p.orderId) },
          { version },
        ),
      ],
      version,
    );
  },

  // ---- auctions (S21) ----------------------------------------------------------------------------------------------
  'auction.leader_changed': (p, m) => {
    const version = auctionStamp(p);
    return requests(
      [
        request(
          m,
          'auction.outbid',
          user(p.previousLeaderId),
          {
            auctionId: p.auctionId,
            priceMinor: text(p.priceMinor),
            currency: p.currency,
          },
          { version },
        ),
      ],
      version,
    );
  },
  'auction.closed': (p, m) => {
    const version = auctionStamp(p);
    if (!p.winnerId || p.finalPriceMinor === null)
      return ignored('no_winner', version);
    return requests(
      [
        request(
          m,
          'auction.won',
          user(p.winnerId),
          {
            auctionId: p.auctionId,
            priceMinor: text(p.finalPriceMinor),
            currency: p.currency,
          },
          { version },
        ),
      ],
      version,
    );
  },
  'auction.second_chance_offered': (p, m) => {
    const version = auctionStamp(p);
    return requests(
      [
        request(
          m,
          'auction.second_chance',
          user(p.offeredToId),
          {
            auctionId: p.auctionId,
            priceMinor: text(p.priceMinor),
            currency: p.currency,
            expiresAt: p.expiresAt,
          },
          { version },
        ),
      ],
      version,
    );
  },
  'auction.sold': (p, m) => {
    const version = auctionStamp(p);
    return requests(
      [
        request(
          m,
          'auction.sold',
          owners(p.shopId),
          {
            auctionId: p.auctionId,
            shopId: p.shopId,
            priceMinor: text(p.finalPriceMinor),
            currency: p.currency,
          },
          { version },
        ),
      ],
      version,
    );
  },

  // ---- billing (S17), payouts (S15) --------------------------------------------------------------------------------
  'billing.invoice_payment_failed': (p, m) => {
    const recipient =
      p.subjectType === 'USER' ? user(p.subjectId) : owners(p.subjectId);
    return requests([
      request(
        m,
        p.nextAttemptAt === null
          ? 'billing.access_withdrawn'
          : 'billing.payment_failed',
        recipient,
        { attempt: text(p.attempt), reason: text(p.reason) },
      ),
    ]);
  },
  'billing.invoice_paid': (p, m) =>
    requests([
      request(
        m,
        'billing.receipt',
        p.subjectType === 'USER' ? user(p.subjectId) : owners(p.subjectId),
        { totalMinor: text(p.totalMinor), currency: p.currency },
      ),
    ]),
  'payout.paid': (p, m) => payoutRequest(p, m, 'payout.paid'),
  'payout.failed': (p, m) => payoutRequest(p, m, 'payout.failed'),

  // ---- launch events (S22), chat (S24), discussions (S25) ----------------------------------------------------------
  'launch_events.booking_confirmed': (p, m) =>
    requests([
      request(m, 'booking.confirmed', user(p.userId), {
        // S22 emits the seat numbers; the notice says how many
        seats: text(Array.isArray(p.seats) ? p.seats.length : p.seats),
        launchEventId: p.launchEventId,
      }),
    ]),
  // ---- flash sales (S11): the shop owners hear that a drop sold out (once per sale) or could not start ---------------
  'flash_sale.sold_out': (p, m) =>
    requests([
      request(
        m,
        'shop.flash_sale_sold_out',
        owners(p.shopId),
        { shopId: p.shopId, saleId: p.saleId },
        { sourceId: p.saleId },
      ),
    ]),
  'flash_sale.start_failed': (p, m) =>
    requests([
      request(
        m,
        'shop.flash_sale_start_failed',
        owners(p.shopId),
        { shopId: p.shopId, saleId: p.saleId, reason: p.reason },
        { sourceId: p.saleId },
      ),
    ]),
  // Chat owns its dedupe key: a retry of the same escalation is the same notification.
  'chat.message_escalated': (p, m) =>
    requests([
      request(
        m,
        'chat.message',
        user(p.recipientId),
        {
          channelId: p.channelId,
          channelTitle: p.channelTitle,
          preview: p.preview,
        },
        { sourceId: p.dedupeKey },
      ),
    ]),
  'discussion.comment_created': (p, m) => {
    // A reply tells the parent's author (once, even when they also own the post); a top-level comment tells the post's.
    const reply = p.parentAuthorId != null;
    const target = reply ? p.parentAuthorId! : p.postAuthorId;
    if (target === p.authorId) return ignored('no_recipient');
    return requests([
      request(
        m,
        reply ? 'discussion.reply' : 'discussion.comment',
        user(target),
        { postId: p.postId, preview: p.preview },
      ),
    ]);
  },

  // ---- seller insights (S41), developer platform (S43), feed (S26) -------------------------------------------------
  'seller_insights.competitor_price_dropped': (p, m) =>
    requests([
      request(m, 'insights.competitor_price_drop', user(p.ownerId), {
        shopId: p.shopId,
        productId: p.productId,
        product: p.productTitle,
        host: p.host,
        competitorPriceMinor: text(p.competitorPriceMinor),
        yourPriceMinor: text(p.yourPriceMinor),
        currency: p.currency,
      }),
    ]),
  'developer_platform.webhook_endpoint_disabled': (p, m) =>
    requests([
      request(m, 'developers.webhook_endpoint_disabled', owners(p.shopId), {
        shopId: p.shopId,
        endpointId: p.endpointId,
        host: p.host,
        failingSince: p.failingSince,
      }),
    ]),
  'feed.item_published': (p, m) =>
    p.kind === 'drop_announced' || p.kind === 'auction_started'
      ? requests([
          request(
            m,
            'marketing.followed_shop_update',
            { kind: 'followers', accountId: p.authorId },
            { itemId: p.itemId, kind: p.kind },
          ),
        ])
      : ignored('not_mapped'),
};

const orderStamp = (p: {
  orderId: string;
  orderVersion: number;
}): VersionStamp => ({
  family: 'order',
  aggregateId: p.orderId,
  version: p.orderVersion,
});

const auctionStamp = (p: {
  auctionId: string;
  auctionVersion: number;
}): VersionStamp => ({
  family: 'auction',
  aggregateId: p.auctionId,
  version: p.auctionVersion,
});

function payoutRequest(
  p: Payload<'payout.paid'>,
  m: SourceMeta,
  type: 'payout.paid' | 'payout.failed',
): Mapping {
  const version: VersionStamp = {
    family: 'payout',
    aggregateId: p.payoutId,
    version: p.payoutVersion,
  };
  return requests(
    [
      request(
        m,
        type,
        owners(p.shopId),
        {
          payoutId: p.payoutId,
          shopId: p.shopId,
          amountMinor: text(p.amountMinor),
          currency: p.currency,
        },
        { version },
      ),
    ],
    version,
  );
}

/** `payload` must already be valid for `type` (the consumer validates with the contract schema first). */
export function mapEvent(
  type: ConsumedEventType,
  payload: unknown,
  meta: SourceMeta,
): Mapping {
  return (MAPPERS[canonicalConsumedType(type)] as Mapper<ConsumedEventType>)(
    payload as never,
    meta,
  );
}

/**
 * The single-consumer invitation message (queue `tenancy-invite-requested`): an address recipient, deduped on the
 * invite id. The token is in `data` for the rendered mail and nowhere else.
 */
export function mapInviteRequested(
  message: InviteRequestedMessage,
  meta: { occurredAt: string },
): MappedRequest & { recipient: { kind: 'address'; email: string } } {
  return {
    type: 'shop.invite',
    recipient: { kind: 'address', email: message.email },
    data: {
      shopName: message.shopName,
      role: message.role,
      token: message.token,
      expiresAt: message.expiresAt,
    },
    sourceId: message.inviteId,
    occurredAt: meta.occurredAt,
  };
}
