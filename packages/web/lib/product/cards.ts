import type {
  PickupNearItem,
  ProductSearchItem,
  RecommendationItem,
  TrendingItem,
} from '@marketplace-sandbox/contracts';
import { formatDistance } from '@/lib/pickup/format';
import { productHref } from '@/lib/routes';
import { safeHttpsUrl } from '@/lib/safe-url';

/**
 * What a product card shows (W02 data-model §3). Every mapper reads a contract type and produces this plain object,
 * so the card components take serialisable props and never see a response shape.
 */
export type CardModel = {
  id: string;
  title: string;
  brand?: string | null;
  priceMinor: number;
  currency: string;
  /** 0 or absent means "not rated": nothing is shown. */
  rating?: number;
  /** Only an absolute `https` address is kept (AS-72). */
  imageUrl?: string | null;
  inStock?: boolean;
  sponsored?: boolean;
  rank?: number;
  category?: string;
  /** One extra line under the price (pickup search: "850 m away · Point · 3 available"). */
  note?: string;
  href: string;
};

/** A search result (S32 item). */
export function searchItemToCard(item: ProductSearchItem): CardModel {
  return {
    id: item.id,
    title: item.title || 'Untitled product',
    brand: item.brand,
    priceMinor: item.priceMinor,
    currency: item.currency,
    rating: item.rating,
    imageUrl: safeHttpsUrl(item.imageUrl) ?? null,
    inStock: item.inStock,
    sponsored: item.sponsored,
    category: item.category,
    href: productHref(item.id),
  };
}

/** A pickup search hit (S19): the product with its nearest point, "{distance} away · {point} · {quantity} available". */
export function pickupItemToCard(item: PickupNearItem): CardModel {
  const { nearest } = item;
  const parts = [`${formatDistance(nearest.distanceM)} away`, nearest.name, `${nearest.quantity} available`].filter(Boolean);
  return {
    id: item.productId,
    title: item.title || 'Untitled product',
    priceMinor: item.priceMinor,
    currency: item.currency,
    category: item.category,
    note: parts.join(' · '),
    href: productHref(item.productId),
  };
}

/** A trending entry (S35): text card with rank and category. */
export function railItemToCard(item: TrendingItem): CardModel {
  return {
    id: item.productId,
    title: item.title,
    priceMinor: item.priceMinor,
    currency: item.currency,
    rank: item.rank,
    category: item.category,
    href: productHref(item.productId),
  };
}

/** A "frequently bought together" entry (S34). */
export function recommendationItemToCard(item: RecommendationItem): CardModel {
  return {
    id: item.productId,
    title: item.title,
    priceMinor: item.priceMinor,
    currency: item.currency,
    href: productHref(item.productId),
  };
}
