import { z } from 'zod';

/** Our normalised view of an external product (the anti-corruption layer's output). */
export const NormalizedProduct = z.object({
  externalId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(20_000),
  priceMinor: z.number().int().min(0),
  stock: z.number().int(),
  category: z.string().min(1).max(60),
  brand: z.string().max(60),
  updatedAt: z.string().datetime({ offset: true }),
  /** Provider-specific ids needed to write back (e.g. Shopify inventory_item_id). */
  writeBack: z.record(z.string(), z.string()),
});
export type NormalizedProduct = z.infer<typeof NormalizedProduct>;

export interface Page {
  items: unknown[];
  nextCursor: string | null;
}

/**
 * Provider port. Adapters speak the provider's real API; everything past
 * `normalize` sees only `NormalizedProduct` - a Shopify API change breaks one
 * adapter, never the sync engine (anti-corruption layer, 10/09 #36).
 */
export interface CommerceProvider {
  readonly name: 'shopify' | 'woocommerce' | 'fake';
  listUpdatedSince(since: Date | null, cursor: string | null): Promise<Page>;
  get(externalId: string): Promise<unknown | null>;
  /** Raw provider object → normalised (throws a ZodError on schema drift → quarantine). */
  normalize(raw: unknown): NormalizedProduct;
  setStock(product: NormalizedProduct, stock: number): Promise<void>;
  listAllIds(): Promise<string[]>;
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): boolean;
}
