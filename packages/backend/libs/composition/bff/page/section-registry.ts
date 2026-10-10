import type {
  PageQuery,
  ProductPageResponse,
  SectionName,
} from '@marketplace-sandbox/contracts';
import { tokenOf, type Credentials } from '../credentials/credentials';
import { productById } from '../upstream/endpoints/catalog';
import { auctionsFor } from '../upstream/endpoints/auctions';
import { hotPosts } from '../upstream/endpoints/boards';
import { chatUnread } from '../upstream/endpoints/chat';
import { recommendations, trending } from '../upstream/endpoints/discovery';
import type { Endpoint } from '../upstream/endpoints/endpoint';
import { flags } from '../upstream/endpoints/flags';
import { flashSalesFor } from '../upstream/endpoints/flash-sales';
import { pickupNear } from '../upstream/endpoints/pickup';
import { shopsBatch } from '../upstream/endpoints/tenancy';
import { productVideos } from '../upstream/endpoints/video';

type Product = ProductPageResponse['product'];

export interface SectionContext {
  productId: string;
  query: PageQuery;
  credentials: Credentials;
  /** Present only for sections that start after the product answered. */
  product?: Product;
}

/**
 * One declared section of the product page (S48 FR-001). Adding a section is adding one entry:
 * - `dependsOn`: what it needs to start (`productId` = at t0 with the product call, `product` = after it answered);
 * - `endpoint`: the one upstream call, or `null` when the section does not apply (no error, no call);
 * - `shape`: field selection only (X.8.3): the owning domain's body is forwarded unchanged; `null` means "nothing to
 *   show" (an empty one-element list, a hidden shop).
 */
export interface SectionDefinition<T = unknown> {
  name: SectionName;
  required: boolean;
  dependsOn: 'productId' | 'product';
  endpoint(ctx: SectionContext): Endpoint<T> | null;
  shape(body: T): unknown;
}

const first = <T>(items: readonly T[]): T | null => items[0] ?? null;

export const SECTION_REGISTRY: readonly SectionDefinition<any>[] = [
  {
    name: 'product',
    required: true,
    dependsOn: 'productId',
    endpoint: (c) => productById(c.productId),
    shape: (body) => body,
  },
  {
    name: 'shop',
    required: false,
    dependsOn: 'product',
    endpoint: (c) =>
      c.product?.shopId ? shopsBatch([c.product.shopId]) : null,
    shape: (body: unknown[]) => first(body),
  },
  {
    name: 'recommendations',
    required: false,
    dependsOn: 'productId',
    endpoint: (c) => recommendations(c.productId, 8),
    shape: (body) => body,
  },
  {
    name: 'trending',
    required: false,
    dependsOn: 'product',
    endpoint: (c) => (c.product ? trending(c.product.category) : null),
    shape: (body) => body,
  },
  {
    name: 'flags',
    required: false,
    dependsOn: 'productId',
    endpoint: () => flags(),
    shape: (body) => body,
  },
  {
    name: 'chatUnread',
    required: false,
    dependsOn: 'productId',
    endpoint: (c) => (tokenOf(c.credentials) ? chatUnread() : null),
    shape: (body) => body,
  },
  {
    name: 'discussions',
    required: false,
    dependsOn: 'productId',
    endpoint: (c) => hotPosts(c.productId),
    shape: (body) => body,
  },
  {
    name: 'videos',
    required: false,
    dependsOn: 'productId',
    endpoint: (c) => productVideos(c.productId),
    shape: (body) => body,
  },
  {
    name: 'pickup',
    required: false,
    dependsOn: 'productId',
    endpoint: (c) =>
      c.query.lat !== undefined && c.query.lng !== undefined
        ? pickupNear({
            lat: c.query.lat,
            lng: c.query.lng,
            radiusKm: c.query.radiusKm,
            productId: c.productId,
          })
        : null,
    shape: (body) => body,
  },
  {
    name: 'flashSale',
    required: false,
    dependsOn: 'productId',
    endpoint: (c) => flashSalesFor([c.productId]),
    shape: (body: unknown[]) => first(body),
  },
  {
    name: 'auction',
    required: false,
    dependsOn: 'productId',
    endpoint: (c) => auctionsFor([c.productId]),
    shape: (body: unknown[]) => first(body),
  },
];
