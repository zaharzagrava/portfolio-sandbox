import { createHmac, timingSafeEqual } from 'node:crypto';
import { ResilientHttpClient } from '@app/infrastructure/http-client/resilient-http-client';
import { CommerceProvider, NormalizedProduct, Page } from '../domain/provider.port';

const API = '2024-10';

interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string | null;
  vendor: string;
  product_type: string;
  updated_at: string;
  variants: { id: number; price: string; inventory_quantity: number; inventory_item_id: number }[];
}

export interface ShopifyCredentials {
  accessToken: string;
  webhookSecret: string;
  locationId: string;
}

/**
 * Shopify Admin REST adapter. Pagination is cursor-based via the `Link`
 * header (page_info); `updated_at_min` gives incremental pulls. Rate limits
 * are enforced by the caller's per-credential bucket; 429s are retried by the
 * resilient client honouring Retry-After. One variant per product is mapped
 * (multi-variant listings → product variants model is a documented extension).
 */
export class ShopifyProvider implements CommerceProvider {
  readonly name = 'shopify' as const;
  private readonly http = new ResilientHttpClient('shopify');

  constructor(
    private readonly shopDomain: string,
    private readonly creds: ShopifyCredentials,
    private readonly beforeRequest: () => Promise<void>,
  ) {}

  async listUpdatedSince(since: Date | null, cursor: string | null): Promise<Page> {
    const params = cursor ? `page_info=${encodeURIComponent(cursor)}&limit=250` : `limit=250&order=updated_at+asc${since ? `&updated_at_min=${since.toISOString()}` : ''}`;
    const res = await this.request<{ products: ShopifyProduct[] }>('GET', `/products.json?${params}`);
    const link = String(res.headers.link ?? '');
    const next = /<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/.exec(link)?.[1] ?? null;
    return { items: res.body.products, nextCursor: next ? decodeURIComponent(next) : null };
  }

  async get(externalId: string) {
    const res = await this.request<{ product: ShopifyProduct }>('GET', `/products/${externalId}.json`).catch((e: { status?: number }) => {
      if (e.status === 404) return null;
      throw e;
    });
    return res?.body.product ?? null;
  }

  normalize(raw: unknown): NormalizedProduct {
    const p = raw as ShopifyProduct;
    const variant = p.variants?.[0];
    return NormalizedProduct.parse({
      externalId: String(p.id),
      title: p.title,
      description: (p.body_html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      priceMinor: variant ? Math.round(Number(variant.price) * 100) : NaN,
      stock: variant?.inventory_quantity,
      category: p.product_type || 'uncategorized',
      brand: p.vendor ?? '',
      updatedAt: p.updated_at,
      writeBack: { inventoryItemId: String(variant?.inventory_item_id ?? '') },
    });
  }

  async setStock(product: NormalizedProduct, stock: number) {
    await this.request('POST', '/inventory_levels/set.json', { location_id: Number(this.creds.locationId), inventory_item_id: Number(product.writeBack.inventoryItemId), available: stock });
  }

  async listAllIds(): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const params: string = cursor ? `page_info=${encodeURIComponent(cursor)}&limit=250&fields=id` : 'limit=250&fields=id';
      const res = await this.request<{ products: { id: number }[] }>('GET', `/products.json?${params}`);
      ids.push(...res.body.products.map((p) => String(p.id)));
      cursor = /<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/.exec(String(res.headers.link ?? ''))?.[1] ?? null;
    } while (cursor);
    return ids;
  }

  /** `X-Shopify-Hmac-Sha256` = base64 HMAC-SHA256(app secret, raw body). */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>) {
    const given = Buffer.from(headers['x-shopify-hmac-sha256'] ?? '');
    const expected = Buffer.from(createHmac('sha256', this.creds.webhookSecret).update(rawBody).digest('base64'));
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: object) {
    await this.beforeRequest(); // per-credential token bucket (fleet-wide, Redis)
    return this.http.requestJson<T>(`https://${this.shopDomain}/admin/api/${API}${path}`, {
      method,
      headers: { 'X-Shopify-Access-Token': this.creds.accessToken, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      idempotent: method === 'GET' || path.includes('inventory_levels/set'), // "set" (not adjust) is idempotent
      timeoutMs: 15_000,
    });
  }
}
