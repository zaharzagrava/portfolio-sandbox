import { z } from 'zod';

/** Topic `assets.events` payloads (specs/domains/S31-assets-digital-delivery/contracts/interfaces.md). */
const id = z.string().uuid();

export const assetEventSchemas = {
  'assets.entitlement_granted': z.object({
    entitlementId: id,
    orderId: id,
    productId: z.string(),
    shopId: id,
    buyerId: z.string(),
    title: z.string(),
    grantedAt: z.string(),
  }),
  'assets.entitlement_revoked': z.object({
    entitlementId: id,
    orderId: id,
    productId: z.string(),
    shopId: id,
    buyerId: z.string(),
    reason: z.enum(['refunded', 'shop_deleted']),
    revokedAt: z.string(),
  }),
  'assets.digital_product_linked': z.object({
    productId: z.string(),
    shopId: id,
    assetId: id,
    linkedAt: z.string(),
  }),
  'assets.digital_product_unlinked': z.object({
    productId: z.string(),
    shopId: id,
    assetId: id,
    unlinkedAt: z.string(),
  }),
} as const;
