import type { ShopRecord } from '../domain/ports';
import type { ShopPlan } from '../domain/shop-types';
import type { ShopStatus } from '../domain/shop-status';
import type { VerificationStatus } from '../domain/verification-status';

/**
 * The shop as other capabilities see it (R1): identity of the shop, its lifecycle and sandbox facts. No payment-provider
 * account and no internal column; a model never leaves the domain (FR-070).
 */
export interface ShopSummaryDto {
  id: string;
  slug: string;
  name: string;
  plan: ShopPlan;
  status: ShopStatus;
  verificationStatus: VerificationStatus;
  payoutsEnabled: boolean;
  region: string;
  isSandbox: boolean;
  sandboxOf: string | null;
  shopVersion: number;
}

export const toShopSummary = (shop: ShopRecord): ShopSummaryDto => ({
  id: shop.id,
  slug: shop.slug,
  name: shop.name,
  plan: shop.plan,
  status: shop.status,
  verificationStatus: shop.verificationStatus,
  payoutsEnabled: shop.payoutsEnabled,
  region: shop.region,
  isSandbox: shop.sandboxOf !== null,
  sandboxOf: shop.sandboxOf,
  shopVersion: shop.shopVersion,
});
