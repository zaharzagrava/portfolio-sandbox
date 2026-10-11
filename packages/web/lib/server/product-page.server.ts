import 'server-only';
import { cacheLife, cacheTag } from 'next/cache';
import { bffUrl } from '@/lib/server/endpoints.server';
import { readPublicJson } from '@/lib/server/read.server';
import { isProductId } from '@/lib/product/ids';
import { parseProductPage, type ProductPage } from '@/lib/product/parse-page';

/** The page states of W02 AS-33. */
export type ProductPageResult =
  | { state: 'ok'; page: ProductPage }
  | { state: 'not-found' }
  | { state: 'unavailable'; requestId?: string }
  | { state: 'rate-limited'; retryAfterSeconds?: number }
  | { state: 'offline' };

/**
 * The one read behind a product page (W02 FR-050, FR-151): `GET {BFF}/api/bff/product-page/{id}` made without any visitor
 * credential, so the answer is the same for everyone and safe to share. Kept 15 s under `product:{id}`; an answer with
 * section errors, and every failure, only 5 s. The cache key is the id alone.
 */
export async function getProductPage(productId: string): Promise<ProductPageResult> {
  'use cache';
  cacheTag(`product:${productId}`);
  const result = await resolve(productId);
  const keepLong = result.state === 'ok' && !result.page.degraded;
  cacheLife(keepLong ? { stale: 30, revalidate: 15, expire: 60 } : { stale: 30, revalidate: 5, expire: 6 });
  return result;
}

async function resolve(productId: string): Promise<ProductPageResult> {
  if (!isProductId(productId)) return { state: 'not-found' };
  const read = await readPublicJson(`${bffUrl()}/api/bff/product-page/${productId}`, { timeoutMs: 5_000 });
  if (!read.ok) {
    if (read.status === 0) return { state: 'offline' };
    if (read.status === 404) return { state: 'not-found' };
    if (read.status === 429) return { state: 'rate-limited', ...(read.retryAfter !== undefined ? { retryAfterSeconds: read.retryAfter } : {}) };
    return { state: 'unavailable', ...(read.requestId ? { requestId: read.requestId } : {}) };
  }
  const page = parseProductPage(read.data);
  return page ? { state: 'ok', page } : { state: 'unavailable' };
}
