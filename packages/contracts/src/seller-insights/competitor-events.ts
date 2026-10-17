import { z } from 'zod';
import {
  consumedEnvelope,
  type ConsumedEnvelopeMeta,
} from './consumed-events.ts';

/**
 * S41 events (specs/domains/S41-competitor-monitor/contracts/events.md): the alert it produces and the tenancy and
 * catalog events its read model and cleanup consume. Consumer schemas strip unknown fields and are strict on what the
 * capability uses: UUID ids, known enums, integer versions.
 */
const uuid = z.string().uuid();
const minor = z.number().int().nonnegative();

export const COMPETITOR_PRICE_DROPPED_TYPE =
  'sellerinsights.competitor_price_dropped';

/** One event per owner of the shop; money is integer minor units in the competitor page's currency; never the URL path or query. */
export const competitorPriceDroppedSchema = z
  .object({
    watchId: uuid,
    shopId: uuid,
    productId: uuid,
    productTitle: z.string(),
    host: z.string().min(1),
    competitorPriceMinor: minor,
    yourPriceMinor: minor,
    currency: z.string().min(1),
    ownerId: z.string().min(1),
    priceVersion: z.number().int().positive(),
  })
  .strict();
export type CompetitorPriceDropped = z.infer<
  typeof competitorPriceDroppedSchema
>;

export const COMPETITOR_SHOP_PLANS = ['STARTER', 'PRO', 'ENTERPRISE'] as const;
export const COMPETITOR_SHOP_STATUSES = [
  'ACTIVE',
  'SUSPENDED',
  'DELETING',
  'DELETED',
] as const;
const plan = z.enum(COMPETITOR_SHOP_PLANS);
const status = z.enum(COMPETITOR_SHOP_STATUSES);
const version = z.number().int().nonnegative();

export const competitorShopCreatedSchema = z.object({
  shopId: uuid,
  plan,
  shopVersion: version,
});
export const competitorShopPlanChangedSchema = z.object({
  shopId: uuid,
  plan,
  shopVersion: version,
});
export const competitorShopStatusChangedSchema = z.object({
  shopId: uuid,
  to: status,
  shopVersion: version,
});
export const competitorShopDeletedSchema = z.object({ shopId: uuid });
export const competitorProductDeletedSchema = z.object({
  productId: uuid,
  shopId: uuid,
  productVersion: z.number().int().positive(),
});

// ---- event factories for tests -----------------------------------------------------------------------------------

export const shopPlanChangedEnvelope = (
  input: { shopId: string; plan: string; shopVersion: number },
  meta: ConsumedEnvelopeMeta = {},
) =>
  consumedEnvelope(
    'tenancy.shop_plan_changed',
    'tenancy',
    input.shopId,
    { ...input },
    { aggregateVersion: input.shopVersion, ...meta },
  );

export const shopStatusChangedEnvelope = (
  input: {
    shopId: string;
    from?: string;
    to: string;
    shopVersion: number;
  },
  meta: ConsumedEnvelopeMeta = {},
) =>
  consumedEnvelope(
    'tenancy.shop_status_changed',
    'tenancy',
    input.shopId,
    {
      shopId: input.shopId,
      from: input.from ?? 'ACTIVE',
      to: input.to,
      shopVersion: input.shopVersion,
    },
    { aggregateVersion: input.shopVersion, ...meta },
  );
