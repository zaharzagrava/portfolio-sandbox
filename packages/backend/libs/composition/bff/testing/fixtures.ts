import { randomUUID } from 'node:crypto';
import {
  auctionPublicSchema,
  authSessionSchema,
  boardPostsPageSchema,
  chatUnreadPageSchema,
  flagsResponseSchema,
  flashSalePublicSchema,
  pickupPageSchema,
  productBatchItemSchema,
  productPublicSchema,
  productGallerySchema,
  productVideosSchema,
  recommendationsResponseSchema,
  shopSummarySchema,
  trendingResponseSchema,
} from '@marketplace-sandbox/contracts';

/**
 * Upstream fixtures for the BFF specs. Every one is parsed with the owning contract schema, so a stub can never serve
 * a body the contract would reject (X.8.5): a drifted fixture fails here, not in an assertion far away.
 */
export const productFixture = (
  over: Partial<{
    id: string;
    shopId: string;
    category: string;
    title: string;
  }> = {},
) =>
  productPublicSchema.parse({
    id: over.id ?? randomUUID(),
    shopId: over.shopId ?? randomUUID(),
    title: over.title ?? 'Studio headphones',
    description: 'Over-ear, closed back',
    brand: 'Acme',
    category: over.category ?? 'audio',
    priceMinor: 4_900,
    currency: 'USD',
    rating: 4.5,
    tags: ['audio'],
    inStock: true,
    version: 3,
    viewCount: 12,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
export type ProductFixture = ReturnType<typeof productFixture>;

export const batchItemOf = (p: ProductFixture) =>
  productBatchItemSchema.parse({
    id: p.id,
    shopId: p.shopId,
    title: p.title,
    priceMinor: p.priceMinor,
    currency: p.currency,
    inStock: p.inStock,
    category: p.category,
    rating: p.rating,
  });

export const shopFixture = (id: string) =>
  shopSummarySchema.parse({ id, name: 'Audio Shop', slug: 'audio-shop' });

export const recommendationsFixture = (productIds: string[] = [randomUUID()]) =>
  recommendationsResponseSchema.parse({
    type: 'bought-together',
    items: productIds.map((productId, i) => ({
      productId,
      title: `Recommended ${i}`,
      priceMinor: 1_900 + i,
      currency: 'USD',
      score: 0.9 - i * 0.01,
      hops: 1,
    })),
  });

export const trendingFixture = (category = 'audio') =>
  trendingResponseSchema.parse({
    category,
    windowMinutes: 60,
    generatedAt: '2026-01-01T12:00:00.000Z',
    items: [
      {
        rank: 1,
        productId: randomUUID(),
        title: 'B',
        priceMinor: 9_900,
        currency: 'USD',
        category,
        score: 35,
      },
      {
        rank: 2,
        productId: randomUUID(),
        title: 'A',
        priceMinor: 4_900,
        currency: 'USD',
        category,
        score: 30,
      },
    ],
  });

export const flagsFixture = () =>
  flagsResponseSchema.parse({ flags: { 'web-new-header': true } });

export const chatUnreadFixture = () =>
  chatUnreadPageSchema.parse({
    items: [
      { channelId: 'ch-1', unread: 5, lastSeq: 9 },
      { channelId: 'ch-2', unread: 1, lastSeq: 2 },
    ],
    nextCursor: 'cursor-2',
  });

export const postsFixture = () =>
  boardPostsPageSchema.parse({
    items: [
      { id: 'p1', title: 'Great sound', score: 12 },
      { id: 'p2', title: 'Comfortable', score: 9 },
    ],
    nextCursor: null,
  });

export const videosFixture = () =>
  productVideosSchema.parse({ items: [{ videoId: 'v1', title: 'Unboxing' }] });

export const galleryFixture = () => {
  const mediaId = randomUUID();
  return productGallerySchema.parse({
    items: [
      {
        mediaId,
        position: 0,
        urls: {
          thumb: `https://media.example/${mediaId}/thumb.webp`,
          feed: `https://media.example/${mediaId}/feed.webp`,
          full: `https://media.example/${mediaId}/full.webp`,
        },
        width: 1600,
        height: 1200,
      },
    ],
  });
};

export const pickupFixture = () =>
  pickupPageSchema.parse({
    items: [
      {
        id: 'pp1',
        shopId: randomUUID(),
        name: 'Corner locker',
        address: '1 Main St',
        lat: 50.45,
        lng: 30.52,
        distanceM: 420,
        openingHours: 'Mon-Fri 9-18',
        quantity: 3,
      },
    ],
    nextCursor: null,
  });

export const flashSaleFixture = (productId: string) =>
  flashSalePublicSchema.parse({
    productId,
    priceMinor: 3_900,
    endsAt: '2026-01-02T00:00:00.000Z',
  });

export const auctionFixture = (productId: string) =>
  auctionPublicSchema.parse({
    productId,
    currentBidMinor: 1_000,
    endsAt: '2026-01-02T00:00:00.000Z',
  });

let sessionCounter = 0;
/** The S01 login / refresh body; tokens are opaque strings that identify the call that issued them. */
export const identitySessionFixture = (
  over: Partial<{
    userId: string;
    email: string;
    role: 'USER' | 'SELLER' | 'MODERATOR' | 'ADMIN';
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> = {},
) => {
  sessionCounter++;
  return authSessionSchema.parse({
    accessToken: {
      token: over.accessToken ?? `access-token-${sessionCounter}`,
      expiresIn: over.expiresIn ?? 300,
    },
    refreshToken: over.refreshToken ?? `refresh-token-${sessionCounter}`,
    sessionId: `identity-session-${sessionCounter}`,
    user: {
      id: over.userId ?? randomUUID(),
      email: over.email ?? 'shopper@example.com',
      role: over.role ?? 'USER',
    },
  });
};
