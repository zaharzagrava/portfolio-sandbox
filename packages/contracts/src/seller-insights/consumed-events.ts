import { z } from 'zod';
import { eventEnvelopeSchema } from '../events/envelope.ts';

/**
 * Consumer-side schemas of the events S40 reads (specs/domains/S40-leaderboards-dashboard/contracts/http-and-events.md).
 * They are stricter than the producers' shared contract where S40 needs it: every line of a paid order names a shop by
 * UUID and carries integer minor units. Unknown fields are stripped. Currency is checked by the consumer (a non-EUR
 * order is dead-lettered as `unsupported_currency`, not as an invalid payload).
 */
const minor = z.number().int().nonnegative();
const uuid = z.string().uuid();
const instant = z.iso.datetime({ offset: true });

export const sellerInsightsOrderPaidSchema = z.object({
  orderId: uuid,
  userId: z.string().min(1),
  currency: z.string().min(1),
  paidAt: instant,
  lines: z
    .array(
      z.object({
        productId: z.string().min(1),
        shopId: uuid,
        title: z.string(),
        quantity: z.number().int().positive(),
        lineTotalMinor: minor,
      }),
    )
    .min(1),
});
export type SellerInsightsOrderPaid = z.infer<
  typeof sellerInsightsOrderPaidSchema
>;

export const sellerInsightsOrderReservedSchema = z.object({
  orderId: uuid,
  shopIds: z.array(z.string().nullable()),
});
export type SellerInsightsOrderReserved = z.infer<
  typeof sellerInsightsOrderReservedSchema
>;

export const sellerInsightsOrderRefundedSchema = z.object({
  orderId: uuid,
  amountMinor: minor,
  currency: z.string().min(1),
});
export type SellerInsightsOrderRefunded = z.infer<
  typeof sellerInsightsOrderRefundedSchema
>;

export const sellerInsightsProductEventSchema = z.object({
  productId: uuid,
  shopId: uuid,
  category: z.string().optional(),
  productVersion: z.number().int().positive(),
});

export const sellerInsightsShopEventSchema = z.object({
  shopId: uuid,
  name: z.string(),
  slug: z.string(),
  shopVersion: z.number().int().nonnegative(),
});

export const sellerInsightsShopDeletedSchema = z.object({ shopId: uuid });

// ---- event factories ---------------------------------------------------------------------------------------------

