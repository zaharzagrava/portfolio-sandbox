import { Injectable, NotFoundException } from '@nestjs/common';
import { CoreClient, CoreProduct } from './core-client';

interface Section<T> {
  name: string;
  required: boolean;
  timeoutMs: number;
  load: (signal: AbortSignal) => Promise<T>;
}

export interface ProductPage {
  product: CoreProduct;
  shop: { id: string; name: string; slug: string } | null;
  recommendations: unknown[] | null;
  trending: unknown[] | null;
  flags: Record<string, unknown> | null;
  chatUnread: number | null;
  errors: { section: string; reason: string }[];
}

/**
 * One request from the app → parallel fan-out to core (04/01 §2.1, 10/04 #4).
 * Only `product` is required; every other section has its OWN timeout and
 * degrades to null + an entry in `errors` - a slow recommendations service
 * costs at most 300 ms and never fails the page. Total latency ≈ the
 * slowest section's budget, not the sum.
 */
@Injectable()
export class ProductPageService {
  constructor(private readonly core: CoreClient) {}

  async load(productId: string, auth?: string): Promise<ProductPage> {
    const product = await this.core.product(productId, auth).catch((e: { status?: number }) => {
      if (e.status === 404) throw new NotFoundException('Product not found');
      throw e;
    });

    const sections: Section<unknown>[] = [
      { name: 'shop', required: false, timeoutMs: 300, load: async () => (product.shopId ? (await this.core.shops([product.shopId]))[0] : null) },
      { name: 'recommendations', required: false, timeoutMs: 300, load: (signal) => this.core.get(`/products/${productId}/recommendations?limit=8`, { timeoutMs: 300, signal }) },
      { name: 'trending', required: false, timeoutMs: 200, load: (signal) => this.core.get(`/trending?category=${encodeURIComponent(product.category)}`, { timeoutMs: 200, signal }) },
      { name: 'flags', required: false, timeoutMs: 150, load: async (signal) => (await this.core.get<{ flags: Record<string, unknown> }>(`/flags`, { auth, timeoutMs: 150, signal })).flags },
      ...(auth ? [{ name: 'chatUnread', required: false, timeoutMs: 200, load: async (signal: AbortSignal) => (await this.core.get<{ unread: number }[]>(`/chat/unread`, { auth, timeoutMs: 200, signal })).reduce((s, c) => s + c.unread, 0) }] : []),
    ];

    const errors: ProductPage['errors'] = [];
    const results = await Promise.all(
      sections.map(async (section) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), section.timeoutMs);
        try {
          return await Promise.race([
            section.load(controller.signal),
            new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error(`timeout after ${section.timeoutMs} ms`)))),
          ]);
        } catch (error) {
          errors.push({ section: section.name, reason: (error as Error).message });
          return null;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    const value = (name: string) => results[sections.findIndex((s) => s.name === name)] ?? null;
    return {
      product,
      shop: value('shop') as ProductPage['shop'],
      recommendations: value('recommendations') as unknown[] | null,
      trending: value('trending') as unknown[] | null,
      flags: value('flags') as Record<string, unknown> | null,
      chatUnread: value('chatUnread') as number | null,
      errors,
    };
  }
}
