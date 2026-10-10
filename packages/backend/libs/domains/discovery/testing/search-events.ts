import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { ProductSnapshot } from '@marketplace-sandbox/contracts';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import {
  ProductArchived,
  ProductCreated,
  ProductDeleted,
  ProductRestored,
  ProductUpdated,
} from '@app/domains/catalog';
import {
  ShopDeleted,
  ShopOffboardingCancelled,
  ShopOffboardingStarted,
  ShopPlanChanged,
  ShopStatusChanged,
} from '@app/domains/tenancy';
import {
  MediaGalleryChanged,
  ProductSponsorshipChanged,
} from '../domain/consumed-events';
import { ProductIndexProjector } from '../infra/projectors/product-index.projector';
import { ShopStateProjector } from '../infra/projectors/shop-state.projector';
import {
  MediaProjector,
  SponsorshipProjector,
} from '../infra/projectors/signal.projectors';

type Kind = 'created' | 'updated' | 'archived' | 'restored';

const DEFINITIONS = {
  created: ProductCreated,
  updated: ProductUpdated,
  archived: ProductArchived,
  restored: ProductRestored,
} as const;

export const snapshot = (
  over: Partial<ProductSnapshot> & { productId: string; shopId: string },
): ProductSnapshot => ({
  title: 'Test product',
  description: '',
  brand: 'Acme',
  category: 'general',
  priceMinor: 1_000,
  currency: 'USD',
  rating: 0,
  tags: [],
  quantity: 5,
  inStock: true,
  status: 'ACTIVE',
  isSandbox: false,
  externalSku: null,
  productVersion: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  changedFields: [],
  ...over,
});

/** The real envelope a product change would put on `products.events`. */
export const productEvent = (
  kind: Kind,
  s: ProductSnapshot,
  occurredAt?: Date,
): EventEnvelope =>
  DEFINITIONS[kind].create(s.productId, s.productVersion, s, occurredAt);

export const productDeleted = (
  productId: string,
  shopId: string,
  productVersion: number,
  occurredAt?: Date,
): EventEnvelope =>
  ProductDeleted.create(
    productId,
    productVersion,
    { productId, shopId, productVersion },
    occurredAt,
  );

export const shopStatusEvent = (
  shopId: string,
  to: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED',
  shopVersion: number,
  occurredAt?: Date,
): EventEnvelope =>
  ShopStatusChanged.create(
    shopId,
    shopVersion,
    { shopId, from: 'ACTIVE', to, shopVersion },
    occurredAt,
  );

export const shopPlanEvent = (
  shopId: string,
  plan: string,
  shopVersion: number,
  occurredAt?: Date,
): EventEnvelope =>
  ShopPlanChanged.create(shopId, shopVersion, { shopId, plan, shopVersion }, occurredAt);

export const offboardingStarted = (shopId: string, occurredAt?: Date) =>
  ShopOffboardingStarted.create(
    shopId,
    0,
    { shopId, purgeAt: new Date(Date.now() + 86_400_000).toISOString() },
    occurredAt,
  );

export const offboardingCancelled = (shopId: string, occurredAt?: Date) =>
  ShopOffboardingCancelled.create(shopId, 0, { shopId }, occurredAt);

export const shopDeleted = (shopId: string, occurredAt?: Date) =>
  ShopDeleted.create(shopId, 0, { shopId }, occurredAt);

export const galleryEvent = (
  productId: string,
  shopId: string,
  mediaIds: string[],
  galleryVersion: number,
  occurredAt?: Date,
) =>
  MediaGalleryChanged.create(
    productId,
    galleryVersion,
    { productId, shopId, mediaIds, galleryVersion },
    occurredAt,
  );

export const sponsorshipEvent = (
  productId: string,
  shopId: string,
  sponsored: boolean,
  sponsorshipVersion: number,
  occurredAt?: Date,
) =>
  ProductSponsorshipChanged.create(
    productId,
    sponsorshipVersion,
    { productId, shopId, sponsored, sponsorshipVersion },
    occurredAt,
  );

/**
 * Delivers real envelopes to the real consumer entry points (`Projector.project`), as the consumer framework does
 * after validation; the catalog's tables are never seeded to feed search (test-plan.md).
 */
export const deliver = (app: INestApplication) => ({
  products: (...events: EventEnvelope[]) =>
    app.get(ProductIndexProjector, { strict: false }).project(events),
  shops: (...events: EventEnvelope[]) =>
    app.get(ShopStateProjector, { strict: false }).project(events),
  gallery: (...events: EventEnvelope[]) =>
    app.get(MediaProjector, { strict: false }).project(events),
  sponsorship: (...events: EventEnvelope[]) =>
    app.get(SponsorshipProjector, { strict: false }).project(events),
});

export const newId = (): string => randomUUID();
