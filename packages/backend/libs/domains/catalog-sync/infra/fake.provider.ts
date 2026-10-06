import { createHmac, timingSafeEqual } from 'node:crypto';
import { CommerceProvider, NormalizedProduct, Page } from '../domain/provider.port';

export interface FakeProduct {
  id: string;
  name: string;
  price_cents: number;
  qty: number;
  type: string;
  modified: string;
}

/**
 * In-memory provider with a deliberately DIFFERENT shape from ours (like any
 * real provider), for local dev and specs. Counts writes so echo suppression
 * is observable. Page size 2 to exercise pagination.
 */
export class FakeProvider implements CommerceProvider {
  readonly name = 'fake' as const;
  readonly products = new Map<string, FakeProduct | Record<string, unknown>>();
  readonly stockWrites: { id: string; qty: number }[] = [];

  constructor(private readonly secret = 'fake-secret') {}

  upsert(p: FakeProduct | Record<string, unknown>) {
    this.products.set(String(p.id), p);
  }

  async listUpdatedSince(since: Date | null, cursor: string | null): Promise<Page> {
    const all = [...this.products.values()]
      .filter((p) => !since || String(p.modified) >= since.toISOString())
      .sort((a, b) => String(a.modified).localeCompare(String(b.modified)) || String(a.id).localeCompare(String(b.id)));
    const start = cursor ? Number(cursor) : 0;
    return { items: all.slice(start, start + 2), nextCursor: start + 2 < all.length ? String(start + 2) : null };
  }

  async get(externalId: string) {
    return this.products.get(externalId) ?? null;
  }

  normalize(raw: unknown): NormalizedProduct {
    const p = raw as FakeProduct;
    return NormalizedProduct.parse({
      externalId: String(p.id),
      title: p.name,
      description: '',
      priceMinor: p.price_cents,
      stock: p.qty,
      category: p.type,
      brand: '',
      updatedAt: p.modified,
      writeBack: {},
    });
  }

  async setStock(product: NormalizedProduct, stock: number) {
    this.stockWrites.push({ id: product.externalId, qty: stock });
    const p = this.products.get(product.externalId) as FakeProduct;
    // Like real providers, a write bumps updated_at → it WILL come back in the next incremental pull (the echo).
    this.products.set(product.externalId, { ...p, qty: stock, modified: new Date().toISOString() });
  }

  async listAllIds() {
    return [...this.products.keys()];
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>) {
    const given = Buffer.from(headers['x-fake-signature'] ?? '');
    const expected = Buffer.from(createHmac('sha256', this.secret).update(rawBody).digest('hex'));
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