/** UUIDv7 without a dependency (the envelope requires one). */
export function newEventId(at: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[0] = (at / 2 ** 40) & 0xff;
  bytes[1] = (at / 2 ** 32) & 0xff;
  bytes[2] = (at / 2 ** 24) & 0xff;
  bytes[3] = (at / 2 ** 16) & 0xff;
  bytes[4] = (at / 2 ** 8) & 0xff;
  bytes[5] = at & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface ConsumedEnvelopeMeta {
  eventId?: string;
  occurredAt?: Date | string;
  aggregateVersion?: number;
  version?: number;
}

/** A contract-valid envelope; the payload is handed over exactly as given (a test may pass an invalid one on purpose). */
export function consumedEnvelope(
  type: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  meta: ConsumedEnvelopeMeta = {},
) {
  const occurredAt = meta.occurredAt ?? new Date();
  return eventEnvelopeSchema.parse({
    eventId: meta.eventId ?? newEventId(),
    type,
    version: meta.version ?? 1,
    aggregateType,
    aggregateId,
    aggregateVersion: meta.aggregateVersion ?? 1,
    occurredAt:
      typeof occurredAt === 'string' ? occurredAt : occurredAt.toISOString(),
    payload,
  });
}

export interface PaidLineInput {
  productId: string;
  shopId: string;
  title?: string;
  quantity?: number;
  unitPriceMinor?: number;
  discountMinor?: number;
  lineTotalMinor: number;
}

export interface OrderPaidInput {
  orderId: string;
  userId?: string;
  currency?: string;
  paidAt: Date | string;
  lines: PaidLineInput[];
  paymentRef?: string;
}

/** `order.paid` v1 as S10 emits it (full S10 payload shape). */
export function orderPaidPayload(input: OrderPaidInput): Record<string, unknown> {
  const lines = input.lines.map((l) => ({
    productId: l.productId,
    shopId: l.shopId,
    title: l.title ?? 'Item',
    quantity: l.quantity ?? 1,
    unitPriceMinor:
      l.unitPriceMinor ??
      Math.round((l.lineTotalMinor + (l.discountMinor ?? 0)) / (l.quantity ?? 1)),
    discountMinor: l.discountMinor ?? 0,
    lineTotalMinor: l.lineTotalMinor,
  }));
  const bySubtotal = new Map<string, number>();
  for (const l of lines)
    bySubtotal.set(l.shopId, (bySubtotal.get(l.shopId) ?? 0) + l.lineTotalMinor);
  return {
    orderId: input.orderId,
    userId: input.userId ?? 'buyer-1',
    orderVersion: 2,
    totalMinor: lines.reduce((sum, l) => sum + l.lineTotalMinor, 0),
    currency: input.currency ?? 'EUR',
    paymentRef: input.paymentRef ?? `pay-${input.orderId}`,
    paidAt:
      typeof input.paidAt === 'string'
        ? input.paidAt
        : input.paidAt.toISOString(),
    lines,
    shopOrders: [...bySubtotal].map(([shopId, subtotalMinor], i) => ({
      shopOrderId: `${input.orderId}-${i}`,
      shopId,
      subtotalMinor,
    })),
  };
}

export const orderPaidEnvelope = (
  input: OrderPaidInput,
  meta: ConsumedEnvelopeMeta = {},
) =>
  consumedEnvelope('order.paid', 'orders', input.orderId, orderPaidPayload(input), {
    aggregateVersion: 2,
    occurredAt: input.paidAt,
    ...meta,
  });

export const orderReservedEnvelope = (
  input: {
    orderId: string;
    userId?: string;
    shopIds: Array<string | null>;
    currency?: string;
  },
  meta: ConsumedEnvelopeMeta = {},
) =>
  consumedEnvelope(
    'order.reserved',
    'orders',
    input.orderId,
    {
      orderId: input.orderId,
      userId: input.userId ?? 'buyer-1',
      orderVersion: 1,
      totalMinor: 1000,
      currency: input.currency ?? 'EUR',
      shopIds: input.shopIds,
      reservedUntil: new Date(Date.now() + 900_000).toISOString(),
    },
    meta,
  );

export const orderRefundedEnvelope = (
  input: {
    orderId: string;
    amountMinor: number;
    userId?: string;
    currency?: string;
  },
  meta: ConsumedEnvelopeMeta = {},
) =>
  consumedEnvelope(
    'order.refunded',
    'orders',
    input.orderId,
    {
      orderId: input.orderId,
      userId: input.userId ?? 'buyer-1',
      orderVersion: 3,
      amountMinor: input.amountMinor,
      currency: input.currency ?? 'EUR',
      reason: 'requested_by_customer',
    },
    { aggregateVersion: 3, ...meta },
  );

export const shopCreatedEnvelope = (
  input: { shopId: string; name: string; slug: string; shopVersion: number },
  meta: ConsumedEnvelopeMeta = {},
) =>
  consumedEnvelope(
    'tenancy.shop_created',
    'tenancy',
    input.shopId,
    {
      shopId: input.shopId,
      ownerId: null,
      name: input.name,
      slug: input.slug,
      plan: 'STARTER',
      region: 'eu-central-1',
      shopVersion: input.shopVersion,
    },
    { aggregateVersion: input.shopVersion, ...meta },
  );

export const shopUpdatedEnvelope = (
  input: { shopId: string; name: string; slug: string; shopVersion: number },
  meta: ConsumedEnvelopeMeta = {},
) =>
  consumedEnvelope(
    'tenancy.shop_updated',
    'tenancy',
    input.shopId,
    { ...input },
    { aggregateVersion: input.shopVersion, ...meta },
  );

export const shopDeletedEnvelope = (
  input: { shopId: string; shopVersion?: number },
  meta: ConsumedEnvelopeMeta = {},
) =>
  consumedEnvelope(
    'tenancy.shop_deleted',
    'tenancy',
    input.shopId,
    { shopId: input.shopId, shopVersion: input.shopVersion ?? 99 },
    { aggregateVersion: input.shopVersion ?? 99, ...meta },
  );
